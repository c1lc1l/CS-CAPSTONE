"""
features.py

Single source of truth for turning a lab session's telemetry into a feature
vector. Imported by BOTH the training pipeline and (later) the runtime
scorer, so the features a model is trained on can never drift from the
features it is served.

Every feature below is derivable from telemetry RUNA already emits:
  - lab_attendance_sessions : time_in, time_out, workstation_label, comlab_id
  - audit_log               : presence_heartbeat, chat_request, tool_invoked,
                              lab_app_launch, url_blocked, usb_inserted,
                              feature_usage, login

Mapped to the features named in the thesis (Algorithm 4): session duration,
access frequency, time-of-day pattern, and account type.
"""

from __future__ import annotations

FEATURE_NAMES = [
    "session_duration_min",
    "heartbeat_count",
    "heartbeat_gap_mean_min",
    "heartbeat_gap_max_min",
    "start_hour",
    "day_of_week",
    "distinct_domains",
    "blocked_url_count",
    "blocked_url_rate_hr",
    "usb_insert_count",
    "app_launch_count",
    "chat_request_count",
    "tool_invoke_count",
    "file_op_count",
    "actions_per_active_min",
    "distinct_workstations",
    "is_guest_account",
]


def extract_features(session: dict) -> dict:
    """
    Build the model feature vector from one session record.

    `session` uses the same keys the simulator emits and that a runtime
    aggregation over audit_log would produce.
    """
    duration = max(float(session.get("session_duration_min", 0.0)), 0.0)
    hb = int(session.get("heartbeat_count", 0))
    blocked = int(session.get("blocked_url_count", 0))

    interactions = (
        int(session.get("app_launch_count", 0))
        + int(session.get("chat_request_count", 0))
        + int(session.get("tool_invoke_count", 0))
        + int(session.get("file_op_count", 0))
    )

    # Rates are computed against duration so that a long quiet session and a
    # short quiet session are distinguishable, which is the whole point of the
    # "unattended machine" case.
    active_min = max(duration, 1.0)

    return {
        "session_duration_min": duration,
        "heartbeat_count": hb,
        "heartbeat_gap_mean_min": float(session.get("heartbeat_gap_mean_min", 0.0)),
        "heartbeat_gap_max_min": float(session.get("heartbeat_gap_max_min", 0.0)),
        "start_hour": int(session.get("start_hour", 0)),
        "day_of_week": int(session.get("day_of_week", 0)),
        "distinct_domains": int(session.get("distinct_domains", 0)),
        "blocked_url_count": blocked,
        "blocked_url_rate_hr": blocked / (active_min / 60.0),
        "usb_insert_count": int(session.get("usb_insert_count", 0)),
        "app_launch_count": int(session.get("app_launch_count", 0)),
        "chat_request_count": int(session.get("chat_request_count", 0)),
        "tool_invoke_count": int(session.get("tool_invoke_count", 0)),
        "file_op_count": int(session.get("file_op_count", 0)),
        "actions_per_active_min": interactions / active_min,
        "distinct_workstations": int(session.get("distinct_workstations", 1)),
        "is_guest_account": int(bool(session.get("is_guest_account", False))),
    }
