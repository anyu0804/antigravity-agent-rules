# ============================================================================
# Antigravity Agent Rules - Uninstaller (uninstall.ps1)
# ----------------------------------------------------------------------------
# Restores ~/.gemini from the most recent backup_antigravity_rules_* snapshot:
#   1. Restores files/directories that existed before installation from the
#      latest backup_antigravity_rules_* directory.
#   2. Deletes files and plugin/skill directories that did not exist before
#      installation.
#   3. In config.json, removes only the 5 plugin entries owned by this repo
#      (anyi-global-rules, search-routing, docx-delivery,
#      lieflat-less-ai-tone, humanizer-zh), preserving all other settings.
#   4. Requires 'y' confirmation by default (use -Force to skip).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -Force
# ============================================================================

param(
    [string]$TargetHome = $env:USERPROFILE,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TargetHome)) {
    throw "TargetHome cannot be empty."
}

$TargetHome = [System.IO.Path]::GetFullPath($TargetHome)
$GeminiDir  = Join-Path $TargetHome '.gemini'
$ConfigDir  = Join-Path $GeminiDir 'config'
$Utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $GeminiDir)) {
    Write-Host "Directory '$GeminiDir' does not exist. Nothing to uninstall."
    exit 0
}

# Find the most recent backup_antigravity_rules_* directory
$BackupDirs = @(
    Get-ChildItem -LiteralPath $GeminiDir -Directory -Filter 'backup_antigravity_rules_*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
)

if ($BackupDirs.Count -eq 0) {
    Write-Error "No 'backup_antigravity_rules_*' directory found in '$GeminiDir'. Cannot safely determine pre-install state."
    exit 1
}

$LatestBackup   = $BackupDirs[0].FullName
$ConfigJsonPath = Join-Path $ConfigDir 'config.json'

# Read install mode from the backup manifest (hook-only installs never touched config.json)
$InstallMode  = 'full'
$ManifestPath = Join-Path $LatestBackup 'manifest.json'
if (Test-Path -LiteralPath $ManifestPath) {
    try {
        $mf = [System.IO.File]::ReadAllText($ManifestPath, $Utf8NoBom) | ConvertFrom-Json
        if ($null -ne $mf.PSObject.Properties['mode'] -and $mf.mode -eq 'hook-only') {
            $InstallMode = 'hook-only'
        }
    } catch { }
}

# Pre-parse config.json before modifying anything
$cfgObj = $null
if (Test-Path -LiteralPath $ConfigJsonPath) {
    $rawCfg = [System.IO.File]::ReadAllText($ConfigJsonPath, $Utf8NoBom)
    if (-not [string]::IsNullOrWhiteSpace($rawCfg)) {
        try {
            $cfgObj = $rawCfg | ConvertFrom-Json
        } catch {
            Write-Error "Failed to parse '$ConfigJsonPath': $($_.Exception.Message). Aborting uninstall."
            exit 1
        }
    }
}

# Managed targets (excluding config\config.json, which is handled via key removal)
$ManagedRelPaths = @(
    'GEMINI.md',
    'config\hooks.json',
    'config\scripts\pretool_guard.ps1',
    'config\scripts\pretool_guard.cjs',
    'config\scripts\read_loop_guard.cjs',
    'config\scripts\read_loop_settings.json',
    'config\scripts\test-cases.txt',
    'config\scripts\verify-hook.py',
    'config\plugins\anyi-global-rules',
    'config\plugins\search-routing',
    'config\plugins\docx-delivery',
    'config\plugins\lieflat-less-ai-tone',
    'config\plugins\humanizer-zh',
    'antigravity\skills\client-maintenance',
    'antigravity\skills\chinese-novelist'
)

if ($InstallMode -eq 'hook-only') {
    # Hook-only installs touched only hooks.json and scripts/; never delete the user's own GEMINI.md or plugins
    $ManagedRelPaths = @($ManagedRelPaths | Where-Object { $_ -like 'config\hooks.json' -or $_ -like 'config\scripts\*' })
}

$ToRestore = @()
$ToDelete  = @()

foreach ($rel in $ManagedRelPaths) {
    $backupItem = Join-Path $LatestBackup $rel
    $liveItem   = Join-Path $GeminiDir $rel
    if (Test-Path -LiteralPath $backupItem) {
        $ToRestore += [PSCustomObject]@{ Rel = $rel; Backup = $backupItem; Live = $liveItem }
    } elseif (Test-Path -LiteralPath $liveItem) {
        $ToDelete += [PSCustomObject]@{ Rel = $rel; Live = $liveItem }
    }
}

Write-Host "======================================================================"
Write-Host "Antigravity Agent Rules Uninstaller"
Write-Host "  Target Home   : $TargetHome"
Write-Host "  Latest Backup : $LatestBackup"
Write-Host "======================================================================"
Write-Host ""
Write-Host "Planned actions:"
foreach ($r in $ToRestore) {
    Write-Host ("  [RESTORE from backup] {0}" -f $r.Live)
}
foreach ($d in $ToDelete) {
    Write-Host ("  [DELETE (new item)]   {0}" -f $d.Live)
}
if ($InstallMode -ne 'hook-only' -and (Test-Path -LiteralPath $ConfigJsonPath)) {
    Write-Host ("  [CLEANUP 5 plugins]   {0}" -f $ConfigJsonPath)
}

if (-not $Force) {
    Write-Host ""
    $ans = Read-Host "Proceed with uninstall? [y/N]"
    if ($ans -notmatch '^[yY]([eE][sS])?$') {
        Write-Host "Aborted by user. No files were modified."
        exit 0
    }
}

# 1. Restore pre-existing items from latest backup
foreach ($r in $ToRestore) {
    if (Test-Path -LiteralPath $r.Live) {
        Remove-Item -LiteralPath $r.Live -Recurse -Force
    }
    $parentDir = Split-Path -Parent $r.Live
    if (-not (Test-Path -LiteralPath $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $r.Backup -Destination $r.Live -Recurse -Force
}

# 2. Delete items that did not exist prior to installation
foreach ($d in $ToDelete) {
    if (Test-Path -LiteralPath $d.Live) {
        Remove-Item -LiteralPath $d.Live -Recurse -Force
    }
}

# 3. Remove only the 5 plugin entries from config.json
$PluginNames = @(
    'anyi-global-rules',
    'search-routing',
    'docx-delivery',
    'lieflat-less-ai-tone',
    'humanizer-zh'
)

if ($InstallMode -ne 'hook-only' -and $null -ne $cfgObj -and $null -ne $cfgObj.PSObject.Properties['plugins']) {
    foreach ($pName in $PluginNames) {
        if ($null -ne $cfgObj.plugins.PSObject.Properties[$pName]) {
            $cfgObj.plugins.PSObject.Properties.Remove($pName)
        }
    }
    $jsonOut = $cfgObj | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($ConfigJsonPath, ($jsonOut + "`r`n"), $Utf8NoBom)
}

Write-Host ""
Write-Host "SUCCESS: Uninstalled Antigravity Agent Rules and restored pre-install state from '$LatestBackup'."
