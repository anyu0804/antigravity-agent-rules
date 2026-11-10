# ============================================================================
# Antigravity PreToolUse guard  (hook: hard-gate)
# ----------------------------------------------------------------------------
# CONTRACT
#   stdin  : hook payload JSON (camelCase), e.g.
#            {"toolCall":{"name":"run_command","args":{"CommandLine":"npm test"}},
#             "conversationId":"...", "stepIdx":19}
#   stdout : exactly ONE JSON object, nothing else.
#            {"decision":"ask"}                  non-flagged command (defaultDecision)
#            {"decision":"deny","reason":"..."}  flagged command
#            {"decision":"force_ask","reason":"..."}  confirm-tier command, only
#                                                when confirmDecision is set to it
#
# DESIGN NOTES
#   1. ASCII-ONLY SOURCE. Never add non-ASCII characters to this file.
#      Reason: Windows PowerShell 5.1 parses BOM-less scripts as ANSI, and
#      this path may contain non-ASCII directory names. Keeping the source pure
#      ASCII removes the whole class of encoding faults.
#   2. TWO TIERS OF FLAGGED COMMANDS.
#      block   - irreversible and outside any workspace (format a disk, delete
#                C:\ or the home directory). Always "deny". Not configurable.
#      confirm - destructive but sometimes intended (rm -r build, git reset
#                --hard, stopping a proxy client). Answered with confirmDecision,
#                which defaults to "deny" so nothing changes until the user opts in.
#   3. SETTINGS. Optional pretool_guard_settings.json next to this script:
#        { "defaultDecision": "ask" | "allow",
#          "confirmDecision": "deny" | "force_ask" | "ask",
#          "logAll": false }
#      Environment variables win over the file: AGY_HOOK_DEFAULT_DECISION,
#      AGY_HOOK_CONFIRM_DECISION, AGY_HOOK_LOG_ALL. AGY_HOOK_SETTINGS points at
#      a different settings file. A missing, unreadable or invalid file, and
#      any unknown value, fall back to the strict defaults ("ask" / "deny").
#      The file exists because a GUI-launched host does not inherit the
#      environment of the user's shell.
#   4. WHAT "ask" AND "allow" MEAN IS DECIDED BY THE HOST, not by this script.
#      Check the hooks documentation of the installed client version and try
#      both on a real host before changing defaultDecision.
#   5. FAIL-OPEN TO DEFAULT DECISION. Any internal error returns defaultDecision
#      so a broken guard never wedges the synchronous agent loop.
#   6. PRIVACY & SECRET REDACTION IN AUDIT LOG. By default, hook_log.jsonl only
#      records flagged (DENY-DANGER, CONFIRM-DANGER) and error (ERROR-FAILOPEN)
#      events; logAll also records the rest. All logged command strings are
#      scrubbed for tokens, passwords, and API keys before writing.
#   7. The rule table mirrors WINDOWS_RULES in pretool_guard.cjs one-to-one.
#      Keep them in sync; verify-hook.py compares the two tables.
# ============================================================================

$ErrorActionPreference = 'Stop'

