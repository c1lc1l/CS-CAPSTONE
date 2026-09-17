# Behavioural Anomaly Detection (Algorithm 4, model 2)

Random Forest classifier that scores a lab session as normal or anomalous
from session telemetry, supporting the BDI belief-update step described in
Algorithm 1.

## Reproducing

```bash
python simulate.py        # writes data/sessions.csv
python train_evaluate.py  # writes reports/ and model/
```

Everything is pinned to `RANDOM_STATE = 42`, so both steps are
deterministic. `data/` and `model/` are gitignored because they regenerate
exactly; `reports/` is committed because those are the Chapter 4 artifacts.

## Headline results

Held-out test set (800 sessions, never seen during training). All rows use
**calibrated** probabilities so they are directly comparable:

| Metric | Threshold 0.5 | Threshold 0.7 (operating) | Threshold 0.9 |
| --- | --- | --- | --- |
| Precision | 0.8955 | **0.9592** | 1.0000 |
| Recall | 0.6250 | **0.4896** | 0.2812 |
| F1 | 0.7362 | **0.6483** | 0.4390 |

ROC-AUC 0.9096 · PR-AUC 0.8126

5-fold stratified CV: F1-macro **0.7920 ± 0.0359**, ROC-AUC 0.9096 ± 0.0200.

Model selection (5-fold F1-macro on the training split):

| Model | F1-macro | std |
| --- | --- | --- |
| **Random Forest** | **0.7650** | 0.0175 |
| Decision Tree | 0.7274 | 0.0287 |
| Naive Bayes | 0.6859 | 0.0332 |
| Logistic Regression | 0.6497 | 0.0230 |

## Interpreting the precision/recall balance

The operating threshold is 0.7, matching `CONFIDENCE_THRESHOLD` in
`src/app/agentic/riskClassifier.ts`, so a session's anomaly probability is
directly comparable against the value the escalation logic already uses.

At that threshold the model is deliberately precision-favouring (0.96
precision, 0.49 recall). In a computer laboratory a false positive is
expensive — it escalates a student's ordinary session to staff review — so
the model is tuned to be confident when it flags. The recall shortfall is
not treated as undetected risk: missed sessions remain covered by the other
detection layers (ClamAV signature scanning, rule-based web governance) and
by the human-in-the-loop approvals gate. This is the quantitative argument
for the multi-layered design.

## Which behaviours are actually detectable

Recall by anomaly archetype at threshold 0.7:

| Archetype | n | Recall |
| --- | --- | --- |
| unattended_idle | 21 | 0.76 |
| policy_probing | 20 | 0.60 |
| credential_sharing | 21 | 0.48 |
| off_hours | 17 | 0.29 |
| usb_heavy | 17 | 0.24 |

This spread is a result, not a defect. Behaviours with a distinctive
*combination* of signals (a long session with heartbeats but no interaction;
one credential active on multiple workstations) are detectable from
telemetry alone. Behaviours that overlap ordinary student activity are not:
a session starting at 20:00 is genuinely ambiguous, and 2–3 USB insertions
with moderate file activity is routine coursework. The `usb_heavy` row in
particular shows why behavioural detection cannot replace the signature
layer — removable-media risk is better addressed by scanning the media than
by inferring intent from session shape.

## Limitations — state these explicitly

**The dataset is simulated.** The deployed prototype has produced only 7
real attendance sessions and 332 audit rows to date, almost entirely
development testing. That is far too little to train or honestly evaluate a
classifier, and no public dataset describes this system's session telemetry.
`simulate.py` therefore defines explicit generative processes for normal and
anomalous sessions and samples from them.

**The metrics measure separability of modelled behaviours, not real-world
detection accuracy.** They establish that the feature set carries signal and
that the pipeline is methodologically sound. They are not evidence of field
performance, and should not be presented as such. Validating against real
labelled sessions is future work once the system has run a full term.

**Feature definitions are grounded in the real system** where possible: the
5-minute presence heartbeat cadence, comlab IDs 08–12, PC-01..PC-30
workstations, and the audit event vocabulary the system actually emits.
`features.py` is the single source of truth and is imported by both training
and (planned) runtime scoring, so served features cannot drift from trained
features.

## Negative control

`is_guest_account` is generated **independently of the label** on purpose. It
is a negative control: a feature the paper names ("account type") that is
known by construction to carry no signal. Its importance comes out at
**0.0075**, near the bottom of the ranking, which confirms the model does not
manufacture signal where none exists.

Its low importance is therefore a property of the simulation and must not be
reported as a finding about account type in the real system. Whether guest
(access-code) sessions actually carry different risk is an open question
that only real labelled data can answer.

## Guarding against leakage

Four modelling errors were found and corrected during development. The first
two produced a falsely perfect classifier; the second two were found by
auditing the generated data directly rather than by trusting the aggregate
metrics:

1. **Categorical rather than degree-based anomalies.** The first generator
   perturbed 3–5 features at once into near-disjoint joint regions, giving
   1.0000 precision/recall/F1. Anomalies now carry a severity drawn from
   `Beta(1.6, 3.0)` and interpolate from an ordinary draw toward an extreme,
   so low-severity anomalies are near-indistinguishable from normal and are
   expected to be missed.
2. **Linear interpolation of a circular variable.** Interpolating start hour
   from 12:00 toward 22:00 passes through mid-afternoon, so low-severity
   "off-hours" sessions were being generated at 15:00 and labelled anomalous
   — label noise, not subtlety. Off-hours severity now steps outward from
   the edge of the normal window (20:00) into the small hours.

3. **`distinct_workstations` was a deterministic tell.** Normal sessions were
   hardcoded to a single workstation, so *any* session showing two machines
   was guaranteed anomalous — 64 sessions perfectly separable, and the model
   was leaning on it (importance 0.0619). Normal sessions now show two
   workstations 4% of the time, since a student moving seats or reconnecting
   on another machine legitimately produces this. Importance fell to 0.0188
   and `credential_sharing` recall fell from 0.75 to 0.48, showing how much
   work the tell had been doing.
4. **`day_of_week == 6` was a deterministic tell.** Normal sessions could
   only be generated on days 0–5, so any Sunday session implied the label.
   Sunday is now reachable for normal sessions (1.5%).

Note that fixing 3 and 4 *lowered* the headline metrics (CV F1-macro 0.8372
to 0.7920). That drop is the point: the earlier figures were inflated by
leakage, and the current ones are what the feature set actually supports.

`train_evaluate.py` re-runs a solo-feature AUC screen on every execution and
warns if any single feature exceeds 0.95 AUC alone. Current maximum is
**0.609**, confirming no single feature encodes the label.

A solo-AUC screen alone is not sufficient, however — it did not catch errors
3 and 4, because each affected only a small subset of sessions and so barely
moved the aggregate AUC. Class purity per feature value was checked
separately. No feature now has a structural cap that makes any region
exclusively one class; the single-class regions that remain are ordinary
distribution tails (for example, very high blocked-URL counts), which is
expected and realistic rather than an artifact.
