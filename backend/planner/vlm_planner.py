"""VLM-backed planner that returns actions accepted by the extension."""

from models.schemas import AgentAction, AgentStepRequest
from planner.base import BasePlanner
from planner.prompt_builder import build_context
from services.action_validator import ActionValidationError, parse_and_validate
from services.vlm_client import VLMClient


class VLMPlanner(BasePlanner):
    def __init__(self, client: VLMClient | None = None) -> None:
        self.client = client or VLMClient()

    async def plan(self, context: AgentStepRequest) -> tuple[AgentAction, str]:
        prompt = build_context(context)
        raw_output = await self.client.complete(prompt, context.sanitized_screenshot_b64)
        try:
            return parse_and_validate(raw_output, context.ui_elements)
        except ActionValidationError as exc:
            repair_prompt = (
                f"Your previous response was invalid: {exc}.\n"
                "Return only one valid JSON object matching the required action schema. "
                "Use an element id exactly as listed in the previous context."
            )
            repaired_output = await self.client.complete(
                f"{prompt}\n\n{repair_prompt}", context.sanitized_screenshot_b64
            )
            return parse_and_validate(repaired_output, context.ui_elements)
