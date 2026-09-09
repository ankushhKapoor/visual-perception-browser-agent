"""
Task schema validation for the local backend.

Validates tasks.json structures returned by the VLM server before
they are forwarded to the browser extension for execution.
"""

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


class TaskValidationError(ValueError):
    """Raised when a tasks.json structure fails validation."""


def validate_tasks_response(data: Any) -> dict[str, Any]:
    """
    Validate the tasks dict received from the VLM server.

    Args:
        data: The parsed JSON dict from the VLM server's /v1/agent response.

    Returns:
        The validated tasks dict (same object, checked).

    Raises:
        TaskValidationError: If any required field is missing or invalid.
    """
    if not isinstance(data, dict):
        raise TaskValidationError("Tasks response must be a JSON object")

    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        raise TaskValidationError("Tasks response must contain a 'tasks' list")

    # Allow empty tasks for Q&A answer responses (type: "answer" or "mixed" with an answer)
    is_answer_response = (
        data.get("type") in ("answer", "mixed") or
        (len(tasks) == 0 and data.get("answer"))
    )

    if len(tasks) == 0 and not is_answer_response:
        raise TaskValidationError("Tasks list is empty")


    if len(tasks) > 50:
        raise TaskValidationError(
            f"Tasks list has {len(tasks)} steps; refusing to execute more than 50 steps"
        )

    for i, task in enumerate(tasks):
        if not isinstance(task, dict):
            raise TaskValidationError(f"Task at index {i} is not a dict")

        action = task.get("action")
        if action not in VALID_ACTIONS:
            raise TaskValidationError(
                f"Task {i}: unknown action '{action}'"
            )

        step = task.get("step")
        if not isinstance(step, int) or step < 1:
            raise TaskValidationError(
                f"Task {i}: 'step' must be a positive integer, got {step!r}"
            )

        # For click/type/hover: target must have at least one identifier
        if action in {"click", "dblclick", "rightclick", "type", "select", "hover", "focus", "clear"}:
            target = task.get("target", {})
            if not isinstance(target, dict):
                raise TaskValidationError(
                    f"Task {i} (step {step}): 'target' must be a dict"
                )
            if not (target.get("elementId") or target.get("selector") or target.get("rect")):
                raise TaskValidationError(
                    f"Task {i} (step {step}): 'target' must have at least one of "
                    "'elementId', 'selector', or 'rect'"
                )

        if action == "type" and task.get("value") is None:
            raise TaskValidationError(
                f"Task {i} (step {step}): 'type' action requires 'value'"
            )

        if action == "navigate" and not task.get("url"):
            raise TaskValidationError(
                f"Task {i} (step {step}): 'navigate' action requires 'url'"
            )

        if action == "opentab" and not task.get("url"):
            raise TaskValidationError(
                f"Task {i} (step {step}): 'opentab' action requires 'url'"
            )

    return data