# Force English .NET exception messages so the audit log stays pure ASCII.
try {
    [System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
} catch { }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile   = Join-Path $scriptDir 'hook_log.jsonl'
$stateDir  = Join-Path $scriptDir 'state'

# --- settings: environment variable first, then the settings file, then the
#     strict default. A missing or invalid file leaves $settings empty. --------
$settingsPath = $env:AGY_HOOK_SETTINGS
if ([string]::IsNullOrWhiteSpace($settingsPath)) {
    $settingsPath = Join-Path $scriptDir 'pretool_guard_settings.json'
}
$settings = $null
try {
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = [System.IO.File]::ReadAllText($settingsPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
    }
} catch { $settings = $null }

function Pick-Decision($EnvValue, $FileValue, [string]$Pattern, [string]$Fallback) {
    foreach ($value in @($EnvValue, $FileValue)) {
        if (($value -is [string]) -and ($value -match $Pattern)) { return $value.ToLowerInvariant() }
    }
    return $Fallback
}

$fileDefault = $null
$fileConfirm = $null
$fileLogAll  = $false
if ($null -ne $settings) {
    try {
        $fileDefault = $settings.defaultDecision
        $fileConfirm = $settings.confirmDecision
        $fileLogAll  = ($settings.logAll -eq $true)
    } catch { }
}

$defaultMode = Pick-Decision $env:AGY_HOOK_DEFAULT_DECISION $fileDefault '^(allow|ask)$' 'ask'
$confirmMode = Pick-Decision $env:AGY_HOOK_CONFIRM_DECISION $fileConfirm '^(deny|force_ask|ask)$' 'deny'
$DEFAULT_PASS = '{"decision":"' + $defaultMode + '"}'
$result       = $DEFAULT_PASS
if ([string]::IsNullOrEmpty($env:AGY_HOOK_LOG_ALL)) {
    $logAll = $fileLogAll
} else {
    $logAll = ($env:AGY_HOOK_LOG_ALL -match '^(1|true|yes)$')
}

function Write-Utf8NoBom([string]$Path, [string]$Text, [bool]$Append) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    if ($Append) {
        [System.IO.File]::AppendAllText($Path, $Text, $enc)
    } else {
        [System.IO.File]::WriteAllText($Path, $Text, $enc)
    }
}

