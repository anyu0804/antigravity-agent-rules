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
//            {"decision":"allow"}
//            {"decision":"deny","reason":"..."}
//
// DESIGN NOTES
//   1. FAIL-OPEN. Any internal error -> {"decision":"allow"}.
//      A broken guard must never wedge the agent loop (hooks are synchronous).
//   2. "allow" is emitted for every non-flagged command, matching
//      autoExecutionPolicy=EAGER (Turbo). IF YOU EVER SWITCH TO AN ASK-FIRST
//      POLICY, this hook must be changed too, otherwise it will keep silently
//      auto-approving commands.
//   3. stdin is read as raw bytes and decoded as UTF-8, so the console code
//      page never matters (the GBK issue handled in the .ps1 does not apply).
//   4. Matching is case-insensitive, same as PowerShell's -match.
//   5. WINDOWS_RULES mirror pretool_guard.ps1 one-to-one. Keep them in sync.
//      UNIX_RULES are extra rules for macOS / Linux commands.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_DIR = __dirname;
const LOG_FILE = path.join(SCRIPT_DIR, 'hook_log.jsonl');
const LOG_ROTATE_BYTES = 524288;
const EOL = process.platform === 'win32' ? '\r\n' : '\n';
const ALLOW = '{"decision":"allow"}';

const PROXY_RULE = 'user rule: proxy/network off-limits without explicit user approval';
const NETWORK_RULE = 'user rule: network off-limits without explicit user approval';

// Mirrors pretool_guard.ps1 lines 84-114.
const WINDOWS_RULES = [
  ['Remove-Item.*-Recurse.*-Force', 'recursive force delete'],
  ['Remove-Item.*-Force.*-Recurse', 'recursive force delete'],
  ['(^|[^a-zA-Z])(Remove-Item|ri|rm|del|erase|rd|rmdir)\\b.*(\\s-(r|recurse)\\b).*(\\s-(fo|force)\\b)', 'recursive force delete (PS alias/short-param)'],
  ['(^|[^a-zA-Z])(Remove-Item|ri|rm|del|erase|rd|rmdir)\\b.*(\\s-(fo|force)\\b).*(\\s-(r|recurse)\\b)', 'recursive force delete (PS alias/short-param)'],
  ['(^|[^a-zA-Z])rm\\s+-[a-zA-Z]*r[a-zA-Z]*f', 'rm -rf'],
  ['(^|[^a-zA-Z])rm\\s+-[a-zA-Z]*f[a-zA-Z]*r', 'rm -fr'],
  ['(^|[^a-zA-Z])rm\\b.*(\\s(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\\b).*(\\s(-[a-zA-Z]*f[a-zA-Z]*|--force)\\b)', 'rm -r -f / --recursive --force'],
  ['(^|[^a-zA-Z])rm\\b.*(\\s(-[a-zA-Z]*f[a-zA-Z]*|--force)\\b).*(\\s(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\\b)', 'rm -f -r / --force --recursive'],
  ['(^|\\s)rd\\s+/s', 'rd /s'],
  ['(^|\\s)rmdir\\s+/s', 'rmdir /s'],
  ['(^|\\s)del\\s+/[a-zA-Z]*[fs]', 'del /f /s'],
  ['git\\s+reset\\s+--hard', 'git reset --hard'],
  ['git\\s+push.*(--force|[^a-zA-Z]-f([^a-zA-Z]|$))', 'git push --force'],
  ['git\\s+clean\\s+-[a-zA-Z]*[fd]', 'git clean -fd'],
  ['Format-Volume', 'Format-Volume'],
  ['(^|\\s)format\\s+[a-zA-Z]:', 'format drive'],
  ['Remove-Item.*HKLM:', 'registry delete (HKLM)'],
  ['(^|\\s)reg\\s+delete', 'reg delete'],
  ['Clear-Disk|Initialize-Disk', 'disk re-init'],
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
  ['(^|[\\s;&|(])diskutil\\s+(erase\\w*|zeroDisk|randomDisk|secureErase|partitionDisk|reformat|apfs\\s+(delete\\w*|erase\\w*))\\b', 'diskutil erase/partition'],
  ['(^|[\\s;&|(])dd\\b.*\\bof=/dev/', 'dd write to raw device'],
  ['(^|[\\s;&|(])(mkfs(\\.\\w+)?|newfs_\\w+)\\b', 'format filesystem'],
  ['(^|[\\s;&|(])tmutil\\s+delete', 'delete Time Machine backups'],
  ['(^|[\\s;&|(])csrutil\\s+disable', 'disable System Integrity Protection'],
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

const RULES = [...WINDOWS_RULES, ...UNIX_RULES].map(([rx, why]) => ({ rx: new RegExp(rx, 'i'), why }));

function check(cmd) {
  for (const r of RULES) {
    if (r.rx.test(cmd)) return r.why;
  }
  return null;
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
  let result = ALLOW;
  try {
    if (!raw.trim()) throw new Error('empty stdin');
    const payload = JSON.parse(raw);
    const tool = String(payload?.toolCall?.name ?? '');
    const cmdRaw = payload?.toolCall?.args?.CommandLine;
    const cmd = typeof cmdRaw === 'string' ? cmdRaw : '';
    const why = check(cmd);
    if (why) {
      result = JSON.stringify({
        decision: 'deny',
        reason: 'HARD GATE: blocked - ' + why + ' (global rule 1/9). Report to the user instead of retrying a variant.',
      });
    }
    appendLog({ ts: stamp(), verdict: why ? 'DENY-DANGER' : 'ALLOW', count: 0, tool, cmd });
  } catch (err) {
    result = ALLOW;
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

module.exports = { check, WINDOWS_RULES, UNIX_RULES };
