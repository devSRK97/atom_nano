<#
.SYNOPSIS
  Build the macOS app FROM WINDOWS by running the GitHub Actions workflow on a free macOS runner,
  then download the DMG into dist\mac\.

  electron-builder cannot build macOS targets on Windows, and the native modules (terminal,
  SQLite) must be compiled on macOS - so the build runs on GitHub's Mac. Unsigned dev build:
  no Apple account is involved.

.DESCRIPTION
  What it does, in order:
    1. checks git + GitHub CLI (gh) and that you are logged in (gh auth login)
    2. initialises the repo / adds the remote if needed (default: devSRK97/atom_nano)
    3. commits your local changes (asks first) and pushes the current branch
    4. triggers .github/workflows/build-mac.yml on that branch and waits for it
    5. downloads the artifacts (DMG + zip) to dist\mac\

.EXAMPLE
  mac\build-mac.bat                 # interactive
  mac\build-mac.ps1 -Yes            # no prompts
  mac\build-mac.ps1 -NoPush         # just re-run the workflow for what is already pushed
  mac\build-mac.ps1 -Arch x64       # Intel Mac build (needs an Intel runner, see mac/README.md)
#>
param(
  [switch]$Yes,
  [switch]$NoPush,
  [string]$Branch,
  [ValidateSet("arm64", "x64")][string]$Arch = "arm64",
  [string]$Remote = "https://github.com/devSRK97/atom_nano.git",
  [string]$Workflow = "build-mac.yml",
  [string]$Out = "dist\mac"
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "[ERROR] '$cmd' not found. $hint" -ForegroundColor Red; exit 1 }
}
function Confirm-Step($question) {
  if ($Yes) { return $true }
  $a = Read-Host "$question [Y/n]"
  return (-not $a) -or ($a -match '^[Yy]')
}

Need git "Install Git for Windows: winget install Git.Git"
Need gh  "Install the GitHub CLI: winget install GitHub.cli   then run: gh auth login"

gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] GitHub CLI is not logged in. Run:  gh auth login" -ForegroundColor Red; exit 1 }

# --- repository + remote ---
if (-not (Test-Path ".git")) {
  Write-Host "Initialising git repository (branch main)..."
  git init -b main | Out-Null
}
$origin = (git remote get-url origin 2>$null)
if (-not $origin) { git remote add origin $Remote; $origin = $Remote; Write-Host "Added remote origin: $origin" }
$repo = $origin -replace '\.git$', '' -replace '^https://github\.com/', '' -replace '^git@github\.com:', ''
if (-not $Branch) { $Branch = (git symbolic-ref --short HEAD 2>$null); if (-not $Branch) { $Branch = "main" } }

# --- commit + push ---
if (-not $NoPush) {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) {
    Write-Host "Uncommitted changes:" -ForegroundColor Yellow
    $dirty | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
    if ($dirty.Count -gt 15) { Write-Host "  ... and $($dirty.Count - 15) more" }
    if (-not (Confirm-Step "Commit them before building?")) { Write-Host "Aborted."; exit 1 }
    git add -A
    git update-index --chmod=+x mac/build.sh mac/dev.sh 2>$null   # executable bits survive the Windows checkout
    git commit -q -m ("macOS build " + (Get-Date -Format "yyyy-MM-dd HH:mm"))
  }
  $hasCommit = git rev-parse -q --verify HEAD 2>$null
  if (-not $hasCommit) { Write-Host "[ERROR] Nothing committed yet - commit first (is the working tree empty?)." -ForegroundColor Red; exit 1 }
  Write-Host "Pushing $Branch to $repo ..."
  git push -u origin $Branch
  if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] push failed." -ForegroundColor Red; exit 1 }
}

# --- trigger the workflow ---
Write-Host "Starting workflow $Workflow on $repo ($Branch, arch $Arch)..."
$before = gh run list --repo $repo --workflow $Workflow --branch $Branch --limit 1 --json databaseId | ConvertFrom-Json
$beforeId = 0
if ($before) { $beforeId = @($before)[0].databaseId }
gh workflow run $Workflow --repo $repo --ref $Branch -f arch=$Arch
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] could not start the workflow. Is .github/workflows/$Workflow pushed on '$Branch', and are Actions enabled for the repo (Settings > Actions)?" -ForegroundColor Red
  exit 1
}

# the new run appears a few seconds after it is queued
$runId = 0
$runUrl = ""
for ($i = 0; $i -lt 30 -and -not $runId; $i++) {
  Start-Sleep -Seconds 3
  $latest = gh run list --repo $repo --workflow $Workflow --branch $Branch --limit 1 --json databaseId,status,url | ConvertFrom-Json
  if ($latest) {
    $l = @($latest)[0]
    if ($l.databaseId -ne $beforeId) { $runId = $l.databaseId; $runUrl = $l.url }
  }
}
if (-not $runId) { Write-Host "[ERROR] the run did not appear. Check: gh run list --repo $repo" -ForegroundColor Red; exit 1 }
Write-Host "Run $runId : $runUrl"
Write-Host "Building on GitHub's macOS runner (usually 6-12 minutes)..."
gh run watch $runId --repo $repo --exit-status
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] the build failed. Logs:  gh run view $runId --repo $repo --log-failed" -ForegroundColor Red
  exit 1
}

# --- download ---
# gh stages the artifact zip (~300 MB) in %TEMP%; use a folder next to the output so a full
# system drive never breaks the download.
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$tmp = Join-Path (Get-Location) "dist\tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP = $tmp; $env:TMP = $tmp
$dest = Join-Path $Out ("run-" + $runId)     # one folder per build, so re-runs never collide with an earlier download
gh run download $runId --repo $repo -D $dest
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] download failed. Retry with:  gh run download $runId --repo $repo -D $dest" -ForegroundColor Red
  exit 1
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done. macOS installers in $dest :" -ForegroundColor Green
Get-ChildItem -Path $dest -Recurse -Include *.dmg, *.zip | ForEach-Object { Write-Host "  $($_.FullName)" }
Write-Host ""
Write-Host "On the Mac: open the DMG, drag AtomNano to Applications, then right-click > Open the first time"
Write-Host "(unsigned dev build), or run:  xattr -dr com.apple.quarantine /Applications/AtomNano.app"
