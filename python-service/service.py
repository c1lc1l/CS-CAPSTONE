"""
service.py  –  PCU Lab Portal Security & AI Microservice
=========================================================
Runs as a local HTTP server (localhost:5001).
Electron spawns this via child_process.spawn.

Endpoints
─────────
  POST /scan-file     → ClamAV file scan
  GET  /usb-list
  POST /scan-usb      → USB device enumeration + scan
  POST /analyze-url   → URL reputation check
  POST /enforcement/chrome-policy-check → Recent Chrome visits vs blocklist (Windows, best-effort)
  POST /enforcement/usb-mount-scan      → Shallow scan of removable drive roots (EICAR heuristic)
  POST /ai-task       → Lambda Function URL proxy
  GET  /health        → liveness check

Install dependencies:
  pip install flask python-clamd requests pyusb

Run standalone:
  FLASK_PORT=5001 python service.py
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import requests  # pyright: ignore[reportMissingImports]
from flask import Flask, jsonify, request

from enforcement.chrome_history import check_blocked_chrome_visits
from enforcement.usb_mount_scan import scan_removable_mounts

# Optional: install python-clamd for real ClamAV support
try:
    import clamd  # pyright: ignore[reportMissingImports]
    CLAMD_AVAILABLE = True
except ImportError:
    CLAMD_AVAILABLE = False

# Optional: install usb-monitor for real USB hooks
try:
    import usb.core  # pyright: ignore[reportMissingImports]  # pyusb
    import usb.backend.libusb1  # pyright: ignore[reportMissingImports]
    USB_AVAILABLE = True
except ImportError:
    USB_AVAILABLE = False

try:
    import libusb_package  # pyright: ignore[reportMissingImports]
except ImportError:
    libusb_package = None

# ─────────────────────────────────────────────
#  Configuration
# ─────────────────────────────────────────────
env_file = Path(__file__).parent / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())

PORT = int(os.environ.get("FLASK_PORT", 5001))
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
# Paste your deployed Lambda Function URL below.
AI_LAMBDA_URL = "https://7bid3jnr6woju6wnlhufbfw34q0cdnbr.lambda-url.ap-southeast-1.on.aws/"
MAX_AI_PROMPT_CHARS = 8_000
MAX_HISTORY_TURNS = 24
MAX_GROQ_TOKENS = 2_048
LAMBDA_TIMEOUT_SEC = 20

logging.basicConfig(level=logging.INFO, format="[service] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

# EICAR standard test string (embedded in many AV test files)
EICAR_MARKER = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"

AI_OFFLINE_FALLBACK = (
    "The AI sidecar is running, but the cloud AI provider could not be reached from this machine "
    "(missing Lambda URL, network policy, or provider access). This is a labeled offline response — "
    "your message was still received. For the thesis demo, configure AI_LAMBDA_URL "
    "or continue using keyword-based stubs in the UI."
)


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _normalize_url(raw: str) -> tuple[str, str]:
    candidate = str(raw or "").strip()
    if not candidate:
        return "", ""
    if not re.match(r"^[a-z][a-z0-9+.-]*://", candidate, flags=re.I):
        candidate = f"https://{candidate}"
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return candidate, host


def _enumerate_usb_devices() -> list[dict]:
    devices: list[dict] = []
    if USB_AVAILABLE:
        backend = _get_usb_backend()
        if backend is None:
            return [
                {
                    "vendor_id": "0x0000",
                    "product_id": "0x0000",
                    "manufacturer": "Stub",
                    "product": "USB backend unavailable — install libusb backend/driver for live USB",
                }
            ]
        try:
            for dev in usb.core.find(find_all=True, backend=backend):
                devices.append(
                    {
                        "vendor_id": hex(dev.idVendor),
                        "product_id": hex(dev.idProduct),
                        "manufacturer": dev.manufacturer if hasattr(dev, "manufacturer") else None,
                        "product": dev.product if hasattr(dev, "product") else None,
                    }
                )
        except Exception as e:
            log.warning("USB enumeration fallback (%s)", e)
            devices = [
                {
                    "vendor_id": "0x0000",
                    "product_id": "0x0000",
                    "manufacturer": "Stub",
                    "product": "USB enumeration fallback active",
                }
            ]
    else:
        log.warning("pyusb not installed – returning stub USB list")
        devices = [
            {
                "vendor_id": "0x0000",
                "product_id": "0x0000",
                "manufacturer": "Stub",
                "product": "No pyusb — install pyusb for live USB",
            }
        ]
    return devices


# ─────────────────────────────────────────────
#  AWS clients (lazy-init so startup is fast)
# ─────────────────────────────────────────────
_usb_backend = None
_usb_backend_checked = False
_usb_backend_warned = False


def _get_usb_backend():
    """Resolve and cache pyusb backend once (Windows-friendly)."""
    global _usb_backend, _usb_backend_checked, _usb_backend_warned
    if _usb_backend_checked:
        return _usb_backend
    _usb_backend_checked = True
    if not USB_AVAILABLE:
        return None
    try:
        if libusb_package is not None:
            backend = usb.backend.libusb1.get_backend(
                find_library=lambda _name: libusb_package.find_library()
            )
        else:
            backend = usb.backend.libusb1.get_backend()
        _usb_backend = backend
        if backend is None and not _usb_backend_warned:
            log.warning("USB backend unavailable — using stub USB list")
            _usb_backend_warned = True
        return _usb_backend
    except Exception as e:
        if not _usb_backend_warned:
            log.warning("USB backend init failed (%s) — using stub USB list", e)
            _usb_backend_warned = True
        return None


# ─────────────────────────────────────────────
#  Health
# ─────────────────────────────────────────────
def _clamd_definitions_status() -> dict:
    """Best-effort ClamAV signature/version readout. Never raises."""
    if not CLAMD_AVAILABLE:
        return {"engine": "stub", "definitions": None, "detail": "ClamAV not installed on this host — running EICAR-only stub scanner"}
    try:
        cd = clamd.ClamdUnixSocket()
        version_line = cd.version()  # e.g. "ClamAV 1.4.1/27500/Mon Jan  5 08:12:00 2026"
        parts = version_line.split("/")
        return {
            "engine": "clamd",
            "definitions": parts[1] if len(parts) > 1 else None,
            "detail": version_line,
        }
    except Exception as e:
        return {"engine": "clamd", "definitions": None, "detail": f"clamd unreachable: {e}"}


@app.get("/health")
def health():
    backend = _get_usb_backend() if USB_AVAILABLE else None
    return jsonify(
        status="ok",
        clamd=CLAMD_AVAILABLE,
        usb=USB_AVAILABLE,
        usbBackendReady=backend is not None,
        lambdaConfigured=bool(AI_LAMBDA_URL),
        definitionsStatus=_clamd_definitions_status(),
        timestamp=time.time(),
    )


# ─────────────────────────────────────────────
#  /scan-file  – ClamAV malware scanning
# ─────────────────────────────────────────────
@app.post("/scan-file")
def scan_file():
    body = request.get_json(force=True)
    file_path: str = body.get("path", "")
    p = Path(file_path)

    if not file_path or not p.is_file():
        return jsonify(ok=False, error="File not found"), 400

    try:
        with p.open("rb") as f:
            head = f.read(65536)
    except OSError as e:
        return jsonify(ok=False, error=str(e)), 400

    if EICAR_MARKER in head:
        sha256 = _sha256_file(p)
        log.info("scan-file EICAR test signature detected: %s", file_path)
        return jsonify(
            ok=True,
            clean=False,
            threat="EICAR-TEST-SIGNATURE",
            sha256=sha256,
            engine="builtin-eicar",
        )

    sha256 = _sha256_file(p)

    if CLAMD_AVAILABLE:
        try:
            cd = clamd.ClamdUnixSocket()  # or ClamdNetworkSocket("127.0.0.1", 3310)
            result = cd.scan(file_path)
            status = result.get(file_path, ("OK", ""))[0]
            threat = result.get(file_path, ("OK", ""))[1]
            clean = status == "OK"
        except Exception as e:
            log.error("ClamAV error: %s", e)
            clean, threat = True, None  # fallback: allow
    else:
        clean, threat = True, None
        log.warning("ClamAV not installed – returning stub result (file hashed)")

    log.info("scan-file %s → clean=%s", file_path, clean)
    return jsonify(ok=True, clean=clean, threat=threat, sha256=sha256, engine="clamd" if CLAMD_AVAILABLE else "stub")


# ─────────────────────────────────────────────
#  /usb-list (GET) + /scan-usb (POST) – USB enumeration
# ─────────────────────────────────────────────
@app.get("/usb-list")
def usb_list():
    devices = _enumerate_usb_devices()
    return jsonify(ok=True, devices=devices, count=len(devices))


@app.post("/scan-usb")
def scan_usb():
    devices = _enumerate_usb_devices()
    return jsonify(ok=True, devices=devices, count=len(devices))


# ─────────────────────────────────────────────
#  /analyze-url  – URL reputation (stub → extend with VirusTotal/GuardDuty)
# ─────────────────────────────────────────────
@app.post("/analyze-url")
def analyze_url():
    body = request.get_json(force=True)
    url: str = body.get("url", "")
    if not url:
        return jsonify(ok=False, error="url required"), 400

    normalized, domain = _normalize_url(url)
    if not domain:
        return jsonify(ok=False, error="invalid url"), 400

    blocked_keywords = ["malware", "phishing", "hack", "crack", "keygen", "trojan", "ransom"]
    text = f"{normalized} {domain}".lower()
    suspicious = any(kw in text for kw in blocked_keywords)
    score = 0.9 if suspicious else 0.1

    return jsonify(ok=True, url=normalized, domain=domain, suspicious=suspicious, score=score)


# ─────────────────────────────────────────────
#  /enforcement/* – host-level policy probes (.student runtime; Windows-oriented)
# ─────────────────────────────────────────────
@app.post("/enforcement/chrome-policy-check")
def enforcement_chrome_policy_check():
    """Recent Chrome visits vs blocked domain list (copy SQLite History, best-effort)."""
    body = request.get_json(force=True, silent=True) or {}
    raw_list = body.get("blockedDomains") or body.get("blocked_domains") or []
    if not isinstance(raw_list, list):
        return jsonify(ok=False, error="blockedDomains must be an array"), 400
    domains = [str(d).strip() for d in raw_list if str(d).strip()]
    result = check_blocked_chrome_visits(domains)
    return jsonify(ok=result.get("ok", True), **{k: v for k, v in result.items() if k != "ok"})


@app.post("/enforcement/usb-mount-scan")
def enforcement_usb_mount_scan():
    """Quick scan of removable drive roots (EICAR / shallow file read)."""
    _ = request.get_json(force=True, silent=True) or {}
    report = scan_removable_mounts()
    return jsonify(ok=True, report=report)


# ─────────────────────────────────────────────
#  /ai-task  – Groq (legacy history format compatibility)
# ─────────────────────────────────────────────
@app.post("/ai-task")
def ai_task():
    body = request.get_json(force=True)
    prompt: str = body.get("prompt", "")
    system_override: str = body.get("system", "")
    max_tokens: int = body.get("maxTokens", body.get("max_tokens", 1024))
    role: str = body.get("role", "student")
    tools = body.get("tools") or []
    history = body.get("history") or []
    temperature: float = body.get("temperature", 0.3)
    use_knowledge_base = body.get("useKnowledgeBase", True)
    if isinstance(use_knowledge_base, str):
        use_knowledge_base = use_knowledge_base.lower() in ("1", "true", "yes")
    kb_top_k = body.get("kbTopK", 5)
    try:
        kb_top_k = int(kb_top_k)
    except Exception:
        kb_top_k = 5
    kb_top_k = max(1, min(kb_top_k, 12))

    if not prompt:
        return jsonify(ok=False, error="prompt required"), 400
    if len(prompt) > MAX_AI_PROMPT_CHARS:
        return jsonify(ok=False, error=f"prompt too large (>{MAX_AI_PROMPT_CHARS} chars)"), 400

    if not AI_LAMBDA_URL or "REPLACE_AI_LAMBDA_URL" in AI_LAMBDA_URL:
        return jsonify(
            ok=True,
            response=AI_OFFLINE_FALLBACK,
            source="local_fallback",
            detail="AI Lambda URL is not configured in python-service/service.py.",
            ragCitations=[],
            ragUsed=False,
        )

    role = "admin" if role == "admin" else "student"
    try:
        max_tokens = int(max_tokens)
    except Exception:
        max_tokens = 1024
    max_tokens = max(64, min(max_tokens, MAX_GROQ_TOKENS))
    try:
        temperature = float(temperature)
    except Exception:
        temperature = 0.3
    temperature = max(0.0, min(temperature, 1.0))

    if not system_override:
        system_override = (
            "You are Runa, a bounded assistant for CS students in the PCU lab."
            if role == "student"
            else "You are Runa, a bounded operational assistant for PCU lab administrators."
        )

    tool_hint = ""
    if isinstance(tools, list) and tools:
        tool_hint = f"\n\nTool ids for this session: {', '.join(str(t) for t in tools)}."

    full_system = f"{system_override}{tool_hint}\nrole: {role}."

    messages = []
    groq_messages = [{"role": "system", "content": full_system}]
    turns = history[-MAX_HISTORY_TURNS:] if isinstance(history, list) else []
    for h in turns:
        if isinstance(h, dict) and h.get("role") in ("user", "assistant"):
            content = h.get("content", [])
            if isinstance(content, str):
                content = [{"text": content}]
            if isinstance(content, list):
                messages.append({"role": h["role"], "content": content})
                normalized = " ".join(
                    block.get("text", "").strip()
                    for block in content
                    if isinstance(block, dict) and isinstance(block.get("text"), str)
                ).strip()
                if normalized:
                    groq_messages.append({"role": h["role"], "content": normalized})
    messages.append({"role": "user", "content": [{"text": prompt}]})
    groq_messages.append({"role": "user", "content": prompt})

    try:
        lambda_payload = {
            "prompt": prompt,
            "system": system_override,
            "role": role,
            "tools": tools,
            "history": history,
            "maxTokens": max_tokens,
            "temperature": temperature,
            "useKnowledgeBase": use_knowledge_base,
            "kbTopK": kb_top_k,
        }
        headers = {"Content-Type": "application/json"}
        res = requests.post(
            AI_LAMBDA_URL,
            json=lambda_payload,
            headers=headers,
            timeout=LAMBDA_TIMEOUT_SEC,
        )
        if res.status_code >= 400:
            raise RuntimeError(f"lambda_status_{res.status_code}: {res.text[:240]}")
        body = res.json() if res.content else {}

        text = str(body.get("response", "")).strip()
        if not text and isinstance(body.get("body"), dict):
            nested = body.get("body", {})
            text = str(nested.get("response", "")).strip()
            body = nested
        if not text:
            text = "No response content from Lambda provider."

        input_tokens = int(body.get("inputTokens", 0) or 0)
        output_tokens = int(body.get("outputTokens", 0) or 0)
        total_tokens = int(body.get("totalTokens", input_tokens + output_tokens) or 0)
        updated_history = body.get("updatedHistory")
        if not isinstance(updated_history, list):
            updated_history = messages + [{"role": "assistant", "content": [{"text": text}]}]

        rag_citations = body.get("ragCitations")
        if not isinstance(rag_citations, list):
            rag_citations = []
        rag_used = bool(body.get("ragUsed"))

        log.info("ai-task completed (%d chars) via provider=lambda url=%s", len(text), AI_LAMBDA_URL)
        return jsonify(
            ok=True,
            response=text,
            source="lambda",
            model=body.get("model", "lambda"),
            inputTokens=input_tokens,
            outputTokens=output_tokens,
            totalTokens=total_tokens,
            updatedHistory=updated_history,
            ragCitations=rag_citations,
            ragUsed=rag_used,
        )
    except Exception as e:
        log.error("Lambda AI error: %s", e)
        return jsonify(
            ok=True,
            response=AI_OFFLINE_FALLBACK,
            source="local_fallback",
            detail=f"lambda_error: {str(e)[:360]}",
            ragCitations=[],
            ragUsed=False,
        )


# ─────────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    log.info("PCU Lab Portal service starting on port %d", PORT)
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
