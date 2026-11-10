'use strict';
// ============================================================================
// Antigravity PreToolUse guard, Node version  (hook: hard-gate)
// ----------------------------------------------------------------------------
// Cross-platform port of pretool_guard.ps1. macOS / Linux installs use this
// file (install.sh); Windows installs keep pretool_guard.ps1 by default.
//
// CONTRACT (same as pretool_guard.ps1)
//   stdin  : hook payload JSON (camelCase), e.g.
//            {"toolCall":{"name":"run_command","args":{"CommandLine":"npm test"}},
//             "conversationId":"...", "stepIdx":19}
//   stdout : exactly ONE JSON object, nothing else.
//            {"decision":"ask"}                  non-flagged command (defaultDecision)
//            {"decision":"deny","reason":"..."}  flagged command
//            {"decision":"force_ask","reason":"..."}  confirm-tier command, only
//                                                when confirmDecision is set to it
//
// DESIGN NOTES
//   1. TWO TIERS OF FLAGGED COMMANDS.
//      block   - irreversible and outside any workspace (format a disk, delete
//                / or the home directory). Always "deny". Not configurable.
//      confirm - destructive but sometimes intended (rm -r build, git reset
//                --hard, stopping a proxy client). Answered with confirmDecision,
//                which defaults to "deny" so nothing changes until the user opts in.
//   2. SETTINGS. Optional pretool_guard_settings.json next to this script:
//        { "defaultDecision": "ask" | "allow",
//          "confirmDecision": "deny" | "force_ask" | "ask",
//          "logAll": false }
//      Environment variables win over the file: AGY_HOOK_DEFAULT_DECISION,
//      AGY_HOOK_CONFIRM_DECISION, AGY_HOOK_LOG_ALL. AGY_HOOK_SETTINGS points at
//      a different settings file. A missing, unreadable or invalid file, and
//      any unknown value, fall back to the strict defaults ("ask" / "deny").
//      The file exists because a GUI-launched host does not inherit the
//      environment of the user's shell.
//   3. WHAT "ask" AND "allow" MEAN IS DECIDED BY THE HOST, not by this script.
//      Check the hooks documentation of the installed client version and try
//      both on a real host before changing defaultDecision.
//   4. FAIL-OPEN TO DEFAULT DECISION. Any internal error returns defaultDecision.
//   5. PRIVACY & SECRET REDACTION IN AUDIT LOG. By default, hook_log.jsonl only
//      records flagged (DENY-DANGER, CONFIRM-DANGER) and error (ERROR-FAILOPEN)
//      events; logAll also records the rest. All logged commands are scrubbed
//      for tokens, passwords, and API keys.
//   6. WINDOWS_RULES mirror pretool_guard.ps1 one-to-one. Keep them in sync;
//      verify-hook.py compares the two tables.
//      UNIX_RULES are extra rules for macOS / Linux commands.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const LOG_FILE = path.join(SCRIPT_DIR, 'hook_log.jsonl');
const LOG_ROTATE_BYTES = 524288;
const EOL = process.platform === 'win32' ? '\r\n' : '\n';

const SETTINGS_FILE = process.env.AGY_HOOK_SETTINGS || path.join(SCRIPT_DIR, 'pretool_guard_settings.json');

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or invalid file: strict defaults apply
  }
}
const SETTINGS = loadSettings();

// Environment variable first, then the settings file, then the strict default.
function pickDecision(envName, key, allowed, fallback) {
  for (const value of [process.env[envName], SETTINGS[key]]) {
    if (typeof value === 'string' && allowed.includes(value.toLowerCase())) return value.toLowerCase();
  }
  return fallback;
}
function pickFlag(envName, key) {
  const env = process.env[envName];
  if (typeof env === 'string' && env !== '') return /^(1|true|yes)$/i.test(env);
  return SETTINGS[key] === true;
}

