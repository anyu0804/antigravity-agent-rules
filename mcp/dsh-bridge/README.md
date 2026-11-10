# dsh-bridge — 把 DSH Headless 接进 MCP 客户端的单文件轻量桥

- 版本：0.2.0（原目录名 `dsh-crew` 0.1.x，自 0.2.0 起改名为 `dsh-bridge`）
- 形态：MCP stdio server（JSON-RPC 2.0，按行分隔），单文件、零依赖 Node 脚本
- 作用：让 Antigravity 等 MCP 客户端把任务派给本机 DSH（DeepSeek Harness）智能体的 `headless` 模式，并拿回最终回答
- 不需要 MCP SDK，不需要 `npm install`，本目录可直接进版本库

## 1. 来历、重名说明与社区致谢

| 项 | 内容 |
|---|---|
| 生成时间 | 2026-11-07 15:55（本地时区） |
| 生成者 | DSH 桌面端自身的 Agent，模型 `deepseek/deepseek-v4.1-flash-fast` |
| 触发指令 | 「把这个 mcp 机制 dsh-crew 接入，让反重力能调用你」 |
| 可溯会话 | `~/.dsh/sessions/--D-deepseek~0020Harness--/session-f7c10545-d0f7-41d1-b3ba-6bb55d8d1e40/`（41 步 / 40 次工具调用） |
| 协议依据 | MCP 规范 `2025-06-18`（JSON-RPC 2.0 over stdio） |
| 后端依据 | 官方 [`@deepseek-ai/dsh-headless`](https://github.com/deepseek-ai/deepseek-harness) 的 `headless` profile 文档（BSD-3-Clause） |

### 为什么从 `dsh-crew` 改名为 `dsh-bridge`？

社区早在 2026 年 8 月就已有开源项目 **[`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew)**（MIT License，DSH 插件 + 独立 MCP Server，支持异步 worker 池、状态轮询、cwd 咨询锁、多模态与 `node src/install/cli.mjs agy` 一键安装）。

11 月 7 日作者在让 DSH 桌面端 Agent 生成本桥时，口头指令直接说了「把这个 mcp 机制 dsh-crew 接入」，DSH 随即从零写了一个单文件 `dsh --profile headless` 包装脚本（未复制 `ZSeven-W/dsh-crew` 的代码；按 2026-11-11 共创者 len 对两边源码去空行与单括号行后的逐行精确交集比对，仅 5 行语言/标准库通用样板语句重合），但也把脚本和 MCP 注册键命名成了 `dsh-crew`，导致两边都会往 `~/.gemini/config/mcp_config.json` 写 `mcpServers['dsh-crew']` 并互相覆盖。

为避免重名混淆与配置覆盖：
1. 本仓库内置的单文件轻量包装桥自 0.2.0 起重命名为 **`dsh-bridge`**（目录 `mcp/dsh-bridge/`、脚本 `dsh-bridge.mjs`、注册键 `mcpServers['dsh-bridge']`）。
2. **如果你需要完整的异步多 worker 协同、状态轮询、工作区咨询锁与成套安装器，推荐直接使用社区上游项目 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew)（或 GUI 端 CDP 验收桥 [`lanlan0811/tianshu-mcp`](https://github.com/lanlan0811/tianshu-mcp)）。** 本目录的 `dsh-bridge` 只提供约 580 行零依赖的同步阻塞式 `dsh --profile headless` 薄封装。

> **与同仓库另一座桥的关系**：[`../agent-bridge`](../agent-bridge/) 是后端可插拔的通用版（`BRIDGE_CMD` 指谁就是谁），但只做过假后端的 32/32 协议断言，未接真实后端。本桥绑死 DSH Headless，已在真机跑通 6/6。

## 2. 后端机制、凭据补丁与默认权限边界

复用 DSH 自带的一次性任务模式 `dsh --profile headless`：

```bash
dsh --profile headless [--patch <凭据补丁>] [--patch <模型补丁>] --json - \
    --permission-mode <档> --approval-policy <策略> [--session-id <id>]
```

- **默认只读（Safe by Default）**：`dsh_ask` 的默认权限自 0.2.0 起收紧为 **`read-only`**（可通过环境变量 `DSH_BRIDGE_DEFAULT_PERMISSION` 或调用参数 `permission: "workspace-write"` 显式放开写权限）；`approval_policy` 默认为 `never`（无人值守子进程遇到需人工审批的越界动作直接拒绝，避免挂起；也可传 `approval_policy: "ask"`）。
- **凭据补丁（`crew-credentials.patch.yml`）来源与作用**：
  - 那三行开关（将 `credentials`、`authorization`、`deepseek-account` 设为 `disabled: false`）**并非自创，直接取自 DSH 自带的 `@deepseek-ai/dsh-headless` 官方 README「凭据」章节**。
  - 作用是把 `headless` profile 默认停用的桌面端凭据存储服务重新加回来，让 headless 模式能读取你在 DSH 桌面端已登录保存的 API 凭据（否则默认报 `MISSING_CREDENTIAL`）。
  - 如果你希望通过环境变量自行管理凭据、不复用桌面端保存的凭据，可设置 `DSH_BRIDGE_DISABLE_CRED_PATCH=1` 关闭该补丁。
- **可选的第三方模型补丁（`crew-commandcode.patch.yml`，默认关闭）**：
  - **默认不启用**，直接沿用 DSH 自身的默认模型。
  - 仅当你显式设置环境变量 `DSH_BRIDGE_ENABLE_COMMANDCODE=1` 且本机存在 `dsh-commandcode` 插件时才会叠加。
  - **合规提示**：公开可见的 `dsh-commandcode` 同类 provider 插件属于非官方第三方插件，本仓库未核实其是否符合对应服务商（Command Code）的服务条款，请使用者在显式开启前自行核实。
- **启动器级选项顺序**：`--profile` / `--patch` 必须排在 app 参数（`--json` 等）之前，否则 headless 报 `unknown option '--patch'`。
- **dsh 版本要求**：headless 需要支持 `--json` / `--session-id` / `--permission-mode` / `--approval-policy`。实测 npm 版 `@deepseek-ai/dsh@0.2.2-rc.1` 支持，`0.1.5-rc.2` 不支持。`dsh_status` 的 `headless_cli` 项会用 `dsh --profile headless --help` 检查（不跑任务、不花 token）。

### 平台差异

| | Windows | macOS / Linux |
|---|---|---|
| 启动器 | 桌面端 `resources/runtime/cli/bin/dsh.cmd`，或 npm 全局 `dsh.cmd` | 桌面端 `.app/Contents/Resources/runtime/cli/bin/dsh`，或 npm 全局 `dsh` |
| 启动方式 | 经 `cmd.exe`（`.cmd` 必须走 shell），启动器路径和参数里带空格的都加引号 | 直接 exec，不经 shell，`/Applications/<产品名>.app` 这类带空格的路径不会被拆开 |
| PATH | 原样继承，末尾追加当前 node 所在目录 | 同左。从 Dock 启动的 GUI 客户端 PATH 里通常没有 Homebrew 的 node，npm 版 `dsh` 的 `#!/usr/bin/env node` 需要这一步才能找到 node |
| 插件 URL | `file:///C:/Users/...` | `file:///Users/...`（由 `pathToFileURL` 生成） |

## 3. 工具

| 工具 | 作用 |
|---|---|
| `dsh_ask` | 派任务给 DSH。参数：`task`（必填）、`session`（标签，默认 `default`）、`cwd`（默认桥进程当前目录）、`permission`（`read-only` / `workspace-write` / `danger-full-access`，**默认 `read-only`**）、`approval_policy`（默认 `never`）、`timeout_ms`（默认 15 分钟，范围 10s–60min） |
| `dsh_sessions` | 列出已保存的会话（标签 / session_id / cwd / 次数 / 上次是否成功） |
| `dsh_status` | 自检后端：启动器、headless 参数支持（首次会执行一次 `dsh --profile headless --help`，不花 token，成功后进程内缓存）、asar（仅参考）、凭据补丁状态、模型补丁开关、默认权限、工作目录、状态文件位置 |
| `dsh_forget` | 忘记某个会话标签（只删映射，不动 DSH 会话数据） |

返回文本固定含 `bridge_session` / `session_id` / `cwd` / `permission` / `exit_code`；成功时附 `== DSH answer ==` 与 token 用量，失败时附 `== DSH error ==` 与 stderr 尾部。

## 4. 安装与注册

```bash
# 1) 确认 DSH 启动器能被找到（装法不同目录名不同，找不到就显式指定）
export DSH_BRIDGE_DSH_CMD="<DSH安装目录>/resources/runtime/cli/bin/dsh.cmd"   # Windows 桌面端
# export DSH_BRIDGE_DSH_CMD="/Applications/<产品名>.app/Contents/Resources/runtime/cli/bin/dsh"  # macOS 桌面端

# 2) 协议层自检，不启动 DSH、不花 token
node verify.mjs --offline

# 3) 全量验收（会真的跑两轮 DSH，耗 token）
node verify.mjs

# 4) 注册进 Antigravity（写入 mcpServers['dsh-bridge']，改前自动备份；若检测到旧版指向已删除 mcp/dsh-crew/dsh-crew.mjs 的残留项会自动迁移并清理，不影响第三方 ZSeven-W/dsh-crew）
node register-antigravity.mjs "D:/my/project"   # 参数可省略
```

第 4 步也可以手工写进 `~/.gemini/config/mcp_config.json`：

```json
"dsh-bridge": {
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/dsh-bridge.mjs", "mcp"],
  "env": { "DSH_BRIDGE_WORKSPACE": "D:/my/project" }
}
```

生效条件：重启 Antigravity 或新开对话后，MCP 面板出现 `dsh-bridge`。

## 5. 环境变量（兼容旧版 `DSH_CREW_*`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_DSH_CMD` | 自动探测 | DSH headless 启动器（向后兼容 `DSH_CREW_DSH_CMD`） |
| `DSH_BRIDGE_WORKSPACE` | 桥进程 cwd | `dsh_ask` 的默认工作目录（向后兼容 `DSH_CREW_WORKSPACE`） |
| `DSH_BRIDGE_DEFAULT_PERMISSION` | `read-only` | `dsh_ask` 未传 `permission` 时的默认权限档（可设为 `read-only` / `workspace-write`） |
| `DSH_BRIDGE_DISABLE_CRED_PATCH` | `0` | 设为 `1` / `true` 时不加载 `crew-credentials.patch.yml`（不复用桌面端保存的凭据） |
| `DSH_BRIDGE_CRED_PATCH` | `~/.dsh/dsh-bridge/crew-credentials.patch.yml` | 凭据补丁落盘位置（向后兼容 `DSH_CREW_CRED_PATCH`） |
| `DSH_BRIDGE_ENABLE_COMMANDCODE` | `0` | 设为 `1` / `true` 且插件文件存在时才叠加 `crew-commandcode.patch.yml`（默认不启用） |
| `DSH_BRIDGE_COMMANDCODE_PLUGIN` | `~/.dsh/profiles/desktop/node_modules/dsh-commandcode/index.js` | 可选的第三方 Command Code 插件路径 |
| `DSH_BRIDGE_STATE_DIR` | `./state` | 标签 → `session_id` 映射存放处 |
| `DSH_BRIDGE_TIMEOUT_MS` | `900000` | 单轮默认超时（毫秒） |

## 6. 许可

本目录沿用仓库根目录的 [MIT License](../../LICENSE)。
