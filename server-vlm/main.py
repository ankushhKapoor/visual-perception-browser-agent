"""
FastAPI wrapper server for the college-side VLM (Qwen2.5-VL-3B via vLLM).

Run this on the college machine AFTER vLLM is serving:
    uvicorn main:app --host 0.0.0.0 --port 9001

The local FastAPI backend connects to this server through an SSH tunnel:
    ssh -N -L 9001:localhost:9001 user@college.machine
"""

import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote_plus, urlparse

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI, APIConnectionError, APITimeoutError
from pydantic import BaseModel, Field

from config import config
from prompt_builder import (
    SYSTEM_PROMPT,
    build_messages,
    build_user_prompt,
    compact_image_b64,
    compact_perception_state,
)
from task_parser import parse_vlm_output, TaskParseError


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("vlm-server")


def validate_plan_against_current_page(tasks: dict[str, Any], request: "AgentRequest") -> None:
    """Reject repeated first-phase plans during a browser continuation.

    This is a deterministic safety rail around small VLMs: after the browser
    has navigated to YouTube results or opened Gmail Compose, asking it to
    search or open Compose again is always a stale-plan error.
    """
    if "AGENT CONTINUATION:" not in request.task_intent:
        return
    page = request.perception_state.get("page") or {}
    url = str(page.get("url") or "")
    parsed = urlparse(url)
    actions = tasks.get("tasks") or []
    action_names = [str(step.get("action") or "") for step in actions]
    descriptions = " ".join(str(step.get("description") or "") for step in actions).lower()

    is_search_results = (
        ("youtube.com" in parsed.netloc and parsed.path.startswith("/results")) or
        ("google." in parsed.netloc and parsed.path.startswith("/search")) or
        ("github.com" in parsed.netloc and parsed.path.startswith("/search")) or
        ("wikipedia.org" in parsed.netloc and "search" in parsed.path) or
        ("amazon." in parsed.netloc and parsed.path.startswith("/s"))
    )
    if is_search_results:
        repeated_search = (
            "type" in action_names or
            "key" in action_names or
            any(action in {"navigate", "opentab"} for action in action_names) or
            "search" in descriptions
        )
        if repeated_search or not any(action in {"click", "dblclick"} for action in action_names):
            raise TaskParseError(
                "Continuation is already on a search-results page. Do not search, type, press Enter, or navigate again. "
                "Return a click or dblclick task for the matching final result on the current page."
            )

    visible_text = str(
        (request.perception_state.get("domContext") or {}).get("visibleText")
        or request.perception_state.get("visibleText") or ""
    ).lower()
    composer_present = "mail.google.com" in parsed.netloc and any(
        marker in visible_text for marker in ("new message", "to recipients", "subject")
    )
    if composer_present and any(action in {"navigate", "opentab"} for action in action_names):
        raise TaskParseError(
            "Gmail compose editor is already present. Do not navigate or open Compose again; "
            "return only tasks that fill the visible compose fields."
        )


