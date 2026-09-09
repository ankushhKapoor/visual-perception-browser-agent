"""
Parses and validates the VLM's JSON output into a structured tasks.json.

The VLM is prompted to output pure JSON, but may sometimes wrap it in markdown
fences or add trailing text. This module handles all such cases robustly.
"""

import json
import re
import uuid
from typing import Any


VALID_ACTIONS = {
    "click",
    "dblclick",
    "rightclick",
    "type",
    "key",
    "select",
    "scroll",
    "wait",
    "navigate",
    "hover",
    "focus",
    "clear",
    "drag",
    "opentab",
    "screenshot",
}

VALID_WAIT_CONDITIONS = {"navigation", "selector", "timeout"}
VALID_SCROLL_DIRECTIONS = {"up", "down", "left", "right"}


class TaskParseError(ValueError):
    """Raised when the VLM output cannot be parsed into a valid task list."""


def _extract_json_from_text(text: str) -> str:
    """
    Extract the first JSON object from raw LLM output.
    Handles markdown fences (```json ... ```) and leading/trailing noise.
    """
    # Strip markdown code fences
    fence_match = re.search(
        r"```(?:json)?\s*(\{.*?\})\s*```",
        text,
        re.DOTALL,
    )
    if fence_match:
        return fence_match.group(1)

    # Find the first { and last } in the text
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise TaskParseError(
            f"No JSON object found in VLM output. Raw output:\n{text[:500]}"
        )
    return text[start : end + 1]


def _validate_target(target: Any, step: int) -> dict[str, Any]:
    """Validate and normalise a task target block."""
    if not isinstance(target, dict):
        raise TaskParseError(
            f"Step {step}: 'target' must be a dict, got {type(target).__name__}"
        )
    # elementId is preferred but not always required (e.g. navigate / scroll)
    return {
        "elementId": target.get("elementId"),
        "selector": target.get("selector"),
        "rect": target.get("rect"),
    }


def _validate_task(raw_task: Any, index: int) -> dict[str, Any]:
    """Validate a single task step dict from the VLM."""
    if not isinstance(raw_task, dict):
        raise TaskParseError(
            f"Task at index {index} must be a dict, got {type(raw_task).__name__}"
        )

    step = raw_task.get("step", index + 1)
    action = raw_task.get("action", "")

    if action not in VALID_ACTIONS:
        raise TaskParseError(
            f"Step {step}: unknown action '{action}'. "
            f"Allowed: {sorted(VALID_ACTIONS)}"
        )

    task: dict[str, Any] = {
        "step": int(step),
        "action": action,
        "description": str(raw_task.get("description", "")),
    }

    # Action-specific validation
    if action in {"click", "dblclick", "rightclick", "type", "select", "hover", "focus", "clear"}:
        task["target"] = _validate_target(raw_task.get("target", {}), step)

    if action == "drag":
        task["from"] = _validate_target(raw_task.get("from", raw_task.get("source", {})), step)
        task["target"] = _validate_target(raw_task.get("target", {}), step)

    if action == "type":
        value = raw_task.get("value")
        if value is None:
            raise TaskParseError(f"Step {step}: 'type' action requires 'value'")
        task["value"] = str(value)

    if action == "select":
        value = raw_task.get("value")
        if value is None:
            raise TaskParseError(f"Step {step}: 'select' action requires 'value'")
        task["value"] = str(value)

    if action == "key":
        task["key"] = str(raw_task.get("key") or raw_task.get("value") or "Enter")
        if "target" in raw_task:
            task["target"] = _validate_target(raw_task["target"], step)

    if action == "scroll":
        direction = str(raw_task.get("direction", "down")).lower()
        if direction not in VALID_SCROLL_DIRECTIONS:
            direction = "down"
        task["direction"] = direction
        task["pixels"] = int(raw_task.get("pixels", 300))
        if "target" in raw_task:
            task["target"] = _validate_target(raw_task["target"], step)

    if action == "wait":
        condition = str(raw_task.get("condition", "timeout")).lower()
        if condition not in VALID_WAIT_CONDITIONS:
            condition = "timeout"
        task["condition"] = condition
        task["timeout_ms"] = int(raw_task.get("timeout_ms", 2000))
        if condition == "selector":
            task["selector"] = str(raw_task.get("selector", ""))

    if action in {"navigate", "opentab"}:
        url = raw_task.get("url", "")
        if not url:
            raise TaskParseError(f"Step {step}: '{action}' action requires 'url'")
        task["url"] = str(url)

    return task


def parse_vlm_output(
    raw_text: str,
    original_intent: str,
) -> dict[str, Any]:
    """
    Parse and validate the VLM's raw text output into a structured tasks dict.

    Supports three response types:
      - type "answer"  → answer field with text, tasks may be []
      - type "tasks"   → tasks array with steps
      - type "mixed"   → both answer and tasks

    Args:
        raw_text: The raw string returned by the VLM.
        original_intent: The user's task intent string (echoed in the output).

    Returns:
        A validated tasks dict ready to be returned to the extension.

    Raises:
        TaskParseError: If the output cannot be parsed or fails validation.
    """
    json_str = _extract_json_from_text(raw_text)

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise TaskParseError(
            f"VLM output is not valid JSON: {exc}\nExtracted:\n{json_str[:500]}"
        ) from exc

    if not isinstance(data, dict):
        raise TaskParseError(
            f"VLM output root must be a JSON object, got {type(data).__name__}"
        )

    response_type = data.get("type", "tasks")
    raw_tasks = data.get("tasks") or []

    if not isinstance(raw_tasks, list):
        raise TaskParseError("VLM output 'tasks' field must be a list")

    # For answer-type responses, tasks may be empty — that's valid
    is_answer_only = response_type == "answer" or (
        not raw_tasks and data.get("answer")
    )

    if not is_answer_only and len(raw_tasks) == 0:
        raise TaskParseError(
            "VLM returned an empty 'tasks' array for a non-answer response"
        )

    validated_tasks = [_validate_task(t, i) for i, t in enumerate(raw_tasks)]

    return {
        "taskId":   data.get("taskId") or str(uuid.uuid4())[:8],
        "intent":   data.get("intent") or original_intent,
        "type":     response_type,
        "answer":   str(data.get("answer") or ""),
        "requires_confirmation": bool(data.get("requires_confirmation", False)),
        "reasoning": str(data.get("reasoning", "")),
        "tasks":    validated_tasks,
        "status":   "pending",
    }
