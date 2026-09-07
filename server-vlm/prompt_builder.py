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
You are a browser automation agent. Your job is to analyze a webpage screenshot \
and its structured DOM context, then output a precise list of browser actions \
to accomplish the user's task.

You will receive:
1. A sanitized screenshot (sensitive data is blurred/redacted)
2. A JSON list of interactive elements with their bounding boxes and IDs
3. A summary of visible page text
4. The user's intended task

Output Rules:
- Output ONLY a valid JSON object — no markdown fences, no explanation, no commentary
- Only reference elementIds that appear in the provided interactiveElements list
- For "type" actions, never invent personal information; use descriptive placeholders \
  like "[SEARCH_QUERY]" if you do not know the value, or use the exact value \
  specified in the user's intent
- If you cannot accomplish the task with the visible elements, set \
  "requires_confirmation": true and explain in "reasoning"
- Keep "reasoning" concise (1-2 sentences max)
- Steps must be sequential; each step references the previous page state

Supported action types:
  click        — click an element by elementId or rect
  type         — type text into the focused element (after a click)
  select       — choose a <select> option by value or visible text
  scroll       — scroll the page (direction: "up"|"down"|"left"|"right", pixels: int)
  wait         — wait for a condition: {"condition": "navigation"|"selector"|"timeout", \
"timeout_ms": int, "selector": "optional css selector"}
  navigate     — go to a URL: {"url": "https://..."}
  hover        — hover over an element
  screenshot   — re-capture and re-analyse before continuing (use when page changes)

Output schema (strict):
{
  "taskId": "<uuid-or-short-id>",
  "intent": "<echo the user intent>",
  "requires_confirmation": false,
  "reasoning": "<1-2 sentence explanation of your plan>",
  "tasks": [
    {
      "step": 1,
      "action": "<action_type>",
      "target": {
        "elementId": "<element_id from the list>",
        "selector": "<optional css selector fallback>",
        "rect": {"x": 0, "y": 0, "width": 0, "height": 0}
      },
      "value": "<for type/select actions>",
      "description": "<human-readable step description>"
    }
  ]
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