def normalize_direct_search_first_phase(tasks: dict[str, Any], request: "AgentRequest") -> dict[str, Any]:
    """Route a search directly to results, reserving call two for the result.

    This is deliberately deterministic rather than a YouTube-only model hint.
    A home page followed by typing is an avoidable intermediate page on every
    supported search site.  The browser gets a fresh, sanitized result-page
    snapshot for the second and final model call, which selects the actual
    result to open/play.
    """
    intent = request.task_intent
    if "AGENT CONTINUATION:" in intent:
        return tasks
    page_url = str((request.perception_state.get("page") or {}).get("url") or "")
    parsed = urlparse(page_url)

    # Supported direct-search endpoints.  Queries are never guessed from page
    # data; they come only from the user's request.
    routes = {
        "youtube": lambda q: f"https://www.youtube.com/results?search_query={quote_plus(q)}",
        "google": lambda q: f"https://www.google.com/search?q={quote_plus(q)}",
        "github": lambda q: f"https://github.com/search?q={quote_plus(q)}&type=repositories",
        "wikipedia": lambda q: f"https://en.wikipedia.org/w/index.php?search={quote_plus(q)}",
        "amazon": lambda q: f"https://www.amazon.in/s?k={quote_plus(q)}",
    }
    aliases = {"youtube music": "youtube", "yt": "youtube", "wiki": "wikipedia"}
    lower_intent = intent.split("\n", 1)[0].lower()
    site = next((name for name in routes if re.search(rf"\b{re.escape(name)}\b", lower_intent)), None)
    if not site:
        site = next((mapped for alias, mapped in aliases.items() if alias in lower_intent), None)

    media = re.search(r"\b(play|watch|listen(?:\s+to)?)\s+(.+?)\s*$", intent.split("\n", 1)[0], re.I)
    explicit = re.search(
        r"\b(?:search(?:\s+for)?|find|look\s+up|open)\s+(.+?)\s+(?:on|in|at)\s+"
        r"(youtube(?:\s+music)?|yt|google|github|wikipedia|wiki|amazon)\b", intent.split("\n", 1)[0], re.I,
    )
    if media:
        # Media requests default to YouTube unless the user explicitly chose
        # another supported source.  This removes the home-page-then-search
        # phase even for concise requests such as "play khat song".
        requested_source = re.search(r"\s+(?:on|in)\s+([a-z0-9 .-]+)\s*$", media.group(2), re.I)
        if requested_source and not site:
            # Do not silently redirect a request such as "play X on Spotify"
            # to YouTube. Let the model plan for the source the user named.
            return tasks
        site = site or "youtube"
        query = media.group(2)
        query = re.sub(r"\s+(?:on|in)\s+youtube(?:\s+music)?\s*$", "", query, flags=re.I)
    elif explicit:
        site = aliases.get(explicit.group(2).lower(), explicit.group(2).lower())
        query = explicit.group(1)
    else:
        return tasks
    if site not in routes:
        return tasks

    already_on_results = (
        (site == "youtube" and "youtube.com" in parsed.netloc and parsed.path.startswith("/results")) or
        (site == "google" and "google." in parsed.netloc and parsed.path.startswith("/search")) or
        (site == "github" and "github.com" in parsed.netloc and parsed.path.startswith("/search")) or
        (site == "wikipedia" and "wikipedia.org" in parsed.netloc and "search" in parsed.path) or
        (site == "amazon" and "amazon." in parsed.netloc and parsed.path.startswith("/s"))
    )
    if already_on_results:
        return tasks
    query = query.strip(" .,!?\"")
    if not query:
        return tasks
    action = "opentab" if re.search(r"\bnew\s+tab\b", intent, re.I) else "navigate"
    return {
        **tasks,
        "type": "tasks",
        "answer": "",
        "task_complete": False,
        "reasoning": "Open direct search results, then select the matching final result from fresh page context.",
        "tasks": [{
            "step": 1,
            "action": action,
            "url": routes[site](query),
            "description": f"Open {site.title()} search results for '{query}'",
        }],
    }


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AgentRequest(BaseModel):
    """Payload sent by the local backend to the VLM server."""

    task_intent: str = Field(
        ...,
        min_length=1,
        max_length=1000,
        description="The user's stated intent / goal",
    )
    perception_state: dict[str, Any] = Field(
        ...,
        description="Sanitized browser perception state from the extension",
    )
    image_b64: str | None = Field(
        None,
        description="Base64-encoded sanitized PNG screenshot (no data: prefix)",
    )
    # Privacy proof forwarded from the browser extension
    privacy_proof: dict[str, Any] = Field(
        default_factory=dict,
        description="Privacy attestation object from the extension",
    )


class AgentResponse(BaseModel):
    """Structured response returned to the local backend."""

    success: bool
    tasks: dict[str, Any] | None = None
    error: str | None = None
    model: str | None = None
    latency_ms: int | None = None


# ---------------------------------------------------------------------------
# vLLM client
# ---------------------------------------------------------------------------

_vlm_client: AsyncOpenAI | None = None
_openai_client: AsyncOpenAI | None = None


def get_vlm_client() -> AsyncOpenAI:
    global _vlm_client
    if _vlm_client is None:
        _vlm_client = AsyncOpenAI(
            base_url=config.vllm_base_url,
            api_key="token-not-needed",  # vLLM local doesn't enforce API keys
            timeout=config.vllm_timeout,
        )
    return _vlm_client


def get_openai_client() -> AsyncOpenAI:
    """Return the hosted OpenAI client only when explicitly configured."""
    global _openai_client
    if not config.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required when MODEL_PROVIDER=openai")
    if _openai_client is None:
        _openai_client = AsyncOpenAI(
            api_key=config.openai_api_key,
            timeout=config.vllm_timeout,
        )
    return _openai_client


