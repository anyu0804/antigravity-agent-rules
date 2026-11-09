# Changelog

## [Unreleased]

- `mcp/dsh-crew` 0.1.1：修复 macOS 上的四处运行问题，Windows 行为保持不变。
  - 非 Windows 平台改为直接 exec 启动器、不经 shell，`/Applications/<产品名>.app/...` 这类带空格的路径不再被拆开；Windows 仍经 `cmd.exe`，并给启动器路径本身加引号。
  - 凭据补丁拆成两份：`crew-credentials.patch.yml` 只保留官方三条开关；Command Code 默认模型移到 `crew-commandcode.patch.yml`，仅在本机存在 `dsh-commandcode` 插件时叠加。插件 URL 改用 `pathToFileURL` 生成，修复 macOS 上拼出 `file:////Users/...` 导致插件加载失败的问题。
  - 子进程 PATH 末尾追加当前 node 所在目录，修复 GUI 客户端启动时 npm 版 `dsh` 报 `env: node: No such file or directory`。
  - macOS 桌面端探测补充用户级 `~/Applications`；桌面端找不到时退回 PATH、当前 node 所在目录、`/opt/homebrew/bin`、`/usr/local/bin` 与 `~/.volta/bin` 中的 npm 版 `dsh`。
  - `dsh_status` 新增 `headless_cli` 检查（`--profile headless --patch <CRED_PATCH> --help`，不花 token，成功后按 `DSH_CMD` 在进程内存缓存），自检前先落盘补丁；`dsh_asar` 改为参考信息，不再计入 `ready`。
  - 解析 headless `--json` 流中的 `error` 事件（区分 `streamError` 与 `NO_FINAL_EVENT`），补齐 `runHeadless()` 的 `timeoutMs` 默认值；旧版 headless 不认识参数时给出升级提示。
- Hook 层支持 macOS / Linux（Windows 默认行为不变，仍使用 `pretool_guard.ps1`）：
  - 新增 `hooks/scripts/pretool_guard.cjs`：`pretool_guard.ps1` 的 Node 跨平台版，29 条规则逐条一致，另加 macOS / Linux 规则（`diskutil erase*`、`dd of=/dev/`、`mkfs`/`newfs_*`、`tmutil delete`、`csrutil disable`；`kill`/`pkill`/`killall`/`launchctl`/`systemctl`/`osascript quit` 结束代理客户端；`networksetup -set*`、`ifconfig down`、`ipconfig set`、`route delete/flush/change`、`pfctl -d/-F`、`nmcli` 断网）。
  - 新增根目录 `install.sh` / `uninstall.sh`（逻辑在 `hooks/unix/hooks-installer.mjs`），等价于 `install.ps1 -HookOnly` 与 `uninstall.ps1` 的 hook-only 分支；`hooks.json` 中的命令改写为 Node 绝对路径，避免 GUI 启动的 Antigravity 找不到 `node`。
  - `verify-hook.py` 新增 `--guard ps|node`（非 Windows 默认 `node`），Node 版额外跑 38 项 macOS / Linux 用例，合计 78 项。
  - `install.ps1` / `uninstall.ps1` 的受管文件清单加入 `pretool_guard.cjs`，保证 Windows 卸载时一并清理。

## [1.1.0] - 2026-11-09

- 新增跨端 MCP 双桥（`mcp/`）：
  - `mcp/dsh-crew`：绑定 DSH（`dsh --profile headless`）的单文件零依赖 MCP stdio 桥，提供 `dsh_ask` / `dsh_sessions` / `dsh_status` / `dsh_forget`，通过 `verify.mjs` 6/6 真机验证（含 `--offline` 5/5 离线协议自检与同一 `session` 续聊复用）。
  - `mcp/agent-bridge`：零依赖可插拔通用 CLI MCP stdio 桥（后端由 `BRIDGE_CMD` / `BRIDGE_ARGS` 指定），提供 `agent_ask` / `agent_sessions` / `agent_status` / `agent_forget`，含假后端 32/32 协议断言自检（标注未接真实后端，与 `dsh-crew` 明确区分验证状态）。
- 更新 `skills/multi-agent-orchestrator/SKILL.md`：将 §4 中的 `<YOUR_HEADLESS_MCP>` 占位符对接至仓库内置的 `mcp/dsh-crew` 与 `mcp/agent-bridge` 双桥对照表；并在 `skills/chinese-novelist/SKILL.md` 与 `skills/safe-network-diagnostics/SKILL.md` 中补充 `BidiGenerateContent` 流式整包缓冲下的分块 `write_file`（单次 ≤1,500–2,000 字 + `Append: true`）规则与假性流中断鉴别说明。
- 补充 `skills/chinese-novelist/SKILL.md` 及 `UPSTREAM.md` 的上游开源归属说明（`PenglongHuang/chinese-novelist-skill`，MIT License），优化 `README.md` 开头「Antigravity 桌面端（IDE / 2.0）& agy CLI」跨端定位说明并新增底部「可选：跨端 MCP 桥（`mcp/`）」章节。

