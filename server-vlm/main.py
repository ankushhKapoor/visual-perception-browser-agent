"""
FastAPI wrapper server for the college-side VLM (Qwen2-VL-7B via vLLM).

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
from prompt_builder import build_messages
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


def get_vlm_client() -> AsyncOpenAI:
    global _vlm_client
    if _vlm_client is None:
        _vlm_client = AsyncOpenAI(
            base_url=config.vllm_base_url,
            api_key="token-not-needed",  # vLLM local doesn't enforce API keys
            timeout=config.vllm_timeout,
        )
    return _vlm_client


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "VLM server starting — model=%s vllm=%s",
        config.model_name,
        config.vllm_base_url,
    )
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
    description="Qwen2-VL-7B endpoint for the visual browser agent",
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
        "model": config.model_name,
        "status": "running",
    }


@app.get("/health")
async def health():
    """Health check — also pings vLLM."""
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
        "model": config.model_name,
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

    messages = build_messages(
        perception_state=request.perception_state,
        task_intent=request.task_intent,
        image_b64=request.image_b64,
    )

    client = get_vlm_client()
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
            completion = await client.chat.completions.create(
                model=config.model_name,
                messages=messages,  # type: ignore[arg-type]
                max_tokens=config.max_response_tokens,
                temperature=config.temperature,
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

        raw_output = completion.choices[0].message.content or ""
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
                model=config.model_name,
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
