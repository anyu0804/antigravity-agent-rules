# ============================================================================
# Antigravity Agent Rules - One-Click Installer (install.ps1)
# ----------------------------------------------------------------------------
# Deploys the 5-layer governance rules, hooks, skills, subagents, and tone
# plugins into ~/.gemini.
#
# Key safety guarantees:
#   1. Pre-validates existing config.json and hooks.json BEFORE modifying any
#      files; aborts immediately on parse failure (no half-installed state).
#   2. Lists all existing files/directories that will be merged or overwritten
#      and prompts for 'y' confirmation (default: No). Use -Force to skip.
#   3. Merges GEMINI.md using <!-- antigravity-agent-rules:begin/end -->
#      markers and merges hooks.json by top-level keys (hard-gate,
#      read-loop-efficiency, read-loop-enforcement).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Force
#   pwsh -NoProfile -File .\install.ps1 -WorkspacePath "D:\MyProject"
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -HookOnly
#
# -HookOnly installs only the PreToolUse/PostToolUse hook layer (hooks.json
# merge + scripts/). GEMINI.md, config.json, rules, skills, agents and tone
# plugins are left untouched.
# ============================================================================

param(
    [string]$TargetHome = $env:USERPROFILE,
    [string]$WorkspacePath = "",
    [switch]$Force,
    [switch]$SkipHookVerify,
    [switch]$HookOnly
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TargetHome)) {
    throw "TargetHome cannot be empty."
}

