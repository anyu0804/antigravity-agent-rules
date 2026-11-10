#!/usr/bin/env node
/**
 * agent-bridge — 零依赖、后端可插拔的 MCP stdio 服务端。
 *
 * 作用：让任意 MCP 宿主（Antigravity / Claude Code / Codex / Grok ...）把子任务
 * 派给本机任意「一次性任务的 CLI agent」，并把最终答案取回来。
 *
 * 与具体产品的解耦点只有一个：BRIDGE_CMD + BRIDGE_ARGS。
 * 桥本身不认识 DSH、Codex 或别的什么，它只负责：
 *   1. 说 MCP（JSON-RPC 2.0，按行分隔，stdio）；
 *   2. 把任务经 stdin 交给后端进程（避免引号/换行/中文标点在参数里被二次转义）；
 *   3. 从后端 stdout 的 NDJSON 事件流里挑出最后一段有效答案；
 *   4. 按会话标签记住上下文的续聊标识。
 *
 * 配置全部走环境变量，见 README。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'agy-agent-bridge';
const VERSION = '0.2.0';
const PROTOCOL_FALLBACK = '2024-11-05';

const ENV = process.env;
const STATE_DIR = ENV.BRIDGE_STATE_DIR || path.join(HERE, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const DEFAULT_TIMEOUT_MS = Number(ENV.BRIDGE_TIMEOUT_MS || 900_000);
const DEFAULT_CWD = ENV.BRIDGE_CWD || process.cwd();
const MAX_OUTPUT_BYTES = Number(ENV.BRIDGE_MAX_OUTPUT_BYTES || 8 * 1024 * 1024);
const ANSWER_TAIL_LINES = Number(ENV.BRIDGE_ANSWER_TAIL_LINES || 80);

const MODES = new Set(['read-only', 'workspace-write', 'full-access']);

/**
 * 子进程环境变量最小白名单：只保留基础系统路径、区域与代理变量，
 * 默认剥离宿主机所有 *_KEY / *_TOKEN / *_SECRET / *_PASSWORD 等凭据与无关变量。
 * 如后端 CLI 确需特定环境变量，可通过 BRIDGE_PASS_ENV="VAR1,VAR2" 显式放行。
 */
const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'SYSTEMDRIVE', 'WINDIR', 'windir', 'COMSPEC', 'ComSpec',
  'TMP', 'TEMP', 'TMPDIR',
  'SHELL', 'USER', 'LOGNAME', 'USERNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
]);
const SENSITIVE_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|PAT|PRIVATE|SESSION_TOKEN)(?:$|_)/i;

function buildChildEnv() {
  const passList = new Set(
    String(ENV.BRIDGE_PASS_ENV || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out = {};
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) continue;
    if (passList.has(k)) {
      out[k] = v;
      continue;
    }
    if (/^BRIDGE_/i.test(k)) continue;
    if (SENSITIVE_NAME_RE.test(k)) continue;
    if (SAFE_ENV_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 输出

/** 写一行 JSON-RPC。用 Buffer 固定 UTF-8，绕开 Windows 控制台代码页。 */
function send(msg) {
  const line = JSON.stringify(msg) + '\n';
  process.stdout.write(Buffer.from(line, 'utf8'));
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/** 工具返回：文本内容块。MCP 规定 tools/call 的 result 必须含 content 数组。 */
function toolResult(text, { isError = false } = {}) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

// ---------------------------------------------------------------- 状态

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, STATE_FILE);
  await fs.chmod(STATE_FILE, 0o600).catch(() => {});
}

// ---------------------------------------------------------------- 后端

function resolveBackend() {
  const cmd = ENV.BRIDGE_CMD;
  if (!cmd) {
    return {
      error:
        'BRIDGE_CMD 未设置。这个变量指定后端 CLI 可执行文件（例如 dsh、codex、claude）。' +
        ' 详见 mcp/agent-bridge/README.md 的环境变量表。',
    };
  }
  let args = [];
  const rawArgs = ENV.BRIDGE_ARGS;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (!Array.isArray(parsed)) throw new Error('不是数组');
      args = parsed.map(String);
    } catch (e) {
      return { error: `BRIDGE_ARGS 必须是 JSON 字符串数组，例如 ["--json","-"]。解析失败：${e.message}` };
    }
  }
  return { cmd, args };
}

/** 把 {{task}}/{{session}}/{{cwd}}/{{mode}} 展开成实际参数。 */
function expandArgs(template, vars) {
  return template.map((a) =>
    a.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole)),
  );
}

/**
 * 从后端 stdout 的 NDJSON 事件流里挑答案。
 * 兼容几类常见形态：{type:'final'|'result', text|result|content}、
 * {content:[{type:'text',text}]}、以及 OpenAI 风格的 choices[0].message.content。
 * 全都认不出来时，退化为 stdout 尾部若干行。
 */
