"""
verify-hook.py - self-test for the Antigravity PreToolUse guard.

Why this exists
---------------
The guard script reads its payload from stdin. Antigravity sends that payload
as raw UTF-8 bytes, but Windows PowerShell 5.1 decodes stdin with the OEM code
page (GBK/936 on zh-CN). Any non-ASCII byte - for example the Chinese user name
in C:\\Users\\<cn>\\... - got mangled, and a byte following a backslash could be
absorbed into a double-byte GBK character. That turned a legal JSON escape into
an illegal one, the parse failed, and the guard silently fail-opened. A payload
that is pure ASCII never showed the bug, so testing with English paths alone
proves nothing.

This script therefore feeds real UTF-8 payloads - including Chinese paths - and
asserts the verdict. Run it after ANY change to pretool_guard.ps1 or
pretool_guard.cjs.

Usage
-----
    python verify-hook.py                 # Windows: tests pretool_guard.ps1
    python3 verify-hook.py                # macOS / Linux: tests pretool_guard.cjs
    python verify-hook.py --guard node    # force the Node guard (any OS)
    python verify-hook.py --guard ps      # force the PowerShell guard

The Node interpreter defaults to `node` on PATH; set NODE=/abs/path/to/node to
override. SECTION 5 (macOS / Linux rules) only runs against the Node guard,
because pretool_guard.ps1 does not carry those rules.

Exit code 0 = all assertions passed, 1 = at least one failure.
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "test-cases.txt")
LOG = os.path.join(HERE, "hook_log.jsonl")
STATE = os.path.join(HERE, "state")


def pick_guard():
    if "--guard" in sys.argv:
        idx = sys.argv.index("--guard")
        if idx + 1 < len(sys.argv) and sys.argv[idx + 1] in ("ps", "node"):
            return sys.argv[idx + 1]
        sys.exit("usage: verify-hook.py [--guard ps|node]")
    return "ps" if os.name == "nt" else "node"


GUARD = pick_guard()

if GUARD == "ps":
    SCRIPT = os.path.join(HERE, "pretool_guard.ps1")
    PS = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    )
    GUARD_CMD = [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT]
else:
    SCRIPT = os.path.join(HERE, "pretool_guard.cjs")
    NODE = os.environ.get("NODE") or shutil.which("node") or "node"
    GUARD_CMD = [NODE, SCRIPT]

CN = "\u6d4b\u8bd5\u7528\u6237"  # <YOUR_CN_USERNAME> Chinese user-name characters for UTF-8 test


def call_guard(payload_obj):
    """Send a payload as UTF-8 bytes on stdin, return the parsed verdict."""
    raw = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
    proc = subprocess.run(
        GUARD_CMD,
        input=raw, capture_output=True, timeout=90,
    )
    text = proc.stdout.decode("utf-8", errors="replace").strip()
    try:
        return json.loads(text).get("decision", "?"), text
    except Exception:
        return "<unparsable>", text or repr(proc.stderr[:200])


def payload(command, conversation="selftest", step=1, cwd=None):
    args = {"CommandLine": command}
    if cwd:
        args["Cwd"] = cwd
    # Mirror the real shape Antigravity sends, including a Chinese path.
    return {
        "artifactDirectoryPath": "C:/Users/%s/.gemini/antigravity/brain/selftest" % CN,
        "conversationId": conversation,
        "modelName": "gemini-3.8-flash-high",
        "stepIdx": step,
        "toolCall": {"name": "run_command", "args": args},
        "workspacePaths": ["c:/Users/%s/Desktop/test/gemini" % CN],
    }


results = []


def check(label, command, expected, conversation="selftest", cwd=None):
    got, raw = call_guard(payload(command, conversation=conversation, cwd=cwd))
    ok = got == expected
    results.append((ok, label, expected, got, command))
    print("%-4s %-46s expected=%-6s got=%-6s" % ("PASS" if ok else "FAIL",
                                                 label, expected, got))
    return got


def main():
    for path in (LOG, os.path.join(STATE, "")):
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
    if os.path.isdir(STATE):
        for f in os.listdir(STATE):
            try:
                os.remove(os.path.join(STATE, f))
            except OSError:
                pass

    print("=" * 78)
    print("SECTION 1  dangerous commands from test-cases.txt (ASCII framing)")
    print("=" * 78)
    with open(CASES, encoding="utf-8") as fh:
        lines = [ln.strip() for ln in fh if ln.strip()]
    allow_list = {"Get-ChildItem C:\\ | Select-Object Name", "node build.mjs", "npm test"}
    for i, cmd in enumerate(lines):
        expected = "allow" if cmd in allow_list else "deny"
        check("case %02d" % (i + 1), cmd, expected, conversation="s1-%d" % i)

    print()
    print("=" * 78)
    print("SECTION 2  the encoding regression (Chinese path in the payload)")
    print("=" * 78)
    check("benign + Chinese path", "echo hook-probe", "allow",
          conversation="s2-a", cwd="c:\\Users\\%s\\Desktop\\test\\gemini" % CN)
    check("DANGEROUS + Chinese path", "Remove-Item C:\\Users\\%s\\temp\\x -Recurse -Force" % CN,
          "deny", conversation="s2-b", cwd="c:\\Users\\%s\\Desktop\\test\\gemini" % CN)

    print()
    print("=" * 78)
    print("SECTION 3  proxy / network protection (rules lines 105-114)")
    print("=" * 78)
    proxy_deny_cases = [
        ("kill proxy (taskkill mihomo)", "taskkill /F /IM mihomo.exe"),
        ("kill proxy (Stop-Process clash)", "Stop-Process -Name clash-verge -Force"),
        ("kill proxy (pipeline Stop-Process)", "Get-Process sing-box | Stop-Process -Force"),
        ("stop proxy service (sc stop)", "sc.exe stop clash-verge-service"),
        ("stop TUN service (Stop-Service)", "Stop-Service -Name tun2socks -Force"),
        ("disconnect WLAN (netsh)", "netsh wlan disconnect"),
        ("disable NIC (Disable-NetAdapter)", "Disable-NetAdapter -Name 'WLAN' -Confirm:$false"),
        ("release IP (ipconfig /release)", "ipconfig /release"),
        ("hang up dial-up/tunnel (rasdial /d)", "rasdial /d"),
        ("delete route (route delete)", "route delete 0.0.0.0"),
        ("modify proxy reg (reg add)", r'reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f'),
        ("modify proxy reg (Set-ItemProperty)", r'Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0'),
        ("set WinHTTP proxy (netsh winhttp)", "netsh winhttp set proxy 127.0.0.1:7890"),
    ]
    for idx, (label, cmd) in enumerate(proxy_deny_cases):
        check(label, cmd, "deny", conversation="s3-deny-%d" % idx)

    proxy_allow_cases = [
        ("read-only proxy process check", "Get-Process clash,mihomo,sing-box -ErrorAction SilentlyContinue"),
        ("read-only proxy registry query", r'reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable'),
        ("read-only HTTP HEAD probe", "curl.exe -I -s -m 5 https://example.com"),
    ]
    for idx, (label, cmd) in enumerate(proxy_allow_cases):
        check(label, cmd, "allow", conversation="s3-allow-%d" % idx)

    print()
    print("=" * 78)
    print("SECTION 4  stateless benign command repetition (decoupled to read_loop_guard)")
    print("=" * 78)
    for i in (1, 2, 3):
        check("repeat benign build #%d" % i, "npm run build", "allow", conversation="s4")
    for i in (1, 2, 3):
        check("repeat read-only ls #%d" % i, "ls -la", "allow", conversation="s4")

    if GUARD == "node":
        print()
        print("=" * 78)
        print("SECTION 5  macOS / Linux rules (Node guard only)")
        print("=" * 78)
        unix_deny_cases = [
            ("rm -Rf (uppercase R)", "rm -Rf ~/Projects/tmp"),
            ("sudo rm -rf", "sudo rm -rf /usr/local/foo"),
            ("diskutil eraseDisk", "diskutil eraseDisk APFS Blank /dev/disk4"),
            ("diskutil apfs deleteVolume", "diskutil apfs deleteVolume disk3s5"),
            ("dd to raw device", "sudo dd if=/dev/zero of=/dev/rdisk4 bs=1m"),
            ("newfs", "newfs_apfs /dev/disk4s1"),
            ("tmutil delete", "sudo tmutil delete /Volumes/Backup/2026-01-01-000000"),
            ("csrutil disable", "csrutil disable"),
            ("killall ClashX", "killall ClashX"),
            ("pkill mihomo", "pkill -9 mihomo"),
            ("kill $(pgrep sing-box)", "kill -9 $(pgrep sing-box)"),
            ("killall Surge", "killall 'Surge'"),
            ("launchctl bootout clash", "launchctl bootout gui/501/com.metacubex.ClashX.ProxyConfigHelper"),
            ("launchctl unload sing-box", "sudo launchctl unload /Library/LaunchDaemons/io.nekohasekai.sing-box.plist"),
            ("systemctl stop mihomo", "sudo systemctl stop mihomo"),
            ("osascript quit Stash", "osascript -e 'quit app \"Stash\"'"),
            ("networksetup set web proxy", "networksetup -setwebproxy Wi-Fi 127.0.0.1 7890"),
            ("networksetup proxy state off", "networksetup -setsecurewebproxystate Wi-Fi off"),
            ("networksetup wifi power off", "networksetup -setairportpower en0 off"),
            ("ifconfig down", "sudo ifconfig en0 down"),
            ("ip link down", "sudo ip link set eth0 down"),
            ("ipconfig set none", "sudo ipconfig set en0 NONE"),
            ("route flush", "sudo route -n flush"),
            ("route delete default", "sudo route delete default"),
            ("pfctl disable", "sudo pfctl -d"),
            ("pfctl flush all", "sudo pfctl -F all"),
            ("nmcli networking off", "nmcli networking off"),
        ]
        for idx, (label, cmd) in enumerate(unix_deny_cases):
            check(label, cmd, "deny", conversation="s5-deny-%d" % idx)

        unix_allow_cases = [
            ("read-only networksetup get", "networksetup -getwebproxy Wi-Fi"),
            ("read-only networksetup list", "networksetup -listallnetworkservices"),
            ("read-only scutil --proxy", "scutil --proxy"),
            ("read-only pgrep proxy", "pgrep -fl 'clash|mihomo|sing-box'"),
            ("read-only launchctl list", "launchctl list | grep -i clash"),
            ("read-only ifconfig", "ifconfig en0"),
            ("read-only route get", "route -n get default"),
            ("read-only diskutil list", "diskutil list"),
            ("rm single file", "rm build/output.log"),
            ("rm -r without force", "rm -r build/tmp"),
            ("brew install", "brew install jq"),
        ]
        for idx, (label, cmd) in enumerate(unix_allow_cases):
            check(label, cmd, "allow", conversation="s5-allow-%d" % idx)

    print()
    print("=" * 78)
    failed = [r for r in results if not r[0]]
    print("TOTAL %d   PASS %d   FAIL %d" % (len(results), len(results) - len(failed), len(failed)))
    if failed:
        for _, label, exp, got, cmd in failed:
            print("  FAILED %s: expected %s got %s  [%s]" % (label, exp, got, cmd))
    print("=" * 78)

    # Any fail-open during this run is itself a failure signal.
    if os.path.isfile(LOG):
        with open(LOG, "rb") as fh:
            data = fh.read().decode("utf-8", errors="replace")
        n_err = data.count("ERROR-FAILOPEN")
        print("ERROR-FAILOPEN entries in log: %d %s" % (n_err, "(must be 0)" if n_err else "(clean)"))
        if n_err:
            for ln in data.splitlines():
                if "ERROR-FAILOPEN" in ln:
                    print("   ", ln[:300])
            sys.exit(1)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
