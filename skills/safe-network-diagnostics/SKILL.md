---
name: safe-network-diagnostics
description: 当任务涉及网络连通性排查、本地代理客户端状态检查、DNS解析测试、端口探测或接口请求报错诊断时使用。固化用户代理严格只读红线与安全只读诊断命令规范。
---

# 安全网络与代理只读诊断规范（safe-network-diagnostics）

> 权威来源：继承自 [`~/.gemini/GEMINI.md`](../../../../GEMINI.md)「用户代理与网络配置：未经许可一律只读」全局红线。命令行底层硬拦截位于 [`~/.gemini/config/scripts/pretool_guard.ps1`](../../../scripts/pretool_guard.ps1)（Windows）与 [`~/.gemini/config/scripts/pretool_guard.cjs`](../../../scripts/pretool_guard.cjs)（macOS / Linux）。

## 1. 绝对红线：未经当次明确许可，严禁任何写/停操作

未经用户**当次明确许可**，严禁执行任何停止、禁用、重启、卸载用户代理或更改网络配置的操作，包括但不限于：

1. **严禁结束代理客户端进程**：
   - 严禁使用 `taskkill` / `tskill` / `kill` / `pkill` / `killall` / `Stop-Process` / `wmic` / `osascript ... quit` 针对以下目标：`clash`、`verge`、`mihomo`、`sing-box`、`v2ray`、`xray`、`neko`、`shadowsocks`、`hysteria`、`surge`、`stash` 等一切代理核心与 GUI 进程。
2. **严禁停止或删除相关代理/TUN 服务**：
   - Windows：严禁执行 `sc stop`、`net stop`、`Stop-Service`、`sc delete` 等命令；
   - macOS / Linux：严禁执行 `launchctl bootout/unload/remove/stop`、`systemctl stop/disable/mask` 等影响代理或虚拟网卡守护进程的命令。
3. **严禁破坏性网络层操作**：
   - Windows：严禁执行 `netsh wlan disconnect`、`Disable-NetAdapter`、`ipconfig /release`、`rasdial /d`、`route delete`；
   - macOS / Linux：严禁执行 `ifconfig ... down`、`ip link set ... down`、`ipconfig set`、`nmcli ... off/down`、`route delete/flush/change`、`pfctl -d/-F`。
4. **严禁修改系统代理设置**：
   - Windows：严禁通过 `reg add` / `Set-ItemProperty` 修改 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`（`ProxyEnable` / `ProxyServer`），严禁执行 `netsh winhttp set proxy`；
   - macOS：严禁执行 `networksetup -setwebproxy` / `-setsecurewebproxy` / `-setsocksfirewallproxy` / `-set*state` 或通过 `scutil` 写入代理配置。

---

## 2. 标准只读网络诊断 SOP

排查网络故障、代理连通性或接口超时问题时，**只允许使用只读命令与只读参数**：

### 2.1 检查系统代理配置（只读）
```bash
# [Windows] 查询当前用户级系统代理注册表与 WinHTTP 代理设置
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer
netsh winhttp show proxy

# [macOS] 查询系统动态代理状态与 Wi-Fi 代理配置
scutil --proxy
networksetup -getwebproxy Wi-Fi
networksetup -getsecurewebproxy Wi-Fi
networksetup -getsocksfirewallproxy Wi-Fi

# [Linux / 通用] 查询当前 Shell 代理环境变量
env | grep -i proxy
```

### 2.2 检查本地代理端口监听状态（只读）
```bash
# [Windows] 查看常见代理端口（如 7890, 7897, 1080, 10808, 2080 等）是否在监听
netstat -ano | grep -E "LISTENING" | grep -E ":(7890|7897|1080|10808|2080)\b"

# [macOS] 查看常见代理端口监听进程
lsof -nP -iTCP -sTCP:LISTEN | grep -E ":(7890|7897|1080|10808|2080)\b"

# [Linux] 查看常见代理端口监听套接字
ss -tulnp | grep -E ":(7890|7897|1080|10808|2080)\b"
```

### 2.3 HTTP/HTTPS 连通性探测（严格限制 GET / HEAD）
- **注意**：`curl` 本身支持上传与写请求，不能凭程序名当作只读保证；诊断时**仅限 `GET` / `HEAD` 类读取**，并加上超时控制（`-m` / `--connect-timeout`）：
```bash
# 只读探测响应头与状态码（跨平台通用）
curl -I -s -m 5 https://www.google.com | head -n 5
```

### 2.4 DNS 与基础网卡/路由查询（只读）
```bash
# [Windows]
nslookup <domain>
ping -n 3 <host>
netsh interface ip show config

# [macOS]
scutil --dns
nslookup <domain>
ping -c 3 <host>
ifconfig

# [Linux]
nslookup <domain>
ping -c 3 <host>
ip addr
ip route
```

### 2.5 鉴别大体积工具调用导致的“假性断网”
若报错为 `The stream was interrupted` 或 `stream idle timeout`，排查网络前先检查上一步是否正在发起大体积 `write_file`（如单次写入 >2,500 字的长篇小说、大文档或大文件）。Antigravity 的 `BidiGenerateContent` 流在服务端生成 Tool Call JSON 参数时采用整包缓冲，参数全部拼装完成前流处于 0 字节静默；当单次写入过大导致后台缓冲耗时超过 90~120s 时，会被网关或客户端空闲超时直接掐断——**这属于单次工具输出块过大，并非用户代理或网络故障**。遇到此类情况直接改用 `write_file` + `Append: true` 分块（单次 ≤1,500–2,000 字）写入即可，无需探测或重启代理。

### 2.6 合法排查请求被安全过滤误拦时
排查网络、硬件或底层问题时，提示词、子任务描述与脚本注释写清操作对象和只读目的（如「只读检查本机代理端口监听」），用准确的工程术语，不用含糊或夸张的措辞。合法请求仍被误拦时，不在原对话下直接反复发「重试」，而是编辑原消息补足上下文后重新提交；仍无法通过就如实告诉用户卡在哪里。

---

## 3. 确需变更时的唯一合规路径

如果诊断结论证实**确实需要重启代理或修改网络配置**：
1. **立即停止自动执行**；
2. 向用户清晰说明：**要执行什么操作、为什么需要做、会产生什么影响**；
3. 等待用户当次明确批准后再执行，或直接提供命令请用户在自己的终端手动执行。