async def generate_gemini_output(
    request: AgentRequest,
    perception_state: dict[str, Any],
    image_b64: str | None,
    image_mime_type: str,
    messages: list[dict[str, Any]],
) -> str:
    """Call Gemini directly over HTTPS without adding a browser-side SDK."""
    if not config.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is required when MODEL_PROVIDER=gemini")
    if config.gemini_model == "gemini-2.5-flash":
        raise RuntimeError(
            "GEMINI_MODEL=gemini-2.5-flash is retired for new users; "
            "set GEMINI_MODEL=gemini-3.6-flash in server-vlm/.env and restart"
        )

    # Interactions is Gemini's current unified API. Keep every item in this
    # request sanitized and self-contained; no previous interaction state is
    # sent or stored.
    parts: list[dict[str, Any]] = [{
        "type": "text",
        "text": f"{SYSTEM_PROMPT}\n\n{build_user_prompt(perception_state, request.task_intent)}",
    }]
    if image_b64:
        parts.insert(0, {
            "type": "image", "data": image_b64, "mime_type": image_mime_type,
        })
    # Gemini Interactions does not consume the OpenAI-style `messages` list.
    # Carry parser/guardrail feedback into its own input explicitly on retry.
    retry_feedback = next((
        str(message.get("content")) for message in reversed(messages)
        if message.get("role") == "user" and "previous response could not" in str(message.get("content"))
    ), "")
    if retry_feedback:
        parts.append({"type": "text", "text": retry_feedback})

    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    payload = {
        "model": config.gemini_model,
        "input": parts,
        "store": False,
        "response_format": {
            "type": "text",
            "mime_type": "application/json",
        },
    }
    async with httpx.AsyncClient(timeout=config.vllm_timeout) as client:
        response = await client.post(
            url,
            json=payload,
            headers={
                "x-goog-api-key": config.gemini_api_key,
                "Api-Revision": config.gemini_api_revision,
            },
        )
    if not response.is_success:
        # Never call raise_for_status here: its URL representation may contain
        # sensitive query strings in future provider implementations.
        raise RuntimeError(
            f"Gemini API returned HTTP {response.status_code}: {response.text[:500]}"
        )
    data = response.json()

    # `output_text` is an SDK convenience field, not guaranteed in the REST
    # response. The current Interactions REST schema returns model output in
    # steps[].content[]; accept legacy outputs[] too for API revision changes.
    if isinstance(data.get("output_text"), str) and data["output_text"].strip():
        return data["output_text"]

    text_parts: list[str] = []
    for step in data.get("steps") or []:
        if step.get("type") != "model_output":
            continue
        for content in step.get("content") or []:
            if content.get("type") == "text" and isinstance(content.get("text"), str):
                text_parts.append(content["text"])
    if not text_parts:
        for output in data.get("outputs") or []:
            if output.get("type") == "text" and isinstance(output.get("text"), str):
                text_parts.append(output["text"])
    if text_parts:
        return "".join(text_parts)

    # Log only structural information, never model input, response content, or
    # API credentials.
    raise RuntimeError(
        "Gemini returned no text output "
        f"(status={data.get('status')!r}, keys={sorted(data.keys())!r})"
    )


async def generate_model_output(
    request: AgentRequest,
    messages: list[dict[str, Any]],
    perception_state: dict[str, Any],
    image_b64: str | None,
    image_mime_type: str,
) -> str:
    """Generate through the selected server-side provider."""
    if config.provider == "local":
        completion = await get_vlm_client().chat.completions.create(
            model=config.model_name,
            messages=messages,  # type: ignore[arg-type]
            max_tokens=config.max_response_tokens,
            temperature=config.temperature,
        )
        return completion.choices[0].message.content or ""

    if config.provider == "openai":
        # Keep the existing multimodal chat message format, with no API key or
        # raw page data ever exposed to the extension.
        completion = await get_openai_client().chat.completions.create(
            model=config.openai_model,
            messages=messages,  # type: ignore[arg-type]
            max_tokens=config.max_response_tokens,
            temperature=config.temperature,
        )
        return completion.choices[0].message.content or ""

    if config.provider == "gemini":
        return await generate_gemini_output(request, perception_state, image_b64, image_mime_type, messages)

    raise RuntimeError("MODEL_PROVIDER must be one of: local, openai, gemini")


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "VLM server starting — provider=%s model=%s",
        config.provider,
        config.active_model_name,
    )
    # Only local vLLM has a health endpoint to ping.
    if config.provider != "local":
        yield
        log.info("VLM server shutting down")
        return

    # Warm up: ping vLLM health endpoint
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                config.vllm_base_url.replace("/v1", "/health")
            )
            if resp.status_code == 200:
                log.info("vLLM is healthy")
            else:
                log.warning(
                    "vLLM health check returned %d — proceeding anyway",
                    resp.status_code,
                )
    except Exception as exc:
        log.warning("vLLM not reachable at startup: %s — will retry on first request", exc)

    yield

    log.info("VLM server shutting down")