const DEFAULT_MODE = pickDecision('AGY_HOOK_DEFAULT_DECISION', 'defaultDecision', ['ask', 'allow'], 'ask');
const CONFIRM_MODE = pickDecision('AGY_HOOK_CONFIRM_DECISION', 'confirmDecision', ['deny', 'force_ask', 'ask'], 'deny');
const DEFAULT_PASS = JSON.stringify({ decision: DEFAULT_MODE });
const LOG_ALL = pickFlag('AGY_HOOK_LOG_ALL', 'logAll');

const PROXY_RULE = 'user rule: proxy/network off-limits without explicit user approval';
const NETWORK_RULE = 'user rule: network off-limits without explicit user approval';

// Command boundary: start of line, whitespace, a separator, a quote, or a path
// separator. The path separator matters: /bin/rm, \rm and C:\...\git.exe are
// the same commands as rm and git and must not slip past the rules.
const B = '(^|[\\s;&|("\'`\\\\/])';

// Git prefix allowing global options (-C <dir>, -c <k=v>, --git-dir=..., --work-tree=..., etc.)
// and a closing quote after a quoted executable path ("C:\Program Files\Git\cmd\git.exe" reset ...).
const GIT_PREFIX = B + 'git(\\.exe)?["\']?\\s+(?:-[Cc]\\s+\\S+\\s+|--(?:git-dir|work-tree|namespace|super-prefix|exec-path)(?:=\\S+|\\s+\\S+)\\s+|--(?:bare|no-pager|no-replace-objects|literal-pathspecs)\\s+)*';

// Delete targets that are never a workspace: filesystem or drive roots, the home
// directory, another user's home, and top-level system directories.
const ROOTISH = '(?:/\\*?|~[\\\\/]?\\*?|\\$HOME[\\\\/]?\\*?|\\$\\{HOME\\}[\\\\/]?\\*?|%(?:USERPROFILE|SystemDrive|SystemRoot)%[\\\\/]?\\*?|\\$env:(?:USERPROFILE|SystemDrive|SystemRoot|HOME)[\\\\/]?\\*?|[a-zA-Z]:[\\\\/]?\\*?|/(?:etc|usr|var|bin|sbin|lib|boot|opt|home|root|Users|System|Library|Applications)[\\\\/]?\\*?|/(?:home|Users)/[^\\s\\\\/"\']+/?\\*?|[a-zA-Z]:[\\\\/](?:Windows|Users|Program Files(?: \\(x86\\))?|ProgramData)[\\\\/]?\\*?|[a-zA-Z]:[\\\\/]Users[\\\\/][^\\s\\\\/"\']+[\\\\/]?\\*?)';

