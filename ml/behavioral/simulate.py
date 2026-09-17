"""
simulate.py

Generates a labelled lab-session dataset for the behavioural anomaly
detection model.

WHY SIMULATED: the deployed prototype has produced only 7 real attendance
sessions and 332 audit rows to date (mostly presence heartbeats from
development testing). That is far too little to train or honestly evaluate a
classifier, and no public dataset describes RUNA's specific session
telemetry. This module therefore defines explicit generative processes for
normal and anomalous lab sessions and samples from them. Reported metrics
measure how separable those modelled behaviours are - they are NOT a claim
about real-world detection accuracy. This must be stated as a limitation.

DESIGN CONSTRAINT - avoiding the leakage trap: anomalies are drawn from five
archetypes that each deviate on a DIFFERENT subset of features, and normal
sessions are allowed to drift into anomaly-like territory on any single
dimension. No one feature threshold separates the classes, so the classifier
must learn feature combinations rather than recover a labelling rule. The
training script re-verifies this with a solo-feature AUC diagnostic.

Grounded in the real system where possible: 5-minute presence heartbeat
cadence, comlab IDs 08-12, PC-01..PC-30 workstations, and the audit event
vocabulary actually emitted (presence_heartbeat, chat_request, tool_invoked,
lab_app_launch, url_blocked, usb_inserted, feature_usage).
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import FEATURE_NAMES, extract_features  # noqa: E402

RANDOM_STATE = 42
HEARTBEAT_INTERVAL_MIN = 5.0  # matches the deployed 5-minute presence heartbeat
ANOMALY_RATE = 0.13

ARCHETYPES = ["unattended_idle", "policy_probing", "off_hours", "credential_sharing", "usb_heavy"]


def _heartbeats(rng, duration, gap_mean, gap_max):
    """Expected heartbeat count for a duration, with realistic drop-out."""
    expected = duration / HEARTBEAT_INTERVAL_MIN
    observed = max(0, int(rng.normal(expected * 0.92, max(expected * 0.08, 0.6))))
    return observed, gap_mean, gap_max


def _normal_session(rng) -> dict:
    # Class hours with small legitimate tails either side.
    start_hour = int(np.clip(rng.normal(12.0, 2.6), 7, 19))
    # Sunday must remain reachable for normal sessions: if only anomalies can
    # fall on day 6, the day itself becomes a deterministic tell.
    day_of_week = int(
        rng.choice([0, 1, 2, 3, 4, 5, 6], p=[0.188, 0.188, 0.188, 0.188, 0.188, 0.045, 0.015])
    )
    duration = float(np.clip(rng.lognormal(np.log(58), 0.48), 12, 190))

    gap_mean = float(np.clip(rng.normal(5.4, 0.9), 4.2, 11))
    gap_max = float(np.clip(gap_mean + abs(rng.normal(3.0, 2.6)), 5, 28))

    s = {
        "session_duration_min": duration,
        "start_hour": start_hour,
        "day_of_week": day_of_week,
        "distinct_domains": int(np.clip(rng.poisson(8), 0, 60)),
        "blocked_url_count": int(rng.choice([0, 1, 2], p=[0.82, 0.13, 0.05])),
        "usb_insert_count": int(rng.choice([0, 1], p=[0.86, 0.14])),
        "app_launch_count": int(np.clip(rng.poisson(3.1), 0, 40)),
        "chat_request_count": int(np.clip(rng.poisson(4.0), 0, 60)),
        "tool_invoke_count": int(np.clip(rng.poisson(2.0), 0, 40)),
        "file_op_count": int(np.clip(rng.poisson(2.2), 0, 50)),
        # A student moving seats or reconnecting on another machine mid-session
        # legitimately produces two workstations. If only anomalies could show
        # >1, the feature would deterministically imply the label.
        "distinct_workstations": int(rng.choice([1, 2], p=[0.96, 0.04])),
        # NEGATIVE CONTROL: deliberately independent of the label. Its
        # importance should come out near zero, confirming the model does not
        # manufacture signal where none exists. Its low importance is
        # therefore a property of the simulation, not a finding about
        # account type in the real system.
        "is_guest_account": bool(rng.random() < 0.08),
    }

    # Deliberate overlap: ~22% of normal sessions drift into anomaly-like
    # territory, and a third of those drift on TWO dimensions at once. Without
    # this, "unusual on more than one axis" would by itself imply anomalous.
    if rng.random() < 0.22:
        n_drifts = 2 if rng.random() < 0.33 else 1
        for drift in rng.choice(6, size=n_drifts, replace=False):
            if drift == 0:
                s["session_duration_min"] = float(rng.uniform(150, 250))
            elif drift == 1:
                s["start_hour"] = int(rng.choice([6, 19, 20, 21, 22]))
            elif drift == 2:
                s["blocked_url_count"] = int(rng.integers(3, 10))
            elif drift == 3:
                # Upper end overlaps the anomalous range so no structural cap
                # makes high USB counts exclusively anomalous by construction.
                s["usb_insert_count"] = int(rng.integers(2, 7))
            elif drift == 4:
                # A quiet but legitimate session: reading, not clicking.
                s["app_launch_count"] = int(rng.integers(0, 2))
                s["chat_request_count"] = int(rng.integers(0, 2))
                s["distinct_domains"] = int(rng.integers(0, 4))
            else:
                s["file_op_count"] = int(rng.integers(12, 26))

    hb, gm, gx = _heartbeats(rng, s["session_duration_min"], gap_mean, gap_max)
    s.update(heartbeat_count=hb, heartbeat_gap_mean_min=gm, heartbeat_gap_max_min=gx)
    return s


def _lerp(base: float, extreme: float, severity: float) -> float:
    """Interpolate from a normal draw toward an extreme by `severity`."""
    return base + severity * (extreme - base)


def _anomalous_session(rng, archetype: str) -> dict:
    """
    Anomalies differ from normal in DEGREE, not in kind.

    Each anomalous session draws a severity in [0, 1] skewed toward the low
    end, and its archetype features are interpolated from an ordinary draw
    toward an extreme by that severity. A low-severity anomaly is therefore
    genuinely near-indistinguishable from a normal session, which is what
    makes the detection problem realistic: the classifier is expected to miss
    the subtle ones. Anomalies that differ categorically instead of
    continuously produce a trivially perfect classifier and prove nothing.

    Archetypes also express only a random subset of their features, so two
    sessions of the same archetype need not look alike.
    """
    s = _normal_session(rng)
    s["is_guest_account"] = bool(rng.random() < 0.08)  # kept independent of label

    severity = float(rng.beta(1.6, 3.0))  # mean ~0.35, most anomalies are mild
    express = lambda p=0.75: rng.random() < p  # noqa: E731 - partial expression

    if archetype == "unattended_idle":
        if express():
            s["session_duration_min"] = _lerp(s["session_duration_min"], rng.uniform(190, 310), severity)
        if express():
            s["app_launch_count"] = int(round(_lerp(s["app_launch_count"], 0, severity)))
            s["chat_request_count"] = int(round(_lerp(s["chat_request_count"], 0, severity)))
            s["tool_invoke_count"] = int(round(_lerp(s["tool_invoke_count"], 0, severity)))
            s["file_op_count"] = int(round(_lerp(s["file_op_count"], 0, severity)))
        if express():
            s["distinct_domains"] = int(round(_lerp(s["distinct_domains"], 1, severity)))
        gap_mean = _lerp(s["heartbeat_gap_mean_min"], rng.uniform(9.0, 14.0), severity)
        gap_max = _lerp(s["heartbeat_gap_max_min"], rng.uniform(45, 95), severity)
        hb, gm, gx = _heartbeats(rng, s["session_duration_min"], gap_mean, gap_max)
        s.update(heartbeat_count=hb, heartbeat_gap_mean_min=gm, heartbeat_gap_max_min=gx)

    elif archetype == "policy_probing":
        if express(0.9):
            s["blocked_url_count"] = int(round(_lerp(s["blocked_url_count"], rng.uniform(12, 26), severity)))
        if express():
            s["distinct_domains"] = int(round(_lerp(s["distinct_domains"], rng.uniform(35, 62), severity)))

    elif archetype == "off_hours":
        # Hour-of-day is circular, so linear interpolation is invalid here:
        # lerp(12 -> 22) passes through mid-afternoon, producing "off-hours"
        # sessions at 15:00. Instead, step outward from the edge of the normal
        # window (20:00) into the small hours, with severity controlling depth.
        if express(0.9):
            ladder = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5]
            idx = int(round(severity * (len(ladder) - 1)))
            idx = int(np.clip(rng.normal(idx, 1.0), 0, len(ladder) - 1))  # blur the boundary
            s["start_hour"] = ladder[idx]
        if express(0.5):
            s["day_of_week"] = int(rng.choice([0, 1, 2, 3, 4, 5, 6], p=[0.11, 0.11, 0.11, 0.11, 0.11, 0.24, 0.21]))
        if express():
            s["app_launch_count"] = int(round(_lerp(s["app_launch_count"], 0, severity * 0.7)))

    elif archetype == "credential_sharing":
        # Even the workstation signal is probabilistic: a shared credential is
        # only visible if the second machine is actually used in-window.
        if express(0.55):
            s["distinct_workstations"] = 2 if severity < 0.75 else int(rng.choice([2, 3]))
        if express():
            s["session_duration_min"] = _lerp(s["session_duration_min"], rng.uniform(200, 280), severity)
        if express():
            s["app_launch_count"] = int(round(_lerp(s["app_launch_count"], rng.uniform(18, 30), severity)))
        if express(0.6):
            s["file_op_count"] = int(round(_lerp(s["file_op_count"], rng.uniform(14, 28), severity)))
        hb, _, _ = _heartbeats(
            rng, s["session_duration_min"], s["heartbeat_gap_mean_min"], s["heartbeat_gap_max_min"]
        )
        s["heartbeat_count"] = hb

    elif archetype == "usb_heavy":
        if express(0.9):
            s["usb_insert_count"] = int(round(_lerp(s["usb_insert_count"], rng.uniform(5, 9), severity)))
        if express():
            s["file_op_count"] = int(round(_lerp(s["file_op_count"], rng.uniform(22, 42), severity)))

    # Clamp back into plausible ranges after interpolation.
    s["session_duration_min"] = float(np.clip(s["session_duration_min"], 8, 320))
    for k in ("app_launch_count", "chat_request_count", "tool_invoke_count",
              "file_op_count", "distinct_domains", "blocked_url_count", "usb_insert_count"):
        s[k] = int(max(0, s[k]))
    return s


def build(n: int = 4000, seed: int = RANDOM_STATE):
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        if rng.random() < ANOMALY_RATE:
            archetype = str(rng.choice(ARCHETYPES))
            raw = _anomalous_session(rng, archetype)
            label = 1
        else:
            archetype = "normal"
            raw = _normal_session(rng)
            label = 0
        feats = extract_features(raw)
        feats["label"] = label
        feats["archetype"] = archetype  # analysis only - never a model feature
        rows.append(feats)
    return rows


def main():
    out_dir = Path(__file__).resolve().parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "sessions.csv"

    rows = build()
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FEATURE_NAMES + ["label", "archetype"])
        writer.writeheader()
        writer.writerows(rows)

    n_anom = sum(r["label"] for r in rows)
    print(f"wrote {out_path}")
    print(f"  sessions : {len(rows)}")
    print(f"  anomalous: {n_anom} ({n_anom / len(rows):.1%})")
    print(f"  normal   : {len(rows) - n_anom}")


if __name__ == "__main__":
    main()