app = FastAPI(
    title="Visual Browser Agent — VLM Server",
    version="0.2.0",
    description="Qwen2.5-VL-3B-Instruct endpoint for the visual browser agent",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    return {
        "service": "VLM Browser Agent Server",
        "model": config.active_model_name,
        "provider": config.provider,
        "status": "running",
    }


@app.get("/health")
async def health():
    """Health check; local mode additionally pings vLLM."""
    if config.provider != "local":
        configured = (
            bool(config.openai_api_key) if config.provider == "openai"
            else bool(config.gemini_api_key) if config.provider == "gemini"
            else False
        )
        return {
            "status": "healthy" if configured else "misconfigured",
            "provider": config.provider,
            "provider_configured": configured,
            "model": config.active_model_name,
        }

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                config.vllm_base_url.replace("/v1", "/health")
            )
            vllm_ok = resp.status_code == 200
    except Exception:
        vllm_ok = False

    return {
        "status": "healthy",
        "vllm_reachable": vllm_ok,
        "provider": config.provider,
        "model": config.active_model_name,
    }


@app.post("/v1/agent", response_model=AgentResponse)
async def agent_task(request: AgentRequest) -> AgentResponse:
    """
    Main agent endpoint.

    Receives the sanitized perception state + screenshot from the local backend,
    calls the VLM, parses the response into tasks.json, and returns it.
    """
    # Basic privacy gate on the server side too
    proof = request.privacy_proof
    if (
        proof.get("sanitized") is not True
        or proof.get("rawScreenshotIncluded") is not False
    ):
        raise HTTPException(
            status_code=400,
            detail="Privacy gate: unsanitized payload rejected by VLM server",
        )

    log.info(
        "Agent request received — intent=%r elements=%d",
        request.task_intent[:80],
        len(request.perception_state.get("interactiveElements", [])),
    )

    compact_state, context_budget = compact_perception_state(
        request.perception_state, request.task_intent,
    )
    compact_image, image_mime_type, image_budget = compact_image_b64(request.image_b64)
    messages = build_messages(
        perception_state=compact_state,
        task_intent=request.task_intent,
        image_b64=compact_image,
        image_mime_type=image_mime_type,
    )
    log.info(
        "Input budget — elements=%d/%d text=%d/%d image=%d/%d bytes",
        context_budget["elements_sent"], context_budget["elements_available"],
        context_budget["text_chars_sent"], context_budget["text_chars_available"],
        image_budget["image_bytes_sent"], image_budget["image_bytes_in"],
    )

    last_error: str = ""
    t_start = time.monotonic()

    for attempt in range(config.max_parse_retries + 1):
        if attempt > 0:
            log.warning("Retry %d/%d after parse failure", attempt, config.max_parse_retries)
            # On retry, append error feedback so VLM corrects itself
            messages.append({
                "role": "assistant",
                "content": last_error,
            })
            messages.append({
                "role": "user",
                "content": (
                    f"Your previous response could not be parsed: {last_error}\n"
                    "Please output ONLY valid JSON matching the required schema."
                ),
            })

        try:
            raw_output = await generate_model_output(
                request, messages, compact_state, compact_image, image_mime_type,
            )
        except (APIConnectionError, APITimeoutError) as exc:
            raise HTTPException(
                status_code=503,
                detail=f"vLLM unreachable: {exc}",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"vLLM inference error: {exc}",
            ) from exc

        latency_ms = int((time.monotonic() - t_start) * 1000)

        log.debug("VLM raw output (attempt %d):\n%s", attempt + 1, raw_output[:800])

        try:
            tasks = parse_vlm_output(raw_output, request.task_intent)
            tasks = normalize_direct_search_first_phase(tasks, request)
            validate_plan_against_current_page(tasks, request)
            log.info(
                "Tasks parsed successfully — %d steps, latency=%dms",
                len(tasks.get("tasks", [])),
                latency_ms,
            )
            return AgentResponse(
                success=True,
                tasks=tasks,
                model=config.active_model_name,
                latency_ms=latency_ms,
            )
        except TaskParseError as exc:
            last_error = str(exc)
            log.warning("Parse error (attempt %d): %s", attempt + 1, last_error)
            # This is not malformed JSON that a retry can repair. The browser
            # is already on a results page and has a local, real-element
            # fallback for the final click. Retrying would turn a two-call
            # browser task into three provider calls while repeating the same
            # stale search plan.
            if "Continuation is already on a search-results page" in last_error:
                return AgentResponse(
                    success=False,
                    error=last_error,
                    latency_ms=latency_ms,
                )

    # All retries exhausted
    return AgentResponse(
        success=False,
        error=f"VLM output could not be parsed after {config.max_parse_retries + 1} attempts: {last_error}",
        latency_ms=int((time.monotonic() - t_start) * 1000),
    )
