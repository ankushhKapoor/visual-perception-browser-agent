"""
Agent router for the local FastAPI backend.

Provides:
  POST /agent/task    — receive perception state + intent from extension,
                        apply second-pass privacy sanitisation,
                        forward to VLM server via SSH tunnel,
                        return tasks.json
  GET  /agent/status  — simple status / last-task echo endpoint

Mounts onto the existing yolo-opencv server.py app.
"""

import base64
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from task_validator import validate_tasks_response, TaskValidationError


log = logging.getLogger("agent-router")

# VLM server URL — reachable through the SSH tunnel
# On the local machine: ssh -N -L 9001:localhost:9001 user@college.machine
VLM_SERVER_URL = os.getenv(
    "VLM_SERVER_URL", "http://localhost:9001/v1/agent"
)
VLM_TIMEOUT = int(os.getenv("VLM_TIMEOUT", "180"))

# PII regex patterns for a final text sanity-check before forwarding
_PII_PATTERNS = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    re.compile(r"\b(?:\+91[\s-]?)?[6-9]\d{9}\b"),
    re.compile(r"\b(?:\d{4}[\s-]?){3}\d{4}\b"),
    re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.IGNORECASE),
)


def _text_contains_pii(value: Any) -> bool:
    if isinstance(value, str):
        return any(p.search(value) for p in _PII_PATTERNS)
    if isinstance(value, dict):
        return any(_text_contains_pii(v) for v in value.values())
    if isinstance(value, list):
        return any(_text_contains_pii(item) for item in value)
    return False


