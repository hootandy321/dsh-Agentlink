#!/usr/bin/env pwsh
# ZCode plugin install script for dsh-agentlink
# Run this after setting up the DSH Web Host to configure the MCP server.
#
# Usage:
#   .\scripts\install.ps1
#   .\scripts\install.ps1 -NodePath "C:\path\to\node.exe" -HostUrl "http://127.0.0.1:3080"

param(
    [string]$NodePath = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2\node.exe",
    [string]$HostUrl = "http://127.0.0.1:3080",
    [string]$Preset = "code",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$BridgeRoot = $PSScriptRoot
$RepoRoot = Split-Path $BridgeRoot -Parent
$BridgeEntry = Join-Path $RepoRoot "dist\index.js"
$ZCodeConfig = Join-Path $env:USERPROFILE ".zcode\cli\config.json"

Write-Host "=== dsh-agentlink ZCode Install ===" -ForegroundColor Cyan

# Check Node.js
if (-not (Test-Path $NodePath)) {
    Write-Host "[ERROR] Node not found at: $NodePath" -ForegroundColor Red
    exit 1
}

# Check bridge entry point
if (-not (Test-Path $BridgeEntry)) {
    Write-Host "[INFO] Building dsh-agentlink..." -ForegroundColor Yellow
    Set-Location $RepoRoot
    & $NodePath npm install --silent 2>&1 | Out-Null
    & $NodePath npm run build 2>&1 | Out-Null
    if (-not (Test-Path $BridgeEntry)) {
        Write-Host "[ERROR] Build failed: $BridgeEntry not found" -ForegroundColor Red
        exit 1
    }
}

# Check DSH host
$hostReachable = $false
try {
    $resp = Invoke-RestMethod -Uri $HostUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    $hostReachable = $true
} catch {
    Write-Host "[WARN] DSH Host not reachable at $HostUrl" -ForegroundColor Yellow
    Write-Host "  Start it with: dsh web --profile web --port 3080"
    $continue = Read-Host "Continue anyway? [y/N]"
    if ($continue -notin @("y","Y","yes")) { exit 0 }
}

# Build MCP config
$mcpBlock = @{
    mcp = @{
        servers = @{
            dsh_agentlink = @{
                command = $NodePath
                args = @($BridgeEntry)
                cwd = "${ZCODE_PROJECT_DIR}"
                env = @{
                    "DSH_HOST_URL" = $HostUrl
                    "DSH_BRIDGE_AGENT_PRESET" = $Preset
                }
                tools = @{
                    "dsh_resolve_approval" = @{
                        "approval_mode" = "prompt"
                    }
                }
            }
        }
    }
}

$config = @{}
if (Test-Path $ZCodeConfig) {
    $existing = Get-Content $ZCodeConfig | ConvertFrom-Json
    $config = @{ plugins = $existing.plugins }
}
$config.mcp = $mcpBlock.mcp

if ($DryRun) {
    Write-Host "# Would write to $ZCodeConfig" -ForegroundColor Gray
    $config | ConvertTo-Json -Depth 10
    exit 0
}

$config | ConvertTo-Json -Depth 10 | Out-File $ZCodeConfig -Encoding UTF8
Write-Host "[OK] Config written to $ZCodeConfig" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart ZCode to load the new MCP server"
Write-Host "  2. In a new session, use /dsh-collab skill or call mcp__dsh_agentlink__dsh_host_status"
if ($hostReachable) {
    Write-Host "  3. DSH Host is running at $HostUrl"
} else {
    Write-Host "  3. Start DSH Web Host first: dsh web --profile web --port 3080"
}
