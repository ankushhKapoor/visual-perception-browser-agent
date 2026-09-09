"""
FastAPI wrapper server for the college-side VLM (Qwen2.5-VL-3B via vLLM).

Run this on the college machine AFTER vLLM is serving:
    uvicorn main:app --host 0.0.0.0 --port 9001

The local FastAPI backend connects to this server through an SSH tunnel:
    ssh -N -L 9001:localhost:9001 user@college.machine
"""

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

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
) -> str:
    """Call Gemini directly over HTTPS without adding a browser-side SDK."""
    if not config.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is required when MODEL_PROVIDER=gemini")

    parts: list[dict[str, Any]] = [{
        "text": build_user_prompt(perception_state, request.task_intent)
    }]
    if image_b64:
        parts.insert(0, {
            "inline_data": {"mime_type": image_mime_type, "data": image_b64}
        })

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{config.gemini_model}:generateContent"
    )
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": config.temperature,
            "maxOutputTokens": config.max_response_tokens,
            "responseMimeType": "application/json",
        },
    }
    async with httpx.AsyncClient(timeout=config.vllm_timeout) as client:
        response = await client.post(
            url,
            json=payload,
            headers={"x-goog-api-key": config.gemini_api_key},
        )
    if not response.is_success:
        # Never call raise_for_status here: its URL representation may contain
        # sensitive query strings in future provider implementations.
        raise RuntimeError(
            f"Gemini API returned HTTP {response.status_code}: {response.text[:500]}"
        )
    data = response.json()
    try:
        return "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"])
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Gemini returned no text candidate: {data!r}") from exc


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
        return await generate_gemini_output(request, perception_state, image_b64, image_mime_type)

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

    # All retries exhausted
    return AgentResponse(
        success=False,
        error=f"VLM output could not be parsed after {config.max_parse_retries + 1} attempts: {last_error}",
        latency_ms=int((time.monotonic() - t_start) * 1000),
    )
