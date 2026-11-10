#!/usr/bin/env node
/**
 * 把 dsh-bridge 注册进 Antigravity 的全局 MCP 配置（改前自动备份）。
 * 使用独立的键名 mcpServers['dsh-bridge']，绝不覆盖第三方项目 ZSeven-W/dsh-crew 的 mcpServers['dsh-crew']。
 *
 * 用法：
 *   node register-antigravity.mjs                 # 不设工作区，交给宿主 cwd
 *   node register-antigravity.mjs "D:/my/project" # 指定 DSH 工作区
 *
 * 所有路径都从本脚本位置和 os.homedir() 推出来，不写死任何本机路径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.AGY_MCP_CONFIG || path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
const BACKUP_DIR = process.env.AGY_MCP_BACKUP_DIR || path.join(HERE, 'backups');
const ENTRY = {
  command: process.execPath,
  args: [path.join(HERE, 'dsh-bridge.mjs'), 'mcp'],
};

const workspace = process.argv[2];
if (workspace) ENTRY.env = { DSH_BRIDGE_WORKSPACE: workspace };

function isLegacyBundledEntry(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.args)) return false;
  return entry.args.some((arg) => typeof arg === 'string' && /[\\/]mcp[\\/]dsh-crew[\\/]dsh-crew\.mjs$/i.test(arg));
}

if (!fs.existsSync(CONFIG)) {
  console.error('未找到 Antigravity MCP 配置：' + CONFIG);
  console.error('先启动一次 Antigravity，或手动创建 {"mcpServers":{}} 后重试。');
  process.exit(1);
}

const raw = fs.readFileSync(CONFIG, 'utf8');
const cfg = raw.trim() ? JSON.parse(raw) : {};
cfg.mcpServers = cfg.mcpServers || {};

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backup = path.join(BACKUP_DIR, 'antigravity-mcp-config-' + ts + '.bak');
fs.writeFileSync(backup, raw, 'utf8');

let migratedLegacy = false;
if (isLegacyBundledEntry(cfg.mcpServers['dsh-crew'])) {
  const legacyEnv = cfg.mcpServers['dsh-crew'].env;
  const inheritedWs = !workspace && legacyEnv && (legacyEnv.DSH_BRIDGE_WORKSPACE || legacyEnv.DSH_CREW_WORKSPACE);
  if (inheritedWs) ENTRY.env = { DSH_BRIDGE_WORKSPACE: inheritedWs };
  delete cfg.mcpServers['dsh-crew'];
  migratedLegacy = true;
}

cfg.mcpServers['dsh-bridge'] = ENTRY;
const next = JSON.stringify(cfg, null, 2) + '\n';
fs.writeFileSync(CONFIG, next, 'utf8');

// 回读校验
const check = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
console.log('CONFIG: ' + CONFIG);
console.log('BACKUP: ' + backup);
if (migratedLegacy) {
  console.log('MIGRATED: removed legacy mcpServers[\'dsh-crew\'] (mcp/dsh-crew/dsh-crew.mjs) -> mcpServers[\'dsh-bridge\']');
}
console.log('SERVERS: ' + Object.keys(check.mcpServers).join(', '));
console.log('DSH_BRIDGE_ENTRY: ' + JSON.stringify(check.mcpServers['dsh-bridge']));
console.log('提示：重启 Antigravity 或新开对话后，MCP 面板才会出现 dsh-bridge。');
