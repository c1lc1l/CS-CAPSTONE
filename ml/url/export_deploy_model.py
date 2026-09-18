"""
export_deploy_model.py

Produces a size-constrained model for shipping inside the desktop app.

The evaluation model from train_evaluate.py is ~820 MB: CalibratedClassifierCV
with cv=3 keeps three full-depth 400-tree forests trained on 170k rows. The
packaged app self-extracts on every launch, so that model is not deployable.

This script trains a compact variant - shallower trees, larger leaves, a
single calibrated forest (ensemble=False) - on the IDENTICAL domain-separated
split, and evaluates it on the IDENTICAL hold-out. Compression is therefore
measured, not assumed; if it cost meaningful accuracy the numbers below would
show it.

Outputs:
  model/runa_url_rf_deploy.joblib
  reports/deploy_model_comparison.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    average_precision_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import FEATURE_NAMES  # noqa: E402

RANDOM_STATE = 42
BASE = Path(__file__).resolve().parent
BANDS = (0.3, 0.7)  # benign < 0.3 <= suspicious < 0.7 <= malicious


def band_table(y_true, p):
    lo, hi = BANDS
    rows = []
    for name, mask in (
        ("benign", p < lo),
        ("suspicious", (p >= lo) & (p < hi)),
        ("malicious", p >= hi),
    ):
        n = int(mask.sum())
        rows.append({
            "band": name,
            "n": n,
            "share": round(n / len(p), 4),
            "phishing_rate": round(float(y_true[mask].mean()), 4) if n else None,
        })
    return rows


def evaluate(model, X_te, y_te):
    p = model.predict_proba(X_te)[:, 1]
    yhat = (p >= BANDS[1]).astype(int)
    return p, {
        "roc_auc": round(float(roc_auc_score(y_te, p)), 4),
        "pr_auc": round(float(average_precision_score(y_te, p)), 4),
        "precision_at_0.7": round(float(precision_score(y_te, yhat, zero_division=0)), 4),
        "recall_at_0.7": round(float(recall_score(y_te, yhat, zero_division=0)), 4),
        "f1_at_0.7": round(float(f1_score(y_te, yhat, zero_division=0)), 4),
    }


def main() -> int:
    df = pd.read_csv(BASE / "data" / "urls.csv")
    X, y, g = df[FEATURE_NAMES], df["label"].astype(int), df["group"]
    tr, te = next(
        GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=RANDOM_STATE).split(X, y, groups=g)
    )
    X_tr, X_te = X.iloc[tr], X.iloc[te]
    y_tr, y_te = y.iloc[tr], y.iloc[te].to_numpy()

    print("evaluating the full evaluation model ...")
    full = joblib.load(BASE / "model" / "runa_url_rf.joblib")
    _, full_m = evaluate(full, X_te, y_te)
    full_mb = (BASE / "model" / "runa_url_rf.joblib").stat().st_size / 1e6

    print("training compact deployment model ...")
    compact_rf = RandomForestClassifier(
        n_estimators=150,
        max_depth=18,
        min_samples_leaf=10,
        class_weight="balanced",
        n_jobs=-1,
        random_state=RANDOM_STATE,
    )
    # ensemble=False fits ONE forest on all training data and calibrates it
    # from cross-validated predictions, instead of keeping three forests.
    compact = CalibratedClassifierCV(estimator=compact_rf, method="isotonic", cv=3, ensemble=False)
    compact.fit(X_tr, y_tr)

    out = BASE / "model" / "runa_url_rf_deploy.joblib"
    joblib.dump(compact, out, compress=3)
    compact_mb = out.stat().st_size / 1e6

    p_c, comp_m = evaluate(compact, X_te, y_te)

    print(f"\n{'metric':18s}{'full':>10s}{'compact':>10s}{'delta':>10s}")
    for k in full_m:
        print(f"{k:18s}{full_m[k]:10.4f}{comp_m[k]:10.4f}{comp_m[k]-full_m[k]:+10.4f}")
    print(f"{'size (MB)':18s}{full_mb:10.1f}{compact_mb:10.1f}")

    print("\ncompact model bands (held-out):")
    bands = band_table(y_te, p_c)
    for b in bands:
        print(f"  {b['band']:11s} n={b['n']:6d}  share={b['share']:.3f}  phishing_rate={b['phishing_rate']}")

    report = {
        "purpose": "size-constrained model for packaging; evaluated on the same domain-separated hold-out",
        "full_model": {**full_m, "size_mb": round(full_mb, 1)},
        "compact_model": {**comp_m, "size_mb": round(compact_mb, 1)},
        "compact_hyperparameters": {
            "n_estimators": 150, "max_depth": 18, "min_samples_leaf": 10,
            "calibration": "isotonic, cv=3, ensemble=False",
        },
        "bands": {"benign_below": BANDS[0], "malicious_at_or_above": BANDS[1]},
        "compact_band_composition": bands,
    }
    (BASE / "reports" / "deploy_model_comparison.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
