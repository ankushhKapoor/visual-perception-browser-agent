"""Runtime configuration for the backend and external VLM service."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    planner_mode: str = os.getenv("PLANNER_MODE", "vlm").lower()
    vlm_base_url: str = os.getenv("VLM_BASE_URL", "http://localhost:8001/v1")
    vlm_model: str = os.getenv("VLM_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
    vlm_api_key: str = os.getenv("VLM_API_KEY", "EMPTY")
    vlm_timeout_seconds: float = float(os.getenv("VLM_TIMEOUT_SECONDS", "60"))
    vlm_temperature: float = float(os.getenv("VLM_TEMPERATURE", "0.1"))


settings = Settings()