function extractAnswer(raw) {
  const lines = raw.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const text = pickText(obj);
    if (text) last = text;
  }
  if (last) return last;
  const tail = lines.filter((l) => l.trim()).slice(-ANSWER_TAIL_LINES);
  return tail.join('\n').trim() || '(后端没有输出)';
}

function pickText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const type = typeof obj.type === 'string' ? obj.type : '';
  const terminal = type === 'final' || type === 'result' || type === 'complete' || type === 'answer';

  // 直接的字符串字段
  for (const key of ['final', 'answer', 'text', 'output']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      if (terminal || key !== 'text') return obj[key].trim();
    }
  }
  // result 可能是字符串或对象
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result.trim();
  if (obj.result && typeof obj.result === 'object') {
    const inner = pickText(obj.result);
    if (inner) return inner;
  }
  // MCP/Anthropic 风格 content 数组
  if (Array.isArray(obj.content)) {
    const joined = obj.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (joined) return joined;
  }
  // OpenAI 风格
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const msg = choice && (choice.message || choice.delta);
  if (msg && typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
  // 事件里套事件
  if (obj.event && typeof obj.event === 'object') return pickText(obj.event);
  if (typeof obj.message === 'string' && terminal && obj.message.trim()) return obj.message.trim();
  return null;
}

/** 跑一次后端。任务走 stdin。 */
function runBackend({ cmd, args, task, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;

    // 只有 .cmd/.bat（以及无扩展名、要靠 PATH 解析的包装脚本）在 Windows 上才需要经 shell；
    // .exe 直接传参，避免带空格路径被 cmd 再拆一次。
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(cmd);

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, code: null, out, err: `启动失败：${e.message}`, ms: 0 });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {}
      err += `\n[TIMEOUT] 超过 ${timeoutMs} ms，已强制结束。`;
    }, timeoutMs);

    const done = (code, spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !spawnErr,
        code,
        out,
        err: (spawnErr ? String(spawnErr.message || spawnErr) + '\n' : '') + err,
        ms: Date.now() - started,
        truncated,
      });
    };

    const collect = (buf, isErr) => {
      const s = buf.toString('utf8');
      if (isErr) {
        if (err.length < MAX_OUTPUT_BYTES) err += s;
        return;
      }
      if (out.length < MAX_OUTPUT_BYTES) out += s;
      else truncated = true;
    };

    child.stdout.on('data', (b) => collect(b, false));
    child.stderr.on('data', (b) => collect(b, true));
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));

    // stdin 写完即关闭，让后端知道输入结束
    child.stdin.on('error', () => {}); // 后端提前退出时的 EPIPE 不该炸桥
    child.stdin.end(task, 'utf8');
  });
}

// ---------------------------------------------------------------- 工具实现

async function toolAsk(input) {
  const task = typeof input?.task === 'string' ? input.task.trim() : '';
  if (!task) throw new Error('agent_ask 需要一个非空的 task 字符串。');

  const label = normalizeSession(input.session);
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : DEFAULT_CWD;
  const mode = MODES.has(input.mode) ? input.mode : 'workspace-write';
  const timeoutMs = Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : DEFAULT_TIMEOUT_MS;

  const backend = resolveBackend();
  if (backend.error) return toolResult(backend.error, { isError: true });

  const state = await loadState();
  const prev = state[label] || null;
  // 会话标识：新建时本地生成，续聊时沿用上一次的（后端若不认这个参数会忽略）。
  const sessionId = prev?.session_id || randomUUID();

  const args = expandArgs(backend.args, {
    task,
    session: sessionId,
    cwd,
    mode,
  });

  const res = await runBackend({ cmd: backend.cmd, args, task, cwd, timeoutMs });
  const answer = extractAnswer(res.out);

  state[label] = {
    session_id: sessionId,
    cwd,
    mode,
    runs: (prev?.runs || 0) + 1,
    last_ok: res.ok,
    last_at: new Date().toISOString(),
    last_exit_code: res.code,
  };
  try {
    await saveState(state);
  } catch {
    // 状态写不进去不该让整次调用失败
  }

  const header = [
    `session: ${label}`,
    `session_id: ${sessionId}`,
    `cwd: ${cwd}`,
    `mode: ${mode}`,
    `exit_code: ${res.code}`,
    `elapsed_ms: ${res.ms}${res.truncated ? ' (stdout 已截断)' : ''}`,
  ].join('\n');

  if (res.ok) {
    return toolResult(`${header}\n\n== answer ==\n${answer}`);
  }
  const reason = res.err.trim() || '(后端没有 stderr 输出)';
  return toolResult(`${header}\n\n== error ==\n${reason}\n\n== last stdout ==\n${answer}`, {
    isError: true,
  });
}