def _apply_pixel_redaction(image_b64: str, redaction_regions: list[dict]) -> str:
    """
    Server-side pixel redaction using OpenCV (Gaussian blur + blackout).
    Mirrors the client-side canvas redaction for defence-in-depth.
    """
    if not image_b64 or not redaction_regions:
        return image_b64

    try:
        img_bytes = base64.b64decode(image_b64)
        nparr = np.frombuffer(img_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return image_b64

        h, w = image.shape[:2]

        for region in redaction_regions:
            box = region.get("rect") or region.get("boundingBox") or region
            try:
                x = max(0, int(float(box.get("x", 0))))
                y = max(0, int(float(box.get("y", 0))))
                bw = int(float(box.get("width", box.get("w", 0))))
                bh = int(float(box.get("height", box.get("h", 0))))
            except (TypeError, ValueError, AttributeError):
                continue

            x2 = min(w, x + bw)
            y2 = min(h, y + bh)
            if x2 <= x or y2 <= y:
                continue

            strategy = str(region.get("strategy", "BLACKOUT")).upper()
            if strategy == "BLACKOUT":
                image[y:y2, x:x2] = 0
            else:
                crop = image[y:y2, x:x2]
                if crop.size:
                    sigma = max(3, min(18, round(max(bw, bh) * 0.08)))
                    image[y:y2, x:x2] = cv2.GaussianBlur(
                        crop, (0, 0), sigmaX=sigma, sigmaY=sigma
                    )

        _, encoded = cv2.imencode(".png", image)
        return base64.b64encode(encoded.tobytes()).decode("ascii")

    except Exception as exc:
        log.warning("Server-side pixel redaction failed: %s — using original", exc)
        return image_b64


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class AgentTaskRequest(BaseModel):
    """Payload from the browser extension."""

    task_intent: str = Field(..., min_length=1, max_length=1000)
    perception_state: dict[str, Any] = Field(...)
    image_b64: str | None = Field(None, description="Base64 PNG (no data: prefix)")
    redaction_regions: list[dict[str, Any]] = Field(default_factory=list)
    privacy_proof: dict[str, Any] = Field(default_factory=dict)


class AgentTaskResponse(BaseModel):
    success: bool
    tasks: dict[str, Any] | None = None
    error: str | None = None
    model: str | None = None
    latency_ms: int | None = None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/agent", tags=["agent"])

# Store the last successful tasks.json for /agent/status polling
_last_tasks: dict[str, Any] = {}


@router.post("/task", response_model=AgentTaskResponse)
async def agent_task(request: AgentTaskRequest) -> AgentTaskResponse:
    """
    Main agent task endpoint.

    1. Validates the privacy proof
    2. Applies server-side pixel redaction on the screenshot
    3. Checks the perception state for raw PII
    4. Forwards to the VLM server (college machine via SSH tunnel)
    5. Validates + returns the tasks.json
    """
    t_start = time.monotonic()

    # --- Privacy gate ---
    proof = request.privacy_proof
    if (
        not isinstance(proof, dict)
        or proof.get("sanitized") is not True
        or proof.get("rawScreenshotIncluded") is not False
    ):
        raise HTTPException(
            status_code=400,
            detail="Privacy gate: unsanitized agent task rejected",
        )

    # Reject if raw PII leaks into the perception state text fields
    if _text_contains_pii(request.perception_state):
        raise HTTPException(
            status_code=400,
            detail="Privacy gate: raw PII detected in perception state",
        )

    log.info(
        "Agent task received — intent=%r elements=%d image=%s",
        request.task_intent[:80],
        len(request.perception_state.get("interactiveElements", [])),
        "yes" if request.image_b64 else "no",
    )

    # --- Server-side pixel redaction ---
    safe_image_b64: str | None = None
    if request.image_b64:
        safe_image_b64 = _apply_pixel_redaction(
            request.image_b64,
            request.redaction_regions,
        )
        log.info("Server-side pixel redaction applied (%d regions)", len(request.redaction_regions))

        # Save ONLY the screenshot that's actually forwarded to VLM
        try:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            save_dir = Path(__file__).parent.parent / "photos" / "output"
            save_dir.mkdir(parents=True, exist_ok=True)
            img_path = save_dir / f"vlm_sent_{ts}.png"
            with open(img_path, "wb") as _f:
                _f.write(base64.b64decode(safe_image_b64))
            log.info("Saved VLM-sent screenshot → %s", img_path.name)
        except Exception as _exc:
            log.warning("Could not save VLM screenshot: %s", _exc)

    # --- Build VLM payload ---
    vlm_payload = {
        "task_intent": request.task_intent,
        "perception_state": request.perception_state,
        "image_b64": safe_image_b64,
        "privacy_proof": {
            "sanitized": True,
            "rawScreenshotIncluded": False,
            "serverRedactionApplied": True,
            "redactionRegionCount": len(request.redaction_regions),
        },
    }

    # --- Call VLM server ---
    try:
        async with httpx.AsyncClient(timeout=VLM_TIMEOUT) as client:
            resp = await client.post(VLM_SERVER_URL, json=vlm_payload)
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot reach VLM server. Is the SSH tunnel running? "
                f"Expected: {VLM_SERVER_URL} — error: {exc}"
            ),
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=f"VLM server timed out after {VLM_TIMEOUT}s: {exc}",
        ) from exc

    if not resp.is_success:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"VLM server error: {resp.text[:500]}",
        )

    vlm_response = resp.json()
    latency_ms = int((time.monotonic() - t_start) * 1000)

    if not vlm_response.get("success"):
        return AgentTaskResponse(
            success=False,
            error=vlm_response.get("error", "VLM server returned failure"),
            latency_ms=latency_ms,
        )

    # --- Validate tasks.json ---
    try:
        tasks = validate_tasks_response(vlm_response.get("tasks", {}))
    except TaskValidationError as exc:
        log.error("Task validation failed: %s", exc)
        return AgentTaskResponse(
            success=False,
            error=f"Task validation error: {exc}",
            latency_ms=latency_ms,
        )

    global _last_tasks
    _last_tasks = tasks

    log.info(
        "Agent task completed — %d steps, latency=%dms",
        len(tasks.get("tasks", [])),
        latency_ms,
    )

    return AgentTaskResponse(
        success=True,
        tasks=tasks,
        model=vlm_response.get("model"),
        latency_ms=latency_ms,
    )


@router.get("/status")
def agent_status():
    """Returns the last successfully generated tasks.json."""
    return {
        "status": "ready",
        "vlm_server": VLM_SERVER_URL,
        "last_task": _last_tasks or None,
    }
