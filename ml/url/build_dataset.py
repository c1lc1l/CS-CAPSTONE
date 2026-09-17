"""
build_dataset.py

Builds the URL threat classification dataset from the PhiUSIIL Phishing URL
corpus (UCI id=967, 235,795 labelled URLs).

Why this source: community re-uploads of the widely circulated four-class
"malicious URLs" dataset were inspected first and found to carry corrupted
labels - RFC documentation pages, Linux Journal articles and GameFAQs URLs
were all labelled "phishing". PhiUSIIL is published through the UCI
repository with documented label provenance, and spot inspection confirms
its classes are coherent.

Three integrity steps are applied before any model sees the data:

  1. Host normalisation removes the corpus's collection artifact (see
     features.py). Scheme, leading "www." and path are discarded.
  2. Hosts appearing with BOTH labels are dropped as ambiguous rather than
     silently contributing contradictory training signal.
  3. Rows are deduplicated by host, and a registrable-domain group key is
     emitted so the training split can keep all URLs of one domain on the
     same side. Without this, near-identical hosts appear in train and test
     and the model is rewarded for memorising domains.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
from ucimlrepo import fetch_ucirepo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import FEATURE_NAMES, extract_features, normalise_host  # noqa: E402

# Suffixes where the registrable domain needs three labels, not two.
_TWO_PART_SUFFIXES = {
    "co.uk", "ac.uk", "org.uk", "gov.uk", "co.jp", "com.au", "net.au",
    "org.au", "co.nz", "com.br", "com.ph", "edu.ph", "gov.ph", "co.za",
    "com.sg", "com.mx", "co.in", "co.kr", "com.tr", "com.cn",
}


def registrable_domain(host: str) -> str:
    labels = [p for p in host.split(".") if p]
    if len(labels) < 2:
        return host
    if ".".join(labels[-2:]) in _TWO_PART_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def main() -> int:
    out_dir = Path(__file__).resolve().parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    print("fetching PhiUSIIL (UCI id=967) ...")
    ds = fetch_ucirepo(id=967)
    df = pd.DataFrame(
        {"url": ds.data.features["URL"], "label_raw": ds.data.targets.iloc[:, 0]}
    )
    # PhiUSIIL encodes 1 = legitimate, 0 = phishing. Flip so the positive
    # class is the threat, matching how precision/recall are reported.
    df["label"] = (df["label_raw"] == 0).astype(int)
    print(f"  raw rows: {len(df)}  (phishing={int(df.label.sum())}, legitimate={int((1-df.label).sum())})")

    df["host"] = df["url"].map(normalise_host)
    df = df[df["host"].str.len() > 0]

    conflicting = df.groupby("host")["label"].nunique()
    conflicting = set(conflicting[conflicting > 1].index)
    if conflicting:
        df = df[~df["host"].isin(conflicting)]
        print(f"  dropped {len(conflicting)} hosts carrying both labels (ambiguous)")

    before = len(df)
    df = df.drop_duplicates(subset="host", keep="first")
    print(f"  deduplicated by host: {before} -> {len(df)}")

    df["group"] = df["host"].map(registrable_domain)
    print(f"  registrable domains: {df['group'].nunique()}")

    feats = pd.DataFrame([extract_features(h) for h in df["host"]], index=df.index)
    out = pd.concat([feats[FEATURE_NAMES], df[["label", "group", "host"]]], axis=1)

    path = out_dir / "urls.csv"
    out.to_csv(path, index=False)
    print(f"\nwrote {path}")
    print(f"  rows: {len(out)}  features: {len(FEATURE_NAMES)}")
    print(f"  phishing: {int(out.label.sum())} ({out.label.mean():.1%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
