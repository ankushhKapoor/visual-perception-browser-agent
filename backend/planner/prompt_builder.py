"""Build the structured prompt sent to the vision-language model."""

import json

from models.schemas import AgentStepRequest


SYSTEM_PROMPT = """You are a browser automation planner.
Choose exactly one next action from the allowed schema using only the supplied task and sanitized browser state.
Return JSON only, with this shape:
{"action":{"type":"TYPE|CLICK|SCROLL|SELECT|PRESS_KEY|WAIT|DONE","target_id":null,"value":null,"key_to_press":null,"scroll_x":null,"scroll_y":null,"wait_ms":null,"confidence":0.0},"reasoning":"short explanation"}
Use target_id only from the supplied UI elements. For typing, preserve the requested text exactly in value. Use PRESS_KEY with key_to_press Enter when the task requires submitting a search or form. Return DONE only when the task is complete.
"""


def build_context(request: AgentStepRequest) -> str:
    elements = [element.model_dump(exclude_none=True) for element in request.ui_elements]
    return (
        f"Task: {request.task}\n"
        f"URL: {request.url}\n"
        f"Page title: {request.page_title}\n"
        f"Visible text:\n{request.visible_text[:6000]}\n"
        f"Interactive UI elements:\n{json.dumps(elements, ensure_ascii=True)}\n"
        "The screenshot, when supplied, is sanitized and may be used to resolve visual ambiguity."
    )
