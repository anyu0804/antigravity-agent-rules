#!/usr/bin/env node
/**
 * agent-bridge 协议自检。
 *
 * 全程用 test/mock-backend.mjs 当后端，不联网、不依赖任何真实 CLI，
 * 所以在任何机器上跑结果都一致：  node mcp/agent-bridge/verify.mjs
 *
 * 覆盖：MCP 握手、工具清单、配置缺失、正常/失败调用、会话复用、
 *       参数模板展开、会话列表与遗忘、未知方法与坏 JSON。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge.mjs');
const MOCK = path.join(HERE, 'test', 'mock-backend.mjs');

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`);
  }
}

/** 起一个桥进程，返回 { request, notify, close, stderr }。 */
function startBridge(env) {
  const stateDir = path.join(os.tmpdir(), `agent-bridge-verify-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BRIDGE_STATE_DIR: stateDir, ...env },
  });

  const pending = new Map();
  let nextId = 1;
  let stderr = '';

  child.stderr.on('data', (b) => {
    stderr += b.toString('utf8');
  });

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const request = (method, params, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  const raw = (text) => child.stdin.write(text);

  const close = () =>
    new Promise((resolve) => {
      child.on('close', resolve);
      child.stdin.end();
    });

  return { request, notify, raw, close, get stderr() { return stderr; }, stateDir };
}

const textOf = (msg) => {
  const blocks = msg?.result?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};

async function main() {
  // ---------------------------------------------------------------- A. 未配置后端
  console.log('\n[A] 未配置后端时的自检行为');
  {
    const b = startBridge({ BRIDGE_CMD: '' });
    const init = await b.request('initialize', { protocolVersion: '2024-11-05' });
    check('initialize 回显协议版本', init.result?.protocolVersion === '2024-11-05');
    check('serverInfo 名称正确', init.result?.serverInfo?.name === 'agy-agent-bridge');

    const st = await b.request('tools/call', { name: 'agent_status', arguments: {} });
    check('缺 BRIDGE_CMD 时 agent_status 报错', st.result?.isError === true);
    check(
      '错误信息指明 BRIDGE_CMD',
      /BRIDGE_CMD/.test(textOf(st)),
      textOf(st).slice(0, 80),
    );
    await b.close();
  }

  // ---------------------------------------------------------------- B. 正常链路
  console.log('\n[B] 配好后端后的完整链路');
  const stateDir = path.join(os.tmpdir(), `ab-state-${Date.now()}`);
  const b = startBridge({
    BRIDGE_CMD: process.execPath,
    BRIDGE_ARGS: JSON.stringify([MOCK, '--session', '{{session}}', '--mode', '{{mode}}']),
    BRIDGE_STATE_DIR: stateDir,
    BRIDGE_PASS_ENV: 'EXPLICIT_ALLOWED_KEY',
    FAKE_SECRET_KEY: 'sk-should-not-leak',
    GITHUB_TOKEN: 'ghp_shouldNotLeak1234567890',
    UNLISTED_HOST_VAR: 'host-private-value',
    EXPLICIT_ALLOWED_KEY: 'explicitly-allowed-value',
  });

  const init = await b.request('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'verify', version: '0' },
  });
  check(
    'initialize 回显客户端协议版本',
    init.result?.protocolVersion === '2025-06-18',
    String(init.result?.protocolVersion),
  );
  b.notify('notifications/initialized');

  const tl = await b.request('tools/list', {});
  const names = (tl.result?.tools || []).map((t) => t.name).sort();
  check(
    'tools/list 返回 4 个工具',
    names.join(',') === 'agent_ask,agent_forget,agent_sessions,agent_status',
    names.join(','),
  );
  const askSchema = (tl.result?.tools || []).find((t) => t.name === 'agent_ask');
  check('agent_ask 的 required 含 task', JSON.stringify(askSchema?.inputSchema?.required) === '["task"]');

  const status = await b.request('tools/call', { name: 'agent_status', arguments: {} });
  const statusText = textOf(status);
  check('agent_status 回显后端命令', statusText.includes('backend_cmd:'), statusText.slice(0, 80));
  check('agent_status 报 state_dir', statusText.includes(stateDir.replace(/\\/g, '\\')) || statusText.includes('state_dir:'));

  // 正常调用
  const task = '把 D:/x/y.ts 第 12 行的空指针修掉。（含中文标点，:、；）';
  const r1 = await b.request('tools/call', {
    name: 'agent_ask',
    arguments: { task, session: 'smoke', mode: 'read-only' },
  });
  const t1 = textOf(r1);
  check('agent_ask 成功返回', r1.result?.isError !== true, t1.slice(0, 120));
  check('返回里带 session 标签', t1.includes('session: smoke'));
  check('exit_code 为 0', /exit_code: 0/.test(t1));

  const answerJson = t1.split('== answer ==')[1]?.trim() || '';
  let answer = null;
  try {
    answer = JSON.parse(answerJson);
  } catch {}
  check('从 NDJSON 里挑出 final 事件的答案', answer !== null, answerJson.slice(0, 100));
  check('答案取自 final 而非中间 step', !!answer && !/中间过程/.test(answer.echo || ''));
  check('任务经 stdin 原样送达（中文标点未被破坏）', !!answer && answer.echo === task);
  check('{{mode}} 已展开', !!answer && answer.argv?.includes('read-only'), JSON.stringify(answer?.argv));
  const firstSessionId = answer?.argv?.[answer.argv.indexOf('--session') + 1];
  check('{{session}} 已展开为 uuid', /^[0-9a-f-]{36}$/.test(firstSessionId || ''), String(firstSessionId));
  check('子进程默认剥离宿主机敏感 *_KEY/*_TOKEN 与非白名单变量', answer?.hasSecretKey === false && answer?.hasBridgeCmd === false);
  check('BRIDGE_PASS_ENV 显式声明的变量可透传给子进程', answer?.passedVar === 'explicitly-allowed-value', String(answer?.passedVar));

  // 会话复用
  const r2 = await b.request('tools/call', {
    name: 'agent_ask',
    arguments: { task: '第二轮', session: 'smoke' },
  });
  const a2 = JSON.parse(textOf(r2).split('== answer ==')[1]?.trim() || '{}');
  const secondSessionId = a2.argv?.[a2.argv.indexOf('--session') + 1];
  check('同名会话复用同一个 session_id', secondSessionId === firstSessionId, `${firstSessionId} vs ${secondSessionId}`);

  // 会话列表
  const sess = await b.request('tools/call', { name: 'agent_sessions', arguments: {} });
  const sessText = textOf(sess);
  check('agent_sessions 列出 smoke', sessText.includes('- smoke'));
  check('agent_sessions 记录 runs=2', /runs: 2/.test(sessText), sessText.slice(0, 120));

  // 失败调用
  const r3 = await b.request('tools/call', {
    name: 'agent_ask',
    arguments: { task: '__FAIL__', session: 'bad' },
  });
  const t3 = textOf(r3);
  check('后端非零退出时 isError', r3.result?.isError === true);
  check('回传非零 exit_code', /exit_code: 3/.test(t3), t3.slice(0, 120));
  check('回传后端 stderr 尾部', /故意失败/.test(t3));

  // 遗忘
  const f1 = await b.request('tools/call', { name: 'agent_forget', arguments: { session: 'smoke' } });
  check('agent_forget 删除已有会话', /已忘记/.test(textOf(f1)));
  const f2 = await b.request('tools/call', { name: 'agent_forget', arguments: { session: 'smoke' } });
  check('重复 forget 不报错', /本来就不存在/.test(textOf(f2)));

  const after = await b.request('tools/call', { name: 'agent_sessions', arguments: {} });
  check('forget 后列表里没有 smoke', !textOf(after).includes('- smoke'));

  // 协议边界
  const unknown = await b.request('resources/read', { uri: 'file:///nope' });
  check('未知方法返回 -32601', unknown.error?.code === -32601, JSON.stringify(unknown.error));

  const badTool = await b.request('tools/call', { name: 'nope', arguments: {} });
  check('未知工具返回 -32602', badTool.error?.code === -32602, JSON.stringify(badTool.error));

  b.raw('{ this is not json }\n');
  await new Promise((r) => setTimeout(r, 300));
  check('坏 JSON 不会让桥崩溃', true);

  const ping = await b.request('ping', {});
  check('坏 JSON 之后仍可正常响应（ping 返回空对象）', !!ping.result && Object.keys(ping.result).length === 0);

  const emptyAsk = await b.request('tools/call', { name: 'agent_ask', arguments: { task: '   ' } });
  check('空 task 被拒绝', emptyAsk.result?.isError === true);

  await b.close();

  // 状态文件确实落盘且权限受限
  const stateFilePath = path.join(stateDir, 'sessions.json');
  const stateRaw = await fs.readFile(stateFilePath, 'utf8').catch(() => '');
  check('会话状态已落盘', stateRaw.includes('"bad"'), stateRaw.slice(0, 80));
  const stStat = await fs.stat(stateFilePath).catch(() => null);
  const modeOk = process.platform === 'win32' ? Boolean(stStat) : (stStat && (stStat.mode & 0o777) === 0o600);
  check('sessions.json 权限为 0600（Windows 下正常落盘）', modeOk, stStat ? '0o' + (stStat.mode & 0o777).toString(8) : 'missing');

  // ---------------------------------------------------------------- 汇总
  const total = pass + failures.length;
  console.log('\n' + '='.repeat(56));
  console.log(`TOTAL ${total} / PASS ${pass} / FAIL ${failures.length}`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? '：' + f.detail : ''}`);
    process.exit(1);
  }
  console.log('全部通过');
}

main().catch((e) => {
  console.error('自检脚本自身出错：', e);
  process.exit(2);
});
