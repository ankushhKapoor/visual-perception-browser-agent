# Windows PowerShell launcher for hosted OpenAI or Gemini providers.
# Local vLLM should be run with start.sh in WSL or Linux.

param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".env"

if (Test-Path -LiteralPath $EnvFile) {
    Get-Content -LiteralPath $EnvFile | ForEach-Object {
        $Line = $_.Trim()
        if ($Line.Length -eq 0) { return }
        if ($Line.StartsWith("#")) { return }
        $Pair = $Line.Split("=", 2)
        if ($Pair.Count -ne 2) { return }
        $Name = $Pair[0].Trim()
        $Value = $Pair[1].Trim()
        if ($Name.Length -gt 0) {
            [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
        }
    }
}

$Provider = $env:MODEL_PROVIDER
if ([string]::IsNullOrWhiteSpace($Provider)) { $Provider = "local" }
$Provider = $Provider.Trim().ToLowerInvariant()

$ServerPort = $env:VLM_SERVER_PORT
if ([string]::IsNullOrWhiteSpace($ServerPort)) { $ServerPort = "9001" }

if ($Provider -eq "local") {
    throw "Use WSL/Linux and server-vlm/start.sh for MODEL_PROVIDER=local."
}
if (($Provider -ne "gemini") -and ($Provider -ne "openai")) {
    throw "MODEL_PROVIDER must be gemini or openai on Windows."
}

$ApiKey = $env:GEMINI_API_KEY
if ($Provider -eq "openai") { $ApiKey = $env:OPENAI_API_KEY }
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw "The API key for the selected provider is missing in server-vlm/.env."
}

Write-Host "Starting model server"
Write-Host "Provider: $Provider"
Write-Host "Port: $ServerPort"

Push-Location $ScriptDir
try {
    & $Python -c "import fastapi, uvicorn, httpx, PIL, openai"
    if ($LASTEXITCODE -ne 0) {
        throw "Python dependencies are missing. Run python -m pip install -r server-vlm/requirements.txt"
    }
    & $Python -m uvicorn main:app --host 0.0.0.0 --port $ServerPort --workers 1 --log-level info
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
