"""
features.py

Lexical feature extraction for URL threat classification.

Shared by training and (planned) runtime scoring at /analyze-url, so served
features cannot drift from trained features. Everything here is computable
from the URL string alone - no page fetch, no network - which is what the
runtime path can actually do when a student requests a site.

HOST-ONLY BY DESIGN
-------------------
The PhiUSIIL corpus harvests its legitimate class as normalised homepage
roots (https://www.domain.tld, no path, no trailing slash) while its phishing
class contains raw captures. Measured on the raw corpus:

    starts "https://www."   legitimate 100.0%   phishing  2.4%
    has path beyond host    legitimate   0.0%   phishing 28.4%
    ends with "/"           legitimate   0.0%   phishing 36.5%

A model given scheme or path features therefore learns which collection
pipeline produced the row, not whether the URL is malicious. That artifact
cannot be repaired by reweighting - legitimate rows simply have no paths to
learn from - so it is removed by construction: the scheme, any leading
"www.", and everything after the host are discarded, and only host-derived
features are used. This costs real signal (paths are genuinely informative
in deployment) and that trade-off is stated as a limitation rather than
hidden.
"""

from __future__ import annotations

import math
import re
from urllib.parse import urlsplit

FEATURE_NAMES = [
    "host_length",
    "num_labels",
    "num_dots",
    "num_hyphens",
    "num_digits",
    "digit_ratio",
    "vowel_ratio",
    "max_consonant_run",
    "longest_label_length",
    "mean_label_length",
    "host_entropy",
    "tld_length",
    "is_common_tld",
    "has_ip_literal",
    "is_punycode",
    "has_port",
    "has_suspicious_token",
    "sld_length",
    "sld_digit_ratio",
    "has_hyphen_in_sld",
]

_COMMON_TLDS = {
    "com", "org", "net", "edu", "gov", "int", "mil", "info", "biz",
    "uk", "de", "fr", "jp", "au", "ca", "nl", "it", "es", "se", "ch",
    "ph", "sg", "in", "br", "ru", "cn", "kr", "mx", "pl", "be", "at",
}

# Tokens that recur in credential-harvesting hostnames. Kept generic and
# structural rather than brand-specific, so this is not a blocklist.
_SUSPICIOUS = (
    "login", "signin", "secure", "account", "verify", "update", "confirm",
    "webscr", "banking", "auth", "wallet", "recover", "unlock", "billing",
)

_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_VOWELS = set("aeiou")


def normalise_host(raw_url: str) -> str:
    """
    Reduce a URL to a bare hostname, discarding the collection artifacts
    described above (scheme, leading 'www.', path, query, fragment).
    """
    u = (raw_url or "").strip()
    if "://" not in u:
        u = "http://" + u  # urlsplit needs a scheme to find the netloc
    host = urlsplit(u).netloc.lower()
    if "@" in host:  # strip any userinfo
        host = host.rsplit("@", 1)[1]
    if host.startswith("www."):
        host = host[4:]
    return host


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _max_consonant_run(s: str) -> int:
    best = run = 0
    for ch in s:
        if ch.isalpha() and ch not in _VOWELS:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


def extract_features(raw_url: str) -> dict:
    host = normalise_host(raw_url)

    port = ""
    if ":" in host and not host.startswith("["):
        host, _, port = host.partition(":")

    labels = [p for p in host.split(".") if p]
    alpha = [c for c in host if c.isalpha()]
    digits = [c for c in host if c.isdigit()]

    tld = labels[-1] if len(labels) > 1 else ""
    sld = labels[-2] if len(labels) > 2 else (labels[0] if labels else "")
    sld_digits = sum(c.isdigit() for c in sld)

    return {
        "host_length": len(host),
        "num_labels": len(labels),
        "num_dots": host.count("."),
        "num_hyphens": host.count("-"),
        "num_digits": len(digits),
        "digit_ratio": len(digits) / len(host) if host else 0.0,
        "vowel_ratio": (sum(c in _VOWELS for c in alpha) / len(alpha)) if alpha else 0.0,
        "max_consonant_run": _max_consonant_run(host),
        "longest_label_length": max((len(p) for p in labels), default=0),
        "mean_label_length": (sum(len(p) for p in labels) / len(labels)) if labels else 0.0,
        "host_entropy": _entropy(host),
        "tld_length": len(tld),
        "is_common_tld": int(tld in _COMMON_TLDS),
        "has_ip_literal": int(bool(_IPV4.match(host))),
        "is_punycode": int("xn--" in host),
        "has_port": int(bool(port)),
        "has_suspicious_token": int(any(t in host for t in _SUSPICIOUS)),
        "sld_length": len(sld),
        "sld_digit_ratio": (sld_digits / len(sld)) if sld else 0.0,
        "has_hyphen_in_sld": int("-" in sld),
    }
