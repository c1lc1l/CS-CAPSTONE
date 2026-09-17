import json
import logging
import os
import re
from urllib import error, parse, request

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
DEMO_SHARED_TOKEN = os.environ.get("DEMO_SHARED_TOKEN", "").strip()
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
MAX_HISTORY_TURNS = 24
MAX_TOOL_SPECS = 16
MAX_TOOL_CALLS = 4

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
KB_TABLE = os.environ.get("RUNA_KB_TABLE", "runa_knowledge_chunks").strip()
KB_TOP_K = max(1, min(int(os.environ.get("RUNA_KB_TOP_K", "5")), 12))
KB_MAX_CHUNK = max(200, min(int(os.environ.get("RUNA_KB_MAX_CHUNK_CHARS", "900")), 4000))

logging.basicConfig(level=logging.INFO, format="[runa-ai-task] %(message)s")
log = logging.getLogger(__name__)


def _resp(status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type,x-api-key",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(body),
    }


def _kb_supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }


def _kb_fetch_chunks(invoke_role: str) -> list[dict]:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return []
    or_vis = (
        "or=(visibility.eq.both,visibility.eq.student)"
        if invoke_role == "student"
        else "or=(visibility.eq.both,visibility.eq.admin)"
    )
    q = f"select=id,source,title,content&limit=800&{or_vis}"
    url = f"{SUPABASE_URL}/rest/v1/{KB_TABLE}?{q}"
    try:
        req = request.Request(url, method="GET", headers=_kb_supabase_headers())
        with request.urlopen(req, timeout=12) as res:
            raw = res.read().decode("utf-8")
            data = json.loads(raw) if raw else []
            return data if isinstance(data, list) else []
    except Exception as exc:
        log.warning("kb_fetch_failed: %s", str(exc)[:200])
        return []


def _kb_tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _kb_score(query: str, chunk_text: str) -> float:
    q = _kb_tokenize(query)
    c = _kb_tokenize(chunk_text)
    if not q or not c:
        return 0.0
    return float(len(q & c)) / (len(q) ** 0.5 + 0.01)


def _kb_select(prompt: str, chunks: list[dict], top_k: int) -> tuple[list[dict], list[dict]]:
    scored: list[tuple[float, dict]] = []
    for row in chunks:
        if not isinstance(row, dict):
            continue
        cid = row.get("id")
        body = str(row.get("content") or "")
        if not body or cid is None:
            continue
        bag = body + " " + str(row.get("title") or "") + " " + str(row.get("source") or "")
        scored.append((_kb_score(prompt, bag), row))
    scored.sort(key=lambda x: x[0], reverse=True)
    picked: list[dict] = []
    cites: list[dict] = []
    filled = 0
    for score, row in scored:
        if filled >= top_k:
            break
        if score <= 0 and filled >= 1:
            break
        body = str(row.get("content") or "")
        if len(body) > KB_MAX_CHUNK:
            body = body[: KB_MAX_CHUNK - 20] + "\n… (truncated)"
        picked.append(
            {
                "id": row.get("id"),
                "source": row.get("source"),
                "title": row.get("title"),
                "content": body,
            }
        )
        cites.append(
            {
                "id": row.get("id"),
                "source": row.get("source"),
                "title": row.get("title"),
                "score": round(score, 4),
            }
        )
        filled += 1
    if not picked and scored:
        row = scored[0][1]
        body = str(row.get("content") or "")[:KB_MAX_CHUNK]
        picked.append({"id": row.get("id"), "source": row.get("source"), "title": row.get("title"), "content": body})
        cites.append({"id": row.get("id"), "source": row.get("source"), "title": row.get("title"), "score": 0.0})
    return picked, cites


