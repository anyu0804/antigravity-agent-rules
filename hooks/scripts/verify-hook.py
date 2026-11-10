"""
verify-hook.py - offline regression self-test for the Antigravity PreToolUse guard.

Why this exists
---------------
The guard script reads its payload from stdin. Antigravity sends that payload
as raw UTF-8 bytes, but Windows PowerShell 5.1 decodes stdin with the OEM code
page (GBK/936 on zh-CN). Any non-ASCII byte - for example the Chinese user name
in C:\\Users\\<cn>\\... - got mangled, and a byte following a backslash could be
absorbed into a double-byte GBK character. That turned a legal JSON escape into
an illegal one, the parse failed, and the guard silently fail-opened.

NOTE: This script feeds synthetic UTF-8 payloads to the guard script over stdin
to verify regex rules, quote-masking, secret redaction, and UTF-8 decoding. It
does NOT prove that the Antigravity host process has loaded hooks.json; see
README.md for the live host verification step.

Sections 1-5 run with the default settings, where every flagged command is
denied. Section 6 replays TIER_CORPUS with confirmDecision=force_ask, the one
mode in which the three outcomes (block / confirm / pass) are all visible.
The corpus is a regression fixture: a rule change that moves any command to a
different outcome fails here and has to be reviewed and recorded on purpose.
Section 8 is static: it compares the regex tables of the two guard scripts, so
it also covers the guard that cannot run on the current OS.

Usage
-----
    python verify-hook.py                 # Windows: tests pretool_guard.ps1
    python3 verify-hook.py                # macOS / Linux: tests pretool_guard.cjs
    python verify-hook.py --guard node    # force the Node guard (any OS)
    python verify-hook.py --guard ps      # force the PowerShell guard

Exit code 0 = all assertions passed, 1 = at least one failure.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "test-cases.txt")
LOG = os.path.join(HERE, "hook_log.jsonl")
STATE = os.path.join(HERE, "state")

PASS_DECISION = "ask"
TMP = tempfile.mkdtemp(prefix="agy-hook-selftest-")
NO_SETTINGS = os.path.join(TMP, "absent.json")
ENV_KEYS = ("AGY_HOOK_DEFAULT_DECISION", "AGY_HOOK_CONFIRM_DECISION", "AGY_HOOK_LOG_ALL")


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

CN = "\u6d4b\u8bd5\u7528\u6237"  # Chinese user-name characters for UTF-8 test


def settings_file(settings):
    """None -> a path that does not exist; dict -> JSON file; str -> raw file text."""
    if settings is None:
        return NO_SETTINGS
    path = os.path.join(TMP, "settings-%d.json" % len(os.listdir(TMP)))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(settings if isinstance(settings, str) else json.dumps(settings))
    return path


def call_guard(payload_obj, settings=None, extra_env=None):
    """Send a payload as UTF-8 bytes on stdin, return the parsed verdict.

    The guard is always pointed at a settings file owned by this run, so a
    pretool_guard_settings.json the user keeps next to the script cannot change
    the expected verdicts.
    """
    raw = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
    env = os.environ.copy()
    for key in ENV_KEYS:
        env.pop(key, None)
    env["AGY_HOOK_SETTINGS"] = settings_file(settings)
    env.update(extra_env or {})
    proc = subprocess.run(
        GUARD_CMD,
        input=raw, capture_output=True, timeout=90, env=env,
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
    return {
        "artifactDirectoryPath": "C:/Users/%s/.gemini/antigravity/brain/selftest" % CN,
        "conversationId": conversation,
        "modelName": "gemini-3.8-flash-high",
        "stepIdx": step,
        "toolCall": {"name": "run_command", "args": args},
        "workspacePaths": ["c:/Users/%s/Desktop/test/gemini" % CN],
    }


results = []


def check(label, command, expected, conversation="selftest", cwd=None, settings=None, extra_env=None):
    got, raw = call_guard(payload(command, conversation=conversation, cwd=cwd),
                          settings=settings, extra_env=extra_env)
    ok = got == expected
    results.append((ok, label, expected, got, command))
    print("%-4s %-46s expected=%-6s got=%-6s" % ("PASS" if ok else "FAIL",
                                                 label, expected, got))
    return got


# ---------------------------------------------------------------------------
# TIER_CORPUS: (expected tier, scope, command)
#   tier  : "block"   always denied
#           "confirm" answered with confirmDecision (deny unless the user opts in)
#           "pass"    not flagged; answered with defaultDecision
#   scope : "all"  both guards        "unix" Node guard only (UNIX_RULES)
# Adding a rule? Add the commands it should catch AND the look-alikes it must
# leave alone. Changing a rule? Every line whose outcome moves needs a reason.
# ---------------------------------------------------------------------------
TIER_CORPUS = [
    # --- block: irreversible, and never inside a workspace -------------------
    ("block", "all", "rm -rf /"),
    ("block", "all", "rm -rf / tmp/build"),
    ("block", "all", "rm -rf ~"),
    ("block", "all", "rm -rf ~/*"),
    ("block", "all", 'sudo rm -rf "$HOME"'),
    ("block", "all", "rm -rf --no-preserve-root /"),
    ("block", "all", "rm -rf /usr/"),
    ("block", "all", "rm -rf /Users/alice"),
    ("block", "all", "Remove-Item C:\\ -Recurse -Force"),
    ("block", "all", "Remove-Item $env:USERPROFILE -Recurse -Force"),
    ("block", "all", "rd /s /q C:\\Users"),
    ("block", "all", "del /f /s /q C:\\*"),
    ("block", "all", 'find / -name "*.log" -delete'),
    ("block", "all", "find ~ -type f -exec rm {} +"),
    ("block", "all", "Format-Volume -DriveLetter D"),
    ("block", "all", "format D: /q"),
    ("block", "all", "Clear-Disk -Number 1 -RemoveData"),
    ("block", "unix", "diskutil eraseDisk APFS Blank /dev/disk4"),
    ("block", "unix", "sudo dd if=/dev/zero of=/dev/rdisk4 bs=1m"),
    ("block", "unix", "mkfs.ext4 /dev/sdb1"),
    ("block", "unix", "csrutil disable"),
    # --- confirm: recursive deletes --------------------------------------------
    ("confirm", "all", "rm -rf build"),
    ("confirm", "all", "rm -r dist"),
    ("confirm", "all", "rm -rf node_modules/.cache"),
    ("confirm", "all", "rm -rf ~/Projects/tmp"),
    ("confirm", "all", "rm -rf /usr/local/foo"),
    ("confirm", "all", "rm -rf $HOME/.cache/app"),
    ("confirm", "all", "/bin/rm -rf src"),
    ("confirm", "all", "\\rm -rf src"),
    ("confirm", "all", "sudo rm -rf ./out"),
    ("confirm", "all", "xargs rm -rf < list.txt"),
    ("confirm", "all", 'bash -lc "rm -rf /tmp/x"'),
    ("confirm", "all", "Remove-Item -Recurse src"),
    ("confirm", "all", "Remove-Item C:\\temp\\x -Recurse -Force"),
    ("confirm", "all", "rd /s /q C:\\foo"),
    ("confirm", "all", "del /f /s /q C:\\foo\\*"),
    ("confirm", "all", 'find . -name "*.pyc" -delete'),
    ("confirm", "all", "find build -type d -exec /bin/rm -rf {} +"),
    ("confirm", "all", 'python -c "import shutil; shutil.rmtree(\'src\')"'),
    ("confirm", "all", "node -e \"require('fs').rmSync('src',{recursive:true})\""),
    ("confirm", "all", "awk 'BEGIN{system(\"rm -rf src\")}'"),
    # --- confirm: text that ends up being executed ---------------------------------
    ("confirm", "all", "echo 'rm -rf src' | sh"),
    ("confirm", "all", "printf 'git reset --hard' | sudo bash"),
    ("confirm", "all", "eval \"$(echo 'rm -rf src')\""),
    # --- confirm: git history and working tree ---------------------------------------
    ("confirm", "all", "git reset --hard HEAD~1"),
    ("confirm", "all", "git -C ./repo reset --hard"),
    ("confirm", "all", "/usr/bin/git reset --hard"),
    ("confirm", "all", '& "C:\\Program Files\\Git\\cmd\\git.exe" reset --hard'),
    ("confirm", "all", "git push --force origin main"),
    ("confirm", "all", "git push origin +main"),
    ("confirm", "all", "git clean -fd"),
    ("confirm", "all", "git checkout -- ."),
    ("confirm", "all", "git checkout ."),
    ("confirm", "all", "git checkout -- src/"),
    ("confirm", "all", "git restore ."),
    ("confirm", "all", "git restore src/"),
    ("confirm", "all", "git restore -s HEAD~1 ."),
    ("confirm", "all", "git stash clear"),
    ("confirm", "all", "git switch --discard-changes main"),
    ("confirm", "all", "git rm -rf src"),
    # --- confirm: registry, proxy clients, network ------------------------------------
    ("confirm", "all", "Remove-Item HKLM:\\Software\\Foo"),
    ("confirm", "all", "reg delete HKCU\\Software\\Foo /f"),
    ("confirm", "all", "taskkill /F /IM mihomo.exe"),
    ("confirm", "all", "Stop-Service -Name tun2socks -Force"),
    ("confirm", "all", "netsh winhttp set proxy 127.0.0.1:7890"),
    ("confirm", "all", "route delete 0.0.0.0"),
    ("confirm", "all", "ip route delete 10.0.0.0/8 dev tun9"),
    ("confirm", "unix", "killall ClashX"),
    ("confirm", "unix", "sudo systemctl stop mihomo"),
    ("confirm", "unix", "networksetup -setwebproxy Wi-Fi 127.0.0.1 7890"),
    ("confirm", "unix", "sudo ifconfig en0 down"),
    # --- pass: look-alikes that delete nothing or only what was asked -----------------
    ("pass", "all", "npm test"),
    ("pass", "all", "ls -la"),
    ("pass", "all", "rm build/output.log"),
    ("pass", "all", "rm -f tmp.txt"),
    ("pass", "all", "git status"),
    ("pass", "all", "git clean -n -d"),
    ("pass", "all", "git clean --dry-run -fd"),
    ("pass", "all", "git rm -r --cached node_modules"),
    ("pass", "all", "git restore --staged ."),
    ("pass", "all", "git checkout -- src/a.ts"),
    ("pass", "all", "git checkout -b feature/x origin/feature/x"),
    ("pass", "all", "git push --force-with-lease origin my-feature"),
    ("pass", "all", "git stash pop"),
    ("pass", "all", "git branch -d merged-branch"),
    ("pass", "all", 'git commit -m "docs: warn about rm -rf in clean script"'),
    ("pass", "all", 'grep -rn "rm -rf" scripts/'),
    ("pass", "all", 'sed -i "s/rm -rf/trash/" clean.sh'),
    ("pass", "all", "echo 'rm -rf src' > notes.txt"),
    ("pass", "all", "echo 'git reset --hard' | tee -a notes.txt"),
    ("pass", "all", "pnpm rm -r lodash"),
    ("pass", "all", "docker run --rm -it img sh"),
    ("pass", "all", "docker container rm -f web"),
    ("pass", "all", 'python -c "import os; os.remove(\'tmp.txt\')"'),
    ("pass", "all", 'find . -name "*.ts" -newer build.stamp'),
    ("pass", "all", "cd / && ls"),
    ("pass", "all", "tar -xzf a.tgz -C /tmp/x"),
    ("pass", "all", "Get-ChildItem C:\\ | Select-Object Name"),
    ("pass", "all", "Get-Process clash,mihomo,sing-box -ErrorAction SilentlyContinue"),
    ("pass", "all", "curl.exe -I -s -m 5 https://example.com"),
    ("pass", "unix", "networksetup -getwebproxy Wi-Fi"),
    ("pass", "unix", "scutil --proxy"),
    # --- pass, but KNOWN GAPS: destructive and not flagged today -----------------------
    # Listed so that the limits of a regex blocklist are written down, and so
    # that closing one of these is a deliberate change to this table.
    ("pass", "all", "git branch -D feature"),          # -D vs -d needs case-sensitive matching
    ("pass", "all", "X=rm; $X -rf src"),               # indirection through a variable
    ("pass", "all", '[IO.Directory]::Delete("src", $true)'),
    ("pass", "all", "rsync -a --delete empty/ src/"),
    ("pass", "all", "truncate -s 0 data.db"),
    ("pass", "all", "mv src /tmp/gone"),
    ("pass", "all", "docker system prune -af --volumes"),
    ("pass", "all", "python cleanup.py"),              # whatever the script does is invisible here
]

TIER_DECISION = {"block": "deny", "confirm": "force_ask", "pass": PASS_DECISION}


# ---------------------------------------------------------------------------
# Static comparison of the two guard scripts. Nothing from either file is
# executed: string literals are lifted out of the source text and compared.
# ---------------------------------------------------------------------------
def _js_literal(src, i):
    quote = src[i]
    i += 1
    out = []
    while src[i] != quote:
        if src[i] == "\\":
            i += 1
            out.append({"n": "\n", "r": "\r", "t": "\t"}.get(src[i], src[i]))
        else:
            out.append(src[i])
        i += 1
    return "".join(out), i + 1


def _ps_literal(src, i):
    i += 1
    out = []
    while True:
        if src[i] == "'":
            if src[i + 1:i + 2] == "'":
                out.append("'")
                i += 2
                continue
            return "".join(out), i + 1
        out.append(src[i])
        i += 1


def _concat(src, i, consts, literal, name_rx):
    """Evaluate  'text' + NAME + 'text' ...  starting at src[i]."""
    parts = []
    while True:
        while src[i] in " \t":
            i += 1
        if src[i] in "'\"":
            value, i = literal(src, i)
        else:
            m = re.match(name_rx, src[i:])
            if not m:
                raise ValueError("not a string expression")
            value = consts[m.group(1)]
            i += m.end()
        parts.append(value)
        while i < len(src) and src[i] in " \t":
            i += 1
        if i < len(src) and src[i] == "+":
            i += 1
            continue
        return "".join(parts), i


def lift_cjs(text):
    """Return (string constants, [(pattern, tier)]) for WINDOWS_RULES in pretool_guard.cjs."""
    name_rx = r"([A-Z_][A-Z0-9_]*)"
    consts = {}
    for m in re.finditer(r"^const ([A-Z_][A-Z0-9_]*) = ", text, re.M):
        try:
            consts[m.group(1)], _ = _concat(text, m.end(), consts, _js_literal, name_rx)
        except (ValueError, KeyError, IndexError):
            pass  # not a plain string constant
    block = re.search(r"^const WINDOWS_RULES = \[\n(.*?)^\];", text, re.M | re.S).group(1)
    rules = []
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("["):
            continue
        pattern, i = _concat(line, 1, consts, _js_literal, name_rx)
        _, i = _concat(line, i + 1, consts, _js_literal, name_rx)
        m = re.match(r"\s*,\s*'(\w+)'", line[i:])
        rules.append((pattern, m.group(1) if m else "confirm"))
    return consts, rules


def lift_ps1(text):
    """Return (string constants, [(pattern, tier)]) for the rule table in pretool_guard.ps1."""
    name_rx = r"\$([A-Za-z][A-Za-z0-9]*)"
    consts = {}
    for m in re.finditer(r"^\$([A-Za-z][A-Za-z0-9]*) = ", text, re.M):
        line_end = text.find("\n", m.end())
        try:
            consts[m.group(1)], _ = _concat(text[:line_end], m.end(), consts, _ps_literal, name_rx)
        except (ValueError, KeyError, IndexError):
            pass
    rules = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("@{ rx = "):
            continue
        pattern, _ = _concat(line, len("@{ rx = "), consts, _ps_literal, name_rx)
        m = re.search(r";\s*tier\s*=\s*'(\w+)'\s*\}\s*,?\s*$", line)
        rules.append((pattern, m.group(1) if m else "confirm"))
    return consts, rules


# Pattern constants that must hold the same regex in both scripts: (cjs name, ps1 name).
SHARED_CONSTANTS = [
    ("B", "boundary"), ("GIT_PREFIX", "gitPrefix"), ("ROOTISH", "rootish"),
    ("PIPE_GUARD", "pipeGuard"), ("MASK_SEARCH", "maskSearch"), ("MASK_PRINT", "maskPrint"),
    ("SUBSTITUTION", "substitution"), ("MASK_GIT_MSG", "maskGitMsg"),
    ("SUBCMD_GIT", "subcmdGit"), ("SUBCMD_PM", "subcmdPm"), ("SUBCMD_DOCKER", "subcmdDocker"),
]


def static_check(label, ok, detail=""):
    results.append((ok, label, "same", "same" if ok else "differ", detail))
    print("%-4s %-46s %s" % ("PASS" if ok else "FAIL", label, "" if ok else detail))


def compare_guards():
    cjs_path = os.path.join(HERE, "pretool_guard.cjs")
    ps1_path = os.path.join(HERE, "pretool_guard.ps1")
    if not (os.path.isfile(cjs_path) and os.path.isfile(ps1_path)):
        print("SKIP both guard scripts are needed for the comparison; only one is present")
        return
    with open(cjs_path, encoding="utf-8") as fh:
        cjs_text = fh.read()
    with open(ps1_path, "rb") as fh:
        ps1_bytes = fh.read()
    ps1_text = ps1_bytes.decode("utf-8", errors="replace")

    try:
        js_consts, js_rules = lift_cjs(cjs_text)
        ps_consts, ps_rules = lift_ps1(ps1_text)
    except Exception as exc:  # a layout change in either table must fail loudly, not pass silently
        static_check("rule tables could be read", False, "could not parse a rule table: %r" % (exc,))
        return

    diffs = []
    for js_name, ps_name in SHARED_CONSTANTS:
        if js_consts.get(js_name) is None or js_consts.get(js_name) != ps_consts.get(ps_name):
            diffs.append("%s / $%s" % (js_name, ps_name))
    static_check("shared pattern constants identical", not diffs, "differ: " + ", ".join(diffs))

    diffs = []
    if len(js_rules) != len(ps_rules):
        diffs.append("rule count cjs=%d ps1=%d" % (len(js_rules), len(ps_rules)))
    for n, (a, b) in enumerate(zip(js_rules, ps_rules), 1):
        if a != b:
            diffs.append("rule %d" % n)
    static_check("rule tables identical (%d rules)" % len(js_rules), not diffs and bool(js_rules),
                 "differ: " + ", ".join(diffs))

    bad = sorted({b for b in ps1_bytes if b > 127})
    static_check("pretool_guard.ps1 is pure ASCII", not bad, "non-ASCII bytes present")


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
    pass_list = {"Get-ChildItem C:\\ | Select-Object Name", "node build.mjs", "npm test"}
    for i, cmd in enumerate(lines):
        expected = PASS_DECISION if cmd in pass_list else "deny"
        check("case %02d" % (i + 1), cmd, expected, conversation="s1-%d" % i)

    print()
    print("=" * 78)
    print("SECTION 2  the encoding regression (Chinese path in the payload)")
    print("=" * 78)
    check("benign + Chinese path", "echo hook-probe", PASS_DECISION,
          conversation="s2-a", cwd="c:\\Users\\%s\\Desktop\\test\\gemini" % CN)
    check("DANGEROUS + Chinese path", "Remove-Item C:\\Users\\%s\\temp\\x -Recurse -Force" % CN,
          "deny", conversation="s2-b", cwd="c:\\Users\\%s\\Desktop\\test\\gemini" % CN)

    print()
    print("=" * 78)
    print("SECTION 3  proxy / network protection")
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

    proxy_pass_cases = [
        ("read-only proxy process check", "Get-Process clash,mihomo,sing-box -ErrorAction SilentlyContinue"),
        ("read-only proxy registry query", r'reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable'),
        ("read-only HTTP HEAD probe", "curl.exe -I -s -m 5 https://example.com"),
    ]
    for idx, (label, cmd) in enumerate(proxy_pass_cases):
        check(label, cmd, PASS_DECISION, conversation="s3-pass-%d" % idx)

    print()
    print("=" * 78)
    print("SECTION 4  edge cases: git -C, refspec +, find -delete, quote masking")
    print("=" * 78)
    edge_deny_cases = [
        ("git -C repo reset --hard", "git -C repo reset --hard"),
        ("git checkout -- .", "git checkout -- ."),
        ("git -C repo checkout -- .", "git -C repo checkout -- ."),
        ("git restore .", "git restore ."),
        ("git -C repo restore .", "git -C repo restore ."),
        ("rm -r build (without -f)", "rm -r build"),
        ("find -delete", "find . -name '*.tmp' -delete"),
        ("git push origin +main", "git push origin +main"),
        ("bash -c wrapped rm -rf", 'bash -lc "rm -rf /tmp/x"'),
        ("python -c shutil.rmtree", 'python -c "import shutil; shutil.rmtree(\'build\')"'),
        ("node -e fs.rmSync", 'node -e "fs.rmSync(\'build\', {recursive:true})"'),
        ("grep followed by && rm -rf", 'grep -rn "rm -rf" scripts/ && rm -rf build --token sk-secret1234567890'),
        # Path-prefixed executables are the same commands.
        ("/bin/rm -rf (absolute path)", "/bin/rm -rf src"),
        ("\\rm -rf (alias bypass)", "\\rm -rf src"),
        ("/usr/bin/git reset --hard", "/usr/bin/git reset --hard"),
        ("quoted git.exe path reset --hard", '& "C:\\Program Files\\Git\\cmd\\git.exe" reset --hard'),
        # Printed text that is piped into a shell, or re-read through substitution, is code.
        ("echo ... | sh", "echo 'rm -rf src' | sh"),
        ("printf ... | sudo bash", "printf 'git reset --hard' | sudo bash"),
        ("eval of echoed text", "eval \"$(echo 'rm -rf src')\""),
        # Whole-tree / whole-directory discards and their neighbours.
        ("git checkout . (no --)", "git checkout ."),
        ("git checkout -- src/", "git checkout -- src/"),
        ("git restore src/", "git restore src/"),
        ("git restore -s HEAD~1 . (source, not staged)", "git restore -s HEAD~1 ."),
        ("git stash clear", "git stash clear"),
        ("git switch --discard-changes", "git switch --discard-changes main"),
        ("git rm -rf", "git rm -rf src"),
        ("find -exec /bin/rm", "find build -type d -exec /bin/rm -rf {} +"),
        ("bare rmtree import", 'python -c "from shutil import rmtree; rmtree(\'src\')"'),
        ("require(fs).rmSync recursive", "node -e \"require('fs').rmSync('src',{recursive:true})\""),
    ]
    for idx, (label, cmd) in enumerate(edge_deny_cases):
        check(label, cmd, "deny", conversation="s4-deny-%d" % idx)

    edge_pass_cases = [
        ("grep -rn 'rm -rf' scripts/", 'grep -rn "rm -rf" scripts/'),
        ("git commit -m with rm -rf", 'git commit -m "fix rm -rf and git reset --hard regex"'),
        ("git push --force-with-lease", "git push --force-with-lease origin main"),
        ("git restore --staged . (safe unstage)", "git restore --staged ."),
        ("git restore --staged src/", "git restore --staged src/"),
        ("git clean dry run", "git clean -n -d"),
        ("git clean --dry-run -fd", "git clean --dry-run -fd"),
        ("git rm -r --cached (untrack only)", "git rm -r --cached node_modules"),
        ("pnpm rm -r (dependency, not files)", "pnpm rm -r lodash"),
        ("docker rm (container)", "docker container rm -f web"),
        ("git checkout single file", "git checkout -- src/a.ts"),
        ("git push --force-if-includes", "git push --force-with-lease --force-if-includes origin main"),
        ("interpreter single-file delete", 'python -c "import os; os.remove(\'tmp.txt\')"'),
        ("sed script mentioning rm -rf", 'sed -i "s/rm -rf/trash/" clean.sh'),
        ("echo text to a file", "echo 'rm -rf src' > notes.txt"),
        ("echo text piped to tee", "echo 'git reset --hard' | tee -a notes.txt"),
        ("repeat benign build #1", "npm run build"),
        ("repeat read-only ls #1", "ls -la"),
    ]
    for idx, (label, cmd) in enumerate(edge_pass_cases):
        check(label, cmd, PASS_DECISION, conversation="s4-pass-%d" % idx)

    if GUARD == "node":
        print()
        print("=" * 78)
        print("SECTION 5  macOS / Linux rules (Node guard only)")
        print("=" * 78)
        unix_deny_cases = [
            ("rm -Rf (uppercase R)", "rm -Rf ~/Projects/tmp"),
            ("sudo rm -rf", "sudo rm -rf /usr/local/foo"),
            ("rm -r build/tmp", "rm -r build/tmp"),
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

        unix_pass_cases = [
            ("read-only networksetup get", "networksetup -getwebproxy Wi-Fi"),
            ("read-only networksetup list", "networksetup -listallnetworkservices"),
            ("read-only scutil --proxy", "scutil --proxy"),
            ("read-only pgrep proxy", "pgrep -fl 'clash|mihomo|sing-box'"),
            ("read-only launchctl list", "launchctl list | grep -i clash"),
            ("read-only ifconfig", "ifconfig en0"),
            ("read-only route get", "route -n get default"),
            ("read-only diskutil list", "diskutil list"),
            ("rm single file", "rm build/output.log"),
            ("brew install", "brew install jq"),
        ]
        for idx, (label, cmd) in enumerate(unix_pass_cases):
            check(label, cmd, PASS_DECISION, conversation="s5-pass-%d" % idx)

    print()
    print("=" * 78)
    print("SECTION 6  tier corpus, replayed with confirmDecision=force_ask")
    print("=" * 78)
    opt_in = {"confirmDecision": "force_ask"}
    for idx, (tier, scope, cmd) in enumerate(TIER_CORPUS):
        if scope == "unix" and GUARD != "node":
            continue
        check("%-7s %s" % (tier, cmd[:38]), cmd, TIER_DECISION[tier],
              conversation="s6-%d" % idx, settings=opt_in)

    print()
    print("=" * 78)
    print("SECTION 7  settings file and environment precedence")
    print("=" * 78)
    check("file: defaultDecision=allow", "npm test", "allow",
          conversation="s7-a", settings={"defaultDecision": "allow"})
    check("env beats file (default)", "npm test", "ask",
          conversation="s7-b", settings={"defaultDecision": "allow"},
          extra_env={"AGY_HOOK_DEFAULT_DECISION": "ask"})
    check("file: confirmDecision=force_ask", "rm -r build", "force_ask",
          conversation="s7-c", settings={"confirmDecision": "force_ask"})
    check("block tier ignores confirmDecision", "rm -rf /", "deny",
          conversation="s7-d", settings={"confirmDecision": "ask", "defaultDecision": "allow"})
    check("env beats file (confirm)", "rm -r build", "deny",
          conversation="s7-e", settings={"confirmDecision": "force_ask"},
          extra_env={"AGY_HOOK_CONFIRM_DECISION": "deny"})
    check("broken file -> strict default (pass)", "npm test", "ask",
          conversation="s7-f", settings="{ not json")
    check("broken file -> strict default (confirm)", "rm -r build", "deny",
          conversation="s7-g", settings="{ not json")
    check("unknown values ignored (pass)", "npm test", "ask",
          conversation="s7-h", settings={"defaultDecision": "auto_approve", "confirmDecision": "allow"})
    check("confirm tier can never become allow", "rm -r build", "deny",
          conversation="s7-i", settings={"defaultDecision": "auto_approve", "confirmDecision": "allow"})

    print()
    print("=" * 78)
    print("SECTION 8  static comparison of pretool_guard.cjs and pretool_guard.ps1")
    print("=" * 78)
    compare_guards()

    shutil.rmtree(TMP, ignore_errors=True)

    print()
    print("=" * 78)
    failed = [r for r in results if not r[0]]
    print("TOTAL %d   PASS %d   FAIL %d" % (len(results), len(results) - len(failed), len(failed)))
    if failed:
        for _, label, exp, got, cmd in failed:
            print("  FAILED %s: expected %s got %s  [%s]" % (label, exp, got, cmd))
    print("=" * 78)

    # Verify audit log behavior: zero ERROR-FAILOPEN, zero ASK/ALLOW plaintext entries, and secret redaction
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
        if "sk-secret1234567890" in data:
            print("FATAL: plaintext secret leaked into hook_log.jsonl!")
            sys.exit(1)
        if '"verdict":"ASK"' in data or '"verdict":"ALLOW"' in data:
            print("FATAL: non-blocked commands should not be logged by default!")
            sys.exit(1)
        print("Audit log privacy & secret redaction check: PASS")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
