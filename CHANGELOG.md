# Changelog

## [1.3.4] - 2026-11-11

按需层（`skills/` 与 `rules/`）5 处工程协议与并发口径补丁，`global/` 常驻层保持冻结未改动（符合 `RULE-MAINTENANCE.md` §14 规则冻结原则）：

- **验收先行、第三方源码核实与异构模型复核（`skills/task-intake/SKILL.md`）**：
  - §2 新增「对接第三方运行时先读对方源码」：插件、扩展、跨进程桥接或读写第三方数据格式时，施工前先委派只读子代理阅读宿主/对方源码，确认加载时机、存档与写回时机、数据格式和并发写入行为，结论带 `文件:行号` 写入项目笔记后再动手；不凭训练记忆假设宿主行为，查不到源码的行为标 `HYPOTHESIS`。
  - §4 新增「外部宿主集成类任务验收先行」：施工前先把真实环境验收步骤写入项目根目录 `ACCEPTANCE.md`；未在真实宿主跑通的层级只报 `NOT_PROVEN`，离线单测或独立探针全绿不得推出 `PASS`（需用户真机确认时标 `REQUIRES_MANUAL_OUT_OF_AGENT_VALIDATION`）。
  - §7 补充独立 Review 异构模型要求：Reviewer 优先使用与施工代理不同厂家或不同模型家族；同一模型复核同一产物只记为自查。
- **前端与 UI 画面截图验收（`rules/IMPLEMENTATION.md`）**：
  - 新增「对着画面验收」：UI 改动完成后须实际启动页面或面板，截取主要状态（空状态、正常数据、报错态）回喂自查层级拥挤、对齐与状态切换，按截图结论修改后再交付；未经截图核对的视觉结论标 `NOT_PROVEN`。
- **并发上限分档与消除重复定义（`skills/multi-agent-orchestrator/SKILL.md` & `rules/BACKGROUND-RESOURCES.md`）**：
  - `multi-agent-orchestrator` §2.1 改为分档并发上限：施工 Worker 同刻 ≤2–3 个；只读调研、代码审查、截图评审等不写文件且不拉起重型子进程的代理不占施工名额，同刻 ≤6 个；用户在当前任务明确授权“放开并发 / 不计配额”时解除代理数量上限（重型子进程上限 ≤1–2 与互斥写入作用域照常执行）。
  - `BACKGROUND-RESOURCES.md` 移除重复且与 orchestrator 不一致的代理数量表述，统一归口指向 `multi-agent-orchestrator` §2.1，仅保留重型编译/渲染子进程 ≤1–2 硬上限；同步更新 `README.md` 架构概览与文件总表描述。
- **验证状态**：规则文件结构、相对链接与双守卫离线自检已复核（`VERIFIED`）；新增按需层条款在真实多步任务中的触发效果尚未跨会话实测（`NOT_PROVEN`）。

## [1.3.3] - 2026-11-11

- **Hook 非黑名单默认决策改回 `"allow"`（交回宿主默认审批策略）并完成 Windows 真机与宿主二进制验证**：
  - 更新 `hooks/scripts/pretool_guard.ps1`、`hooks/scripts/pretool_guard.cjs` 与 `hooks/scripts/verify-hook.py`：将未命中高危黑名单命令的 `defaultDecision` 默认值从 `"ask"` 改回 `"allow"`（仍支持通过 `pretool_guard_settings.json` 或 `AGY_HOOK_DEFAULT_DECISION=ask` 显式改为 `"ask"`）。
  - **宿主二进制与真机实测结论（`VERIFIED`）**：经核查 Antigravity 在线官方文档（`antigravity.google/docs/hooks`）与 Windows 桌面端 `2.31.0` `language_server.exe` 的 6 值 `PreToolUse` 状态机实现（`allow` / `auto_approve` / `ask` / `force_ask` / `deny` / `deny_unless_prior_grant`），`"auto_approve"`（日志标签 `hook_auto_approve`）才是将 Ask-First 基础策略覆盖为自动执行的返回值；`"allow"` 会检查宿主基础策略（Turbo 下直接放行、Ask-First 下交回宿主审批），而 `"ask"` 则会强制触发确认框，导致 Turbo 用户执行 `git status` 等常规命令也被迫弹窗确认。在 Windows 桌面端真机挂载更新后的 `pretool_guard.ps1` 实测：常规只读命令（`git status -sb`）返回 `allow` 无弹窗顺畅执行，受控高危探针（`rm -r __nonexistent_hook_probe__`）返回 `deny` 硬拦截并写入 `hook_log.jsonl`。
