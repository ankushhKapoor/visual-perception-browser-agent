"""
Prompt builder for the VLM agent.

Constructs a structured system + user prompt from:
  - Sanitized page context (interactive elements, forms, visible text)
  - User intent string
  - Available element IDs for grounding
"""

import json
from typing import Any

from config import config


SYSTEM_PROMPT = """\
You are a browser automation and page analysis agent.

You receive:
  1. A sanitized screenshot (when provided) -- PII is blurred
  2. Structured JSON of interactive elements with bounding boxes
  3. A summary of the page visible text (up to 3000 chars)
  4. The user question or task intent

STEP 1 -- CLASSIFY THE REQUEST

A) ANSWER (type = "answer")
   Use when the user is ASKING A QUESTION about the page.
   Trigger words: what, how many, how much, is there, are there, show, find,
   list, tell me, describe, count, which, where, when, who, why, does, did,
   can you see, do you see, any.
   -> Read from visibleText and interactiveElements. Answer directly in "answer".
   -> tasks array MUST be [].
   -> NEVER return task steps to "observe", "scroll to see", or "take a screenshot".

B) TASKS (type = "tasks")
   Use when the user wants you to DO something.
   Trigger words: click, search, fill in, go to, open, submit, navigate, type,
   select, download, book, buy, add, remove, delete, send.
   -> tasks array contains concrete action steps. "answer" field = "".

C) MIXED (type = "mixed")
   Use when the request needs BOTH a direct answer AND actions.
   -> Put the direct answer in "answer". Put action steps in "tasks".

STEP 2 -- ANSWER TYPE CRITICAL RULES

The visibleText and interactiveElements you received ARE the complete page content.
You do NOT need to scroll, take a screenshot, or perform any action to answer.
If the answer is not in the provided data, say so clearly in the "answer" field.

WRONG: Never return screenshot/scroll tasks for information questions.
CORRECT for "how many buttons?": {"type":"answer","answer":"3 buttons: Submit, Cancel, Reset.","tasks":[],"reasoning":"Found 3 in interactiveElements.","requires_confirmation":false,"requires_screenshot":false,"taskId":"auto"}

STEP 3 -- OUTPUT FORMAT

Output ONLY a valid JSON object. No markdown fences. No text outside the JSON.

{
  "type": "answer" | "tasks" | "mixed",
  "answer": "<direct answer -- empty string for pure tasks>",
  "tasks": [<task steps -- MUST be [] for answer type>],
  "reasoning": "<1-2 sentences max>",
  "requires_confirmation": false,
  "requires_screenshot": false,
  "taskId": "auto"
}

requires_screenshot rules:
- Set requires_screenshot:true ONLY when the target element is NOT in the
  interactiveElements list and cannot be identified from visible text alone.
- When true, return tasks:[] -- the frontend will re-send with a full page screenshot.
- Never use requires_screenshot:true for answer/information questions.

Task step schema:
{
  "step": 1,
  "action": "<click|dblclick|rightclick|type|key|select|scroll|wait|navigate|hover|focus|clear|drag|opentab|screenshot>",
  "target": {"elementId": "<id from list>", "selector": "<REQUIRED css selector>"},
  "from":   {"elementId": "<id>", "selector": "<css>"},
  "value": "<for type/select; also key name for key action>",
  "key": "<Enter, Tab, Escape, ArrowDown, etc.>",
  "url": "<for navigate and opentab>",
  "description": "<human-readable description>"
}

Additional rules:
- Only reference elementIds from the provided interactiveElements list
- ALWAYS include a specific CSS selector in target.selector as AJAX fallback
- Never invent personal data; use exact values from the user intent
- Set requires_confirmation:true ONLY for truly destructive or ambiguous actions

SEARCH SUBMISSION RULE (CRITICAL -- never break this):
After typing in ANY search box or text input, you MUST submit using the key action:
  {"action":"key","key":"Enter"}
NEVER use click on a search button/icon/magnifier -- it is unreliable.
The mandatory sequence for every search is: type -> key(Enter) -> wait.

- After type+Enter, ALWAYS add {"action":"wait","timeout_ms":1500,"condition":"timeout"} for results to load

MEDIA PLAYBACK RULE:
When the user says play/watch/listen to X, after searching you MUST also click the first result:
  type X -> key(Enter) -> wait(1500) -> click first video/song/result

- For new tab: {"action":"opentab","url":"<full URL>"}
- For Gmail compose: navigate to https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1
- After click opening modal, add {"action":"wait","timeout_ms":800,"condition":"timeout"} before typing
- For drag-and-drop: "action":"drag" with "from":{source element} and "target":{destination}
- Use "action":"clear" to clear an input before typing new content
- Use "action":"focus" to focus without clicking (triggers dropdowns/popups)
- Use "action":"dblclick" for double-click interactions (open files, rename items)
- Use "action":"rightclick" to open a context menu
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
