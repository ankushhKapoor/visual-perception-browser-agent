"""
Configuration for the VLM server running on the college machine.
Served via vLLM with an OpenAI-compatible API endpoint.
"""

import os
from dataclasses import dataclass, field


@dataclass
class VLMConfig:
    # vLLM endpoint (running locally on college machine)
    vllm_base_url: str = os.getenv("VLLM_BASE_URL", "http://localhost:9000/v1")

    # Model name as registered in vLLM
    model_name: str = os.getenv("MODEL_NAME", "Qwen/Qwen2.5-VL-3B-Instruct")

    # Max tokens in VLM response
    max_response_tokens: int = int(os.getenv("MAX_RESPONSE_TOKENS", "2048"))

    # Max interactive elements to include in context (saves tokens)
    max_interactive_elements: int = int(os.getenv("MAX_INTERACTIVE_ELEMENTS", "60"))

    # Max characters for visible text summary sent to VLM
    max_visible_text_chars: int = int(os.getenv("MAX_VISIBLE_TEXT_CHARS", "2000"))

    # Max visual text items to include in context
    max_visual_text_items: int = int(os.getenv("MAX_VISUAL_TEXT_ITEMS", "30"))

    # VLM inference temperature (0 = deterministic JSON)
    temperature: float = float(os.getenv("TEMPERATURE", "0.1"))

    # VLM server port (the FastAPI wrapper, not vLLM directly)
    server_host: str = os.getenv("VLM_SERVER_HOST", "0.0.0.0")
    server_port: int = int(os.getenv("VLM_SERVER_PORT", "9001"))

    # Max retries for JSON parsing if VLM outputs malformed JSON
    max_parse_retries: int = int(os.getenv("MAX_PARSE_RETRIES", "2"))

    # Request timeout for vLLM (seconds)
    vllm_timeout: int = int(os.getenv("VLLM_TIMEOUT", "120"))


# Singleton config
config = VLMConfig()
