"""Parse and validate actions returned by the VLM."""

import json
import re
from typing import Any

from models.schemas import ActionType, AgentAction, UIElement


class ActionValidationError(ValueError):
    """Raised when model output is not an executable browser action."""


def _json_object(raw_output: str) -> dict[str, Any]:
    cleaned = raw_output.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if not match:
            raise ActionValidationError("VLM output was not valid JSON")
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise ActionValidationError("VLM output was not valid JSON") from exc
    if not isinstance(value, dict):
        raise ActionValidationError("VLM output must be a JSON object")
    return value


def parse_and_validate(raw_output: str, elements: list[UIElement]) -> tuple[AgentAction, str]:
    payload = _json_object(raw_output)
    action_data = payload.get("action", payload)
    if not isinstance(action_data, dict):
        raise ActionValidationError("VLM response is missing an action object")

    try:
        action = AgentAction.model_validate(action_data)
    except ValueError as exc:
        raise ActionValidationError(f"Invalid action schema: {exc}") from exc

    element_ids = {element.id for element in elements}
    if action.type in {ActionType.CLICK, ActionType.TYPE, ActionType.SELECT}:
        if not action.target_id:
            raise ActionValidationError(f"{action.type.value} requires target_id")
        if action.target_id not in element_ids:
            raise ActionValidationError(f"Unknown target_id: {action.target_id}")
    if action.type is ActionType.TYPE and action.value is None:
        raise ActionValidationError("TYPE requires value")
    if action.type is ActionType.PRESS_KEY and not action.key_to_press:
        raise ActionValidationError("PRESS_KEY requires key_to_press")
    if action.type is ActionType.WAIT and (action.wait_ms is None or action.wait_ms < 0):
        raise ActionValidationError("WAIT requires a non-negative wait_ms")

    reasoning = payload.get("reasoning", "")
    if not isinstance(reasoning, str):
        reasoning = str(reasoning)
    return action, reasoning[:1000]
