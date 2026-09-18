# URL Threat Classification (Algorithm 4, model 1)

Random Forest classifier that scores a requested hostname as legitimate or
phishing from lexical features, supporting the web governance module.

## Reproducing

```bash
python build_dataset.py    # fetches PhiUSIIL from UCI, writes data/urls.csv
python train_evaluate.py   # writes reports/ and model/
```

Pinned to `RANDOM_STATE = 42`. `data/` and `model/` are gitignored (they
regenerate); `reports/` is committed as the Chapter 4 artifacts.

## Headline results

Hold-out set of **48,631 hosts**, domain-separated so no registrable domain
appears in both train and test (verified: 0 shared domains). All rows use
calibrated probabilities:

| Metric | Threshold 0.5 | Threshold 0.7 (operating) | Threshold 0.9 |
| --- | --- | --- | --- |
| Precision | 0.9458 | **0.9746** | 0.9904 |
| Recall | 0.6541 | **0.5511** | 0.3455 |
| F1 | 0.7734 | **0.7040** | 0.5123 |

Hold-out ROC-AUC 0.8734 · PR-AUC 0.8871 · OOB 0.8217

5-fold stratified **group** CV: F1-macro **0.8020 ± 0.0260**, ROC-AUC 0.8380 ± 0.0305.

## Deployment model — smaller and better

The evaluation model above is ~820 MB (calibrated with `cv=3`, keeping three
full-depth 400-tree forests), which cannot ship inside a desktop app that
self-extracts. `export_deploy_model.py` trains a compact variant on the
**identical** domain-separated split and evaluates it on the **identical**
hold-out:

| Metric (calibrated) | Evaluation model | Deployed model | Δ |
| --- | --- | --- | --- |
| ROC-AUC | 0.8796 | **0.8956** | +0.016 |
| PR-AUC | 0.8943 | **0.9043** | +0.010 |
| Precision @ 0.7 | 0.9746 | 0.9704 | −0.004 |
| Recall @ 0.7 | 0.5511 | **0.6217** | +0.071 |
| F1 @ 0.7 | 0.7040 | **0.7579** | +0.054 |
| Size | 819.7 MB | **15.6 MB** | |

Compact hyperparameters: 150 trees, `max_depth=18`, `min_samples_leaf=10`,
isotonic calibration with `ensemble=False` (one forest, calibrated from
cross-validated predictions). These were chosen *a priori* as standard
regularisation settings and evaluated once — not tuned against the test set.

The full-depth forest was **overfitting**: regularisation generalises better
to domains it has never seen. The deployed model is what ships and what
`/analyze-url` serves, so it is the model whose numbers belong in Chapter 4.

Deployed band composition on the hold-out (0.3 / 0.7):

| Band | Share | Actually phishing |
| --- | --- | --- |
| benign | 59.4% | 15.6% |
| suspicious | 12.3% | 60.5% |
| malicious | 28.3% | 97.0% |

## Model selection — Random Forest did NOT win (unregularised)

> **Open question:** the comparison below used an *unregularised* Random
> Forest. The regularised deployment forest scores higher than every figure
> in this table, so a regularised forest may well win a re-run. That has not
> been tested and must not be claimed until it is — re-run the baseline
> comparison with the deployment hyperparameters before writing Chapter 4.

Domain-separated 3-fold F1-macro on the training split:

| Model | F1-macro | std |
| --- | --- | --- |
| **Logistic Regression** | **0.8025** | 0.0055 |
| Random Forest | 0.7934 | 0.0083 |
| Decision Tree | 0.7760 | 0.0101 |
| Naive Bayes | 0.6880 | 0.0113 |

Logistic Regression edges out Random Forest on this feature set, and is also
more stable (std 0.0055 vs 0.0083). The margin is small — about 0.009 F1,
roughly one standard deviation — so the two are close to tied rather than
clearly separated.

This is reported rather than buried. The thesis should not claim Random
Forest was selected because it was the most accurate model on this task,
because on this evidence it was not. The defensible justification for
retaining Random Forest is different and still holds:

