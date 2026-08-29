"""
DummyPlanner — a simple rule-based planner for prototyping.

Replace this with a VLM/LLM-backed planner when the model is ready.
The interface (plan method signature) must stay the same.

Decision logic:
  1. Parse intent keywords from the task string.
  2. Match against available UI elements (by role, tag, text).
  3. Return the best-fit action.
"""

from __future__ import annotations

import re
import logging

from models.schemas import AgentAction, ActionType, AgentStepRequest, UIElement
from planner.base import BasePlanner

logger = logging.getLogger(__name__)

# Roles / tags considered clickable
CLICKABLE_ROLES = {"button", "link", "checkbox", "radio", "menuitem", "tab", "option"}
CLICKABLE_TAGS = {"button", "a", "select"}

# Roles / tags that accept text input
INPUT_ROLES = {"textbox", "searchbox", "combobox", "spinbutton"}
INPUT_TAGS = {"input", "textarea"}


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _element_matches_keywords(element: UIElement, keywords: list[str]) -> bool:
    """Return True if any keyword appears in the element's text or attributes."""
    haystack = _normalize(element.text)
    haystack += " " + _normalize(element.role)
    haystack += " " + " ".join(_normalize(v) for v in element.attributes.values())
    return any(kw in haystack for kw in keywords)


def _extract_type_value(task: str) -> str:
    """
    Try to pull out the value to type from the task string.

    Handles patterns like:
      'type "hello world" into the search box'
      "enter john@example.com in email field"
    """
    # Quoted value
    quoted = re.search(r'["\'](.+?)["\']', task)
    if quoted:
        return quoted.group(1)

    # After "type" / "enter" / "input" / "fill"
    match = re.search(
        r"\b(?:type|enter|input|fill(?:\s+in)?)\s+(.+?)(?:\s+(?:in(?:to)?|on|at|to)\b|$)",
        task,
        re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()

    return ""


class DummyPlanner(BasePlanner):
    """
    Keyword-matching planner — no AI required.

    Future replacement path:
        class VLMPlanner(BasePlanner):
            def plan(self, context: AgentStepRequest) -> tuple[AgentAction, str]:
                prompt = ContextBuilder.build(context)
                raw = vlm_client.complete(prompt)
                action = ActionValidator.parse(raw)
                return action, raw
    """

    def plan(self, context: AgentStepRequest) -> tuple[AgentAction, str]:
        task_lower = _normalize(context.task)
        elements = context.ui_elements

        logger.debug(
            "DummyPlanner.plan | task=%r | elements=%d | url=%s",
            context.task,
            len(elements),
            context.url,
        )

        # 1. DONE / finish intent
        if any(kw in task_lower for kw in ("done", "finish", "complete", "stop", "exit")):
            action = AgentAction(type=ActionType.DONE)
            return action, "Task marked as done by user intent."

        # 2. SCROLL intent
        if any(kw in task_lower for kw in ("scroll", "page down", "page up")):
            direction = -500 if "up" in task_lower else 500
            action = AgentAction(type=ActionType.SCROLL, scroll_x=0, scroll_y=direction)
            return action, f"Scrolling {'up' if direction < 0 else 'down'} by {abs(direction)}px."

        # 3. TYPE / FILL intent
        if any(kw in task_lower for kw in ("type", "fill", "enter", "input", "write", "search")):
            value = _extract_type_value(context.task)
            task_keywords = [w for w in task_lower.split() if len(w) > 2]

            # Find best matching input element
            target = self._find_element(
                elements,
                preferred_roles=INPUT_ROLES,
                preferred_tags=INPUT_TAGS,
                keywords=task_keywords,
            )

            if target:
                action = AgentAction(
                    type=ActionType.TYPE,
                    target_id=target.id,
                    value=value or "",
                )
                return action, (
                    f"Found input element '{target.id}' (role={target.role}, "
                    f"text='{target.text}'). Typing: '{value}'."
                )

        # 4. CLICK intent (default for most actions)
        if any(kw in task_lower for kw in (
            "click", "press", "tap", "submit", "open", "select", "choose",
            "navigate", "go to", "login", "sign in", "sign up", "register",
        )):
            task_keywords = [w for w in task_lower.split() if len(w) > 2]

            target = self._find_element(
                elements,
                preferred_roles=CLICKABLE_ROLES,
                preferred_tags=CLICKABLE_TAGS,
                keywords=task_keywords,
            )

            if target:
                action = AgentAction(type=ActionType.CLICK, target_id=target.id)
                return action, (
                    f"Clicking element '{target.id}' (role={target.role}, text='{target.text}')."
                )

        # 5. Fallback: try any clickable element, then WAIT
        clickable = [
            el for el in elements
            if el.role in CLICKABLE_ROLES or el.tag in CLICKABLE_TAGS
        ]
        if clickable:
            target = clickable[0]
            action = AgentAction(type=ActionType.CLICK, target_id=target.id)
            return action, (
                f"No clear intent matched. Falling back to clicking first "
                f"clickable element '{target.id}' (role={target.role})."
            )

        action = AgentAction(type=ActionType.WAIT, wait_ms=1000)
        return action, "No matching elements found. Waiting 1 second."

    # Helpers

    @staticmethod
    def _find_element(
        elements: list[UIElement],
        preferred_roles: set[str],
        preferred_tags: set[str],
        keywords: list[str],
    ) -> UIElement | None:
        """
        Priority:
          1. Preferred role/tag AND keyword match
          2. Keyword match only
          3. First preferred role/tag element
          4. None
        """
        preferred_keyword_matches = [
            el for el in elements
            if (el.role in preferred_roles or el.tag in preferred_tags)
            and _element_matches_keywords(el, keywords)
        ]
        if preferred_keyword_matches:
            return preferred_keyword_matches[0]

        keyword_matches = [
            el for el in elements
            if _element_matches_keywords(el, keywords)
        ]
        if keyword_matches:
            return keyword_matches[0]

        preferred = [
            el for el in elements
            if el.role in preferred_roles or el.tag in preferred_tags
        ]
        if preferred:
            return preferred[0]

        return None