// Each rule is [pattern, reason] or [pattern, reason, 'block'].
// 'block' rules always answer "deny". All other rules are the confirm tier.
// Mirrors pretool_guard.ps1 rules one-to-one.
const WINDOWS_RULES = [
  [B + '(?:rm|rmdir|rd|del|erase|ri|Remove-Item)(?:\\.exe)?\\b[^;&|\\r\\n]*[\\s"\'=]' + ROOTISH + '(?=["\']?(?:\\s|$|[;&|)]))', 'delete of a filesystem root, home or system directory', 'block'],
  [B + 'find\\s+["\']?(?:/|~|\\$HOME|\\$\\{HOME\\})["\']?\\s[^;&|\\r\\n]*\\s(?:-delete\\b|-exec(?:dir)?\\s+(?:\\S*[\\\\/])?(?:rm|rmdir)\\b)', 'find -delete from / or the home directory', 'block'],
  ['Remove-Item\\b[^;&|\\r\\n]*\\s-(r|recurse)\\b', 'recursive delete (Remove-Item -Recurse)'],
  ['(^|[^a-zA-Z0-9_-])(Remove-Item|ri|rm|del|erase|rd|rmdir)\\b[^;&|\\r\\n]*(\\s-(r|recurse)\\b)', 'recursive delete (PS alias/short-param)'],
  [B + 'rm(\\.exe)?\\s+(-[a-zA-Z]*[rR]|--recursive\\b|[^;&|\\r\\n]*\\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b)', 'rm -r / --recursive'],
  [B + 'find\\b[^;&|\\r\\n]*\\s(-delete\\b|-exec(dir)?\\s+(\\S*[\\\\/])?(rm|rmdir)\\b)', 'find -delete / -exec rm'],
  // Tree deletes only. Deleting one file from an interpreter is no more dangerous than `rm file`, which is not flagged.
  [B + '(python3?|py|node|nodejs|deno|bun|perl|ruby)(\\.exe)?\\b[^\\r\\n]*(\\brmtree\\s*\\(|\\bremovedirs\\s*\\(|\\b(rmSync|rmdirSync|rm|rmdir)\\s*\\([^)]*\\brecursive\\b|\\brm_rf\\b|\\brm_r\\b|\\bremove_tree\\b|\\bremove_dir\\b|\\brimraf\\b)', 'interpreter one-liner recursive delete'],
  ['(^|\\s)rd\\s+/s', 'rd /s'],
  ['(^|\\s)rmdir\\s+/s', 'rmdir /s'],
  ['(^|\\s)del\\s+/[a-zA-Z]*[fs]', 'del /f /s'],
  [GIT_PREFIX + 'reset\\b[^;&|\\r\\n]*\\s--hard\\b', 'git reset --hard'],
  [GIT_PREFIX + 'push\\b[^;&|\\r\\n]*(\\s--force(?![-a-zA-Z])|\\s-[a-zA-Z]*f\\b|\\s\\+[a-zA-Z0-9_./-]+)', 'git push --force / +refspec'],
  // A dry run (-n / --dry-run) deletes nothing and is the safe way to preview, so it is not flagged.
  [GIT_PREFIX + 'clean\\b(?![^;&|\\r\\n]*\\s(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)\\b)[^;&|\\r\\n]*\\s(-[a-zA-Z]*[fd]|--force\\b)', 'git clean -fd'],
  // Whole-tree or whole-directory discards, with or without "--". Single-file checkouts stay unflagged.
  [GIT_PREFIX + 'checkout\\b[^;&|\\r\\n]*(\\s(-f|--force)\\b|\\s(--\\s*)?(\\.|\\*|:/)(?=\\s|$)|\\s[^\\s;&|-][^\\s;&|]*[\\\\/](?=\\s|$))', 'git checkout . / <dir>/ / --force'],
  // Matching is case-insensitive, so "-S" (--staged) cannot be told apart from "-s" (--source).
  // Only the long --staged form is treated as the safe unstage-only case.
  [GIT_PREFIX + 'restore\\b(?![^;&|\\r\\n]*\\s--staged\\b(?![^;&|\\r\\n]*\\s(-W|--worktree)\\b))[^;&|\\r\\n]*(\\s(\\.|\\*|:/)(?=\\s|$)|\\s(-W|--worktree)\\b|\\s[^\\s;&|-][^\\s;&|]*[\\\\/](?=\\s|$))', 'git restore working tree'],
  [GIT_PREFIX + 'stash\\s+(drop|clear)\\b', 'git stash drop / clear'],
  [GIT_PREFIX + 'switch\\b[^;&|\\r\\n]*\\s(--discard-changes|-f|--force)\\b', 'git switch --discard-changes'],
  // SUBCMD_RM is what maskDataQuotes() leaves in place of `git rm`. Forced removal outside --cached drops uncommitted edits.
  [GIT_PREFIX + 'SUBCMD_RM\\b(?![^;&|\\r\\n]*\\s--cached\\b)[^;&|\\r\\n]*\\s(-[a-zA-Z]*f[a-zA-Z]*|--force)\\b', 'git rm --force'],
  ['Format-Volume', 'Format-Volume', 'block'],
  ['(^|\\s)format\\s+[a-zA-Z]:', 'format drive', 'block'],
  ['Remove-Item.*HKLM:', 'registry delete (HKLM)'],
  ['(^|\\s)reg\\s+delete', 'reg delete'],
  ['Clear-Disk|Initialize-Disk', 'disk re-init', 'block'],
  ['(taskkill|tskill|pkill|killall|Stop-Process|wmic\\s+process).{0,120}(clash|verge|mihomo|sing-?box|singbox|v2ray|xray|nekobox|nekoray|netch|sstap|shadowsocks|trojan(-go)?|hysteria|naiveproxy|cfw|sysproxy|privoxy)', 'kill proxy client (' + PROXY_RULE + ')'],
  ['(clash|verge|mihomo|sing-?box|singbox|v2ray|xray|nekobox|nekoray|shadowsocks|hysteria).{0,120}(Stop-Process|taskkill|\\.Kill\\()', 'kill proxy client (' + PROXY_RULE + ')'],
  ['(sc(\\.exe)?\\s+(stop|delete|config)|net(\\.exe)?\\s+stop|Stop-Service).{0,120}(clash|sing-?box|v2ray|xray|wintun|tap-windows|tun2socks|shadowsocks|verge|nekobox)', 'stop/delete proxy service (' + PROXY_RULE + ')'],
  ['netsh.{0,80}(interface\\s+set\\s+interface|wlan\\s+disconnect)', 'disable NIC / disconnect WLAN (' + NETWORK_RULE + ')'],
  ['Disable-NetAdapter', 'disable network adapter (' + PROXY_RULE + ')'],
  ['ipconfig\\s+/release6?', 'release IP, drops connectivity (' + NETWORK_RULE + ')'],
  ['rasdial\\s+/d', 'hang up dialup/tunnel (' + PROXY_RULE + ')'],
  ['(^|\\s)route\\s+delete', 'delete route, may break TUN (' + PROXY_RULE + ')'],
  ['(reg(\\.exe)?\\s+add|Set-ItemProperty|New-ItemProperty|regedit).{0,160}Internet\\s+Settings', 'modify system proxy registry (' + PROXY_RULE + ')'],
  ['netsh\\s+winhttp\\s+set\\s+proxy', 'set WinHTTP proxy (' + PROXY_RULE + ')'],
];