## [v1.0.2] - 2026-11-09

- `install.ps1` 新增 `-HookOnly`：只合并 `hooks.json` 并部署 `scripts/`，不改 `GEMINI.md`、`config.json` 和规则/Skill/文风层，自检照常运行。
- 备份 `manifest.json` 新增 `mode` 字段（`full` / `hook-only`）；`uninstall.ps1` 遇到 `hook-only` 时只还原 Hook 相关文件，不删用户自己的 `GEMINI.md` 与插件，也不改 `config.json`。

## [v1.0.1] - 2026-11-09

- 重写 README：开头讲清痛点与四条使用边界（仅支持 Windows、黑名单是安全网而非沙箱、Ask-First 下默认 allow 的注意事项、不要全量常驻），文件总表与手动部署步骤收进折叠块。
- 拦截提示、自检输出与规则文档中的措辞统一为“代理/网络配置”，拦截正则与判定逻辑不变。

## [v1.0.0] - 2026-11-09

- **首版公开发布（v1.0）**：完整整理并开源全套 Antigravity / Gemini Agent 分层治理与技能规则体系。
  - **历史溯源**：本套规则最早发布于 **百度贴吧·谷歌gemini吧（2026-09-29）**，经长期真实工程、自动化排障与多代理协同实战迭代定型。
- **五层 + 子代理架构定型**：
  1. **`hooks/`（底层硬拦截层）**：`hooks.json`、`pretool_guard.ps1`（危险破坏性命令与用户代理/网络配置只读硬拦截，解决中文 Windows PowerShell 5.1 标准输入 UTF-8/GBK 双字节吞反斜杠解析漏洞）、`read_loop_guard.cjs`（未变更文件同区间重复读取死循环诊断与拦截）及 `verify-hook.py` 回归自检套件。
  2. **`global/`（Always-on 全局宪法层）**：`GEMINI.md`（人机协作基调、防开盒与路径脱敏铁律、代理只读红线、Git Bash/pwsh 7 偏好、子代理派工原则）与 `AGENTS.md`（§1–§15 动作分级、`FAST_PATH`/`INVESTIGATION_PATH` 轮次纪律、禁仪式化严谨、停止与资源边界、交付契约、证据真实性、范围锁定及按需路由）。
  3. **`tone/`（去 AI 味文风层）**：按需加载的中文成稿创作与文本润色规范（`lieflat-less-ai-tone` 与 `humanizer-zh` 规则衔接版及上游 MIT 协议引用占位）。
  4. **`rules/`（按需 `model_decision` 专项规则层）**：`BACKGROUND-RESOURCES.md`（后台进程与 GUI 脱钩生命周期）、`IMPLEMENTATION.md`（诊断→施工切换）、`LONG-TASKS.md`（8 分钟长任务阶段可见性）、`RELEASE-PACKAGING.md`（冻结基线与完整依赖闭包）、`RULE-MAINTENANCE.md`（规则冻结原则）、`WINDOWS-RELEASE.md`（Windows 脚本编码与实跑验证）、`SEARCH-ROUTING.md`（外部检索路由）。
  5. **`skills/` & `agents/`（按需执行 SOP 与子代理层）**：`task-intake`（多步骤工程任务编译、状态机与四态回报）、`research-routing`（多源交叉检索 SOP）、`safe-network-diagnostics`（代理安全只读网络诊断）、`multi-agent-orchestrator`（多代理分工与跨端 MCP 协同）、`client-maintenance`（客户端缓存与陈旧会话归档维护）、`docx-delivery`（Markdown 转可编辑 Word 交付与校验）、`chinese-novelist`（长篇小说创作衔接定义）以及全局只读验证专员 `flash-verifier.md`。
- **一键部署与自检闭环**：
  - 提供根目录 `install.ps1` 一键安装脚本（前置校验 `config.json`/`hooks.json` 语法、列出修改项并经 `y` 确认或 `-Force` 跳过、自动备份原配置、按 `<!-- antigravity-agent-rules:begin/end -->` 标记与顶层键无损合并 `GEMINI.md` 及 `hooks.json`、替换 `<YOUR_PATH>`、按标准插件目录结构分发 5 层文件、启用 5 个插件并自动执行 `verify-hook.py` 40 项回归校验）。
  - 提供根目录 `uninstall.ps1` 一键卸载脚本（经 `y` 确认后从最近一次 `backup_antigravity_rules_*` 还原、删除安装前不存在的文件与插件目录、并仅移除 `config.json` 中本仓库的 5 个插件条目）。
  - `tone/lieflat-less-ai-tone`、`tone/humanizer-zh`、`skills/docx-delivery` 均已对齐为 `plugin.json` + `skills/<name>/SKILL.md` 标准插件层级。
