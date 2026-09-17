"""
train_evaluate.py

Trains and evaluates the URL threat classifier (Algorithm 4, model 1) and
writes the artifacts Chapter 4 needs.

Methodology mirrors the project's established discipline: solo-feature AUC
leakage screening, a DOMAIN-SEPARATED split so no registrable domain appears
in both train and test, grouped k-fold cross-validation, baseline model
comparison, probability calibration, and threshold analysis tied to the
system's CONFIDENCE_THRESHOLD of 0.7.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV, CalibrationDisplay  # noqa: E402
from sklearn.ensemble import RandomForestClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    ConfusionMatrixDisplay,
    average_precision_score,
    brier_score_loss,
    classification_report,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import (  # noqa: E402
    GroupShuffleSplit,
    StratifiedGroupKFold,
    cross_val_score,
    cross_validate,
)
from sklearn.naive_bayes import GaussianNB  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402
from sklearn.tree import DecisionTreeClassifier  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import FEATURE_NAMES  # noqa: E402

RANDOM_STATE = 42
OPERATING_THRESHOLD = 0.7  # mirrors CONFIDENCE_THRESHOLD in riskClassifier.ts
LEAKAGE_AUC_LIMIT = 0.95

BASE = Path(__file__).resolve().parent
REPORTS = BASE / "reports"
MODEL_DIR = BASE / "model"


def main() -> int:
    REPORTS.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(BASE / "data" / "urls.csv")
    X = df[FEATURE_NAMES]
    y = df["label"].astype(int)
    groups = df["group"]

    print(f"dataset: {len(df)} hosts, {len(FEATURE_NAMES)} features")
    print(f"class balance: phishing={int(y.sum())} ({y.mean():.1%}), legitimate={int((1-y).sum())}")
    print(f"registrable domains: {groups.nunique()}\n")

    # ---- leakage screen ----------------------------------------------------
    solo = []
    for col in FEATURE_NAMES:
        auc = cross_val_score(
            RandomForestClassifier(n_estimators=60, random_state=RANDOM_STATE, n_jobs=-1),
            X[[col]], y, cv=3, scoring="roc_auc",
        ).mean()
        solo.append({"feature": col, "solo_auc": round(float(auc), 4)})
    solo_df = pd.DataFrame(solo).sort_values("solo_auc", ascending=False)
    solo_df.to_csv(REPORTS / "solo_feature_auc.csv", index=False)
    print("top solo-feature AUC (leakage screen):")
    print(solo_df.head(6).to_string(index=False))
    leaky = solo_df[solo_df.solo_auc >= LEAKAGE_AUC_LIMIT]
    print(
        f"\nLEAKAGE WARNING: {leaky.feature.tolist()}"
        if not leaky.empty
        else f"\nno single feature reaches {LEAKAGE_AUC_LIMIT} solo AUC\n"
    )

    # ---- domain-separated hold-out ----------------------------------------
    gss = GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=RANDOM_STATE)
    tr, te = next(gss.split(X, y, groups=groups))
    X_train, X_test = X.iloc[tr], X.iloc[te]
    y_train, y_test = y.iloc[tr], y.iloc[te]
    print(f"domain-separated split: train={len(X_train)}  test={len(X_test)}")
    overlap = set(groups.iloc[tr]) & set(groups.iloc[te])
    print(f"domains shared across the split: {len(overlap)} (must be 0)\n")

    rf = RandomForestClassifier(
        n_estimators=400, class_weight="balanced", oob_score=True,
        n_jobs=-1, random_state=RANDOM_STATE,
    )
    rf.fit(X_train, y_train)
    y_pred = rf.predict(X_test)
    y_proba = rf.predict_proba(X_test)[:, list(rf.classes_).index(1)]

    print("held-out classification report (threshold 0.5, uncalibrated):")
    print(classification_report(y_test, y_pred, target_names=["legitimate", "phishing"], digits=4))
    roc = float(roc_auc_score(y_test, y_proba))
    pr = float(average_precision_score(y_test, y_proba))
    print(f"ROC-AUC {roc:.4f}   PR-AUC {pr:.4f}   OOB {rf.oob_score_:.4f}\n")

    # ---- grouped cross-validation -----------------------------------------
    scoring = ["accuracy", "precision_macro", "recall_macro", "f1_macro", "roc_auc"]
    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    cv = cross_validate(rf, X, y, groups=groups, cv=sgkf, scoring=scoring, n_jobs=-1)
    cv_table = pd.DataFrame({
        "metric": scoring,
        "mean": [round(float(cv[f"test_{m}"].mean()), 4) for m in scoring],
        "std": [round(float(cv[f"test_{m}"].std()), 4) for m in scoring],
    })
    cv_table.to_csv(REPORTS / "cv_metrics.csv", index=False)
    print("5-fold stratified GROUP cross-validation (domain-separated):")
    print(cv_table.to_string(index=False))

    # ---- baselines ---------------------------------------------------------
    models = {
        "Logistic Regression": make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=1000, class_weight="balanced")),
        "Decision Tree": DecisionTreeClassifier(class_weight="balanced", random_state=RANDOM_STATE),
        "Naive Bayes": GaussianNB(),
        "Random Forest": rf,
    }
    rows = []
    sub = StratifiedGroupKFold(n_splits=3, shuffle=True, random_state=RANDOM_STATE)
    for name, m in models.items():
        r = cross_validate(m, X_train, y_train, groups=groups.iloc[tr], cv=sub,
                           scoring="f1_macro", n_jobs=-1)
        rows.append({"model": name,
                     "f1_macro_mean": round(float(r["test_score"].mean()), 4),
                     "f1_macro_std": round(float(r["test_score"].std()), 4)})
    compare = pd.DataFrame(rows).sort_values("f1_macro_mean", ascending=False)
    compare.to_csv(REPORTS / "baseline_comparison.csv", index=False)
    print("\nbaseline comparison (domain-separated 3-fold f1_macro):")
    print(compare.to_string(index=False))

    # ---- calibration + thresholds -----------------------------------------
    cal = CalibratedClassifierCV(estimator=rf, method="isotonic", cv=3)
    cal.fit(X_train, y_train)
    p_cal = cal.predict_proba(X_test)[:, 1]
    brier_raw = float(brier_score_loss(y_test, y_proba))
    brier_cal = float(brier_score_loss(y_test, p_cal))
    print(f"\nBrier raw {brier_raw:.4f} -> calibrated {brier_cal:.4f}")

    thresholds = []
    for t in (0.5, OPERATING_THRESHOLD, 0.9):
        yhat = (p_cal >= t).astype(int)
        thresholds.append({
            "threshold": t,
            "precision": round(float(precision_score(y_test, yhat, zero_division=0)), 4),
            "recall": round(float(recall_score(y_test, yhat, zero_division=0)), 4),
            "f1": round(float(f1_score(y_test, yhat, zero_division=0)), 4),
            "flagged": int(yhat.sum()),
        })
    thr_df = pd.DataFrame(thresholds)
    thr_df.to_csv(REPORTS / "threshold_analysis.csv", index=False)
    print("\nthreshold analysis (calibrated):")
    print(thr_df.to_string(index=False))
    op = next(r for r in thresholds if r["threshold"] == OPERATING_THRESHOLD)

    # ---- plots -------------------------------------------------------------
    ConfusionMatrixDisplay.from_predictions(
        y_test, (p_cal >= OPERATING_THRESHOLD).astype(int),
        cmap="Blues", display_labels=["legitimate", "phishing"])
    plt.title(f"URL threat - confusion matrix (threshold {OPERATING_THRESHOLD})")
    plt.tight_layout(); plt.savefig(REPORTS / "confusion_matrix.png", dpi=150); plt.close()

    imp = pd.Series(rf.feature_importances_, index=FEATURE_NAMES).sort_values()
    imp.plot(kind="barh", figsize=(8, 7), title="Feature importance - URL threat model")
    plt.tight_layout(); plt.savefig(REPORTS / "feature_importance.png", dpi=150); plt.close()
    imp.sort_values(ascending=False).round(4).to_csv(
        REPORTS / "feature_importance.csv", header=["importance"])

    CalibrationDisplay.from_predictions(y_test, y_proba, n_bins=12, name="raw")
    CalibrationDisplay.from_predictions(y_test, p_cal, n_bins=12, name="calibrated")
    plt.title("Calibration curve - URL threat model")
    plt.tight_layout(); plt.savefig(REPORTS / "calibration_curve.png", dpi=150); plt.close()

    joblib.dump(cal, MODEL_DIR / "runa_url_rf.joblib", compress=3)

    metrics = {
        "dataset": {
            "source": "PhiUSIIL Phishing URL Dataset, UCI id=967",
            "hosts": int(len(df)),
            "features": len(FEATURE_NAMES),
            "feature_scope": "host-only lexical (collection artifact neutralised - see features.py)",
            "phishing": int(y.sum()),
            "phishing_rate": round(float(y.mean()), 4),
            "registrable_domains": int(groups.nunique()),
            "split": "domain-separated (GroupShuffleSplit); no domain spans train/test",
        },
        "holdout_uncalibrated_argmax": {
            "precision": round(float(precision_score(y_test, y_pred, zero_division=0)), 4),
            "recall": round(float(recall_score(y_test, y_pred, zero_division=0)), 4),
            "f1": round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
        },
        "holdout_calibrated_thresholds": thresholds,
        "holdout_operating_threshold": op,
        "roc_auc": round(roc, 4),
        "pr_auc": round(pr, 4),
        "oob_score": round(float(rf.oob_score_), 4),
        "brier_raw": round(brier_raw, 4),
        "brier_calibrated": round(brier_cal, 4),
        "cross_validation": cv_table.to_dict(orient="records"),
        "baseline_comparison": compare.to_dict(orient="records"),
        "max_solo_feature_auc": round(float(solo_df.solo_auc.max()), 4),
        "leakage_screen_passed": bool(solo_df.solo_auc.max() < LEAKAGE_AUC_LIMIT),
        "operating_threshold": OPERATING_THRESHOLD,
        "random_state": RANDOM_STATE,
    }
    (REPORTS / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(f"\nartifacts -> {REPORTS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