// macOS / Linux proxy client names, in addition to the Windows list above.
const UNIX_PROXY_NAMES = '(clash|verge|mihomo|sing-?box|v2ray|xray|nekoray|shadowsocks|hysteria|surge|stash|flclash|hiddify|qv2ray|shadowrocket|tun2socks|privoxy)';

const UNIX_RULES = [
  // Disk / filesystem destruction
  ['(^|[\\s;&|(])diskutil\\s+(erase\\w*|zeroDisk|randomDisk|secureErase|partitionDisk|reformat|apfs\\s+(delete\\w*|erase\\w*))\\b', 'diskutil erase/partition', 'block'],
  ['(^|[\\s;&|(])dd\\b.*\\bof=/dev/', 'dd write to raw device', 'block'],
  ['(^|[\\s;&|(])(mkfs(\\.\\w+)?|newfs_\\w+)\\b', 'format filesystem', 'block'],
  ['(^|[\\s;&|(])tmutil\\s+delete', 'delete Time Machine backups', 'block'],
  ['(^|[\\s;&|(])csrutil\\s+disable', 'disable System Integrity Protection', 'block'],
  // Proxy clients: kill / stop / quit
  ['(^|[\\s;&|(])kill\\b.{0,120}' + UNIX_PROXY_NAMES, 'kill proxy client (' + PROXY_RULE + ')'],
  ['(pkill|killall).{0,120}' + UNIX_PROXY_NAMES, 'kill proxy client (' + PROXY_RULE + ')'],
  ['launchctl\\s+(stop|unload|bootout|remove|disable|kill)\\b.{0,160}' + UNIX_PROXY_NAMES, 'stop proxy launchd service (' + PROXY_RULE + ')'],
  ['systemctl\\s+(stop|disable|mask|kill)\\b.{0,160}' + UNIX_PROXY_NAMES, 'stop proxy systemd service (' + PROXY_RULE + ')'],
  ['osascript.{0,200}(quit.{0,120}' + UNIX_PROXY_NAMES + '|' + UNIX_PROXY_NAMES + '.{0,120}quit)', 'quit proxy app (' + PROXY_RULE + ')'],
  // System proxy / network settings. Read-only forms (-get*, -list*, scutil --proxy) stay allowed.
  ['networksetup\\s+-set\\w+', 'modify network/proxy settings via networksetup (' + PROXY_RULE + ')'],
  ['(^|[\\s;&|(])ifconfig\\s+\\S+\\s+down\\b', 'disable network interface (' + NETWORK_RULE + ')'],
  ['(^|[\\s;&|(])ip\\s+link\\s+set\\s+\\S+\\s+down\\b', 'disable network interface (' + NETWORK_RULE + ')'],
  ['(^|[\\s;&|(])ipconfig\\s+set\\s+\\S+\\s+(none|dhcp|bootp|manual|inform)\\b', 'reconfigure interface IP (' + NETWORK_RULE + ')'],
  ['(^|[\\s;&|(])route\\s+(-n\\s+)?(delete|flush|change)\\b', 'modify routes, may break TUN (' + PROXY_RULE + ')'],
  ['(^|[\\s;&|(])pfctl\\b.*\\s-(d|F)\\b', 'disable/flush pf firewall, may break TUN (' + PROXY_RULE + ')'],
  ['(^|[\\s;&|(])nmcli\\s+(networking\\s+off|radio\\s+wifi\\s+off|(dev(ice)?|con(nection)?)\\s+(down|disconnect))', 'disable network via nmcli (' + NETWORK_RULE + ')'],
];

