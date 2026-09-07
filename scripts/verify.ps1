# verify.ps1 - Visual Browser Agent verification
# Usage: .\scripts\verify.ps1
# Usage (skip tunnel check): .\scripts\verify.ps1 -SkipTunnel

param([switch]$SkipTunnel)

function CheckUrl {
    param([string]$Url, [string]$Label)
    try {
        $r = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $body = $r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
        Write-Host "[OK ] $Label" -ForegroundColor Green
        return $body
    } catch {
        Write-Host "[ERR] $Label  -- $($_.Exception.Message.Split("`n")[0])" -ForegroundColor Red
        return $null
    }
}

function PostJson {
    param([string]$Url, [hashtable]$Body, [string]$Label)
    try {
        $json = $Body | ConvertTo-Json -Depth 10
        $r = Invoke-WebRequest -Uri $Url -Method POST -Body $json -ContentType "application/json" -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
        $resp = $r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
        Write-Host "[OK ] $Label" -ForegroundColor Green
        return $resp
    } catch {
        Write-Host "[ERR] $Label  -- $($_.Exception.Message.Split("`n")[0])" -ForegroundColor Red
        return $null
    }
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Visual Agent -- Verification Suite" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "-- [1] Local FastAPI backend (port 8000) --" -ForegroundColor Yellow
$backendOk = CheckUrl -Url "http://127.0.0.1:8000/" -Label "Backend root"
$agentOk   = CheckUrl -Url "http://127.0.0.1:8000/agent/status" -Label "Agent status"

if (-not $backendOk) {
    Write-Host "[INF] Start backend with:" -ForegroundColor DarkYellow
    Write-Host "      cd yolo-opencv && uvicorn server:app --host 127.0.0.1 --port 8000 --reload" -ForegroundColor DarkYellow
}
Write-Host ""

if (-not $SkipTunnel) {
    Write-Host "-- [2] SSH Tunnel -> VLM server (port 9001) --" -ForegroundColor Yellow
    $vlmHealth = CheckUrl -Url "http://localhost:9001/health" -Label "VLM wrapper health"

    if ($vlmHealth -ne $null) {
        if ($vlmHealth.vllm_reachable) {
            Write-Host "[OK ] vLLM loaded - model: $($vlmHealth.model)" -ForegroundColor Green
        } else {
            Write-Host "[ERR] vLLM not yet ready (still loading model, wait 2-5 min)" -ForegroundColor Red
            Write-Host "[INF] On college machine: curl http://localhost:9000/health" -ForegroundColor DarkYellow
        }
    } else {
        Write-Host "[INF] Start tunnel: .\scripts\start_tunnel.ps1 -Remote user@college.ip" -ForegroundColor DarkYellow
    }
    Write-Host ""
}

Write-Host "-- [3] End-to-end Q&A test --" -ForegroundColor Yellow
if ($backendOk -ne $null -and (-not $SkipTunnel)) {
    $payload = @{
        task_intent = "How many buttons are visible? List them."
        perception_state = @{
            page = @{ url = "http://test.local/"; title = "Test"; viewport = @{ width = 1280; height = 720 } }
            interactiveElements = @(
                @{ elementId = "element_1"; tag = "button"; category = "button"; text = "Submit"; rect = @{ x = 100; y = 200; width = 80; height = 36 } }
                @{ elementId = "element_2"; tag = "button"; category = "button"; text = "Cancel"; rect = @{ x = 200; y = 200; width = 80; height = 36 } }
            )
            forms = @()
            visualText = @()
            visibleText = "Submit Cancel"
            privacy = @{ sanitized = $true; rawScreenshotIncluded = $false; redactedRegionCount = 0 }
        }
        image_b64 = $null
        redaction_regions = @()
        privacy_proof = @{ sanitized = $true; rawScreenshotIncluded = $false; redactionMap = @() }
    }

    Write-Host "[INF] Sending test Q&A (this calls the VLM, may take 10-30s)..." -ForegroundColor DarkYellow
    $result = PostJson -Url "http://127.0.0.1:8000/agent/task" -Body $payload -Label "Agent Q&A test"

    if ($result -ne $null) {
        if ($result.success) {
            Write-Host "[OK ] Type    : $($result.tasks.type)" -ForegroundColor Green
            Write-Host "[OK ] Answer  : $($result.tasks.answer)" -ForegroundColor Green
            Write-Host "[OK ] Steps   : $($result.tasks.tasks.Count)" -ForegroundColor Green
            Write-Host "[OK ] Latency : $($result.latency_ms) ms" -ForegroundColor Green
        } else {
            Write-Host "[ERR] Agent error: $($result.error)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "[INF] Skipped (backend or tunnel not ready)" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Done" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Quick curl commands (run in PowerShell):"
Write-Host "  curl http://127.0.0.1:8000/health            # local backend"
Write-Host "  curl http://localhost:9001/health             # VLM wrapper via tunnel"
Write-Host "  curl http://localhost:9000/health             # vLLM direct via tunnel"
Write-Host ""
Write-Host "On the COLLEGE machine:"
Write-Host "  ps aux | grep vllm                           # is vLLM process running?"
Write-Host "  curl http://localhost:9000/health            # vLLM ready?"
Write-Host "  curl http://localhost:9001/health            # wrapper ready?"
Write-Host ""
