#!/usr/bin/env node
/**
 * 测试用假后端：不联网、不调任何真实 CLI，只按契约吐 NDJSON 事件。
 * 契约：任务从 stdin 进；事件从 stdout 按行出；退出码非 0 表示失败。
 */
const args = process.argv.slice(2);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const task = Buffer.concat(chunks).toString('utf8');

if (task.includes('__FAIL__')) {
  console.error('mock-backend: 故意失败（任务是 __FAIL__ 标记）');
  process.exit(3);
}

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\r\n');
emit({ type: 'start', argv: args, task_length: task.length });
emit({ type: 'step', text: '中间过程不该被当成最终答案' });
emit({
  type: 'final',
  text: JSON.stringify({
    echo: task.trim(),
    argv: args,
    hasSecretKey: Boolean(process.env.FAKE_SECRET_KEY || process.env.GITHUB_TOKEN || process.env.UNLISTED_HOST_VAR),
    hasBridgeCmd: Boolean(process.env.BRIDGE_CMD),
    passedVar: process.env.EXPLICIT_ALLOWED_KEY || null,
  }),
});
