"""
POST /agent/step router.

This is the single entry point the Chrome Extension calls.
Swap the planner by changing the import below — nothing else changes.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from models.schemas import AgentStepRequest, AgentStepResponse
from planner.dummy_planner import DummyPlanner

# When VLM is ready:
# from planner.vlm_planner import VLMPlanner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agent", tags=["agent"])

# Single planner instance (stateless for now; make async / injected later)
_planner = DummyPlanner()


@router.post("/step", response_model=AgentStepResponse)
async def agent_step(request: AgentStepRequest) -> AgentStepResponse:
    """
    Receive sanitized browser state and return the next action to execute.

    The planner is intentionally decoupled from the router so the entire
    AI decision-making component can be upgraded independently.
    """
    logger.info(
        "agent_step | session=%s | task=%r | url=%s | elements=%d",
        request.session_id,
        request.task,
        request.url,
        len(request.ui_elements),
    )

    try:
        action, reasoning = _planner.plan(request)
    except Exception as exc:
        logger.exception("Planner error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Planner error: {exc}") from exc

    response = AgentStepResponse(
        session_id=request.session_id,
        action=action,
        reasoning=reasoning,
        done=action.type.value == "DONE",
    )

    logger.info(
        "agent_step | response | action=%s | target=%s | reasoning=%s",
        action.type,
        action.target_id,
        reasoning,
    )

    return response
