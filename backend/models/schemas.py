"""
Pydantic schemas for the agent API.
These define the contract between the Chrome Extension and the FastAPI backend.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# UI Element (sent by the extension after DOM scraping)
# ---------------------------------------------------------------------------

class UIElement(BaseModel):
    id: str = Field(..., description="Unique data-agent-id assigned by the extension")
    role: str = Field(..., description="ARIA role or inferred role (button, textbox, link …)")
    tag: str = Field(..., description="HTML tag name in lowercase (button, input, a …)")
    text: str = Field(default="", description="Visible text or placeholder of the element")
    attributes: dict[str, str] = Field(
        default_factory=dict,
        description="Extra attributes (type, name, aria-label …)"
    )


# ---------------------------------------------------------------------------
# Agent Step Request — what the extension sends
# ---------------------------------------------------------------------------

class AgentStepRequest(BaseModel):
    session_id: str = Field(..., description="Unique session identifier")
    task: str = Field(..., description="The user's natural-language task")
    url: str = Field(..., description="Current page URL")
    page_title: str = Field(default="", description="Current page title")
    visible_text: str = Field(
        default="",
        description="Sanitized visible text extracted from the page"
    )
    ui_elements: list[UIElement] = Field(
        default_factory=list,
        description="Interactive UI elements discovered on the page"
    )
    # Future fields for the VLM pipeline
    sanitized_screenshot_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded sanitized screenshot (reserved for VLM integration)"
    )


# ---------------------------------------------------------------------------
# Action Types and Payloads
# ---------------------------------------------------------------------------

class ActionType(str, Enum):
    CLICK = "CLICK"
    TYPE = "TYPE"
    SCROLL = "SCROLL"
    WAIT = "WAIT"
    DONE = "DONE"


class AgentAction(BaseModel):
    type: ActionType
    target_id: Optional[str] = Field(
        default=None,
        description="data-agent-id of the target element (for CLICK / TYPE)"
    )
    value: Optional[str] = Field(
        default=None,
        description="Text to type (for TYPE action)"
    )
    scroll_x: Optional[int] = Field(default=None, description="Horizontal scroll delta (px)")
    scroll_y: Optional[int] = Field(default=500, description="Vertical scroll delta (px)")
    wait_ms: Optional[int] = Field(default=1000, description="Wait duration in ms")
    extra: dict[str, Any] = Field(
        default_factory=dict,
        description="Additional action parameters for future use"
    )


# ---------------------------------------------------------------------------
# Agent Step Response — what the backend sends back
# ---------------------------------------------------------------------------

class AgentStepResponse(BaseModel):
    session_id: str
    action: AgentAction
    reasoning: str = Field(
        default="",
        description="Human-readable explanation of why this action was chosen"
    )
    done: bool = Field(
        default=False,
        description="True when the planner signals the overall task is complete"
    )
