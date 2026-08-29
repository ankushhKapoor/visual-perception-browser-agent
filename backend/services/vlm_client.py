"""HTTP client for an OpenAI-compatible Qwen VLM server."""

import base64

import httpx

from config import settings
from planner.prompt_builder import SYSTEM_PROMPT


class VLMClientError(RuntimeError):
    """Raised when the external VLM cannot produce a response."""


class VLMClient:
    async def complete(self, prompt: str, screenshot_b64: str | None) -> str:
        user_content: list[dict[str, object]] = [{"type": "text", "text": prompt}]
        if screenshot_b64:
            image_data = screenshot_b64
            if not image_data.startswith("data:"):
                image_data = f"data:image/png;base64,{image_data}"
            try:
                base64.b64decode(image_data.split(",", 1)[-1], validate=True)
            except (ValueError, base64.binascii.Error) as exc:
                raise VLMClientError("Invalid sanitized screenshot encoding") from exc
            user_content.append({"type": "image_url", "image_url": {"url": image_data}})

        payload = {
            "model": settings.vlm_model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            "temperature": settings.vlm_temperature,
            "max_tokens": 300,
        }
        headers = {"Authorization": f"Bearer {settings.vlm_api_key}"}

        try:
            async with httpx.AsyncClient(timeout=settings.vlm_timeout_seconds) as client:
                response = await client.post(
                    f"{settings.vlm_base_url.rstrip('/')}/chat/completions",
                    json=payload,
                    headers=headers,
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except (httpx.HTTPError, KeyError, IndexError, TypeError) as exc:
            raise VLMClientError(f"VLM request failed: {exc}") from exc

