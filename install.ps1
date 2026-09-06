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

    Steps 3-4 are for working on the extension itself. Pass -EnginesOnly to
    build just the Python and Rust engines that the CLI and the MCP server use;
    npm is then not required at all.

    You do not need this script to use Vinv. The editor extension installs from
    the marketplace and builds the engines itself on first run, and the MCP
    server is `pip install vinv` plus `npx -y vinv-mcp`. Build from source to
    work on Vinv.

.PARAMETER EnginesOnly
    Skip packaging the editor extension and skip installing it into your
    editors. Alias: -NoExtension.

.EXAMPLE
    git clone https://github.com/VinvAI/VinvAI $HOME\.vinv\engines
    cd $HOME\.vinv\engines
    .\install.ps1

.EXAMPLE
    .\install.ps1 -EnginesOnly

.NOTES
    If script execution is blocked, run it for this session only with:
      powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

[CmdletBinding()]
param(
    [Alias('NoExtension')]
    [switch] $EnginesOnly
)

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
#
# The preference dance matters as much as the exit code. Under PowerShell 5.1 a
# native command's stderr is wrapped in an ErrorRecord whenever that stream is
# redirected -- `.\install.ps1 2>&1` from CI, say -- and $ErrorActionPreference
# 'Stop' then turns it terminating. uv and cargo both write ordinary progress to
# stderr, so the build would die on its own output. Exit codes are the real
# signal, so drop to 'Continue' for the call itself and judge the result here.
function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string] $What,
        [Parameter(Mandatory)] [string] $Exe,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $Arguments,
        # Set for the editor installs: one editor refusing the VSIX must not
        # abort the others.
        [switch] $IgnoreExitCode
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments
    } finally {
        $ErrorActionPreference = $previous
    }
    if (-not $IgnoreExitCode -and $LASTEXITCODE -ne 0) {
        throw "$What failed (exit code $LASTEXITCODE)."
    }
}

# npm is a prerequisite of step 3 only, so -EnginesOnly must not demand it.
# Everything still required is checked up front: a missing tool should surface
# now, not three minutes into a release build of the Rust index.
$missing = @()
if (-not (Test-Tool 'uv'))    { $missing += 'uv    -> https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Tool 'cargo')) { $missing += 'cargo -> https://rustup.rs' }
if (-not $EnginesOnly -and -not (Test-Tool 'npm')) {
    $missing += 'npm   -> https://nodejs.org  (or pass -EnginesOnly)'
}
if ($missing.Count -gt 0) {
    Write-Host 'Missing prerequisites:' -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "  $m" }
    exit 1
}

$steps = if ($EnginesOnly) { 2 } else { 4 }

Write-Host "==> [1/$steps] Python engines (uv sync)"
Invoke-Native -What 'uv sync' -Exe 'uv' -Arguments @('sync')

Write-Host "==> [2/$steps] Rust index (cargo build --release)"
Invoke-Native -What 'cargo build' -Exe 'cargo' -Arguments @('build', '--release', '--manifest-path', 'index/Cargo.toml')

if ($EnginesOnly) {
    Write-Host ''
    Write-Host 'Done -- engines only. The CLI and the MCP server can use them now.'
    Write-Host '(First index build downloads the local embedding model once, ~500 MB.)'
    exit 0
}

Write-Host "==> [3/$steps] Editor extension (npm install + package)"
Invoke-Native -What 'npm install' -Exe 'npm' -Arguments @('install', '--prefix', 'extension', '--no-fund', '--no-audit')

$vsix = Join-Path $PSScriptRoot 'vinv.vsix'
Push-Location extension
try {
    Invoke-Native -What 'vsce package' -Exe 'npx' -Arguments @('--yes', '@vscode/vsce', 'package', '--no-rewrite-relative-links', '-o', $vsix) | Out-Null
} finally {
    Pop-Location
}
Write-Host '    built vinv.vsix'

# Detect first and say so before overwriting anything: --force replaces an
# already-installed Vinv, including one from the marketplace, with this local
# build. Announcing the list beforehand is what makes that a choice.
Write-Host "==> [4/$steps] Installing the extension into detected editors"
$editors = @(@('code', 'cursor', 'windsurf', 'codium', 'trae') | Where-Object { Test-Tool $_ })

if ($editors.Count -eq 0) {
    Write-Host "    no editor CLI found -- install manually: Extensions -> ... -> Install from VSIX... -> $vsix"
} else {
    Write-Host "    replacing any installed Vinv in: $($editors -join ', ')"
    Write-Host '    (skip this step with -EnginesOnly; restore the released build with'
    Write-Host '     <editor> --install-extension VinvAI.VinvAI)'
    foreach ($editor in $editors) {
        Write-Host "    $editor --install-extension vinv.vsix"
        Invoke-Native -What $editor -Exe $editor -Arguments @('--install-extension', $vsix, '--force') -IgnoreExitCode | Out-Null
    }
}

Write-Host ''
Write-Host 'Done. Open your repo in the editor -- the Vinv panel takes it from here.'
Write-Host '(First index build downloads the local embedding model once, ~500 MB.)'