- **`mcp/agent-bridge`（v0.2.0）注册键名防撞车、子进程环境变量最小白名单与状态文件 `0o600` 权限**：
  - 将包名、二进制名、MCP `serverInfo.name` 及文档示例注册键统一从 `agent-bridge` 改为 **`agy-agent-bridge`**（`mcpServers['agy-agent-bridge']`），避免与社区现有的 `@paulmh/agentbridge-mcp`、`raysonmeng/agent-bridge`、`EthanSK/agent-bridge` 等同名冲突。
  - 移除 `bridge.mjs` 中把宿主机全量环境变量原样传给子进程的 `env: process.env`，改为 `buildChildEnv()` 最小系统白名单（`SAFE_ENV_KEYS`），默认剥离所有非白名单变量及匹配 `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` / `*_CREDENTIAL*` 和 `BRIDGE_*` 的敏感变量；如需向特定后端显式透传指定变量名，可通过 `BRIDGE_PASS_ENV="VAR1,VAR2"` 按需放行。
  - `saveState()` 创建状态目录时显式指定 `mode: 0o700`，落盘 `sessions.json` 时显式设置 `mode: 0o600` 并调用 `fs.chmod(STATE_FILE, 0o600)` 收紧权限。
  - `mcp/agent-bridge/verify.mjs` 扩充至 **35/35** 项断言（新增子进程敏感环境变量剥离、`BRIDGE_PASS_ENV` 显式放行与 `sessions.json` `0o600` 权限校验）。
- **安装器与卸载器新增 `.antigravity-rules-managed` 来源标记防覆盖保护**：
  - 更新 `install.ps1`、`uninstall.ps1` 与 `hooks/unix/hooks-installer.mjs`：安装本仓库管理的插件与 Skill 目录时自动写入 `.antigravity-rules-managed` 标记文件。
  - 若安装前检测到目标同名目录（如 `~/.gemini/antigravity/skills/chinese-novelist`、`~/.gemini/config/plugins/humanizer-zh` 等）已存在且**不含** `.antigravity-rules-managed`（例如用户此前已安装带全套脚本的上游完整版 Skill），默认打印 `[SKIP (unmanaged)]` 并跳过覆盖；卸载时同样校验该标记，绝不删除非本包创建的同名目录。
- **主插件 ID 中性化（`anyi-global-rules` → `antigravity-core-rules`）与个人工作流习惯解耦**：
  - 将主插件名从 `anyi-global-rules` 统一改为中性的 **`antigravity-core-rules`**（涵盖 `global/plugin.json`、`global/GEMINI.md`、`agents/flash-verifier.md`、`skills/client-maintenance/SKILL.md`、`skills/multi-agent-orchestrator/SKILL.md`、`install.ps1`、`uninstall.ps1`、`hooks/unix/hooks-installer.mjs` 及 `README.md`）。
  - `install.ps1`、`uninstall.ps1` 与 `hooks/unix/hooks-installer.mjs` 支持自动检测并迁移/清理旧版 `~/.gemini/config/plugins/anyi-global-rules` 目录与 `config.json` 中的 `plugins["anyi-global-rules"]` 旧键。
  - 将 `global/GEMINI.md` 与 `global/AGENTS.md` 中的 `共享待办` 条目明确标注为“仅在用户显式配置了共享待办文件路径时生效；未配置时忽略”。