- it exposes `feature_importances_`, which the explainability argument (SO4)
  depends on, whereas linear coefficients on correlated lexical features are
  harder to present honestly;
- it captures non-linear interactions that matter once path features are
  restored in future work;
- it required no feature scaling, while the Logistic Regression baseline
  needed a `StandardScaler` pipeline.

If the panel presses on "why Random Forest", the honest answer is
interpretability and headroom, not accuracy. Switching to Logistic
Regression would also be defensible.

## Interpreting the precision/recall balance

The operating threshold is 0.7, matching `CONFIDENCE_THRESHOLD` in
`src/app/agentic/riskClassifier.ts`, so the score is directly comparable to
the value the escalation logic already uses.

At that threshold the model is strongly precision-favouring: **97.5%
precision at 55.1% recall**. Blocking a legitimate site a student needs
mid-class is an expensive failure, so the model only flags when confident.
Missed phishing is not treated as unhandled risk — it falls through to the
enforced blocklist, ClamAV scanning of anything downloaded, and the
human-in-the-loop gate. Same argument as the behavioural model, from the
opposite direction.

## Data integrity — three problems found and handled

**1. Community datasets had corrupted labels.** Three HuggingFace re-uploads
of the widely circulated four-class "malicious URLs" dataset were inspected
first. All three were unusable: `tools.ietf.org/html/rfc1879`,
`www.linuxjournal.com/article/7002` and `www.gamefaqs.com/psp/...` were all
labelled *phishing*, and obvious credential-harvesting URLs were labelled
*benign*. Only 1 of 16 sampled "phishing" rows was genuinely phishing.
Training on any of them would have produced meaningless metrics under a
"verified labels" claim. PhiUSIIL (UCI id=967) was used instead because its
provenance is documented and spot inspection confirms coherent classes.

**2. PhiUSIIL carries a severe collection artifact.** Measured on the raw
corpus:

| Check | Legitimate | Phishing | Separability |
| --- | --- | --- | --- |
| starts `https://www.` | 100.0% | 2.4% | 0.976 |
| has path beyond host | 0.0% | 28.4% | 0.284 |
| ends with `/` | 0.0% | 36.5% | 0.365 |

The legitimate class was harvested as normalised homepage roots; the
phishing class contains raw captures. A model given scheme or path features
learns which collection pipeline produced the row. This cannot be repaired
by reweighting — legitimate rows have no paths at all — so it is removed by
construction: scheme, leading `www.` and everything after the host are
discarded, and only host-derived features are used. Re-checked after
normalisation: all four artifact probes read 0.0000 in both classes.

**3. Host duplication and label conflicts.** 58 hosts appeared with both
labels and were dropped as ambiguous. 235,636 rows collapsed to 219,043
unique hosts; without deduplication the same host would appear in train and
test. Splitting is grouped by registrable domain (`co.uk`-style multi-part
suffixes handled), so `a.example.com` and `b.example.com` cannot straddle
the split.

`train_evaluate.py` re-runs a solo-feature AUC screen every execution;
current maximum is **0.7176** (`mean_label_length`), well clear of the 0.95
limit.

## Limitations — state these explicitly

**Host-only features.** Path, query and scheme are discarded to neutralise
the collection artifact. This costs genuine signal — a path like
`/service_logins.html` is informative in deployment — so these figures are a
floor, not a ceiling. Restoring path features requires a corpus whose
classes were collected the same way.

**Binary, not multi-class.** The intent was benign / phishing / malware so
the system could report *what kind* of threat. That was abandoned because no
multi-class corpus with trustworthy labels could be obtained (see problem 1).
Reporting a threat *type* from a model trained on corrupted type labels
would be worse than reporting none. Obtaining a verified multi-class corpus
is future work.

**Single corpus, no external validation.** Everything here comes from
PhiUSIIL. Validating against an independent source (URLhaus, OpenPhish) is
the natural next step, but those feeds are collected differently and would
introduce the same source-bias problem unless a matched benign source is
found.