$RepoRoot    = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetHome  = [System.IO.Path]::GetFullPath($TargetHome)
$ForwardHome = ($TargetHome.TrimEnd('\', '/')) -replace '\\', '/'
$ForwardWs   = ""
if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) {
    $WorkspacePath = [System.IO.Path]::GetFullPath($WorkspacePath)
    $ForwardWs     = ($WorkspacePath.TrimEnd('\', '/')) -replace '\\', '/'
}

$GeminiDir   = Join-Path $TargetHome '.gemini'
$ConfigDir   = Join-Path $GeminiDir 'config'
$ScriptsDir  = Join-Path $ConfigDir 'scripts'
$PluginsDir  = Join-Path $ConfigDir 'plugins'
$AgySkillDir = Join-Path (Join-Path $GeminiDir 'antigravity') 'skills'

$Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)

function Ensure-Dir([string]$DirPath) {
    if (-not (Test-Path -LiteralPath $DirPath)) {
        New-Item -ItemType Directory -Path $DirPath -Force | Out-Null
    }
}

Write-Host "======================================================================"
Write-Host "Antigravity Agent Rules Installer"
Write-Host "  Source Repo : $RepoRoot"
Write-Host "  Target Home : $TargetHome ($ForwardHome)"
if (-not [string]::IsNullOrWhiteSpace($ForwardWs)) {
    Write-Host "  Workspace   : $WorkspacePath ($ForwardWs)"
}
if ($HookOnly) {
    Write-Host "  Mode        : HOOK ONLY (hooks.json + scripts/; rules/skills/tone skipped)"
}
Write-Host "======================================================================"

# ----------------------------------------------------------------------------
# 0. Pre-parse config.json and hooks.json BEFORE touching any files
# ----------------------------------------------------------------------------
$ConfigJsonPath   = Join-Path $ConfigDir 'config.json'
$TargetHooksPath  = Join-Path $ConfigDir 'hooks.json'
$RepoHooksPath    = Join-Path $RepoRoot 'hooks\hooks.json'
$TargetGeminiPath = Join-Path $GeminiDir 'GEMINI.md'
$RepoGeminiPath   = Join-Path $RepoRoot 'global\GEMINI.md'

$cfgObj = $null
if (Test-Path -LiteralPath $ConfigJsonPath) {
    $rawCfg = [System.IO.File]::ReadAllText($ConfigJsonPath, $Utf8NoBom)
    if (-not [string]::IsNullOrWhiteSpace($rawCfg)) {
        try {
            $cfgObj = $rawCfg | ConvertFrom-Json
        } catch {
            Write-Error "Failed to parse existing config.json at '$ConfigJsonPath': $($_.Exception.Message). Please fix syntax/remove comments first. Aborting with no changes."
            exit 1
        }
    }
}

$existingHooksObj = $null
if (Test-Path -LiteralPath $TargetHooksPath) {
    $rawHooks = [System.IO.File]::ReadAllText($TargetHooksPath, $Utf8NoBom)
    if (-not [string]::IsNullOrWhiteSpace($rawHooks)) {
        try {
            $existingHooksObj = $rawHooks | ConvertFrom-Json
        } catch {
            Write-Error "Failed to parse existing hooks.json at '$TargetHooksPath': $($_.Exception.Message). Please fix syntax/remove comments first. Aborting with no changes."
            exit 1
        }
    }
}

$repoHooksRaw = [System.IO.File]::ReadAllText($RepoHooksPath, $Utf8NoBom)
$repoHooksObj = $repoHooksRaw | ConvertFrom-Json

# ----------------------------------------------------------------------------
# 1. Inspect existing targets and ask for user confirmation ('y')
# ----------------------------------------------------------------------------
$ManagedTargets = @(
    @{ Rel = 'GEMINI.md';                                 Mode = 'MERGE (marker block)' },
    @{ Rel = 'config\hooks.json';                         Mode = 'MERGE (top-level keys)' },
    @{ Rel = 'config\config.json';                        Mode = 'MERGE (enable 5 plugins)' },
    @{ Rel = 'config\scripts\pretool_guard.ps1';          Mode = 'OVERWRITE' },
    @{ Rel = 'config\scripts\pretool_guard.cjs';          Mode = 'OVERWRITE' },
    @{ Rel = 'config\scripts\read_loop_guard.cjs';        Mode = 'OVERWRITE' },
    @{ Rel = 'config\scripts\read_loop_settings.json';    Mode = 'OVERWRITE' },
    @{ Rel = 'config\scripts\test-cases.txt';             Mode = 'OVERWRITE' },
    @{ Rel = 'config\scripts\verify-hook.py';             Mode = 'OVERWRITE' },
    @{ Rel = 'config\plugins\anyi-global-rules';          Mode = 'OVERWRITE' },
    @{ Rel = 'config\plugins\search-routing';             Mode = 'OVERWRITE' },
    @{ Rel = 'config\plugins\docx-delivery';              Mode = 'OVERWRITE' },
    @{ Rel = 'config\plugins\lieflat-less-ai-tone';       Mode = 'OVERWRITE' },
    @{ Rel = 'config\plugins\humanizer-zh';               Mode = 'OVERWRITE' },
    @{ Rel = 'antigravity\skills\client-maintenance';     Mode = 'OVERWRITE' },
    @{ Rel = 'antigravity\skills\chinese-novelist';       Mode = 'OVERWRITE' }
)

if ($HookOnly) {
    $ManagedTargets = @($ManagedTargets | Where-Object { $_.Rel -like 'config\hooks.json' -or $_.Rel -like 'config\scripts\*' })
}

$ExistingItems = @()
foreach ($item in $ManagedTargets) {
    $full = Join-Path $GeminiDir $item.Rel
    if (Test-Path -LiteralPath $full) {
        $ExistingItems += [PSCustomObject]@{
            Rel  = $item.Rel
            Full = $full
            Mode = $item.Mode
        }
    }
}

if ($ExistingItems.Count -gt 0) {
    Write-Host ""
    Write-Host "The following existing files/directories in '$GeminiDir' will be modified:"
    foreach ($ex in $ExistingItems) {
        Write-Host ("  [{0}] {1}" -f $ex.Mode, $ex.Full)
    }
} else {
    Write-Host ""
    Write-Host "No existing target files found in '$GeminiDir' (clean install)."
}

if (-not $Force) {
    Write-Host ""
    $ans = Read-Host "Proceed with installation? [y/N]"
    if ($ans -notmatch '^[yY]([eE][sS])?$') {
        Write-Host "Aborted by user. No files were modified."
        exit 0
    }
}

# ----------------------------------------------------------------------------
# 2. Backup existing files into ~/.gemini/backup_antigravity_rules_<timestamp>
# ----------------------------------------------------------------------------
$stamp     = (Get-Date).ToString('yyyyMMdd_HHmmss')
$backupDir = Join-Path $GeminiDir ("backup_antigravity_rules_" + $stamp)
Ensure-Dir $backupDir

foreach ($ex in $ExistingItems) {
    $dst = Join-Path $backupDir $ex.Rel
    Ensure-Dir (Split-Path -Parent $dst)
    Copy-Item -LiteralPath $ex.Full -Destination $dst -Recurse -Force
}

$manifestObj = [ordered]@{
    timestamp     = $stamp
    targetHome    = $TargetHome
    workspacePath = $WorkspacePath
    mode          = $(if ($HookOnly) { 'hook-only' } else { 'full' })
    preExisting   = @($ExistingItems | ForEach-Object { $_.Rel })
}
$manifestJson = $manifestObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $backupDir 'manifest.json'), ($manifestJson + "`r`n"), $Utf8NoBom)
Write-Host "[1/5] Created backup snapshot ($($ExistingItems.Count) pre-existing item(s)): $backupDir"

