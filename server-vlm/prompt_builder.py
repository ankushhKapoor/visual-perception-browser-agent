"""
Prompt builder for the VLM agent.

Constructs a structured system + user prompt from:
  - Sanitized page context (interactive elements, forms, visible text)
  - User's intent string
  - Available element IDs for grounding
"""

import json
from typing import Any

from config import config


SYSTEM_PROMPT = """\
You are a browser automation and page analysis agent. You are given:
1. A sanitized screenshot of a webpage (PII is blurred/redacted)
2. A structured JSON list of interactive elements with their bounding boxes
3. A summary of the page's visible text
4. The user's question or task

You can respond in ONE of three ways — choose the most appropriate:

A) ANSWER a question about the page content:
   Use when the user asks "how many", "what is", "show me", "list", "find", etc.
   Output: {"type": "answer", "answer": "Your detailed answer here", "tasks": [], "reasoning": "...", "requires_confirmation": false, "taskId": "auto"}

B) EXECUTE automation tasks:
   Use when the user says "click", "search", "fill", "go to", "open", "submit", etc.
   Output: {"type": "tasks", "answer": "", "tasks": [...steps...], "reasoning": "...", "requires_confirmation": false, "taskId": "auto"}

C) MIXED — answer AND execute:
   Use when both are needed (e.g. "How many items are in the cart? Then remove them all")
   Output: {"type": "mixed", "answer": "There are 3 items...", "tasks": [...steps...], "reasoning": "...", "requires_confirmation": false, "taskId": "auto"}

Output Rules:
- Output ONLY a valid JSON object — no markdown fences, no explanation outside the JSON
- For "answer" type: put all information in the "answer" field; tasks array must be []
- For "tasks" type: only reference elementIds from the provided interactiveElements list
- For "type" action values, never invent personal data; use the exact value from the user's intent
- Keep "reasoning" to 1-2 sentences max
- If you cannot answer the question or cannot find the right elements, set "requires_confirmation": true

Supported task action types:
  click, type, select, scroll, wait, navigate, hover, screenshot

Tasks step schema:
{
  "step": 1,
  "action": "<action_type>",
  "target": {"elementId": "<id from list>", "selector": "<css fallback>"},
  "value": "<for type/select>",
  "description": "<human-readable>"
}
"""


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "... [truncated]"


def _format_element(el: dict[str, Any]) -> dict[str, Any]:
    """Return a compact element dict for the VLM prompt."""
    rect = el.get("rect", {})
    return {
        "elementId": el.get("elementId"),
        "tag": el.get("tag"),
        "category": el.get("category"),
        "type": el.get("type"),
        "text": _truncate(str(el.get("text") or ""), 120),
        "placeholder": _truncate(str(el.get("placeholder") or ""), 80) or None,
        "label": _truncate(str(el.get("label") or ""), 80) or None,
        "ariaLabel": _truncate(
            str(
                (el.get("accessibility") or {}).get("ariaLabel") or
                (el.get("accessibility") or {}).get("accessibleName") or ""
            ),
            80
        ) or None,
        "disabled": (el.get("accessibility") or {}).get("disabled", False),
        "rect": {
            "x": int(rect.get("x", 0)),
            "y": int(rect.get("y", 0)),
            "w": int(rect.get("width", 0)),
            "h": int(rect.get("height", 0)),
        },
    }


def _format_form(form: dict[str, Any]) -> dict[str, Any]:
    """Return a compact form dict for the VLM prompt."""
    return {
        "formId": form.get("formId"),
        "rect": form.get("rect"),
        "controls": [
            {
                "controlId": c.get("controlId"),
                "tag": c.get("tag"),
                "type": c.get("type"),
                "label": _truncate(str(c.get("label") or ""), 60) or None,
                "placeholder": _truncate(str(c.get("placeholder") or ""), 60) or None,
                "name": c.get("name"),
                "disabled": (c.get("accessibility") or {}).get("disabled", False),
                "rect": c.get("rect"),
            }
            for c in (form.get("controls") or [])
        ],
    }


def build_user_prompt(
    perception_state: dict[str, Any],
    task_intent: str,
) -> str:
    """
    Build the user-facing portion of the VLM prompt from the
    sanitized browser perception state.
    """
    page = perception_state.get("page", {})
    interactive_elements = perception_state.get("interactiveElements", [])
    forms = perception_state.get("forms", [])
    visible_text = (
        (perception_state.get("domContext") or {}).get("visibleText")
        or perception_state.get("visibleText")
        or ""
    )
    visual_text = perception_state.get("visualText", [])

    # Truncate + cap interactive elements
    elements_to_send = interactive_elements[: config.max_interactive_elements]
    compact_elements = [_format_element(el) for el in elements_to_send]

    # Compact forms
    compact_forms = [_format_form(f) for f in forms[:10]]

    # Visual text regions (OCR hits from YOLO server)
    visual_text_snippets = [
        {"text": _truncate(str(vt.get("text") or ""), 80), "rect": vt.get("rect")}
        for vt in visual_text[: config.max_visual_text_items]
    ]

    parts = [
        f"Page URL: {page.get('url', '<unknown>')}",
        f"Page Title: {page.get('title', '<unknown>')}",
    ]

    viewport = page.get("viewport", {})
    if viewport:
        parts.append(
            f"Viewport: {viewport.get('width', '?')}x{viewport.get('height', '?')}"
        )

    if visible_text:
        parts.append(
            "\nVisible Text (sanitized):\n"
            + _truncate(visible_text, config.max_visible_text_chars)
        )

    parts.append(
        f"\nInteractive Elements ({len(compact_elements)} of "
        f"{len(interactive_elements)} total):\n"
        + json.dumps(compact_elements, ensure_ascii=False, indent=2)
    )

    if compact_forms:
        parts.append(
            f"\nForms ({len(compact_forms)}):\n"
            + json.dumps(compact_forms, ensure_ascii=False, indent=2)
        )

    if visual_text_snippets:
        parts.append(
            f"\nOCR-detected text regions ({len(visual_text_snippets)}):\n"
            + json.dumps(visual_text_snippets, ensure_ascii=False, indent=2)
        )

    parts.append(f"\nUser Task: {task_intent}")
    parts.append("\nRespond with tasks.json:")

    return "\n".join(parts)


def build_messages(
    perception_state: dict[str, Any],
    task_intent: str,
    image_b64: str | None = None,
) -> list[dict[str, Any]]:
    """
    Build the full message list for the OpenAI chat completions API.
    Includes the base64-encoded screenshot as an image_url content block
    when available (required for VLM vision input).
    """
    user_text = build_user_prompt(perception_state, task_intent)

    user_content: list[dict[str, Any]]

    if image_b64:
        user_content = [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{image_b64}",
                    "detail": "high",
                },
            },
            {
                "type": "text",
                "text": user_text,
            },
        ]
    else:
        user_content = [{"type": "text", "text": user_text}]

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