const RULES = [...WINDOWS_RULES, ...UNIX_RULES].map(([rx, why, tier]) => ({ rx: new RegExp(rx, 'i'), why, tier: tier === 'block' ? 'block' : 'confirm' }));

function stripSegmentQuotes(seg) {
  return seg
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"$`\\])*"/g, '""');
}

// A masked segment must end the command, end at ; & || or a newline, or be piped
// into something that is not a shell or interpreter. `echo 'rm -rf src' | sh`
// runs the quoted text, so its quotes are code, not data, and stay visible.
const PIPE_GUARD = '(?=$|[;&\\r\\n]|\\|\\||\\|(?!\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|iex|Invoke-Expression|xargs|eval|source|python3?|node|perl|ruby)\\b))';
// Search tools: the quoted argument is a pattern. awk is left out on purpose (its program can call system()).
const MASK_SEARCH = '(^|[\\s;&|(])(grep|egrep|fgrep|rg|ripgrep|ag|ack|sed|Select-String)\\b[^;&|\\r\\n]*' + PIPE_GUARD;
// Print commands: the quoted argument is the output, which is only data when nothing re-reads it as code.
const MASK_PRINT = '(^|[\\s;&|(])(echo|printf|Write-Host|Write-Output)\\b[^;&|\\r\\n]*' + PIPE_GUARD;
// If the command line uses command substitution or eval anywhere, printed text may be executed: do not mask it.
const SUBSTITUTION = '\\$\\(|`|\\beval\\b|<\\(';
const MASK_GIT_MSG = B + 'git(\\.exe)?\\b[^;&|\\r\\n]*\\b(commit|tag|notes|merge)\\b[^;&|\\r\\n]*';
// `rm` as a subcommand (git rm, pnpm rm, docker rm, ...) is not the filesystem rm.
const SUBCMD_GIT = GIT_PREFIX + 'rm\\b';
const SUBCMD_PM = '(' + B + '(?:pnpm|npm|yarn|bun|cargo|brew)(?:\\.exe|\\.cmd)?(?:\\s+-\\S+)*\\s+)rm\\b';
const SUBCMD_DOCKER = '(' + B + '(?:docker|podman)(?:\\.exe)?(?:\\s+-\\S+)*(?:\\s+(?:container|image|volume|network|compose|secret|config|context))?\\s+)rm\\b';