# ----------------------------------------------------------------------------
# Helper functions for file deployment with placeholder replacement
# ----------------------------------------------------------------------------
function Format-MarkdownContent([string]$RawText) {
    $out = $RawText.Replace('<YOUR_PATH>', $ForwardHome)
    if (-not [string]::IsNullOrWhiteSpace($ForwardWs)) {
        $out = $out.Replace('<YOUR_PROJECT_PATH>', $ForwardWs)
    }
    return $out
}

function Copy-WithPlaceholderReplacement([string]$SrcFile, [string]$DstFile) {
    Ensure-Dir (Split-Path -Parent $DstFile)
    $ext = [System.IO.Path]::GetExtension($SrcFile).ToLowerInvariant()
    if ($ext -eq '.md') {
        $content = [System.IO.File]::ReadAllText($SrcFile, $Utf8NoBom)
        $content = Format-MarkdownContent $content
        [System.IO.File]::WriteAllText($DstFile, $content, $Utf8NoBom)
    } else {
        Copy-Item -LiteralPath $SrcFile -Destination $DstFile -Force
    }
}

function Copy-TreeWithReplacement([string]$SrcDir, [string]$DstDir) {
    Ensure-Dir $DstDir
    $items = Get-ChildItem -LiteralPath $SrcDir -Force
    foreach ($item in $items) {
        $targetPath = Join-Path $DstDir $item.Name
        if ($item.PSIsContainer) {
            Copy-TreeWithReplacement -SrcDir $item.FullName -DstDir $targetPath
        } else {
            Copy-WithPlaceholderReplacement -SrcFile $item.FullName -DstFile $targetPath
        }
    }
}

# ----------------------------------------------------------------------------
# 3. Deploy Layer 1: hooks/ -> merge hooks.json & copy scripts/
# ----------------------------------------------------------------------------
Ensure-Dir $ConfigDir
$HookTopKeys = @('hard-gate', 'read-loop-efficiency', 'read-loop-enforcement')
if ($null -eq $existingHooksObj) {
    $mergedHooksObj = New-Object PSObject
} else {
    $mergedHooksObj = $existingHooksObj
}
foreach ($hk in $HookTopKeys) {
    $val = $repoHooksObj.$hk
    if ($null -eq $mergedHooksObj.PSObject.Properties[$hk]) {
        $mergedHooksObj | Add-Member -MemberType NoteProperty -Name $hk -Value $val
    } else {
        $mergedHooksObj.$hk = $val
    }
}
$hooksOut = $mergedHooksObj | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($TargetHooksPath, ($hooksOut + "`r`n"), $Utf8NoBom)

Copy-TreeWithReplacement `
    -SrcDir (Join-Path $RepoRoot 'hooks\scripts') `
    -DstDir $ScriptsDir

Write-Host "[2/5] Merged hooks.json (top-level keys) & deployed scripts/."

