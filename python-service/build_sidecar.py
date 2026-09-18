"""
build_sidecar.py

Builds the standalone security sidecar with both ML models bundled, as a
directory build copied to python-service/service/ (entry point
service/service.exe), where electron-builder's extraResources picks it up.

    python python-service/build_sidecar.py

Why the non-obvious flags matter:

  --collect-submodules sklearn
      The models are unpickled at runtime. Pickles reference scikit-learn
      internals (sklearn.calibration, sklearn.ensemble._forest,
      sklearn.tree._classes, ...) by module path, which PyInstaller's static
      import analysis cannot see. Without this flag the frozen executable
      starts normally and then fails the moment it loads a model.

  --add-data <model>;<dest>
      Bundles the .joblib files INSIDE service.exe. They are resolved at
      runtime from sys._MEIPASS, so the packaged app cannot ship without its
      models - there is no separate file to forget.

  --paths <repo root>
      Makes the ml package importable so service.py uses the SAME
      ml/*/features.py modules as training. Served features cannot drift.

Prerequisites: the deployment models must exist. Regenerate them with:

    python ml/behavioral/simulate.py && python ml/behavioral/train_evaluate.py
    python ml/url/build_dataset.py && python ml/url/train_evaluate.py
    python ml/url/export_deploy_model.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

EXCLUDE = [
    "matplotlib", "tkinter", "IPython", "jupyter", "notebook",
    "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6", "sklearn.tests",
]

MODELS = [
    (ROOT / "ml" / "url" / "model" / "runa_url_rf_deploy.joblib", "ml/url/model"),
    (ROOT / "ml" / "behavioral" / "model" / "runa_behavioral_rf.joblib", "ml/behavioral/model"),
]


VENV = HERE / ".venv-sidecar"
REQUIREMENTS = HERE / "requirements-sidecar.txt"


def build_python() -> Path:
    """
    Returns the interpreter of an isolated build environment, creating it if
    needed. Building from the global interpreter bundles whatever else happens
    to be installed there - on the development machine that was PyTorch,
    OpenCV and Transformers (~530 MB) reached through scikit-learn's optional
    imports.
    """
    py = VENV / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
    if not py.exists():
        print(f"creating isolated build environment at {VENV} ...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    print("installing pinned sidecar dependencies ...")
    subprocess.run([str(py), "-m", "pip", "install", "--quiet", "--upgrade", "pip"], check=True)
    subprocess.run([str(py), "-m", "pip", "install", "--quiet", "-r", str(REQUIREMENTS)], check=True)
    return py


def main() -> int:
    missing = [str(src) for src, _ in MODELS if not src.exists()]
    if missing:
        print("missing model files - regenerate them first (see module docstring):")
        for m in missing:
            print("  ", m)
        return 1

    py = build_python()

    cmd = [
        str(py), "-m", "PyInstaller",
        # --onedir, not --onefile: a one-file build self-extracts its entire
        # payload to %TEMP% on EVERY launch (measured: 18 s for 390 MB), and
        # inside electron-builder's portable wrapper that extraction happens a
        # second time. A directory build starts directly.
        "--onedir", "--name", "service", "--noconfirm", "--clean",
        "--paths", str(ROOT),
        "--hidden-import", "ml.url.features",
        "--hidden-import", "ml.behavioral.features",
        "--collect-submodules", "sklearn",
    ]
    # Pulled in transitively by scikit-learn's plotting helpers and test
    # utilities; never used when scoring.
    for mod in EXCLUDE:
        cmd += ["--exclude-module", mod]
    for src, dest in MODELS:
        cmd += ["--add-data", f"{src}{os.pathsep}{dest}"]
    cmd.append(str(HERE / "service.py"))

    print("running PyInstaller ...")
    result = subprocess.run(cmd, cwd=HERE)
    if result.returncode != 0:
        print(f"PyInstaller failed with exit code {result.returncode}")
        return result.returncode

    built = HERE / "dist" / "service"
    target = HERE / "service"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(built, target)

    size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
    print(f"\nbuilt  {built}")
    print(f"copied {target}  ({size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