- **修复裁剪版第三方 Skill 中的悬空本地相对链接**：
  - 更新 `skills/chinese-novelist/SKILL.md` 与 `tone/lieflat-less-ai-tone/skills/lieflat-less-ai-tone/SKILL.md`：将正文中指向 `references/flows/phase*.md`、`shared-infrastructure.md` 等未随精简包分发的本地相对路径全部替换为上游 GitHub 仓库的完整网页链接，并显式注明“本精简包不含 `references/`、`scripts/` 或 `RESEARCH.md` 子文件，请勿调用本地文件读取工具查找”，消除模型触发 `ENOENT` 白耗轮次的问题。

## [1.3.2] - 2026-11-11

- **补齐纯正文创作与前端面板同步场景的思考可见性豁免槽**：
  - 更新 `global/THINKING-VISIBILITY.md` 与 `global/plugin.json`（`1.3.2`）：在保留常规工程主会话「工具调用前先用 1–2 句说明排查脉络」与后台并行子代理豁免的基础上，新增**纯正文创作与前端面板同步豁免**——当已激活的创作类 Skill（如连载小说写作 `chinese-novelist`）或前端交互 Sidecar 协议明确要求仅输出成稿正文/沉浸式对白时，免除工具调用前的工程分析播报，静默完成状态同步并仅输出目标正文，避免工程态前置说明混入文学成稿或前端交互流；安全、隐私与数据保护红线照常生效。
  - 同步更新 `README.md` 文件总表中 `global/THINKING-VISIBILITY.md` 的职责说明。

## [1.3.1] - 2026-11-11

Hook 守卫层（`pretool_guard.ps1` / `pretool_guard.cjs` / `verify-hook.py`）与 `mcp/dsh-bridge` 迁移补全。**默认行为相对 1.3.0 不变**：不加设置文件时，被标记的命令仍然全部返回 `deny`，其余命令仍然返回 `ask`。

- **修复 v1.3.0 引入的回退（v1.2.3 能拦、v1.3.0 放过）**：
  - 带路径的可执行文件：`/bin/rm -rf`、`\rm -rf`、`/usr/bin/git reset --hard`、`"C:\...\git.exe" reset --hard`。
  - 引号掩码把会被执行的文本当成了数据：`echo '...' | sh`、`printf '...' | bash`；命令行含 `$(...)`、反引号或 `eval` 时不再对 `echo` / `printf` 做掩码。
