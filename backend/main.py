"""
FastAPI application entry point.

Run with:
    uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.agent import router as agent_router

# Environment
load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# App
app = FastAPI(
    title="Privacy-Preserving Browser Vision Agent — Backend",
    description=(
        "Receives sanitized browser state from the Chrome Extension "
        "and returns the next browser action to execute. "
        "Dummy planner is used until the VLM/LLM is integrated."
    ),
    version="0.1.0",
)

# Allow the Chrome Extension (and local dev) to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(agent_router)


# Health check
@app.get("/health", tags=["infra"])
async def health() -> dict:
    return {"status": "ok", "version": app.version}


@app.get("/", tags=["infra"])
async def root() -> dict:
    return {
        "message": "Browser Vision Agent API",
        "docs": "/docs",
        "health": "/health",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
