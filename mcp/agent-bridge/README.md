# agy-agent-bridge（目录 `mcp/agent-bridge`）

零依赖、**后端可插拔**的 MCP stdio 服务端（注册键名 `agy-agent-bridge`，避免与社区 `@paulmh/agentbridge-mcp`、`raysonmeng/agent-bridge`、`EthanSK/agent-bridge` 等同名项目冲突）。让任意 MCP 宿主（Antigravity、Claude Code、Codex、Grok……）把子任务派给本机任意「一次性任务的 CLI agent」，并取回最终答案。

约 500 行、只用 Node 内建模块、不装任何依赖。**本目录不含任何第三方项目的代码**，只依赖公开的 MCP 协议（JSON-RPC 2.0 over stdio）和一条约定：后端把任务从 stdin 读进去，把事件从 stdout 按行吐出来。

---

## 来历与验证状态（先看这里）

| 项 | 内容 |
|---|---|
| 编写 | 2026-11-09，由作者使用的编码 Agent 按需求新写，不是从别的仓库拷来的 |
| 版权 | 作者原创实现，随仓库根 [MIT License](../../LICENSE) 发布 |
| 验证状态 | `verify.mjs` 用假后端跑 **35 项协议与安全断言，35/35 通过**（含子进程敏感环境变量隔离、`BRIDGE_PASS_ENV` 显式透传与 `sessions.json` `0600` 权限检查），不联网、不需要真 CLI；**尚未接入任何真实后端跑通端到端（`NOT_PROVEN`）** |
| 姊妹实现 | 同仓库 [`../dsh-bridge`](../dsh-bridge)（原目录名 `dsh-crew`，自 0.2.0 起改名为 `dsh-bridge` 以免与社区 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew) 重名）：DSH Headless 专用，**已在真机跑通 6/6** |