if ($HookOnly) {
    Write-Host "[3-5/5] Skipped (-HookOnly): GEMINI.md, config.json, rules/, skills/, agents/, tone/ untouched."
} else {

# ----------------------------------------------------------------------------
# 4. Deploy Layer 2 & 3: merge GEMINI.md & deploy global/ + rules/
# ----------------------------------------------------------------------------
Ensure-Dir $GeminiDir
$BeginMarker = '<!-- antigravity-agent-rules:begin -->'
$EndMarker   = '<!-- antigravity-agent-rules:end -->'

$repoGeminiRaw = [System.IO.File]::ReadAllText($RepoGeminiPath, $Utf8NoBom)
$repoGeminiFmt = (Format-MarkdownContent $repoGeminiRaw).TrimEnd("`r", "`n")
$wrappedBlock  = $BeginMarker + "`r`n" + $repoGeminiFmt + "`r`n" + $EndMarker

if (Test-Path -LiteralPath $TargetGeminiPath) {
    $existingGemini = [System.IO.File]::ReadAllText($TargetGeminiPath, $Utf8NoBom)
    $idxBegin = $existingGemini.IndexOf($BeginMarker, [System.StringComparison]::Ordinal)
    $idxEnd   = $existingGemini.IndexOf($EndMarker, [System.StringComparison]::Ordinal)
    if ($idxBegin -ge 0 -and $idxEnd -gt $idxBegin) {
        $before = $existingGemini.Substring(0, $idxBegin)
        $after  = $existingGemini.Substring($idxEnd + $EndMarker.Length)
        $finalGemini = $before + $wrappedBlock + $after
    } elseif ([string]::IsNullOrWhiteSpace($existingGemini)) {
        $finalGemini = $wrappedBlock + "`r`n"
    } else {
        $finalGemini = $existingGemini.TrimEnd("`r", "`n") + "`r`n`r`n" + $wrappedBlock + "`r`n"
    }
} else {
    $finalGemini = $wrappedBlock + "`r`n"
}
[System.IO.File]::WriteAllText($TargetGeminiPath, $finalGemini, $Utf8NoBom)

$AnyiPluginDir = Join-Path $PluginsDir 'anyi-global-rules'
Copy-WithPlaceholderReplacement `
    -SrcFile (Join-Path $RepoRoot 'global\plugin.json') `
    -DstFile (Join-Path $AnyiPluginDir 'plugin.json')
Copy-WithPlaceholderReplacement `
    -SrcFile (Join-Path $RepoRoot 'global\AGENTS.md') `
    -DstFile (Join-Path $AnyiPluginDir 'rules\AGENTS.md')

$AnyiRuleFiles = @(
    'BACKGROUND-RESOURCES.md',
    'IMPLEMENTATION.md',
    'LONG-TASKS.md',
    'RELEASE-PACKAGING.md',
    'RULE-MAINTENANCE.md',
    'WINDOWS-RELEASE.md'
)
foreach ($rf in $AnyiRuleFiles) {
    Copy-WithPlaceholderReplacement `
        -SrcFile (Join-Path (Join-Path $RepoRoot 'rules') $rf) `
        -DstFile (Join-Path (Join-Path $AnyiPluginDir 'rules') $rf)
}

$SearchPluginDir = Join-Path $PluginsDir 'search-routing'
Copy-WithPlaceholderReplacement `
    -SrcFile (Join-Path $RepoRoot 'rules\search-routing.plugin.json') `
    -DstFile (Join-Path $SearchPluginDir 'plugin.json')
Copy-WithPlaceholderReplacement `
    -SrcFile (Join-Path $RepoRoot 'rules\SEARCH-ROUTING.md') `
    -DstFile (Join-Path $SearchPluginDir 'rules\SEARCH-ROUTING.md')

Write-Host "[3/5] Merged GEMINI.md & deployed Layer 2 (global/) + Layer 3 (rules/)."

# ----------------------------------------------------------------------------
# 5. Deploy Layer 4 & 5: skills/, agents/, and tone/
# ----------------------------------------------------------------------------
$AnyiSkills = @('task-intake', 'safe-network-diagnostics', 'multi-agent-orchestrator')
foreach ($sk in $AnyiSkills) {
    Copy-TreeWithReplacement `
        -SrcDir (Join-Path (Join-Path $RepoRoot 'skills') $sk) `
        -DstDir (Join-Path (Join-Path $AnyiPluginDir 'skills') $sk)
}

Copy-WithPlaceholderReplacement `
    -SrcFile (Join-Path $RepoRoot 'agents\flash-verifier.md') `
    -DstFile (Join-Path $AnyiPluginDir 'agents\flash-verifier.md')

Copy-TreeWithReplacement `
    -SrcDir (Join-Path $RepoRoot 'skills\research-routing') `
    -DstDir (Join-Path $SearchPluginDir 'skills\research-routing')

Copy-TreeWithReplacement `
    -SrcDir (Join-Path $RepoRoot 'skills\docx-delivery') `
    -DstDir (Join-Path $PluginsDir 'docx-delivery')

Copy-TreeWithReplacement `
    -SrcDir (Join-Path $RepoRoot 'tone\lieflat-less-ai-tone') `
    -DstDir (Join-Path $PluginsDir 'lieflat-less-ai-tone')

Copy-TreeWithReplacement `
    -SrcDir (Join-Path $RepoRoot 'tone\humanizer-zh') `
    -DstDir (Join-Path $PluginsDir 'humanizer-zh')

$StandaloneSkills = @('client-maintenance', 'chinese-novelist')
foreach ($ssk in $StandaloneSkills) {
    Copy-TreeWithReplacement `
        -SrcDir (Join-Path (Join-Path $RepoRoot 'skills') $ssk) `
        -DstDir (Join-Path $AgySkillDir $ssk)
    if (-not [string]::IsNullOrWhiteSpace($WorkspacePath)) {
        $wsSkillDir = Join-Path (Join-Path (Join-Path $WorkspacePath '.agents') 'skills') $ssk
        Copy-TreeWithReplacement `
            -SrcDir (Join-Path (Join-Path $RepoRoot 'skills') $ssk) `
            -DstDir $wsSkillDir
    }
}

Write-Host "[4/5] Deployed Layer 4 (skills/ & agents/) & Layer 5 (tone/)."

# ----------------------------------------------------------------------------
# 6. Enable 5 plugins in ~/.gemini/config/config.json
# ----------------------------------------------------------------------------
$PluginNames = @(
    'anyi-global-rules',
    'search-routing',
    'docx-delivery',
    'lieflat-less-ai-tone',
    'humanizer-zh'
)

if ($null -eq $cfgObj) {
    $cfgObj = New-Object PSObject
}
if ($null -eq $cfgObj.PSObject.Properties['plugins']) {
    $cfgObj | Add-Member -MemberType NoteProperty -Name 'plugins' -Value (New-Object PSObject)
}
foreach ($pName in $PluginNames) {
    if ($null -eq $cfgObj.plugins.PSObject.Properties[$pName]) {
        $pEntry = New-Object PSObject
        $pEntry | Add-Member -MemberType NoteProperty -Name 'enabled' -Value $true
        $cfgObj.plugins | Add-Member -MemberType NoteProperty -Name $pName -Value $pEntry
    } else {
        $cfgObj.plugins.$pName.enabled = $true
    }
}

$jsonOut = $cfgObj | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($ConfigJsonPath, ($jsonOut + "`r`n"), $Utf8NoBom)
Write-Host "[5/5] Enabled 5 plugins in: $ConfigJsonPath"
}

# ----------------------------------------------------------------------------
# Optional: Run verify-hook.py self-test
# ----------------------------------------------------------------------------
if (-not $SkipHookVerify) {
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    $verifyScript = Join-Path $ScriptsDir 'verify-hook.py'
    if ($null -ne $pyCmd -and (Test-Path -LiteralPath $verifyScript)) {
        Write-Host ""
        Write-Host "Running PreToolUse hook self-test (verify-hook.py)..."
        & python $verifyScript
        if ($LASTEXITCODE -ne 0) {
            throw "verify-hook.py failed with exit code $LASTEXITCODE"
        }
        $tmpLog = Join-Path $ScriptsDir 'hook_log.jsonl'
        if (Test-Path -LiteralPath $tmpLog) {
            Remove-Item -LiteralPath $tmpLog -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
if ($HookOnly) {
    Write-Host "SUCCESS: Antigravity Agent Rules hook layer installed (hook-only mode)."
} else {
    Write-Host "SUCCESS: Antigravity Agent Rules installed and verified."
}
