#!/usr/bin/env node
// ============================================================================
// Antigravity Agent Rules - hook layer installer for macOS / Linux
// ----------------------------------------------------------------------------
// Unix counterpart of `install.ps1 -HookOnly` / `uninstall.ps1`. Called by the
// repo-root install.sh / uninstall.sh wrappers.
//
//   node hooks/unix/hooks-installer.mjs install   [--force] [--skip-hook-verify] [--target-home DIR]
//   node hooks/unix/hooks-installer.mjs uninstall [--force] [--target-home DIR]
//
// install:
//   1. Pre-validates the existing ~/.gemini/config/hooks.json BEFORE touching
//      anything; aborts on a parse error.
//   2. Lists files that will be modified and asks for 'y' (skip with --force).
//   3. Backs up pre-existing targets into
//      ~/.gemini/backup_antigravity_rules_<timestamp>/ with manifest.json
//      (mode = hook-only), the same layout install.ps1 uses.
//   4. Merges hooks.json by top-level keys (hard-gate, read-loop-efficiency,
//      read-loop-enforcement). Commands are rewritten for `sh -c`:
//        powershell ... pretool_guard.ps1  ->  "<node>" ./scripts/pretool_guard.cjs
//        node ./scripts/...                ->  "<node>" ./scripts/...
//      <node> is the absolute path of the Node running this installer, because
//      a GUI-launched Antigravity may not have Homebrew's bin dir on PATH.
//   5. Copies hooks/scripts/* into ~/.gemini/config/scripts/.
//   6. Runs `python3 verify-hook.py --guard node` unless --skip-hook-verify.
//
// uninstall:
//   Restores hooks.json and scripts/* from the latest backup snapshot and
//   deletes the ones that did not exist before installation. Only hook-only
//   snapshots are accepted; full installs are produced by install.ps1 on
//   Windows and must be removed with uninstall.ps1.
// ============================================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_HOOKS = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const REPO_SCRIPTS = path.join(REPO_ROOT, 'hooks', 'scripts');
const HOOK_TOP_KEYS = ['hard-gate', 'read-loop-efficiency', 'read-loop-enforcement'];
// install.sh passes the Node path it found on PATH (e.g. /opt/homebrew/bin/node). Prefer it over
// process.execPath, which under Homebrew is a versioned Cellar path that breaks on `brew upgrade`.
const NODE = process.env.HOOKS_NODE || process.execPath;

function parseArgs(argv) {
  const opts = { action: argv[0], force: false, skipVerify: false, home: os.homedir() };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--skip-hook-verify') opts.skipVerify = true;
    else if (a === '--target-home') opts.home = argv[++i];
    else fail('unknown option: ' + a);
  }
  if (!['install', 'uninstall'].includes(opts.action)) fail('usage: hooks-installer.mjs install|uninstall [options]');
  if (!opts.home) fail('--target-home cannot be empty.');
  opts.home = path.resolve(opts.home);
  return opts;
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function paths(home) {
  const gemini = path.join(home, '.gemini');
  const config = path.join(gemini, 'config');
  return { gemini, config, hooks: path.join(config, 'hooks.json'), scripts: path.join(config, 'scripts') };
}

