#!/usr/bin/env bash
# ============================================================
# College machine startup script
# Run this on the COLLEGE machine to start vLLM + VLM server
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# .env is local and git-ignored. Export its provider/API configuration only to
# this server process; the extension never receives these values.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +a
fi

MODEL="${MODEL_NAME:-Qwen/Qwen2.5-VL-3B-Instruct}"
PROVIDER="${MODEL_PROVIDER:-local}"
if [ "$PROVIDER" = "openai" ]; then
  MODEL="${OPENAI_MODEL:-gpt-5-mini}"
elif [ "$PROVIDER" = "gemini" ]; then
  MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
fi
VLLM_PORT="${VLLM_PORT:-9000}"
SERVER_PORT="${VLM_SERVER_PORT:-9001}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
GPU_UTIL="${GPU_UTIL:-0.88}"

echo "============================================"
echo "  Visual Browser Agent — Model Server"
echo "============================================"
echo "Model          : $MODEL"
echo "Provider       : $PROVIDER"
echo "vLLM port      : $VLLM_PORT"
echo "Wrapper port   : $SERVER_PORT"
echo "Max model len  : $MAX_MODEL_LEN"
echo "GPU utilisation: $GPU_UTIL"
echo ""

# Hosted provider: no local vLLM process or GPU is required.
if [ "$PROVIDER" = "openai" ] || [ "$PROVIDER" = "gemini" ]; then
  if [ "$PROVIDER" = "openai" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "ERROR: OPENAI_API_KEY is required when MODEL_PROVIDER=openai"
    exit 1
  fi
  if [ "$PROVIDER" = "gemini" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
    echo "ERROR: GEMINI_API_KEY is required when MODEL_PROVIDER=gemini"
    exit 1
  fi
  echo "[1/1] Starting hosted-provider wrapper..."
  cd "$SCRIPT_DIR"
  exec uvicorn main:app --host 0.0.0.0 --port "$SERVER_PORT" --workers 1 --log-level info
fi

if [ "$PROVIDER" != "local" ]; then
  echo "ERROR: MODEL_PROVIDER must be local, openai, or gemini"
  exit 1
fi

# Local provider: start vLLM in the background.
echo "[1/2] Starting vLLM..."
vllm serve "$MODEL" \
  --host 127.0.0.1 \
  --port "$VLLM_PORT" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_UTIL" \
  --trust-remote-code \
  --dtype bfloat16 \
  &

VLLM_PID=$!
echo "      vLLM PID: $VLLM_PID"

# Wait for vLLM to be ready
echo "      Waiting for vLLM to be ready..."
MAX_WAIT=120
WAITED=0
until curl -s "http://127.0.0.1:${VLLM_PORT}/health" > /dev/null 2>&1; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: vLLM did not become ready in ${MAX_WAIT}s"
    kill $VLLM_PID 2>/dev/null || true
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo "      Still waiting... (${WAITED}s)"
done
echo "      vLLM is ready!"

# 2. Start the FastAPI wrapper
echo "[2/2] Starting VLM wrapper server..."
cd "$SCRIPT_DIR"

VLLM_BASE_URL="http://127.0.0.1:${VLLM_PORT}/v1" \
MODEL_NAME="$MODEL" \
VLM_SERVER_PORT="$SERVER_PORT" \
  uvicorn main:app \
    --host 0.0.0.0 \
    --port "$SERVER_PORT" \
    --workers 1 \
    --log-level info

# If the wrapper exits, also kill vLLM
kill $VLLM_PID 2>/dev/null || true
