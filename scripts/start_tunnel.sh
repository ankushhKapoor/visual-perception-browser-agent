#!/usr/bin/env bash
# ============================================================
# start_tunnel.sh — SSH tunnel for the Visual Browser Agent
#
# Run this on your LOCAL (Windows WSL / macOS / Linux) machine.
# Forwards:
#   localhost:9001 → college:9001   (VLM FastAPI wrapper)
#   localhost:9000 → college:9000   (vLLM direct, optional)
#
# Usage:
#   ./scripts/start_tunnel.sh user@college.machine.ip
# ============================================================

set -euo pipefail

REMOTE="${1:-}"
LOCAL_VLM_PORT="${LOCAL_VLM_PORT:-9001}"
REMOTE_VLM_PORT="${REMOTE_VLM_PORT:-9001}"
LOCAL_VLLM_PORT="${LOCAL_VLLM_PORT:-9000}"
REMOTE_VLLM_PORT="${REMOTE_VLLM_PORT:-9000}"

if [ -z "$REMOTE" ]; then
  echo "Usage: $0 user@college.machine.ip"
  echo ""
  echo "Environment variables (optional):"
  echo "  LOCAL_VLM_PORT   (default 9001) — local port for VLM wrapper"
  echo "  REMOTE_VLM_PORT  (default 9001) — remote port for VLM wrapper"
  echo "  LOCAL_VLLM_PORT  (default 9000) — local port for vLLM direct"
  echo "  REMOTE_VLLM_PORT (default 9000) — remote port for vLLM"
  exit 1
fi

echo "============================================"
echo "  Visual Agent — SSH Tunnel"
echo "  Remote : $REMOTE"
echo "  Tunnel : localhost:${LOCAL_VLM_PORT} → ${REMOTE}:${REMOTE_VLM_PORT}  (VLM wrapper)"
echo "  Tunnel : localhost:${LOCAL_VLLM_PORT} → ${REMOTE}:${REMOTE_VLLM_PORT} (vLLM)"
echo "============================================"
echo "Press Ctrl+C to stop the tunnel."
echo ""

ssh -N \
  -L "${LOCAL_VLM_PORT}:localhost:${REMOTE_VLM_PORT}" \
  -L "${LOCAL_VLLM_PORT}:localhost:${REMOTE_VLLM_PORT}" \
  -o ServerAliveInterval=60 \
  -o ServerAliveCountMax=5 \
  -o ExitOnForwardFailure=yes \
  "$REMOTE"