一句话取舍：
- **只接 DSH Headless（单文件零依赖）**：用同仓库 [`../dsh-bridge`](../dsh-bridge)（已真机验证）。
- **需要异步多 Worker 池、进度轮询、cwd 咨询锁或 GUI CDP 验收**：直接用社区成熟项目 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew)（MIT）或 [`lanlan0811/tianshu-mcp`](https://github.com/lanlan0811/tianshu-mcp)（Apache-2.0）。
- **后端要换、或只想一层可插拔薄封装**：用本桥——但请自己先跑一遍真实后端再上生产。

---

## 为什么自己写一个

市面上的 MCP 桥通常都是某个具体产品的配套插件：装进来会带一串依赖，工具面铺得很大，能力也绑在那个后端上。如果你要的只是「把一段任务交给本机某个 CLI，拿回一段文本」，这些都用不上。

本桥的取舍：

| | 本桥 (`agent-bridge`) | 社区成套插件（如 [`ZSeven-W/dsh-crew`](https://github.com/ZSeven-W/dsh-crew)） |
|---|---|---|
| 依赖 | 0（仅 Node 内建模块） | 通常带 MCP SDK、参数校验库等 |
| 后端绑定 | 无，`BRIDGE_CMD` 指谁就是谁 | 一般绑定特定产品 |
| 工具面 | 4 个（派活 / 列表 / 自检 / 遗忘） | 6~10+ 个，含异步任务与并行 |
| 可审计 | 单文件约 500 行，读完就懂 | 需要读整个包结构 |
| 适合 | 想完全掌控、后端随便换 | 想开箱即用、要并行与进度 |

---

## 快速开始

```bash
# 自检（用假后端，不联网、不需要真 CLI）
node mcp/agent-bridge/verify.mjs
# => TOTAL 35 / PASS 35 / FAIL 0
```

自检全绿说明协议层没问题，剩下只需要把你的后端命令填进环境变量。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `BRIDGE_CMD` | ✅ | 后端可执行文件。`.exe` 直接传参；`.cmd`/`.bat` 在 Windows 上自动经 shell。 |
| `BRIDGE_ARGS` | | JSON 字符串数组，参数模板。支持四个占位符：`{{session}}` `{{mode}}` `{{cwd}}` `{{task}}`。缺省为 `[]`。 |
| `BRIDGE_CWD` | | 后端默认工作目录，缺省为桥自己的 `process.cwd()`。**建议显式设置**，否则取决于宿主从哪里拉起桥。 |
| `BRIDGE_PASS_ENV` | | 逗号分隔的环境变量白名单（如 `"OPENAI_API_KEY,ANTHROPIC_API_KEY"`）。子进程默认仅继承系统基础路径与代理变量，**自动剥离宿主机所有 `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` 等敏感凭据**；后端 CLI 确需特定密钥时在此显式列出。 |
| `BRIDGE_TIMEOUT_MS` | | 单次调用超时，缺省 `900000`（15 分钟）。超时 SIGKILL 并回传 `[TIMEOUT]`。 |
| `BRIDGE_STATE_DIR` | | 会话映射文件目录，缺省 `./state`（目录权限 `0700`，`sessions.json` 权限 `0600`）。 |
| `BRIDGE_MAX_OUTPUT_BYTES` | | stdout 累计上限，缺省 8 MB，超出后截断。 |
| `BRIDGE_ANSWER_TAIL_LINES` | | 认不出结构化事件时，退化为取 stdout 尾部多少行，缺省 80。 |

> `{{task}}` 一般用不上——任务默认**经 stdin 传入**，这是刻意的：长文本、引号、换行、中文标点在参数里容易被命令行二次转义搞坏。只有当后端坚持从参数收任务时才用它。

---

## 注册到 Antigravity

写进 `~/.gemini/config/mcp_config.json`（改完重启客户端或新开对话；使用 `agy-agent-bridge` 键名以免与社区同名桥冲突）：

```json
{
  "mcpServers": {
    "agy-agent-bridge": {
      "command": "node",
      "args": ["<仓库绝对路径>/mcp/agent-bridge/bridge.mjs"],
      "env": {
        "BRIDGE_CMD": "<你的后端可执行文件>",
        "BRIDGE_ARGS": "[\"--json\",\"--session\",\"{{session}}\"]",
        "BRIDGE_CWD": "<你希望后端干活的工作区>",
        "BRIDGE_STATE_DIR": "<仓库绝对路径>/mcp/agent-bridge/state"
      }
    }
  }
}
```

工具会以 `agent_ask` / `agent_sessions` / `agent_status` / `agent_forget` 出现在 MCP 面板。

**先调 `agent_status`**：它会把解析出的 `backend_cmd`、`backend_args`、`state_dir` 原样回显，并尝试用 `--version` 探一次后端版本。配置写错时，这一条能立刻定位是路径问题还是参数模板问题。

---

## 后端怎么配（三档）

### 1. 后端接受「stdin 进任务、stdout 出 NDJSON」〔最理想〕

```jsonc
"BRIDGE_CMD": "some-agent",
"BRIDGE_ARGS": "[\"--json\",\"--session\",\"{{session}}\",\"--mode\",\"{{mode}}\"]"
```

桥会扫 stdout 每一行 JSON，挑出终结类事件（`type: final / result / complete / answer`，或含 `content[]`、`choices[0].message.content` 的形态），取**最后一条**有效文本。中间过程事件会被忽略。

### 2. 后端只吐纯文本

什么都不用配。桥认不出结构化事件时，退化成取 stdout 尾部 `BRIDGE_ANSWER_TAIL_LINES` 行。

### 3. 后端需要交互式 TTY

**不支持。** 本桥按一次性任务设计（stdin 写完即关）。需要常驻会话、多轮交互的后端不适用，请另找对应方案。

> ⚠️ 真实后端的参数组合我没有替你验证过。上面第 1、3 档是设计意图，第 2 档是天然兜底；`[VERIFIED]` 的只有「用 `verify.mjs` 的假后端跑通 32 项协议断言」这一件事。填你自己的后端时，**先跑一次 `agent_status` 再跑一次最小 `agent_ask`**，别直接上长任务。

---

## 设计要点

1. **任务走 stdin，不走参数。** 避免引号、换行、中文标点在 `cmd` 里被二次解析——这是这类桥最常见的翻车点。
2. **答案按「最后一条有效事件」取。** 不假设事件格式，只认几类常见形状，认不出就退化成尾巴几行，保证任何后端都有输出而不是空返回。
3. **会话标识由桥本地生成。** 首次调用生成 UUID，同标签后续调用沿用它并展开进 `{{session}}`。后端不认这个参数时会忽略，不影响主流程；认的话就天然支持多轮续聊。
4. **状态写盘用 tmp + rename。** 避免并发调用把 `sessions.json` 写坏。
5. **主循环串行排队。** 并发请求会依次执行，防止两路同时 spawn 后端抢同一工作区。
6. **stdout 固定 UTF-8 Buffer 写出。** 绕开 Windows 控制台代码页，中文不会变问号。
7. **后端提前退出导致的 EPIPE 被吞掉。** 不让一次失败的派发把整个桥带崩。

---

## 已知限制

1. **同步阻塞式**：`agent_ask` 会一直等到后端退出或超时。跑长任务时宿主那边的工具调用也会一起等，必要时把 `timeout_ms` 调小、分片派活。没有异步 job、没有进度轮询。
2. **无并发保护**：不像成熟插件那样对同一 `cwd` 加咨询锁。两个不同会话标签同时派活到同一工作区，后果由后端自己承担。
3. **会话续聊取决于后端**：桥只负责把 `{{session}}` 展开并记下来，后端不认就退化成每次全新会话。
4. **Windows 优先**：`.cmd/.bat` 的 shell 判定、UTF-8 写出都按 Windows 实测过；Linux/macOS 理论上可用（`useShell` 恒为 false，直接 exec），但**未实测**，标 `NOT_PROVEN`。
5. **只做单向派活**：不解析后端的工具调用、不支持中途插话、不支持流式回传。要这些请用成熟插件。
