#Requires -Version 5.1
<#
.SYNOPSIS
    Vinv -- one-command install from a clone of this repo (Windows).

.DESCRIPTION
    The PowerShell counterpart to install.sh. Builds everything from source
    (no downloads, no accounts):

      1. uv sync                -- Python engines + the local embedding sidecar
      2. cargo build --release  -- the Rust semantic index
      3. npm install + package  -- the editor extension (VSIX)
      4. installs the VSIX into every detected editor CLI

.EXAMPLE
    git clone https://github.com/VinvAI/VinvAI $HOME\.vinv\engines
    cd $HOME\.vinv\engines
    .\install.ps1

.NOTES
    If script execution is blocked, run it for this session only with:
      powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Get-Command throws under -ErrorAction Stop and merely warns otherwise, so wrap
# it: this must be a plain boolean test, never a terminating error.
function Test-Tool([string] $Name) {
    try {
        $null = Get-Command $Name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# Native executables set $LASTEXITCODE rather than throwing, so every build step
# is checked explicitly -- otherwise a failed cargo build would sail on and the
# script would report success with no binary.
function Assert-LastExitCode([string] $What) {
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit code $LASTEXITCODE)."
    }
}

$missing = @()
if (-not (Test-Tool 'uv'))    { $missing += 'uv    -> https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Tool 'cargo')) { $missing += 'cargo -> https://rustup.rs' }
if (-not (Test-Tool 'npm'))   { $missing += 'npm   -> https://nodejs.org' }
if ($missing.Count -gt 0) {
    Write-Host 'Missing prerequisites:' -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  $m" }
    exit 1
}

Write-Host '==> [1/4] Python engines (uv sync)'
uv sync
Assert-LastExitCode 'uv sync'

Write-Host '==> [2/4] Rust index (cargo build --release)'
cargo build --release --manifest-path index/Cargo.toml
Assert-LastExitCode 'cargo build'

Write-Host '==> [3/4] Editor extension (npm install + package)'
npm install --prefix extension --no-fund --no-audit
Assert-LastExitCode 'npm install'

$vsix = Join-Path $PSScriptRoot 'vinv.vsix'
Push-Location extension
try {
    npx --yes @vscode/vsce package --no-rewrite-relative-links -o $vsix | Out-Null
    Assert-LastExitCode 'vsce package'
} finally {
    Pop-Location
}
Write-Host '    built vinv.vsix'

Write-Host '==> [4/4] Installing the extension into detected editors'
$installed = 0
foreach ($editor in @('code', 'cursor', 'windsurf', 'codium', 'trae')) {
    if (Test-Tool $editor) {
        Write-Host "    $editor --install-extension vinv.vsix"
        & $editor --install-extension $vsix --force | Out-Null
        # A single editor refusing the VSIX must not abort the others.
        if ($LASTEXITCODE -eq 0) { $installed++ }
    }
}
if ($installed -eq 0) {
    Write-Host "    no editor CLI found -- install manually: Extensions -> ... -> Install from VSIX... -> $vsix"
}

Write-Host ''
Write-Host 'Done. Open your repo in the editor -- the Vinv panel takes it from here.'
Write-Host '(First index build downloads the local embedding model once, ~500 MB.)'
