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

Held-out test set (800 sessions, never seen during training):

| Metric | Threshold 0.5 | Threshold 0.7 (operating) |
| --- | --- | --- |
| Precision | 0.9375 | 0.9322 |
| Recall | 0.5882 | 0.5392 |
| F1 | 0.7229 | 0.6832 |

ROC-AUC 0.9046 · PR-AUC 0.8087 · OOB 0.9444

5-fold stratified CV: F1-macro **0.8372 ± 0.0200**, ROC-AUC 0.9235 ± 0.0106.

Model selection (5-fold F1-macro on the training split):

| Model | F1-macro | std |
| --- | --- | --- |
| **Random Forest** | **0.8448** | 0.0229 |
| Decision Tree | 0.7853 | 0.0120 |
| Naive Bayes | 0.7648 | 0.0366 |
| Logistic Regression | 0.7088 | 0.0187 |

## Interpreting the precision/recall balance

The operating threshold is 0.7, matching `CONFIDENCE_THRESHOLD` in
`src/app/agentic/riskClassifier.ts`, so a session's anomaly probability is
directly comparable against the value the escalation logic already uses.

At that threshold the model is deliberately precision-favouring (0.93
precision, 0.54 recall). In a computer laboratory a false positive is
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
| unattended_idle | 21 | 0.81 |
| credential_sharing | 20 | 0.75 |
| policy_probing | 18 | 0.56 |
| off_hours | 21 | 0.38 |
| usb_heavy | 22 | 0.23 |

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

## Guarding against leakage

Two modelling errors were found and corrected during development, both of
which had produced a falsely perfect classifier:

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

`train_evaluate.py` re-runs a solo-feature AUC screen on every execution and
warns if any single feature exceeds 0.95 AUC alone. Current maximum is
**0.6123** (`file_op_count`), confirming no single feature encodes the label.