def _kb_context_block(chunks: list[dict]) -> str:
    lines = [
        "Knowledge base excerpts (RUNA). When you use a fact from a chunk, cite it as [KB:<id>]. "
        "If nothing matches the user's question, say the KB has no matching entry and answer with general safe guidance."
    ]
    for ch in chunks:
        cid = ch.get("id")
        title = str(ch.get("title") or "").strip()
        src = str(ch.get("source") or "").strip()
        body = str(ch.get("content") or "").strip()
        header = f"[KB:{cid}]"
        if title:
            header += f" {title}"
        if src:
            header += f" (source: {src})"
        lines.append(header)
        lines.append(body)
        lines.append("---")
    return "\n".join(lines)


def _normalize_tool_calls(raw):
    """
    Normalize provider tool_calls into a compact, client-safe shape.
    Arguments arrive as a JSON string; invalid JSON is dropped rather than
    forwarded, so the client never receives a half-formed action payload.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:MAX_TOOL_CALLS]:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") or {}
        name = str(fn.get("name") or "").strip()
        if not name:
            continue
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args) if args.strip() else {}
            except json.JSONDecodeError:
                log.warning("tool_call_bad_arguments name=%s", name)
                continue
        if not isinstance(args, dict):
            args = {}
        out.append({"name": name, "arguments": args})
    return out


def _normalize_history(history):
    messages = []
    turns = history[-MAX_HISTORY_TURNS:] if isinstance(history, list) else []
    for item in turns:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in ("user", "assistant"):
            continue
        content = item.get("content", [])
        if isinstance(content, str):
            normalized = content.strip()
        elif isinstance(content, list):
            normalized = " ".join(
                block.get("text", "").strip()
                for block in content
                if isinstance(block, dict) and isinstance(block.get("text"), str)
            ).strip()
        else:
            normalized = ""
        if normalized:
            messages.append({"role": role, "content": normalized})
    return messages


def lambda_handler(event, _context):
    request_id = getattr(_context, "aws_request_id", "unknown")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    log.info("request_start request_id=%s method=%s", request_id, method)
    if method == "OPTIONS":
        log.info("request_options request_id=%s", request_id)
        return _resp(200, {"ok": True})

    headers = event.get("headers") or {}
    incoming_key = headers.get("x-api-key") or headers.get("X-Api-Key") or ""
    if DEMO_SHARED_TOKEN and incoming_key != DEMO_SHARED_TOKEN:
        log.warning("request_unauthorized request_id=%s", request_id)
        return _resp(401, {"ok": False, "error": "unauthorized"})

    if not GROQ_API_KEY:
        log.error("missing_groq_api_key request_id=%s", request_id)
        return _resp(500, {"ok": False, "error": "missing GROQ_API_KEY"})

    try:
        raw_body = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            import base64

            raw_body = base64.b64decode(raw_body).decode("utf-8")
        body = json.loads(raw_body)
    except Exception:
        log.exception("invalid_json request_id=%s", request_id)
        return _resp(400, {"ok": False, "error": "invalid_json"})

    prompt = str(body.get("prompt", "")).strip()
    role = "admin" if body.get("role") == "admin" else "student"
    system = str(body.get("system", "")).strip()
    tools = body.get("tools") if isinstance(body.get("tools"), list) else []
    tool_specs = body.get("toolSpecs") if isinstance(body.get("toolSpecs"), list) else []
    tool_specs = [t for t in tool_specs if isinstance(t, dict)]
    history = body.get("history") if isinstance(body.get("history"), list) else []
    max_tokens = int(body.get("maxTokens", 1024) or 1024)
    temperature = float(body.get("temperature", 0.3) or 0.3)
    use_knowledge_base = body.get("useKnowledgeBase", True)
    if isinstance(use_knowledge_base, str):
        use_knowledge_base = use_knowledge_base.lower() in ("1", "true", "yes")
    kb_top = int(body.get("kbTopK", KB_TOP_K) or KB_TOP_K)
    kb_top = max(1, min(kb_top, 12))

    if not prompt:
        log.warning("prompt_required request_id=%s", request_id)
        return _resp(400, {"ok": False, "error": "prompt_required"})
    log.info(
        "request_validated request_id=%s role=%s prompt_len=%d history_turns=%d",
        request_id,
        role,
        len(prompt),
        len(history) if isinstance(history, list) else 0,
    )

    if not system:
        system = (
            "You are Runa, a bounded assistant for CS students in the PCU lab."
            if role == "student"
            else "You are Runa, a bounded operational assistant for PCU lab administrators."
        )

    tool_hint = ""
    if tools:
        tool_hint = f"\n\nTool ids for this session: {', '.join(str(t) for t in tools)}."
    full_system = f"{system}{tool_hint}\nrole: {role}."

    rag_citations: list[dict] = []
    if use_knowledge_base:
        rows = _kb_fetch_chunks(role)
        kb_chunks, rag_citations = _kb_select(prompt, rows, kb_top)
        if kb_chunks:
            full_system = full_system + "\n\n" + _kb_context_block(kb_chunks)
            log.info(
                "kb_applied request_id=%s chunks=%d citations=%s",
                request_id,
                len(kb_chunks),
                [c.get("id") for c in rag_citations],
            )
        else:
            log.info("kb_empty request_id=%s", request_id)

    groq_messages = [{"role": "system", "content": full_system}]
    groq_messages.extend(_normalize_history(history))
    groq_messages.append({"role": "user", "content": prompt})

    try:
        payload = {
            "model": GROQ_MODEL,
            "messages": groq_messages,
            "max_tokens": max(64, min(max_tokens, 2048)),
            "temperature": max(0.0, min(temperature, 1.0)),
        }
        # Native provider function-calling. The model may only SELECT a tool;
        # execution and risk classification stay on the client governance path.
        if tool_specs:
            payload["tools"] = tool_specs[:MAX_TOOL_SPECS]
            payload["tool_choice"] = "auto"
        req = request.Request(
            GROQ_URL,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "runa-ai-lambda/1.0",
            },
        )
        try:
            with request.urlopen(req, timeout=20) as res:
                raw = res.read().decode("utf-8")
                data = json.loads(raw) if raw else {}
        except error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")
            response_headers = dict(e.headers.items()) if e.headers else {}
            log.error(
                "groq_http_error request_id=%s status=%s headers=%s detail=%s",
                request_id,
                e.code,
                json.dumps(
                    {
                        "cf-ray": response_headers.get("cf-ray"),
                        "server": response_headers.get("server"),
                        "content-type": response_headers.get("content-type"),
                    }
                ),
                detail[:360],
            )
            raise RuntimeError(f"groq_http_{e.code}: {detail[:360]}")

        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        tool_calls = _normalize_tool_calls(message.get("tool_calls"))
        text = (message.get("content") or "").strip()
        if not text:
            text = (
                "Selected a tool for this request."
                if tool_calls
                else "No response content from model."
            )

        usage = data.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens", 0) or 0)
        output_tokens = int(usage.get("completion_tokens", 0) or 0)
        total_tokens = int(usage.get("total_tokens", input_tokens + output_tokens) or 0)

        updated_history = history + [
            {"role": "user", "content": [{"text": prompt}]},
            {"role": "assistant", "content": [{"text": text}]},
        ]
        log.info(
            "request_success request_id=%s model=%s response_len=%d input_tokens=%d output_tokens=%d",
            request_id,
            GROQ_MODEL,
            len(text),
            input_tokens,
            output_tokens,
        )

        return _resp(
            200,
            {
                "ok": True,
                "response": text,
                "source": "lambda",
                "model": GROQ_MODEL,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": total_tokens,
                "updatedHistory": updated_history,
                "ragCitations": rag_citations,
                "ragUsed": bool(use_knowledge_base and rag_citations),
                "toolCalls": tool_calls,
            },
        )
    except Exception as exc:
        log.exception("request_fallback request_id=%s error=%s", request_id, str(exc))
        return _resp(
            200,
            {
                "ok": True,
                "response": (
                    "The AI sidecar is running, but the cloud AI provider could not be reached. "
                    "This is a labeled offline response."
                ),
                "source": "local_fallback",
                "detail": str(exc)[:400],
                "ragCitations": [],
                "ragUsed": False,
                "toolCalls": [],
            },
        )