function readJsonOrNull(file, label) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Failed to parse ${label} at '${file}': ${e.message}. Please fix syntax/remove comments first. Aborting with no changes.`);
  }
}

async function confirm(question, force) {
  if (force) return true;
  if (!process.stdin.isTTY) fail('Not running in a terminal; re-run with --force to skip the confirmation.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(question + ' [y/N] ');
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Managed targets relative to ~/.gemini, POSIX separators. */
function managedRelPaths() {
  const scripts = fs.readdirSync(REPO_SCRIPTS).filter((f) => fs.statSync(path.join(REPO_SCRIPTS, f)).isFile()).sort();
  return ['config/hooks.json', ...scripts.map((f) => 'config/scripts/' + f)];
}

/** Rewrite repo hook commands so they run under `sh -c` with an absolute Node path. */
function rewriteCommand(cmd) {
  const q = JSON.stringify(NODE);
  if (/pretool_guard\.ps1/i.test(cmd)) return `${q} ./scripts/pretool_guard.cjs`;
  if (/^node\s+/.test(cmd)) return cmd.replace(/^node\s+/, q + ' ');
  return cmd;
}

function rewriteHooks(value) {
  if (Array.isArray(value)) return value.map(rewriteHooks);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'command' && typeof v === 'string' ? rewriteCommand(v) : rewriteHooks(v);
    }
    return out;
  }
  return value;
}

async function install(opts) {
  const P = paths(opts.home);
  console.log('======================================================================');
  console.log('Antigravity Agent Rules Installer (macOS / Linux, hook layer only)');
  console.log('  Source Repo : ' + REPO_ROOT);
  console.log('  Target Home : ' + opts.home);
  console.log('  Node        : ' + NODE + ' (' + process.version + ')');
  console.log('======================================================================');

  // 0. Pre-parse before touching anything
  const existingHooks = readJsonOrNull(P.hooks, 'existing hooks.json');
  const repoHooks = readJsonOrNull(REPO_HOOKS, 'repo hooks.json');
  if (!repoHooks) fail('repo hooks/hooks.json is missing or empty.');

  const managed = managedRelPaths();
  const existing = managed.filter((rel) => fs.existsSync(path.join(P.gemini, rel)));
  console.log('');
  if (existing.length) {
    console.log(`The following existing files in '${P.gemini}' will be modified:`);
    for (const rel of existing) console.log(`  [${rel === 'config/hooks.json' ? 'MERGE (top-level keys)' : 'OVERWRITE'}] ${path.join(P.gemini, rel)}`);
  } else {
    console.log(`No existing target files found in '${P.gemini}' (clean install).`);
  }
  console.log('');
  if (!(await confirm('Proceed with installation?', opts.force))) {
    console.log('Aborted by user. No files were modified.');
    return 0;
  }

  // 1. Backup
  const stamp = timestamp();
  const backupDir = path.join(P.gemini, 'backup_antigravity_rules_' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const rel of existing) {
    const dst = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(P.gemini, rel), dst);
  }
  const manifest = {
    timestamp: stamp,
    targetHome: opts.home,
    workspacePath: '',
    mode: 'hook-only',
    platform: process.platform,
    preExisting: existing,
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[1/3] Created backup snapshot (${existing.length} pre-existing item(s)): ${backupDir}`);

  // 2. Merge hooks.json & copy scripts
  fs.mkdirSync(P.scripts, { recursive: true });
  const merged = existingHooks && typeof existingHooks === 'object' && !Array.isArray(existingHooks) ? existingHooks : {};
  const rewritten = rewriteHooks(repoHooks);
  for (const key of HOOK_TOP_KEYS) merged[key] = rewritten[key];
  fs.writeFileSync(P.hooks, JSON.stringify(merged, null, 2) + '\n');
  for (const rel of managed.filter((r) => r.startsWith('config/scripts/'))) {
    fs.copyFileSync(path.join(REPO_SCRIPTS, path.basename(rel)), path.join(P.gemini, rel));
  }
  console.log('[2/3] Merged hooks.json (top-level keys) & deployed scripts/.');

  // 3. Self-test
  if (opts.skipVerify) {
    console.log('[3/3] Skipped hook self-test (--skip-hook-verify).');
  } else {
    const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
    if (!py) {
      console.log('[3/3] WARNING: python3 not found, hook self-test skipped. Run it later with:');
      console.log(`      python3 "${path.join(P.scripts, 'verify-hook.py')}" --guard node`);
    } else {
      console.log(`[3/3] Running hook self-test (${py} verify-hook.py --guard node)...`);
      const r = spawnSync(py, [path.join(P.scripts, 'verify-hook.py'), '--guard', 'node'], {
        cwd: P.scripts, stdio: 'inherit', env: Object.assign({}, process.env, { NODE }),
      });
      if (r.status !== 0) {
        console.error('Hook self-test FAILED. The hooks are installed; restore the previous state with ./uninstall.sh.');
        return 1;
      }
    }
  }
  console.log('');
  console.log('Done. Start a new conversation (or restart Antigravity) for the hooks to take effect.');
  return 0;
}

async function uninstall(opts) {
  const P = paths(opts.home);
  if (!fs.existsSync(P.gemini)) {
    console.log(`Directory '${P.gemini}' does not exist. Nothing to uninstall.`);
    return 0;
  }
  const backups = fs.readdirSync(P.gemini)
    .filter((n) => n.startsWith('backup_antigravity_rules_') && fs.statSync(path.join(P.gemini, n)).isDirectory())
    .sort().reverse();
  if (!backups.length) fail(`No 'backup_antigravity_rules_*' directory found in '${P.gemini}'. Cannot safely determine pre-install state.`);
  const latest = path.join(P.gemini, backups[0]);
  let mode = 'full';
  try { mode = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8')).mode || 'full'; } catch { /* keep full */ }
  if (mode !== 'hook-only') {
    fail(`Latest backup '${latest}' is a '${mode}' install (made by install.ps1). Use uninstall.ps1 on Windows for it.`);
  }

  const toRestore = [];
  const toDelete = [];
  for (const rel of managedRelPaths()) {
    const backupItem = path.join(latest, rel);
    const liveItem = path.join(P.gemini, rel);
    if (fs.existsSync(backupItem)) toRestore.push({ backupItem, liveItem });
    else if (fs.existsSync(liveItem)) toDelete.push(liveItem);
  }

  console.log('======================================================================');
  console.log('Antigravity Agent Rules Uninstaller (macOS / Linux, hook layer only)');
  console.log('  Target Home   : ' + opts.home);
  console.log('  Latest Backup : ' + latest);
  console.log('======================================================================');
  console.log('');
  console.log('Planned actions:');
  for (const r of toRestore) console.log('  [RESTORE from backup] ' + r.liveItem);
  for (const d of toDelete) console.log('  [DELETE (new item)]   ' + d);
  if (!toRestore.length && !toDelete.length) console.log('  (nothing to do)');
  console.log('');
  if (!(await confirm('Proceed with uninstall?', opts.force))) {
    console.log('Aborted by user. No files were modified.');
    return 0;
  }
  for (const r of toRestore) {
    fs.mkdirSync(path.dirname(r.liveItem), { recursive: true });
    fs.copyFileSync(r.backupItem, r.liveItem);
  }
  for (const d of toDelete) fs.rmSync(d, { force: true });
  console.log(`Restored ${toRestore.length} item(s), deleted ${toDelete.length} item(s).`);
  console.log('Start a new conversation (or restart Antigravity) for the change to take effect.');
  return 0;
}

const opts = parseArgs(process.argv.slice(2));
process.exitCode = await (opts.action === 'install' ? install(opts) : uninstall(opts));
