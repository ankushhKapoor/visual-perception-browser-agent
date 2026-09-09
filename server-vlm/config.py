"""
Configuration for the VLM server running on the college machine.
Served via vLLM with an OpenAI-compatible API endpoint.
"""

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
except ImportError:  # Environment variables still work without the convenience loader.
    def load_dotenv() -> bool:
        return False


# Loads server-vlm/.env when the service is started from this directory. The
# file is git-ignored; production deployments can use normal environment vars.
load_dotenv()


def _env(name: str, default: str | None = None) -> str | None:
    """Read and trim .env values; avoids accidental whitespace/newlines."""
    value = os.getenv(name, default)
    return value.strip() if isinstance(value, str) else value


@dataclass
class VLMConfig:
    # Provider is intentionally local by default. Hosted providers receive only
    # the already-sanitized request assembled by the extension/backend.
    provider: str = (_env("MODEL_PROVIDER", "local") or "local").lower()

    # vLLM endpoint (running locally on college machine)
    vllm_base_url: str = _env("VLLM_BASE_URL", "http://localhost:9000/v1") or "http://localhost:9000/v1"

    # Model name as registered in vLLM
    model_name: str = _env("MODEL_NAME", "Qwen/Qwen2.5-VL-3B-Instruct") or "Qwen/Qwen2.5-VL-3B-Instruct"

    # Hosted-provider configuration. Keep keys in the server environment only;
    # never expose them in the extension, UI, logs, or task payload.
    openai_api_key: str | None = _env("OPENAI_API_KEY")
    openai_model: str = _env("OPENAI_MODEL", "gpt-5-mini") or "gpt-5-mini"
    gemini_api_key: str | None = _env("GEMINI_API_KEY")
    gemini_model: str = _env("GEMINI_MODEL", "gemini-3.8-flash") or "gemini-3.8-flash"
    gemini_api_revision: str = _env("GEMINI_API_REVISION", "2026-05-20") or "2026-05-20"

    # Max tokens in VLM response (keep small — JSON answers rarely exceed 600 tokens)
    max_response_tokens: int = int(os.getenv("MAX_RESPONSE_TOKENS", "1024"))

    # Max interactive elements to include in context (saves tokens)
    max_interactive_elements: int = int(os.getenv("MAX_INTERACTIVE_ELEMENTS", "16"))

    # Max characters for visible text summary sent to VLM
    max_visible_text_chars: int = int(os.getenv("MAX_VISIBLE_TEXT_CHARS", "800"))

    # Max visual text items to include in context
    max_visual_text_items: int = int(os.getenv("MAX_VISUAL_TEXT_ITEMS", "20"))

    # Provider-neutral input budgets. Screenshot capture is text-first by
    # default in the extension; when an image is needed, resize it here before
    # any local or hosted model sees it.
    max_image_side_px: int = int(os.getenv("MAX_IMAGE_SIDE_PX", "1024"))
    image_jpeg_quality: int = int(os.getenv("IMAGE_JPEG_QUALITY", "75"))

    # VLM inference temperature (0 = deterministic JSON)
    temperature: float = float(os.getenv("TEMPERATURE", "0.1"))

    # VLM server port (the FastAPI wrapper, not vLLM directly)
    server_host: str = os.getenv("VLM_SERVER_HOST", "0.0.0.0")
    server_port: int = int(os.getenv("VLM_SERVER_PORT", "9001"))

    # Max retries for JSON parsing if VLM outputs malformed JSON
    max_parse_retries: int = int(os.getenv("MAX_PARSE_RETRIES", "2"))

    # Request timeout for vLLM (seconds)
    vllm_timeout: int = int(os.getenv("VLLM_TIMEOUT", "120"))

    @property
    def active_model_name(self) -> str:
        if self.provider == "openai":
            return self.openai_model
        if self.provider == "gemini":
            return self.gemini_model
        return self.model_name


# Singleton config
config = VLMConfig()
