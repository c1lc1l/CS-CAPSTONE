"""
train_evaluate.py

Trains and evaluates the behavioural anomaly detection classifier
(Algorithm 4, model 2) and writes every artifact Chapter 4 needs.

Mirrors the methodology already established in the project's URL classifier
pipeline: leakage screening by solo-feature AUC, stratified hold-out, 5-fold
stratified cross-validation, baseline model comparison, probability
calibration, and threshold analysis tied to the system's CONFIDENCE_THRESHOLD
of 0.7.

Outputs (ml/behavioral/reports/):
  metrics.json               all headline numbers
  cv_metrics.csv             5-fold mean/std table
  baseline_comparison.csv    RF vs Logistic Regression / Decision Tree / NB
  solo_feature_auc.csv       leakage diagnostic
  threshold_analysis.csv     precision/recall at 0.5 / 0.7 / 0.9
  confusion_matrix.png
  feature_importance.png
  calibration_curve.png
Model (ml/behavioral/model/):
  runa_behavioral_rf.joblib  calibrated classifier
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV, CalibrationDisplay  # noqa: E402
from sklearn.ensemble import RandomForestClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    ConfusionMatrixDisplay,
    average_precision_score,
    brier_score_loss,
    classification_report,
    precision_score,
    recall_score,
    f1_score,
    roc_auc_score,
)
from sklearn.model_selection import (  # noqa: E402
    StratifiedKFold,
    cross_val_score,
    cross_validate,
    train_test_split,
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

    df = pd.read_csv(BASE / "data" / "sessions.csv")
    X = df[FEATURE_NAMES].copy()
    y = df["label"].astype(int)

    print(f"dataset: {X.shape[0]} sessions, {X.shape[1]} features")
    print(f"class balance: {y.value_counts().to_dict()}  (positive = anomalous)\n")

    # ---- leakage diagnostic -------------------------------------------------
    # Any single feature that alone separates the classes would mean the
    # simulator encoded the label into a feature rather than into behaviour.
    solo = []
    for col in FEATURE_NAMES:
        auc = cross_val_score(
            RandomForestClassifier(n_estimators=80, random_state=RANDOM_STATE, n_jobs=-1),
            X[[col]], y, cv=3, scoring="roc_auc",
        ).mean()
        solo.append({"feature": col, "solo_auc": round(float(auc), 4)})
    solo_df = pd.DataFrame(solo).sort_values("solo_auc", ascending=False)
    solo_df.to_csv(REPORTS / "solo_feature_auc.csv", index=False)
    print("top solo-feature AUC (leakage screen):")
    print(solo_df.head(6).to_string(index=False))

    leaky = solo_df[solo_df["solo_auc"] >= LEAKAGE_AUC_LIMIT]
    if not leaky.empty:
        print(f"\nLEAKAGE WARNING: {leaky['feature'].tolist()} exceed {LEAKAGE_AUC_LIMIT} solo AUC")
    else:
        print(f"\nno single feature reaches {LEAKAGE_AUC_LIMIT} solo AUC - no obvious leakage\n")

    # ---- hold-out split -----------------------------------------------------
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.20, stratify=y, random_state=RANDOM_STATE
    )

    rf = RandomForestClassifier(
        n_estimators=500,
        class_weight="balanced",
        oob_score=True,
        n_jobs=-1,
        random_state=RANDOM_STATE,
    )
    rf.fit(X_train, y_train)

    y_pred = rf.predict(X_test)
    y_proba = rf.predict_proba(X_test)[:, list(rf.classes_).index(1)]

    print("held-out classification report (threshold 0.5):")
    print(classification_report(y_test, y_pred, target_names=["normal", "anomalous"], digits=4))

    roc = float(roc_auc_score(y_test, y_proba))
    pr = float(average_precision_score(y_test, y_proba))
    print(f"ROC-AUC: {roc:.4f}   PR-AUC: {pr:.4f}   OOB: {rf.oob_score_:.4f}\n")

    # ---- 5-fold stratified CV ----------------------------------------------
    scoring = ["accuracy", "precision_macro", "recall_macro", "f1_macro", "roc_auc"]
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    cv = cross_validate(rf, X, y, cv=skf, scoring=scoring, n_jobs=-1)
    cv_table = pd.DataFrame({
        "metric": scoring,
        "mean": [round(float(cv[f"test_{m}"].mean()), 4) for m in scoring],
        "std": [round(float(cv[f"test_{m}"].std()), 4) for m in scoring],
    })
    cv_table.to_csv(REPORTS / "cv_metrics.csv", index=False)
    print("5-fold stratified cross-validation:")
    print(cv_table.to_string(index=False))

    # ---- baseline comparison ------------------------------------------------
    models = {
        "Logistic Regression": make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=2000, class_weight="balanced")
        ),
        "Decision Tree": DecisionTreeClassifier(class_weight="balanced", random_state=RANDOM_STATE),
        "Naive Bayes": GaussianNB(),
        "Random Forest": rf,
    }
    rows = []
    for name, m in models.items():
        r = cross_validate(m, X_train, y_train, cv=5, scoring="f1_macro", n_jobs=-1)
        rows.append({
            "model": name,
            "f1_macro_mean": round(float(r["test_score"].mean()), 4),
            "f1_macro_std": round(float(r["test_score"].std()), 4),
        })
    compare = pd.DataFrame(rows).sort_values("f1_macro_mean", ascending=False)
    compare.to_csv(REPORTS / "baseline_comparison.csv", index=False)
    print("\nbaseline comparison (5-fold f1_macro on train):")
    print(compare.to_string(index=False))

    # ---- calibration --------------------------------------------------------
    cal = CalibratedClassifierCV(estimator=rf, method="isotonic", cv=3)
    cal.fit(X_train, y_train)
    p_cal = cal.predict_proba(X_test)[:, 1]
    brier_raw = float(brier_score_loss(y_test, y_proba))
    brier_cal = float(brier_score_loss(y_test, p_cal))
    print(f"\nBrier raw: {brier_raw:.4f}   calibrated: {brier_cal:.4f}")

    # ---- threshold analysis -------------------------------------------------
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
    print("\nthreshold analysis (calibrated probabilities):")
    print(thr_df.to_string(index=False))

    op = next(r for r in thresholds if r["threshold"] == OPERATING_THRESHOLD)

    # ---- per-archetype recall at the operating threshold --------------------
    test_idx = X_test.index
    arch = df.loc[test_idx, "archetype"]
    flagged = (p_cal >= OPERATING_THRESHOLD).astype(int)
    per_arch = (
        pd.DataFrame({"archetype": arch.values, "label": y_test.values, "flagged": flagged})
        .query("label == 1")
        .groupby("archetype")
        .agg(n=("label", "size"), detected=("flagged", "sum"))
    )
    per_arch["recall"] = (per_arch["detected"] / per_arch["n"]).round(4)
    per_arch.to_csv(REPORTS / "per_archetype_recall.csv")
    print(f"\nper-archetype recall at threshold {OPERATING_THRESHOLD}:")
    print(per_arch.to_string())

    # ---- plots --------------------------------------------------------------
    ConfusionMatrixDisplay.from_predictions(
        y_test, (p_cal >= OPERATING_THRESHOLD).astype(int),
        cmap="Blues", display_labels=["normal", "anomalous"],
    )
    plt.title(f"Behavioural anomaly - confusion matrix (threshold {OPERATING_THRESHOLD})")
    plt.tight_layout()
    plt.savefig(REPORTS / "confusion_matrix.png", dpi=150)
    plt.close()

    imp = pd.Series(rf.feature_importances_, index=FEATURE_NAMES).sort_values()
    imp.plot(kind="barh", figsize=(8, 7), title="Feature importance - behavioural anomaly model")
    plt.tight_layout()
    plt.savefig(REPORTS / "feature_importance.png", dpi=150)
    plt.close()
    imp.sort_values(ascending=False).round(4).to_csv(REPORTS / "feature_importance.csv", header=["importance"])

    CalibrationDisplay.from_predictions(y_test, y_proba, n_bins=12, name="raw")
    CalibrationDisplay.from_predictions(y_test, p_cal, n_bins=12, name="calibrated")
    plt.title("Calibration curve - behavioural anomaly model")
    plt.tight_layout()
    plt.savefig(REPORTS / "calibration_curve.png", dpi=150)
    plt.close()

    # ---- persist ------------------------------------------------------------
    joblib.dump(cal, MODEL_DIR / "runa_behavioral_rf.joblib", compress=3)

    metrics = {
        "dataset": {
            "sessions": int(len(df)),
            "features": len(FEATURE_NAMES),
            "anomalous": int(y.sum()),
            "anomaly_rate": round(float(y.mean()), 4),
            "source": "simulated (see simulate.py) - not real-world detection accuracy",
        },
        # All reported thresholds use calibrated probabilities so the rows are
        # directly comparable. The uncalibrated argmax is kept separately for
        # reference rather than mixed into the same table.
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
        "max_solo_feature_auc": round(float(solo_df["solo_auc"].max()), 4),
        "leakage_screen_passed": bool(solo_df["solo_auc"].max() < LEAKAGE_AUC_LIMIT),
        "operating_threshold": OPERATING_THRESHOLD,
        "random_state": RANDOM_STATE,
    }
    (REPORTS / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(f"\nartifacts written to {REPORTS}")
    print(f"model saved to {MODEL_DIR / 'runa_behavioral_rf.joblib'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
