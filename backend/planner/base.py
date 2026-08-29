"""
Abstract base class for all planners.

Swap out DummyPlanner for a VLM-backed planner without touching the router.
"""

from abc import ABC, abstractmethod

from models.schemas import AgentStepRequest, AgentAction


class BasePlanner(ABC):
    """Interface that every planner must implement."""

    @abstractmethod
    def plan(self, context: AgentStepRequest) -> tuple[AgentAction, str]:
        """
        Given the current browser context, decide the next action.

        Returns:
            action   — the AgentAction to execute
            reasoning — human-readable explanation (useful for debugging / UI display)
        """
        ...