async function toolSessions() {
  const state = await loadState();
  const labels = Object.keys(state);
  if (!labels.length) return toolResult('（还没有任何会话记录）');
  const rows = labels.map((label) => {
    const s = state[label];
    return [
      `- ${label}`,
      `  session_id: ${s.session_id}`,
      `  cwd: ${s.cwd}`,
      `  runs: ${s.runs}`,
      `  last_ok: ${s.last_ok}`,
      `  last_at: ${s.last_at}`,
    ].join('\n');
  });
  return toolResult(rows.join('\n'));
}

async function toolStatus() {
  const backend = resolveBackend();
  const lines = [
    `${NAME} v${VERSION} (node ${process.version}, ${process.platform})`,
    `state_dir: ${STATE_DIR}`,
    `default_cwd: ${DEFAULT_CWD}`,
    `default_timeout_ms: ${DEFAULT_TIMEOUT_MS}`,
  ];
  if (backend.error) {
    lines.push('backend: 未配置', `  ${backend.error}`);
    return toolResult(lines.join('\n'), { isError: true });
  }
  lines.push(`backend_cmd: ${backend.cmd}`, `backend_args: ${JSON.stringify(backend.args)}`);

  // 用 --version 探一次，探不到不算失败（很多 CLI 没有这个开关）
  const probe = await runBackend({
    cmd: backend.cmd,
    args: ['--version'],
    task: '',
    cwd: DEFAULT_CWD,
    timeoutMs: 15_000,
  });
  const firstLine = (probe.out || probe.err).split(/\r?\n/).find((l) => l.trim()) || '';
  if (probe.ok && firstLine) lines.push(`backend_version: ${firstLine.trim()}`);
  else if (!probe.ok) lines.push(`backend_probe: 未能取到版本（不影响使用，可能是 CLI 没有 --version）`);
  return toolResult(lines.join('\n'));
}

async function toolForget(input) {
  const label = normalizeSession(input?.session);
  const state = await loadState();
  if (!(label in state)) return toolResult(`会话 ${label} 本来就不存在。`);
  delete state[label];
  await saveState(state);
  return toolResult(`已忘记会话 ${label}（只删本地映射，不动后端自己的会话数据）。`);
}

function normalizeSession(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || 'default';
}

// ---------------------------------------------------------------- 工具声明

const TOOLS = [
  {
    name: 'agent_ask',
    description:
      '把一个任务派给本机外部 CLI agent，等它跑完并取回最终答案。任务经 stdin 传入，长文本和中文标点不会被参数转义搞坏。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要派发的任务全文（必填）' },
        session: {
          type: 'string',
          description: '会话标签，同名标签会续用同一上下文，默认 default',
        },
        cwd: { type: 'string', description: '后端进程的工作目录，默认取 BRIDGE_CWD' },
        mode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'full-access'],
          description: '权限档位提示，会替换进 BRIDGE_ARGS 的 {{mode}}，默认 workspace-write',
        },
        timeout_ms: { type: 'integer', description: '单次超时毫秒数，默认取 BRIDGE_TIMEOUT_MS' },
      },
      required: ['task'],
    },
  },
  {
    name: 'agent_sessions',
    description: '列出桥记录过的会话标签、对应 session_id、工作目录、调用次数与上次是否成功。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_status',
    description: '自检：回显桥版本、状态目录、后端命令与探测到的后端版本，用来排查配置问题。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_forget',
    description: '忘掉某个会话标签的本地映射。只删桥的记录，不动后端自己的会话数据。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: '要忘记的会话标签' } },
      required: ['session'],
    },
  },
];

const HANDLERS = {
  agent_ask: toolAsk,
  agent_sessions: toolSessions,
  agent_status: toolStatus,
  agent_forget: toolForget,
};

// ---------------------------------------------------------------- MCP 主循环

/** 串行化处理，避免并发写 stdout 交错、以及状态文件互相覆盖。 */
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => {
    process.stderr.write(`[${NAME}] handler error: ${e && e.stack ? e.stack : e}\n`);
  });
  return queue;
}

async function handle(msg) {
  const { id, method, params } = msg || {};

  // 通知（没有 id）不需要回包
  const isNotification = id === undefined || id === null;
  if (isNotification) return;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) {
        replyError(id, -32602, `未知工具：${name}`);
        return;
      }
      try {
        const result = await handler(params?.arguments || {});
        reply(id, result);
      } catch (e) {
        reply(id, toolResult(`工具执行失败：${e && e.message ? e.message : e}`, { isError: true }));
      }
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      replyError(id, -32601, `不支持的方法：${method}`);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      replyError(null, -32700, 'JSON 解析失败');
      return;
    }
    if (Array.isArray(msg)) {
      for (const one of msg) enqueue(() => handle(one));
      return;
    }
    enqueue(() => handle(msg));
  });
  rl.on('close', () => {
    // 还有在跑的调用时，等队列排空再退
    queue.finally(() => process.exit(0));
  });
  process.stderr.write(`[${NAME}] v${VERSION} listening on stdio\n`);
}

main();