function Redact-Command([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $s = $Text
    # Redact URL user:password@
    $s = [regex]::Replace($s, '(https?://[^/\s:@]+:)[^/\s@]+(@)', '$1<REDACTED>$2', 'IgnoreCase')
    # Redact Authorization: Bearer / Basic / Token headers
    $s = [regex]::Replace($s, '(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"''`]+', '$1<REDACTED>', 'IgnoreCase')
    # Redact well-known token prefixes (OpenAI/Anthropic sk-, GitHub ghp_/github_pat_, Google AIza, Slack xox*)
    $s = [regex]::Replace($s, '\b(sk-[a-zA-Z0-9_-]{10,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|ak-[a-zA-Z0-9]{16,})\b', '<REDACTED_TOKEN>')
    # Redact CLI flags carrying secrets (--token, --password, --api-key, --secret, etc.)
    $s = [regex]::Replace($s, '(--?(?:token|password|passwd|secret|api-?key|access-?key|private-?key|auth-?token|client-?secret))(\s+|=)("[^"]*"|''[^'']*''|\S+)', '$1$2<REDACTED>', 'IgnoreCase')
    # Redact ENV_VAR=secret assignments
    $s = [regex]::Replace($s, '\b([A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|''[^'']*''|\S+)', '$1=<REDACTED>', 'IgnoreCase')
    if ($s.Length -gt 500) {
        $s = $s.Substring(0, 500) + '...(truncated)'
    }
    return $s
}

# Command boundary: start of line, whitespace, a separator, a quote, or a path
# separator. The path separator matters: /bin/rm, \rm and C:\...\git.exe are
# the same commands as rm and git and must not slip past the rules.
$boundary = '(^|[\s;&|("''`\\/])'

# Git prefix allowing global options (-C <dir>, -c <k=v>, --git-dir=..., --work-tree=..., etc.)
# and a closing quote after a quoted executable path ("C:\Program Files\Git\cmd\git.exe" reset ...).
$gitPrefix = $boundary + 'git(\.exe)?["'']?\s+(?:-[Cc]\s+\S+\s+|--(?:git-dir|work-tree|namespace|super-prefix|exec-path)(?:=\S+|\s+\S+)\s+|--(?:bare|no-pager|no-replace-objects|literal-pathspecs)\s+)*'

# Delete targets that are never a workspace: filesystem or drive roots, the home
# directory, another user's home, and top-level system directories.
$rootish = '(?:/\*?|~[\\/]?\*?|\$HOME[\\/]?\*?|\$\{HOME\}[\\/]?\*?|%(?:USERPROFILE|SystemDrive|SystemRoot)%[\\/]?\*?|\$env:(?:USERPROFILE|SystemDrive|SystemRoot|HOME)[\\/]?\*?|[a-zA-Z]:[\\/]?\*?|/(?:etc|usr|var|bin|sbin|lib|boot|opt|home|root|Users|System|Library|Applications)[\\/]?\*?|/(?:home|Users)/[^\s\\/"'']+/?\*?|[a-zA-Z]:[\\/](?:Windows|Users|Program Files(?: \(x86\))?|ProgramData)[\\/]?\*?|[a-zA-Z]:[\\/]Users[\\/][^\s\\/"'']+[\\/]?\*?)'

# A masked segment must end the command, end at ; & || or a newline, or be piped
# into something that is not a shell or interpreter. echo 'rm -rf src' | sh
# runs the quoted text, so its quotes are code, not data, and stay visible.
$pipeGuard = '(?=$|[;&\r\n]|\|\||\|(?!\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|iex|Invoke-Expression|xargs|eval|source|python3?|node|perl|ruby)\b))'
# Search tools: the quoted argument is a pattern. awk is left out on purpose (its program can call system()).
$maskSearch = '(^|[\s;&|(])(grep|egrep|fgrep|rg|ripgrep|ag|ack|sed|Select-String)\b[^;&|\r\n]*' + $pipeGuard
# Print commands: the quoted argument is the output, which is only data when nothing re-reads it as code.
$maskPrint = '(^|[\s;&|(])(echo|printf|Write-Host|Write-Output)\b[^;&|\r\n]*' + $pipeGuard
# If the command line uses command substitution or eval anywhere, printed text may be executed: do not mask it.
$substitution = '\$\(|`|\beval\b|<\('
$maskGitMsg = $boundary + 'git(\.exe)?\b[^;&|\r\n]*\b(commit|tag|notes|merge)\b[^;&|\r\n]*'
# rm as a subcommand (git rm, pnpm rm, docker rm, ...) is not the filesystem rm.
$subcmdGit = $gitPrefix + 'rm\b'
$subcmdPm = '(' + $boundary + '(?:pnpm|npm|yarn|bun|cargo|brew)(?:\.exe|\.cmd)?(?:\s+-\S+)*\s+)rm\b'
$subcmdDocker = '(' + $boundary + '(?:docker|podman)(?:\.exe)?(?:\s+-\S+)*(?:\s+(?:container|image|volume|network|compose|secret|config|context))?\s+)rm\b'

function Mask-DataQuotes([string]$CmdText) {
    if ([string]::IsNullOrWhiteSpace($CmdText)) { return '' }
    $eval = {
        param($m)
        $seg = $m.Value
        # Strip single-quoted literal strings (no shell expansion inside single quotes)
        $seg = [regex]::Replace($seg, '''[^'']*''', '''''')
        # Strip double-quoted literal strings that do not contain $( or ` command substitution
        $seg = [regex]::Replace($seg, '"(?:\\.|[^"$`\\])*"', '""')
        return $seg
    }
    $subcmdEval = {
        param($m)
        return $m.Value.Substring(0, $m.Value.Length - 2) + 'SUBCMD_RM'
    }
    $out = $CmdText
    # 1. Search commands where quoted strings are patterns, not subshell code
    $out = [regex]::Replace($out, $maskSearch, $eval, 'IgnoreCase')
    # 2. Print commands, unless the command line can re-read printed text as code
    if (-not [regex]::IsMatch($CmdText, $substitution, 'IgnoreCase')) {
        $out = [regex]::Replace($out, $maskPrint, $eval, 'IgnoreCase')
    }
    # 3. Git commit / tag / notes / merge commands where -m "..." is a commit/tag message
    $out = [regex]::Replace($out, $maskGitMsg, $eval, 'IgnoreCase')
    # 4. rm used as a subcommand of git / package managers / docker
    $out = [regex]::Replace($out, $subcmdGit, $subcmdEval, 'IgnoreCase')
    $out = [regex]::Replace($out, $subcmdPm, '${1}SUBCMD_RM', 'IgnoreCase')
    $out = [regex]::Replace($out, $subcmdDocker, '${1}SUBCMD_RM', 'IgnoreCase')
    return $out
}

try {
    # --- stdin: decode STRICTLY as UTF-8 -----------------------------------
    $reader = New-Object System.IO.StreamReader(
        [Console]::OpenStandardInput(),
        (New-Object System.Text.UTF8Encoding($false)))
    $raw = $reader.ReadToEnd()
    $reader.Dispose()

    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'empty stdin' }

    $payload = $raw | ConvertFrom-Json

    $tool = [string]$payload.toolCall.name
    $conv = [string]$payload.conversationId
    $cmd  = [string]$payload.toolCall.args.CommandLine

    if ([string]::IsNullOrWhiteSpace($conv)) { $conv = 'default' }
    if ([string]::IsNullOrWhiteSpace($cmd))  { $cmd  = '' }

    # Mask quoted data arguments in grep/rg/echo/git-commit so patterns like
    # grep -rn "rm -rf" scripts/ or git commit -m "fix rm -rf" are not false-flagged.
    $maskedCmd = Mask-DataQuotes $cmd

    # ------------------------------------------------------------------
    # 1) Flagged commands. A rule with tier = 'block' always answers "deny".
    #    Every other rule is the confirm tier and answers $confirmMode.
    # ------------------------------------------------------------------
    $danger = $false
    $why    = ''
    $tier   = ''

    $rules = @(
        @{ rx = $boundary + '(?:rm|rmdir|rd|del|erase|ri|Remove-Item)(?:\.exe)?\b[^;&|\r\n]*[\s"''=]' + $rootish + '(?=["'']?(?:\s|$|[;&|)]))'; why = 'delete of a filesystem root, home or system directory'; tier = 'block' },
        @{ rx = $boundary + 'find\s+["'']?(?:/|~|\$HOME|\$\{HOME\})["'']?\s[^;&|\r\n]*\s(?:-delete\b|-exec(?:dir)?\s+(?:\S*[\\/])?(?:rm|rmdir)\b)'; why = 'find -delete from / or the home directory'; tier = 'block' },
        @{ rx = 'Remove-Item\b[^;&|\r\n]*\s-(r|recurse)\b';          why = 'recursive delete (Remove-Item -Recurse)' },
        @{ rx = '(^|[^a-zA-Z0-9_-])(Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^;&|\r\n]*(\s-(r|recurse)\b)'; why = 'recursive delete (PS alias/short-param)' },
        @{ rx = $boundary + 'rm(\.exe)?\s+(-[a-zA-Z]*[rR]|--recursive\b|[^;&|\r\n]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b)'; why = 'rm -r / --recursive' },
        @{ rx = $boundary + 'find\b[^;&|\r\n]*\s(-delete\b|-exec(dir)?\s+(\S*[\\/])?(rm|rmdir)\b)'; why = 'find -delete / -exec rm' },
        # Tree deletes only. Deleting one file from an interpreter is no more dangerous than rm <file>, which is not flagged.
        @{ rx = $boundary + '(python3?|py|node|nodejs|deno|bun|perl|ruby)(\.exe)?\b[^\r\n]*(\brmtree\s*\(|\bremovedirs\s*\(|\b(rmSync|rmdirSync|rm|rmdir)\s*\([^)]*\brecursive\b|\brm_rf\b|\brm_r\b|\bremove_tree\b|\bremove_dir\b|\brimraf\b)'; why = 'interpreter one-liner recursive delete' },
        @{ rx = '(^|\s)rd\s+/s';                                     why = 'rd /s' },
        @{ rx = '(^|\s)rmdir\s+/s';                                  why = 'rmdir /s' },
        @{ rx = '(^|\s)del\s+/[a-zA-Z]*[fs]';                        why = 'del /f /s' },
        @{ rx = $gitPrefix + 'reset\b[^;&|\r\n]*\s--hard\b';         why = 'git reset --hard' },
        @{ rx = $gitPrefix + 'push\b[^;&|\r\n]*(\s--force(?![-a-zA-Z])|\s-[a-zA-Z]*f\b|\s\+[a-zA-Z0-9_./-]+)'; why = 'git push --force / +refspec' },
        # A dry run (-n / --dry-run) deletes nothing and is the safe way to preview, so it is not flagged.
        @{ rx = $gitPrefix + 'clean\b(?![^;&|\r\n]*\s(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)\b)[^;&|\r\n]*\s(-[a-zA-Z]*[fd]|--force\b)'; why = 'git clean -fd' },
        # Whole-tree or whole-directory discards, with or without "--". Single-file checkouts stay unflagged.
        @{ rx = $gitPrefix + 'checkout\b[^;&|\r\n]*(\s(-f|--force)\b|\s(--\s*)?(\.|\*|:/)(?=\s|$)|\s[^\s;&|-][^\s;&|]*[\\/](?=\s|$))'; why = 'git checkout . / <dir>/ / --force' },
        # Matching is case-insensitive, so "-S" (--staged) cannot be told apart from "-s" (--source).
        # Only the long --staged form is treated as the safe unstage-only case.
        @{ rx = $gitPrefix + 'restore\b(?![^;&|\r\n]*\s--staged\b(?![^;&|\r\n]*\s(-W|--worktree)\b))[^;&|\r\n]*(\s(\.|\*|:/)(?=\s|$)|\s(-W|--worktree)\b|\s[^\s;&|-][^\s;&|]*[\\/](?=\s|$))'; why = 'git restore working tree' },
        @{ rx = $gitPrefix + 'stash\s+(drop|clear)\b';                why = 'git stash drop / clear' },
        @{ rx = $gitPrefix + 'switch\b[^;&|\r\n]*\s(--discard-changes|-f|--force)\b'; why = 'git switch --discard-changes' },
        # SUBCMD_RM is what Mask-DataQuotes leaves in place of git rm. Forced removal outside --cached drops uncommitted edits.
        @{ rx = $gitPrefix + 'SUBCMD_RM\b(?![^;&|\r\n]*\s--cached\b)[^;&|\r\n]*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)\b'; why = 'git rm --force' },
        @{ rx = 'Format-Volume';                                     why = 'Format-Volume'; tier = 'block' },
        @{ rx = '(^|\s)format\s+[a-zA-Z]:';                          why = 'format drive'; tier = 'block' },
        @{ rx = 'Remove-Item.*HKLM:';                                why = 'registry delete (HKLM)' },
        @{ rx = '(^|\s)reg\s+delete';                                why = 'reg delete' },
        @{ rx = 'Clear-Disk|Initialize-Disk';                        why = 'disk re-init'; tier = 'block' },
        # --- Proxy / network protection (user rule: proxy/network is OFF-LIMITS
        #     without explicit per-task user approval) --------------------------
        @{ rx = '(taskkill|tskill|pkill|killall|Stop-Process|wmic\s+process).{0,120}(clash|verge|mihomo|sing-?box|singbox|v2ray|xray|nekobox|nekoray|netch|sstap|shadowsocks|trojan(-go)?|hysteria|naiveproxy|cfw|sysproxy|privoxy)'; why = 'kill proxy client (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = '(clash|verge|mihomo|sing-?box|singbox|v2ray|xray|nekobox|nekoray|shadowsocks|hysteria).{0,120}(Stop-Process|taskkill|\.Kill\()'; why = 'kill proxy client (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = '(sc(\.exe)?\s+(stop|delete|config)|net(\.exe)?\s+stop|Stop-Service).{0,120}(clash|sing-?box|v2ray|xray|wintun|tap-windows|tun2socks|shadowsocks|verge|nekobox)'; why = 'stop/delete proxy service (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = 'netsh.{0,80}(interface\s+set\s+interface|wlan\s+disconnect)'; why = 'disable NIC / disconnect WLAN (user rule: network off-limits without explicit user approval)' },
        @{ rx = 'Disable-NetAdapter';                                    why = 'disable network adapter (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = 'ipconfig\s+/release6?';                                 why = 'release IP, drops connectivity (user rule: network off-limits without explicit user approval)' },
        @{ rx = 'rasdial\s+/d';                                          why = 'hang up dialup/tunnel (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = '(^|\s)route\s+delete';                                  why = 'delete route, may break TUN (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = '(reg(\.exe)?\s+add|Set-ItemProperty|New-ItemProperty|regedit).{0,160}Internet\s+Settings'; why = 'modify system proxy registry (user rule: proxy/network off-limits without explicit user approval)' },
        @{ rx = 'netsh\s+winhttp\s+set\s+proxy';                         why = 'set WinHTTP proxy (user rule: proxy/network off-limits without explicit user approval)' }
    )

    # A block rule wins over a confirm rule wherever the two sit in the table.
    foreach ($r in $rules) {
        if (($r.tier -eq 'block') -and ($maskedCmd -match $r.rx)) { $danger = $true; $why = $r.why; $tier = 'block'; break }
    }
    if (-not $danger) {
        foreach ($r in $rules) {
            if (($r.tier -ne 'block') -and ($maskedCmd -match $r.rx)) { $danger = $true; $why = $r.why; $tier = 'confirm'; break }
        }
    }

    $count = 0

    # ------------------------------------------------------------------
    # 3) Verdict
    # ------------------------------------------------------------------
    $verdict = $defaultMode.ToUpperInvariant()
    if ($danger -and (($tier -eq 'block') -or ($confirmMode -eq 'deny'))) {
        $verdict = 'DENY-DANGER'
        $result = '{"decision":"deny","reason":"HARD GATE: blocked - ' + $why + ' (global rule 1/9). Report to the user instead of retrying a variant."}'
    } elseif ($danger) {
        $verdict = 'CONFIRM-DANGER'
        $result = '{"decision":"' + $confirmMode + '","reason":"CONFIRM: ' + $why + ' (global rule 1/9). Runs only if the user approves this exact command."}'
    }

    # ------------------------------------------------------------------
    # 4) Audit log (best effort, never fatal; default logs DENY only + redacts secrets)
    # ------------------------------------------------------------------
    if ($danger -or $logAll) {
        try {
            if (Test-Path $logFile) {
                if ((Get-Item $logFile).Length -gt 524288) {
                    $rotFile = $logFile + '.1'
                    if (Test-Path $rotFile) { Remove-Item $rotFile -Force }
                    Move-Item $logFile $rotFile -Force
                }
            }
            $rec = [ordered]@{
                ts      = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                verdict = $verdict
                count   = $count
                tool    = $tool
                cmd     = (Redact-Command $cmd)
            } | ConvertTo-Json -Compress

            Write-Utf8NoBom -Path $logFile -Text ($rec + "`r`n") -Append $true
        } catch { }
    }
}
catch {
    $result = $DEFAULT_PASS
    try {
        $msg = [string]$_.Exception.Message
        $msg = $msg -replace '[\r\n]+', ' '
        $msg = $msg -replace '"', "'"
        $rec = '{"ts":"' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '","verdict":"ERROR-FAILOPEN","error":"' + $msg + '"}'
        Write-Utf8NoBom -Path $logFile -Text ($rec + "`r`n") -Append $true
    } catch { }
}

# --- stdout: emit UTF-8 so text survives regardless of the console code page
$writer = New-Object System.IO.StreamWriter(
    [Console]::OpenStandardOutput(),
    (New-Object System.Text.UTF8Encoding($false)))
$writer.Write($result)
$writer.Flush()
$writer.Dispose()