function maskDataQuotes(cmd) {
  if (!cmd) return '';
  let out = cmd;
  out = out.replace(new RegExp(MASK_SEARCH, 'gi'), stripSegmentQuotes);
  if (!new RegExp(SUBSTITUTION, 'i').test(cmd)) {
    out = out.replace(new RegExp(MASK_PRINT, 'gi'), stripSegmentQuotes);
  }
  out = out.replace(new RegExp(MASK_GIT_MSG, 'gi'), stripSegmentQuotes);
  out = out.replace(new RegExp(SUBCMD_GIT, 'gi'), (m) => m.slice(0, -2) + 'SUBCMD_RM');
  out = out.replace(new RegExp(SUBCMD_PM, 'gi'), '$1SUBCMD_RM');
  out = out.replace(new RegExp(SUBCMD_DOCKER, 'gi'), '$1SUBCMD_RM');
  return out;
}

function redactCmd(text) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/(https?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, '$1<REDACTED>$2');
  s = s.replace(/(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"'`]+/gi, '$1<REDACTED>');
  s = s.replace(/\b(sk-[a-zA-Z0-9_-]{10,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|ak-[a-zA-Z0-9]{16,})\b/g, '<REDACTED_TOKEN>');
  s = s.replace(/(--?(?:token|password|passwd|secret|api-?key|access-?key|private-?key|auth-?token|client-?secret))(\s+|=)("[^"]*"|'[^']*'|\S+)/gi, '$1$2<REDACTED>');
  s = s.replace(/\b([A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=<REDACTED>');
  if (s.length > 500) s = s.slice(0, 500) + '...(truncated)';
  return s;
}

// Returns { why, tier } for a flagged command, or null. A block rule wins over
// a confirm rule wherever the two sit in the table.
function classify(cmd) {
  const masked = maskDataQuotes(cmd);
  const hit = RULES.find((r) => r.tier === 'block' && r.rx.test(masked))
    || RULES.find((r) => r.tier === 'confirm' && r.rx.test(masked));
  return hit ? { why: hit.why, tier: hit.tier } : null;
}

function check(cmd) {
  const hit = classify(cmd);
  return hit ? hit.why : null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appendLog(record) {
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_ROTATE_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + EOL, 'utf8');
  } catch { /* best effort, never fatal */ }
}

function main(raw) {
  let result = DEFAULT_PASS;
  try {
    if (!raw.trim()) throw new Error('empty stdin');
    const payload = JSON.parse(raw);
    const tool = String(payload?.toolCall?.name ?? '');
    const cmdRaw = payload?.toolCall?.args?.CommandLine;
    const cmd = typeof cmdRaw === 'string' ? cmdRaw : '';
    const hit = classify(cmd);
    let verdict = DEFAULT_MODE.toUpperCase();
    if (hit && (hit.tier === 'block' || CONFIRM_MODE === 'deny')) {
      verdict = 'DENY-DANGER';
      result = JSON.stringify({
        decision: 'deny',
        reason: 'HARD GATE: blocked - ' + hit.why + ' (global rule 1/9). Report to the user instead of retrying a variant.',
      });
    } else if (hit) {
      verdict = 'CONFIRM-DANGER';
      result = JSON.stringify({
        decision: CONFIRM_MODE,
        reason: 'CONFIRM: ' + hit.why + ' (global rule 1/9). Runs only if the user approves this exact command.',
      });
    }
    if (hit || LOG_ALL) {
      appendLog({ ts: stamp(), verdict, count: 0, tool, cmd: redactCmd(cmd) });
    }
  } catch (err) {
    result = DEFAULT_PASS;
    appendLog({ ts: stamp(), verdict: 'ERROR-FAILOPEN', error: String(err && err.message ? err.message : err).replace(/[\r\n]+/g, ' ') });
  }
  process.stdout.write(result);
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => main(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', () => main(''));
}

module.exports = { check, classify, maskDataQuotes, redactCmd, WINDOWS_RULES, UNIX_RULES };
