# ============================================================
# start_tunnel.ps1 — SSH tunnel for the Visual Browser Agent
#
# Run this on your LOCAL Windows machine (PowerShell).
# Forwards:
#   localhost:9001 → college:9001   (VLM FastAPI wrapper)
#   localhost:9000 → college:9000   (vLLM direct, optional)
#
# Usage:
#   .\scripts\start_tunnel.ps1 -Remote user@college.machine.ip
# ============================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$Remote,

    [int]$LocalVlmPort    = 9001,
    [int]$RemoteVlmPort   = 9001,
    [int]$LocalVllmPort   = 9000,
    [int]$RemoteVllmPort  = 9000
)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Visual Agent — SSH Tunnel (PowerShell)"   -ForegroundColor Cyan
Write-Host "  Remote : $Remote"
Write-Host "  Tunnel : localhost:${LocalVlmPort} -> ${Remote}:${RemoteVlmPort}  (VLM wrapper)"
Write-Host "  Tunnel : localhost:${LocalVllmPort} -> ${Remote}:${RemoteVllmPort} (vLLM)"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the tunnel." -ForegroundColor Yellow
Write-Host ""

$sshArgs = @(
    "-N",
    "-L", "${LocalVlmPort}:localhost:${RemoteVlmPort}",
    "-L", "${LocalVllmPort}:localhost:${RemoteVllmPort}",
    "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=5",
    "-o", "ExitOnForwardFailure=yes",
    $Remote
)

try {
    & ssh @sshArgs
} catch {
    Write-Host "SSH tunnel exited: $_" -ForegroundColor Red
    exit 1
}