- **修复 v1.3.0 新增的误拦**：`git clean -n` / `--dry-run` 预演、`git rm -r --cached`、`pnpm rm -r`、`docker rm`（`rm` 作为子命令）、解释器里删除单个文件（与 `rm <file>` 一致，不标记）。
- **补齐相邻写法**：不带 `--` 的 `git checkout .`、整目录的 `checkout` / `restore`、`git restore -s <rev> .`（原豁免按不区分大小写匹配 `-S`，把 `--source` 也豁免了）、`git stash drop` / `clear`、`git switch --discard-changes`、`git rm -f`、`find -exec /bin/rm`、裸 `rmtree()` 与 `require('fs').rmSync`。
- **两档拦截**：规则带档位。block 档（格式化磁盘、删除根目录 / 家目录 / 系统目录、从 `/` 或 `~` 起 `find -delete`）恒定 `deny`；confirm 档（其余全部规则）返回 `confirmDecision`，默认 `deny`，可改为 `force_ask`。
- **设置文件**：可选的 `pretool_guard_settings.json`（`defaultDecision` / `confirmDecision` / `logAll`），解决从 GUI 启动的客户端读不到 shell 环境变量的问题；环境变量仍然优先，文件损坏或取值无效时回落到最严格的默认值。新增环境变量 `AGY_HOOK_CONFIRM_DECISION`、`AGY_HOOK_SETTINGS`。
- **扩展审计日志凭据脱敏**：补齐非 HTTP 协议 URI 内嵌凭据（`postgres://`、`redis://`、`mongodb+srv://` 等 `user:pass@...`）、`curl -u` / `--user`、自定义敏感请求头（`X-API-Key` / `X-Auth-Token` / `Api-Key`）、CLI 短参数密码（`mysql` / `sshpass` 的 `-p<pass>` / `-p <pass>`、`redis-cli -a`）及 AWS Access Key（`AKIA*` / `ASIA*`）的落盘脱敏。
- **`mcp/dsh-bridge` 旧键自动迁移与重合度说明**：`register-antigravity.mjs` 检测到 `mcp_config.json` 中残留指向本仓库旧路径 `mcp/dsh-crew/dsh-crew.mjs` 的 `mcpServers['dsh-crew']` 条目时自动迁移至 `mcpServers['dsh-bridge']`（继承自定义 `DSH_CREW_WORKSPACE`），绝不触碰社区 `ZSeven-W/dsh-crew` 条目；`mcp/dsh-bridge/README.md` 补充 `2026-11-11` 与上游 `0.1.0` 代码比对口径说明。
- **测试**：`verify-hook.py` 新增三节——110 条命令的档位语料（`TIER_CORPUS`，含不应标记的近似命令与一组已知漏拦）、设置文件与环境变量优先级、两份守卫脚本的静态比对（共享正则常量、规则表、`ps1` 纯 ASCII），并扩展凭据脱敏断言。套件规模：Node 守卫 242 项，PowerShell 守卫 194 项；`mcp/dsh-bridge/verify.mjs --offline` 扩至 7 项。
- **文档与状态标签对齐**：更正 README 中「`ask` 交还宿主审批策略」的表述并补充 Antigravity 在线文档（6 值）与桌面端 `2.31.0` 内置文档（4 值）的版本差异提示（as-of `2026-11-11`）；移除 `v1.3.0` 临时新造的 `PRELIMINARY / PARTIALLY_VERIFIED` 标签，严格收敛回 `task-intake` 既定的 `VERIFIED` / `NOT_PROVEN`；在下方 `1.3.0` 变更记录中补标破坏性变更（`BREAKING CHANGES`）。
- **验证状态**：Node 守卫 242/242（`VERIFIED`，离线自检）；Windows PowerShell 5.1 守卫实跑 194/194（`VERIFIED`，离线自检，`ERROR-FAILOPEN: 0`）；`mcp/dsh-bridge/verify.mjs --offline` 7/7（`VERIFIED`）。`ask` / `allow` / `force_ask` 在宿主 GUI 侧的实际弹窗行为未在各客户端版本逐一真机验证（`NOT_PROVEN`）。

## [1.3.0] - 2026-11-11

> **BREAKING CHANGES（相对 1.2.x 的破坏性变更）**：
> 1. **`mcp/dsh-crew` 重命名为 `mcp/dsh-bridge`**：`mcp_config.json` 注册键改为 `mcpServers['dsh-bridge']`（旧手动注册条目在 `1.3.0` 下不会自动移除，`1.3.1` 的 `register-antigravity.mjs` 已补自动迁移）。
> 2. **`dsh_ask` 默认权限收紧**：默认 `permission` 从 `workspace-write` 改为 `read-only`，需写文件时必须显式传入 `permission: "workspace-write"`。
> 3. **Hook 非黑名单默认返回改为 `"ask"`**：`pretool_guard.ps1` / `pretool_guard.cjs` 对未命中黑名单的命令默认返回 `{"decision":"ask"}` 而非 `{"decision":"allow"}`（如需恢复自动放行需配置 `defaultDecision: "allow"` 或 `AGY_HOOK_DEFAULT_DECISION=allow`）。

- **解决 `dsh-crew` 重名与 `mcp_config.json` 覆盖冲突（重命名为 `mcp/dsh-bridge` v0.2.0）**：
  - 将仓库内置的单文件 DSH Headless 包装桥从 `mcp/dsh-crew` 重命名为 `mcp/dsh-bridge`（脚本 `dsh-bridge.mjs`、注册键 `mcpServers['dsh-bridge']`、环境变量 `DSH_BRIDGE_*` 并向后兼容 `DSH_CREW_*`），避免与社区早在 2026 年 8 月开源的 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew)（MIT）撞名及互相覆盖 `~/.gemini/config/mcp_config.json` 中的 `mcpServers['dsh-crew']`。
  - 在 `README.md`、`mcp/dsh-bridge/README.md` 与 `mcp/agent-bridge/README.md` 中坦诚说明 11 月 7 日生成脚本时的命名缘起，恢复对 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew) 与 [`lanlan0811/tianshu-mcp`](https://github.com/lanlan0811/tianshu-mcp) 的明确指向。
  - **收紧跨 Agent 默认权限与凭据/插件边界**：`dsh_ask` 默认权限从 `workspace-write` 收紧为 `read-only`；明确说明 `crew-credentials.patch.yml` 的三行开关直接出自 `@deepseek-ai/dsh-headless` 官方 README「凭据」节并支持 `DSH_BRIDGE_DISABLE_CRED_PATCH=1` 关闭；将非官方第三方 `dsh-commandcode` 模型补丁改为默认不启用（需显式设 `DSH_BRIDGE_ENABLE_COMMANDCODE=1` 才叠加）并补充服务条款核实提示。
- **Hook 守卫层（`pretool_guard.ps1` / `pretool_guard.cjs`）安全默认值、日志脱敏与正则防漏拦/防误拦升级**：
  - **非黑名单默认决策改为 `"ask"`**：默认返回 `{"decision":"ask"}` 而非 `{"decision":"allow"}`，保留用户在 Ask-First 模式下的确认环节（如需 Hook 自动放行可通过环境变量 `AGY_HOOK_DEFAULT_DECISION=allow` 显式开启）。
  - **审计日志最小化与密钥自动脱敏**：`hook_log.jsonl` 默认仅记录被拦截（`DENY-DANGER`）与解析故障（`ERROR-FAILOPEN`）事件（设 `AGY_HOOK_LOG_ALL=1` 才记录日常命令），并在落盘前对命令行中的 Bearer Token、`sk-*`/`ghp_*`/`github_pat_*`/`AIza*`、`--token`/`--password`/`--api-key` 及环境变量赋值中的密钥做正则脱敏（`<REDACTED>`）。
  - **消除搜索与提交信息误拦（上下文引号掩码）**：对 `grep`/`egrep`/`fgrep`/`rg`/`ag`/`ack`/`Select-String`/`echo`/`printf` 及 `git commit`/`tag`/`notes`/`merge` 中不含 `$(` 或反引号命令替换的单双引号字面量先行掩码，消除 `grep -rn "rm -rf" scripts/` 与 `git commit -m "...rm -rf..."` 的误拦；同时放行安全的 `git push --force-with-lease` 与 `git restore --staged .`。
  - **补齐高危命令漏拦**：支持 `git -C <dir>` / `-c k=v` / `--git-dir` / `--work-tree` 全局选项穿透，新增拦截 `git checkout -- .` / `-f`、`git restore .` / `--worktree`、`git push origin +main`（`+refspec` 强推）、不带 `-f` 的递归删除 `rm -r` / `Remove-Item -Recurse`、`find ... -delete` / `-exec rm` 以及 `python -c` / `node -e` 单行解释器删除。`verify-hook.py` 扩展至 Windows 52 项 / Node 90 项全绿断言，并在 README 中明确区分脚本离线自检与宿主真机挂载验证。
- **规则去个人化、清理未替换占位符与修正 `Gemini 4 Carbon` 验证等级表述**：
  - 移除 `global/GEMINI.md` 中的个人固定笔名「安钰」与 `global/plugin.json` 中的个人化描述，改为通用署名脱敏规则。
  - 移除 `global/GEMINI.md`、`agents/flash-verifier.md`、`skills/client-maintenance/SKILL.md`、`skills/multi-agent-orchestrator/SKILL.md` 中残留的 `<YOUR_PROJECT_PATH>`、`<YOUR_MCP_SERVER>`、`<YOUR_DOMAIN_VERIFIER>`、`<YOUR_CHECK_SCRIPT>`、`<YOUR_PROJECT_REDLINES>`、`<YOUR_HEADLESS_MCP>`、`<YOUR_GUI_MCP>` 占位符及 `multi-agent-orchestrator` 中残留的一处“梯子”措辞（统一改为“用户代理与网络配置”）。
  - 修正 `README.md` 模型适配矩阵：将 2026-11-10 刚上线的 `Gemini 4 Carbon` 从长期 `VERIFIED` 中单列为 `PRELIMINARY / PARTIALLY_VERIFIED`（上线首日初步适配，长周期 `/swarm` 压测标 `NOT_PROVEN`；注：该临时标签已在 `1.3.1` 收敛回标准 `VERIFIED` / `NOT_PROVEN`）。
  - 更新 `LICENSE` 与 `README.md` 版权声明：补齐共创者 `len (LEN5010)` 的版权署名（`Copyright (c) 2026 安钰, len (LEN5010) and contributors`）。

## [1.2.3] - 2026-11-11

- **放宽隔离工作树（`branch` / `share`）批量改动拦截**：
  - 更新 `global/AGENTS.md`（§1 动作分级）与 `skills/multi-agent-orchestrator/SKILL.md`（§2.1）：明确主工作树单次修改 ≥5 个文件属于“先问再动”，但当子代理或 `/swarm` Worker 运行在 `branch` / `share` 隔离 Git worktree 且尚未合入主分支时，允许在授权写入白名单内直接执行批量修改，统一留在 Adversarial Verifier 终审与合入主分支前由用户一次性拍板。
- **按运行模式豁免思考可见性前置播报**：
  - 更新 `global/THINKING-VISIBILITY.md` 与 `agents/flash-verifier.md`：区分主会话交互与后台并行执行——主会话直面用户时保留每次工具调用前 1–2 句前置判断；对 `/swarm` 并行执行 worker、`flash-verifier`、`research` 等后台子代理免除逐次工具前置播报，直接静默执行工具链，降低高单价模型输出开销与看板噪音。
- **补齐并发度与本地资源硬上限 + `read_loop_guard.cjs` 升级与并行评估**：
  - 更新 `skills/multi-agent-orchestrator/SKILL.md`（§2.1）与 `rules/BACKGROUND-RESOURCES.md`：新增单次任务活跃施工子代理并发上限（≤2–3 个，总活跃子代理 ≤3–4 个）及本机重型编译/打包/渲染/全量测试子进程并发硬上限（≤1–2 个，共享产物目录/端口/锁时强制 `max=1` 串行化），防止 `Gemini 4 Carbon` 在重型并行任务上吃满本机 CPU 与内存。
  - 更新 `hooks/hooks.json` 与 `hooks/scripts/read_loop_guard.cjs`：补齐对 Antigravity 2.0 原生工具名（`read_file` / `edit_file` / `write_file`）、省略 `EndLine` 的整文件读取检测及 `read_loop_log.jsonl` 5 MB 自动轮转（`.1`）的支持；经评估 `/swarm` 看板唤醒的 transcript epoch 边界、同会话并发锁竞争（`STATE_BUSY`）及 Ask-First 模式下的 `PreToolUse` `allow` 副作用，`read_loop_settings.json` 继续保持 `"mode": "observe"`（`enforce` 维持 `NOT_PROVEN`）。
- **新增对外文档交付润色串联与前端 UI 密度约束**：
  - 更新 `skills/docx-delivery/skills/docx-delivery/SKILL.md`：区分“既有文本原样转换”与“Agent（如 `Gemini 4 Carbon`）撰稿的对外客户文档交付”，后者在转出终版 `.docx` 前默认串联 `humanizer-zh`（或交由 `Gemini 4 Argon` 终审润色），定稿后再跑转换与 `validate_docx.py` 校验。
  - 更新 `rules/IMPLEMENTATION.md`：新增「前端与 UI 交付密度约束」，限制单个视图内视觉容器嵌套层级 ≤3 层、单行并列卡片 ≤3–4 个、单卡核心指标 ≤3 项，次要诊断参数与长日志默认折叠或下沉至二级详情抽屉。

## [1.2.2] - 2026-11-11

- **针对 Gemini 4 Carbon（4c）与 `/swarm` 并行编排的增量适配（`global/` 常驻层零改动）**：
  - 更新 `skills/multi-agent-orchestrator/SKILL.md`：补充 `Gemini 4 Carbon` / `Gemini 4 Argon` 配额与思考档位分流纪律；新增 §2.1 原生 `/swarm`（桌面端斜杠菜单亦作 `/teamwork`）并行编排与对抗性验收纪律，明确角色分层（Carbon 统筹架构与终态审计、Argon/Flash 并发施工与扫描）、互斥写入作用域（`Disjoint Write Scopes`，显式白名单 + `share`/`branch` 隔离工作树）及诚实阻塞透传要求。
  - 更新 `skills/chinese-novelist/SKILL.md`：补充 4c / 4a 分阶段模型协同建议（大纲推演与全书连续性核查可用 Carbon，逐章正文优先 Argon）；针对 Carbon 较长的内部推理耗时，将 `BidiGenerateContent` 分块 `write_file` 在 Carbon 下的单次字数上限收紧至 `1,000–1,500` 字（分 2–4 段落盘，下调至 `Low` / `Medium` 档位），并同步校准阶段 3 写作流程说明。
  - 更新 `README.md`：在适配模型版本矩阵（`VERIFIED`）中新增 `Gemini 4 Carbon` 说明，并同步更新文件总表中 `multi-agent-orchestrator` 的触发与职责摘要。

## [1.2.1] - 2026-11-10

- **新增工具调用前思考可见性常驻规则（`global/THINKING-VISIBILITY.md`）**：
  - 新增 `trigger: always_on` 规则文件 `global/THINKING-VISIBILITY.md`：要求每次发起工具调用或连续执行多步操作前，先用 1–2 句简练文字说明当前的分析判断、调用原因及预期验证问题，禁止静默连续调用工具。
  - 双端安装器（`install.ps1` 与 `hooks/unix/hooks-installer.mjs`）已同步接入，全量安装时自动部署至 `~/.gemini/config/plugins/anyi-global-rules/rules/THINKING-VISIBILITY.md`（亦可单独复制至 `~/.gemini/antigravity/rules/` 或工作区 `.agents/rules/` 独立使用）。
- **完善 README 边界与合规声明**：
  - 明确说明 `pretool_guard.ps1` / `pretool_guard.cjs` 对未命中黑名单命令默认返回 `{"decision":"allow"}` 的放行边界（适配 Turbo / Eager 模式，Ask-First 手动审批用户请勿原样启用该分支）。
  - 补充第三方开源 Skill 上游协议归属细节（含 `lieflat-less-ai-tone` V1 MIT 提交哈希与上游后续协议变更提示）及底部非官方社区项目免责声明。

## [1.2.0] - 2026-11-10

- **macOS / Linux 全量 5 层一键安装与跨平台规则补齐**：
  - 扩充 `hooks/unix/hooks-installer.mjs`（及根目录 `install.sh` / `uninstall.sh`）：默认支持与 `install.ps1` 完全对等的 **5 层全量安装（Full mode）**，自动无损合并 `~/.gemini/GEMINI.md`（按 `<!-- antigravity-agent-rules:begin/end -->` 标记）与 `~/.gemini/config/hooks.json`、部署 5 个插件到 `~/.gemini/config/plugins/`、部署独立 Skills 到 `~/.gemini/antigravity/skills/`（支持 `--workspace-path` 同步至工作区 `.agents/skills/`）、启用 `~/.gemini/config/config.json` 中的 5 个插件开关，并将 `<YOUR_PATH>` 与 `%USERPROFILE%\...` 路径占位符替换为 `$HOME` 正斜杠路径；保留 `--hook-only` 作为仅安装 Hook 层的可选参数，`uninstall.sh` 自动识别 `full` / `hook-only` 备份快照并完整还原。
  - 更新 `global/GEMINI.md`：将「Shell 偏好」改为按平台分流（Windows 下使用 Git Bash / `pwsh` 7；macOS / Linux 下直接使用系统原生 `zsh` / `bash`），并在「用户代理与网络配置：未经许可一律只读」中补充 macOS / Linux 下禁止停止的代理服务（`launchctl` / `systemctl` / `osascript ... quit`）与禁止修改的网络/代理命令（`networksetup -set*`、`scutil`、`ifconfig ... down`、`nmcli`、`pfctl`）。
  - 更新 `skills/safe-network-diagnostics/SKILL.md`：在 Windows（`reg query`、`netsh winhttp show proxy`、`netstat -ano`）旁完整补充 macOS（`scutil --proxy`、`networksetup -getwebproxy Wi-Fi`、`lsof`、`scutil --dns`、`ifconfig`）与 Linux（`env | grep -i proxy`、`ss -tulnp`、`ip addr`、`ip route`）的只读网络诊断命令对照。
- **Hook 守卫层支持 macOS / Linux**（Windows 默认行为不变，仍使用 `pretool_guard.ps1`）：
  - 新增 `hooks/scripts/pretool_guard.cjs`：`pretool_guard.ps1` 的 Node 跨平台版，29 条通用/Windows 规则逐条一致，另加 17 条 macOS / Linux 规则（`diskutil erase*`、`dd of=/dev/`、`mkfs`/`newfs_*`、`tmutil delete`、`csrutil disable`；`kill`/`pkill`/`killall`/`launchctl`/`systemctl`/`osascript quit` 结束代理客户端；`networksetup -set*`、`ifconfig down`、`ipconfig set`、`route delete/flush/change`、`pfctl -d/-F`、`nmcli` 断网）。
  - `hooks.json` 在 macOS / Linux 安装时自动将命令改写为 Node 绝对路径，避免 GUI 启动的 Antigravity 找不到 `node`。
  - `verify-hook.py` 新增 `--guard ps|node`（非 Windows 默认 `node`），Node 版额外跑 38 项 macOS / Linux 用例，合计 78 项自检全通。
  - `install.ps1` / `uninstall.ps1` 的受管文件清单加入 `pretool_guard.cjs`，保证 Windows 卸载时一并清理。
- **`mcp/dsh-crew` 0.1.1 跨平台适配**：修复 macOS 上的四处运行问题，Windows 行为保持不变。
  - 非 Windows 平台改为直接 exec 启动器、不经 shell，`/Applications/<产品名>.app/...` 这类带空格的路径不再被拆开；Windows 仍经 `cmd.exe`，并给启动器路径本身加引号。
  - 凭据补丁拆成两份：`crew-credentials.patch.yml` 只保留官方三条开关；Command Code 默认模型移到 `crew-commandcode.patch.yml`，仅在本机存在 `dsh-commandcode` 插件时叠加。插件 URL 改用 `pathToFileURL` 生成，修复 macOS 上拼出 `file:////Users/...` 导致插件加载失败的问题。
  - 子进程 PATH 末尾追加当前 node 所在目录，修复 GUI 客户端启动时 npm 版 `dsh` 报 `env: node: No such file or directory`。
  - macOS 桌面端探测补充用户级 `~/Applications`；桌面端找不到时退回 PATH、当前 node 所在目录、`/opt/homebrew/bin`、`/usr/local/bin` 与 `~/.volta/bin` 中的 npm 版 `dsh`。
  - `dsh_status` 新增 `headless_cli` 检查（`--profile headless --patch <CRED_PATCH> --help`，不花 token，成功后按 `DSH_CMD` 在进程内存缓存），自检前先落盘补丁；`dsh_asar` 改为参考信息，不再计入 `ready`。
  - 解析 headless `--json` 流中的 `error` 事件（区分 `streamError` 与 `NO_FINAL_EVENT`），补齐 `runHeadless()` 的 `timeoutMs` 默认值；旧版 headless 不认识参数时给出升级提示。

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
