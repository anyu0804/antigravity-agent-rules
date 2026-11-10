#!/usr/bin/env node
// ============================================================================
// Antigravity Agent Rules - One-Click Installer for macOS / Linux
// ----------------------------------------------------------------------------
// Unix counterpart of `install.ps1` / `uninstall.ps1`. Called by the repo-root
// `install.sh` / `uninstall.sh` wrappers.
//
// Deploys the 5-layer governance rules, hooks, skills, subagents, and tone
// plugins into ~/.gemini (or only the hook layer when --hook-only is passed).
//
// Usage:
//   node hooks/unix/hooks-installer.mjs install   [--force] [--hook-only] [--skip-hook-verify] [--workspace-path DIR] [--target-home DIR]
//   node hooks/unix/hooks-installer.mjs uninstall [--force] [--target-home DIR]
//
// Key safety guarantees:
//   1. Pre-validates existing ~/.gemini/config/config.json and hooks.json
//      BEFORE modifying any files; aborts immediately on parse failure.
//   2. Lists all existing files/directories that will be merged or overwritten
//      and prompts for 'y' confirmation (default: No). Use --force to skip.
//   3. Backs up pre-existing targets into
//      ~/.gemini/backup_antigravity_rules_<timestamp>/ with manifest.json
//      (mode = 'full' | 'hook-only').
//   4. Merges GEMINI.md using <!-- antigravity-agent-rules:begin/end -->
//      markers and merges hooks.json by top-level keys (hard-gate,
//      read-loop-efficiency, read-loop-enforcement), rewriting commands to use
//      the absolute Node path so GUI-launched Antigravity finds node reliably.
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
const REPO_GEMINI = path.join(REPO_ROOT, 'global', 'GEMINI.md');
const HOOK_TOP_KEYS = ['hard-gate', 'read-loop-efficiency', 'read-loop-enforcement'];
const MANAGED_MARKER = '.antigravity-rules-managed';
const LEGACY_PLUGIN_NAME = 'anyi-global-rules';
const PLUGIN_NAMES = [
  'antigravity-core-rules',
  'search-routing',
  'docx-delivery',
  'lieflat-less-ai-tone',
  'humanizer-zh',
];
const CORE_RULE_FILES = [
  'BACKGROUND-RESOURCES.md',
  'IMPLEMENTATION.md',
  'LONG-TASKS.md',
  'RELEASE-PACKAGING.md',
  'RULE-MAINTENANCE.md',
  'WINDOWS-RELEASE.md',
];
const CORE_SKILLS = ['task-intake', 'safe-network-diagnostics', 'multi-agent-orchestrator'];
const STANDALONE_SKILLS = ['client-maintenance', 'chinese-novelist'];

function isManagedDir(dirPath) {
  if (!fs.existsSync(dirPath)) return true;
  return fs.existsSync(path.join(dirPath, MANAGED_MARKER));
}

function writeManagedMarker(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, MANAGED_MARKER),
    'Managed by antigravity-agent-rules. Do not remove this file if you want install/uninstall scripts to manage this directory.\n',
    'utf8',
  );
}

// install.sh passes the Node path it found on PATH (e.g. /opt/homebrew/bin/node). Prefer it over
// process.execPath, which under Homebrew is a versioned Cellar path that breaks on `brew upgrade`.
const NODE = process.env.HOOKS_NODE || process.execPath;

function parseArgs(argv) {
  const opts = {
    action: argv[0],
    force: false,
    hookOnly: false,
    skipVerify: false,
    workspacePath: '',
    home: os.homedir(),
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--hook-only' || a === '-HookOnly') opts.hookOnly = true;
    else if (a === '--skip-hook-verify') opts.skipVerify = true;
    else if (a === '--workspace-path' || a === '-w') opts.workspacePath = argv[++i] || '';
    else if (a === '--target-home') opts.home = argv[++i] || '';
    else fail('unknown option: ' + a);
  }
  if (!['install', 'uninstall'].includes(opts.action)) {
    fail('usage: hooks-installer.mjs install|uninstall [--force] [--hook-only] [--skip-hook-verify] [--workspace-path DIR] [--target-home DIR]');
  }
  if (!opts.home) fail('--target-home cannot be empty.');
  opts.home = path.resolve(opts.home);
  if (opts.workspacePath) opts.workspacePath = path.resolve(opts.workspacePath);
  return opts;
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function toForwardSlash(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function paths(home) {
  const gemini = path.join(home, '.gemini');
  const config = path.join(gemini, 'config');
  return {
    gemini,
    config,
    configJson: path.join(config, 'config.json'),
    hooks: path.join(config, 'hooks.json'),
    scripts: path.join(config, 'scripts'),
    plugins: path.join(config, 'plugins'),
    agySkills: path.join(gemini, 'antigravity', 'skills'),
    geminiMd: path.join(gemini, 'GEMINI.md'),
  };
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

/** Managed targets relative to ~/.gemini (POSIX separators). */
function getManagedTargets(hookOnly) {
  const scripts = fs.readdirSync(REPO_SCRIPTS)
    .filter((f) => fs.statSync(path.join(REPO_SCRIPTS, f)).isFile())
    .sort();
  const hookTargets = [
    { rel: 'config/hooks.json', mode: 'MERGE (top-level keys)', isDir: false },
    ...scripts.map((f) => ({ rel: 'config/scripts/' + f, mode: 'OVERWRITE', isDir: false })),
  ];
  if (hookOnly) return hookTargets;
  return [
    { rel: 'GEMINI.md', mode: 'MERGE (marker block)', isDir: false },
    hookTargets[0],
    { rel: 'config/config.json', mode: 'MERGE (enable 5 plugins)', isDir: false },
    ...hookTargets.slice(1),
    { rel: 'config/plugins/antigravity-core-rules', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'config/plugins/search-routing', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'config/plugins/docx-delivery', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'config/plugins/lieflat-less-ai-tone', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'config/plugins/humanizer-zh', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'antigravity/skills/client-maintenance', mode: 'OVERWRITE (managed)', isDir: true },
    { rel: 'antigravity/skills/chinese-novelist', mode: 'OVERWRITE (managed)', isDir: true },
  ];
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

/** Replace path placeholders (<YOUR_PATH>, <YOUR_PROJECT_PATH>, %USERPROFILE%\...) in Markdown files. */
function formatMarkdownContent(rawText, forwardHome, forwardWs) {
  let out = rawText.replaceAll('<YOUR_PATH>', forwardHome);
  if (forwardWs) {
    out = out.replaceAll('<YOUR_PROJECT_PATH>', forwardWs);
  }
  // Convert path-prefixed %USERPROFILE%\... or $env:USERPROFILE\... to $HOME/... on Unix
  out = out.replace(/%USERPROFILE%[\\/]/g, '$HOME/');
  out = out.replace(/\$env:USERPROFILE[\\/]/g, '$HOME/');
  return out;
}

function copyWithPlaceholderReplacement(srcFile, dstFile, forwardHome, forwardWs) {
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  if (path.extname(srcFile).toLowerCase() === '.md') {
    const raw = fs.readFileSync(srcFile, 'utf8');
    const formatted = formatMarkdownContent(raw, forwardHome, forwardWs);
    fs.writeFileSync(dstFile, formatted, 'utf8');
  } else {
    fs.copyFileSync(srcFile, dstFile);
  }
}

function copyTreeWithReplacement(srcDir, dstDir, forwardHome, forwardWs) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeWithReplacement(srcPath, dstPath, forwardHome, forwardWs);
    } else {
      copyWithPlaceholderReplacement(srcPath, dstPath, forwardHome, forwardWs);
    }
  }
}

function copyItemRecursive(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
  } else {
    fs.copyFileSync(srcPath, dstPath);
  }
}

async function install(opts) {
  const P = paths(opts.home);
  const forwardHome = toForwardSlash(opts.home);
  const forwardWs = opts.workspacePath ? toForwardSlash(opts.workspacePath) : '';

  console.log('======================================================================');
  console.log('Antigravity Agent Rules Installer (macOS / Linux)');
  console.log('  Source Repo : ' + REPO_ROOT);
  console.log('  Target Home : ' + opts.home + ' (' + forwardHome + ')');
  if (forwardWs) {
    console.log('  Workspace   : ' + opts.workspacePath + ' (' + forwardWs + ')');
  }
  console.log('  Node        : ' + NODE + ' (' + process.version + ')');
  if (opts.hookOnly) {
    console.log('  Mode        : HOOK ONLY (hooks.json + scripts/; rules/skills/tone skipped)');
  } else {
    console.log('  Mode        : FULL (5 layers: hooks + global + rules + skills/agents + tone)');
  }
  console.log('======================================================================');

  // 0. Pre-parse config.json and hooks.json before touching anything
  const existingCfg = opts.hookOnly ? null : readJsonOrNull(P.configJson, 'existing config.json');
  const existingHooks = readJsonOrNull(P.hooks, 'existing hooks.json');
  const repoHooks = readJsonOrNull(REPO_HOOKS, 'repo hooks.json');
  if (!repoHooks) fail('repo hooks/hooks.json is missing or empty.');

  const managed = getManagedTargets(opts.hookOnly);
  const existing = [];
  const skippedUnmanaged = [];
  for (const item of managed) {
    const full = path.join(P.gemini, item.rel);
    if (fs.existsSync(full)) {
      if (item.isDir && item.rel !== 'config/plugins/antigravity-core-rules' && !isManagedDir(full)) {
        skippedUnmanaged.push({ rel: item.rel, full, mode: 'SKIP (unmanaged)' });
      } else {
        existing.push(item);
      }
    }
  }
  const legacyAnyiRel = 'config/plugins/' + LEGACY_PLUGIN_NAME;
  const legacyAnyiFull = path.join(P.gemini, legacyAnyiRel);
  if (!opts.hookOnly && fs.existsSync(legacyAnyiFull)) {
    existing.push({ rel: legacyAnyiRel, mode: 'MIGRATE -> config/plugins/antigravity-core-rules', isDir: true });
  }

  console.log('');
  if (existing.length) {
    console.log(`The following existing files/directories in '${P.gemini}' will be modified:`);
    for (const item of existing) {
      console.log(`  [${item.mode}] ${path.join(P.gemini, item.rel)}`);
    }
  } else {
    console.log(`No existing target files found in '${P.gemini}' (clean install).`);
  }
  if (skippedUnmanaged.length) {
    console.log('');
    console.log(`The following existing directories do NOT have '${MANAGED_MARKER}' and will be SKIPPED (preserving user/upstream files):`);
    for (const sk of skippedUnmanaged) {
      console.log(`  [${sk.mode}] ${sk.full}`);
    }
  }
  console.log('');
  if (!(await confirm('Proceed with installation?', opts.force))) {
    console.log('Aborted by user. No files were modified.');
    return 0;
  }

  // 1. Backup existing files/directories into ~/.gemini/backup_antigravity_rules_<timestamp>
  const stamp = timestamp();
  const backupDir = path.join(P.gemini, 'backup_antigravity_rules_' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const item of existing) {
    const src = path.join(P.gemini, item.rel);
    const dst = path.join(backupDir, item.rel);
    copyItemRecursive(src, dst);
  }
  const manifest = {
    timestamp: stamp,
    targetHome: opts.home,
    workspacePath: opts.workspacePath,
    mode: opts.hookOnly ? 'hook-only' : 'full',
    platform: process.platform,
    preExisting: existing.map((x) => x.rel),
    skippedUnmanaged: skippedUnmanaged.map((x) => x.rel),
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[1/5] Created backup snapshot (${existing.length} pre-existing item(s)): ${backupDir}`);

  // 2. Deploy Layer 1: hooks/ -> merge hooks.json & copy scripts/
  fs.mkdirSync(P.scripts, { recursive: true });
  const mergedHooks = existingHooks && typeof existingHooks === 'object' && !Array.isArray(existingHooks) ? existingHooks : {};
  const rewrittenHooks = rewriteHooks(repoHooks);
  for (const key of HOOK_TOP_KEYS) {
    mergedHooks[key] = rewrittenHooks[key];
  }
  fs.writeFileSync(P.hooks, JSON.stringify(mergedHooks, null, 2) + '\n', 'utf8');
  copyTreeWithReplacement(REPO_SCRIPTS, P.scripts, forwardHome, forwardWs);
  console.log('[2/5] Merged hooks.json (top-level keys) & deployed scripts/.');

  if (opts.hookOnly) {
    console.log('[3-5/5] Skipped (--hook-only): GEMINI.md, config.json, rules/, skills/, agents/, tone/ untouched.');
  } else {
    // 3. Deploy Layer 2 & 3: merge GEMINI.md & deploy global/ + rules/
    fs.mkdirSync(P.gemini, { recursive: true });
    const beginMarker = '<!-- antigravity-agent-rules:begin -->';
    const endMarker = '<!-- antigravity-agent-rules:end -->';
    const repoGeminiRaw = fs.readFileSync(REPO_GEMINI, 'utf8');
    const repoGeminiFmt = formatMarkdownContent(repoGeminiRaw, forwardHome, forwardWs).replace(/[\r\n]+$/, '');
    const wrappedBlock = `${beginMarker}\n${repoGeminiFmt}\n${endMarker}`;

    let finalGemini;
    if (fs.existsSync(P.geminiMd)) {
      const existingGemini = fs.readFileSync(P.geminiMd, 'utf8');
      const idxBegin = existingGemini.indexOf(beginMarker);
      const idxEnd = existingGemini.indexOf(endMarker);
      if (idxBegin >= 0 && idxEnd > idxBegin) {
        const before = existingGemini.slice(0, idxBegin);
        const after = existingGemini.slice(idxEnd + endMarker.length);
        finalGemini = before + wrappedBlock + after;
      } else if (!existingGemini.trim()) {
        finalGemini = wrappedBlock + '\n';
      } else {
        finalGemini = existingGemini.replace(/[\r\n]+$/, '') + '\n\n' + wrappedBlock + '\n';
      }
    } else {
      finalGemini = wrappedBlock + '\n';
    }
    fs.writeFileSync(P.geminiMd, finalGemini, 'utf8');

    const corePluginDir = path.join(P.plugins, 'antigravity-core-rules');
    copyWithPlaceholderReplacement(
      path.join(REPO_ROOT, 'global', 'plugin.json'),
      path.join(corePluginDir, 'plugin.json'),
      forwardHome,
      forwardWs,
    );
    copyWithPlaceholderReplacement(
      path.join(REPO_ROOT, 'global', 'AGENTS.md'),
      path.join(corePluginDir, 'rules', 'AGENTS.md'),
      forwardHome,
      forwardWs,
    );
    copyWithPlaceholderReplacement(
      path.join(REPO_ROOT, 'global', 'THINKING-VISIBILITY.md'),
      path.join(corePluginDir, 'rules', 'THINKING-VISIBILITY.md'),
      forwardHome,
      forwardWs,
    );
    for (const rf of CORE_RULE_FILES) {
      copyWithPlaceholderReplacement(
        path.join(REPO_ROOT, 'rules', rf),
        path.join(corePluginDir, 'rules', rf),
        forwardHome,
        forwardWs,
      );
    }
    writeManagedMarker(corePluginDir);
    if (fs.existsSync(legacyAnyiFull)) {
      fs.rmSync(legacyAnyiFull, { recursive: true, force: true });
      console.log(`  [MIGRATED] Removed legacy plugin directory '${legacyAnyiFull}' -> '${corePluginDir}'`);
    }

    const searchPluginDir = path.join(P.plugins, 'search-routing');
    const searchPluginManaged = isManagedDir(searchPluginDir);
    if (searchPluginManaged) {
      copyWithPlaceholderReplacement(
        path.join(REPO_ROOT, 'rules', 'search-routing.plugin.json'),
        path.join(searchPluginDir, 'plugin.json'),
        forwardHome,
        forwardWs,
      );
      copyWithPlaceholderReplacement(
        path.join(REPO_ROOT, 'rules', 'SEARCH-ROUTING.md'),
        path.join(searchPluginDir, 'rules', 'SEARCH-ROUTING.md'),
        forwardHome,
        forwardWs,
      );
      writeManagedMarker(searchPluginDir);
    } else {
      console.log('  [SKIP (unmanaged)] ' + searchPluginDir);
    }
    console.log('[3/5] Merged GEMINI.md & deployed Layer 2 (global/) + Layer 3 (rules/).');

    // 4. Deploy Layer 4 & 5: skills/, agents/, and tone/
    for (const sk of CORE_SKILLS) {
      copyTreeWithReplacement(
        path.join(REPO_ROOT, 'skills', sk),
        path.join(corePluginDir, 'skills', sk),
        forwardHome,
        forwardWs,
      );
    }
    copyWithPlaceholderReplacement(
      path.join(REPO_ROOT, 'agents', 'flash-verifier.md'),
      path.join(corePluginDir, 'agents', 'flash-verifier.md'),
      forwardHome,
      forwardWs,
    );
    if (searchPluginManaged) {
      copyTreeWithReplacement(
        path.join(REPO_ROOT, 'skills', 'research-routing'),
        path.join(searchPluginDir, 'skills', 'research-routing'),
        forwardHome,
        forwardWs,
      );
    }

    const optionalPlugins = [
      { name: 'docx-delivery', src: path.join(REPO_ROOT, 'skills', 'docx-delivery') },
      { name: 'lieflat-less-ai-tone', src: path.join(REPO_ROOT, 'tone', 'lieflat-less-ai-tone') },
      { name: 'humanizer-zh', src: path.join(REPO_ROOT, 'tone', 'humanizer-zh') },
    ];
    for (const op of optionalPlugins) {
      const opDst = path.join(P.plugins, op.name);
      if (isManagedDir(opDst)) {
        copyTreeWithReplacement(op.src, opDst, forwardHome, forwardWs);
        writeManagedMarker(opDst);
      } else {
        console.log('  [SKIP (unmanaged)] ' + opDst);
      }
    }

    for (const ssk of STANDALONE_SKILLS) {
      const sskDst = path.join(P.agySkills, ssk);
      if (isManagedDir(sskDst)) {
        copyTreeWithReplacement(
          path.join(REPO_ROOT, 'skills', ssk),
          sskDst,
          forwardHome,
          forwardWs,
        );
        writeManagedMarker(sskDst);
      } else {
        console.log('  [SKIP (unmanaged)] ' + sskDst);
      }
      if (opts.workspacePath) {
        const wsSkillDir = path.join(opts.workspacePath, '.agents', 'skills', ssk);
        if (isManagedDir(wsSkillDir)) {
          copyTreeWithReplacement(
            path.join(REPO_ROOT, 'skills', ssk),
            wsSkillDir,
            forwardHome,
            forwardWs,
          );
          writeManagedMarker(wsSkillDir);
        } else {
          console.log('  [SKIP (unmanaged)] ' + wsSkillDir);
        }
      }
    }
    console.log('[4/5] Deployed Layer 4 (skills/ & agents/) & Layer 5 (tone/).');

    // 5. Enable 5 plugins in ~/.gemini/config/config.json (migrate legacy key)
    const cfgObj = existingCfg && typeof existingCfg === 'object' && !Array.isArray(existingCfg) ? existingCfg : {};
    if (!cfgObj.plugins || typeof cfgObj.plugins !== 'object' || Array.isArray(cfgObj.plugins)) {
      cfgObj.plugins = {};
    }
    delete cfgObj.plugins[LEGACY_PLUGIN_NAME];
    for (const pName of PLUGIN_NAMES) {
      if (!cfgObj.plugins[pName] || typeof cfgObj.plugins[pName] !== 'object') {
        cfgObj.plugins[pName] = { enabled: true };
      } else {
        cfgObj.plugins[pName].enabled = true;
      }
    }
    fs.writeFileSync(P.configJson, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');
    console.log(`[5/5] Enabled 5 plugins in: ${P.configJson}`);
  }

  // 6. Optional: Run verify-hook.py self-test
  if (opts.skipVerify) {
    console.log('Skipped hook self-test (--skip-hook-verify).');
  } else {
    const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
    if (!py) {
      console.log('WARNING: python3 not found, hook self-test skipped. Run it later with:');
      console.log(`  python3 "${path.join(P.scripts, 'verify-hook.py')}" --guard node`);
    } else {
      console.log('');
      console.log(`Running PreToolUse hook self-test (${py} verify-hook.py --guard node)...`);
      const r = spawnSync(py, [path.join(P.scripts, 'verify-hook.py'), '--guard', 'node'], {
        cwd: P.scripts,
        stdio: 'inherit',
        env: Object.assign({}, process.env, { NODE }),
      });
      if (r.status !== 0) {
        console.error('Hook self-test FAILED. Restore the previous state with ./uninstall.sh.');
        return 1;
      }
      const tmpLog = path.join(P.scripts, 'hook_log.jsonl');
      if (fs.existsSync(tmpLog)) {
        fs.rmSync(tmpLog, { force: true });
      }
    }
  }

  console.log('');
  if (opts.hookOnly) {
    console.log('SUCCESS: Antigravity Agent Rules hook layer installed (hook-only mode).');
  } else {
    console.log('SUCCESS: Antigravity Agent Rules installed and verified.');
  }
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
    .sort()
    .reverse();
  if (!backups.length) {
    fail(`No 'backup_antigravity_rules_*' directory found in '${P.gemini}'. Cannot safely determine pre-install state.`);
  }
  const latest = path.join(P.gemini, backups[0]);
  let mode = 'full';
  try {
    mode = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8')).mode || 'full';
  } catch {
    /* default to full */
  }

  const hookOnly = mode === 'hook-only';
  const cfgObj = hookOnly ? null : readJsonOrNull(P.configJson, 'existing config.json');

  // Managed targets (excluding config/config.json, which is handled via key removal)
  const managedTargets = getManagedTargets(hookOnly)
    .filter((x) => x.rel !== 'config/config.json');
  if (!hookOnly) {
    managedTargets.push({ rel: 'config/plugins/' + LEGACY_PLUGIN_NAME, isDir: true });
  }

  const toRestore = [];
  const toDelete = [];
  const skippedUnmanaged = [];
  for (const item of managedTargets) {
    const rel = item.rel;
    const backupItem = path.join(latest, rel);
    const liveItem = path.join(P.gemini, rel);
    if (rel === 'config/plugins/' + LEGACY_PLUGIN_NAME) {
      if (fs.existsSync(liveItem)) {
        toDelete.push({ rel, liveItem });
      }
      continue;
    }
    if (fs.existsSync(backupItem)) {
      toRestore.push({ rel, backupItem, liveItem });
    } else if (fs.existsSync(liveItem)) {
      if (item.isDir && rel !== 'config/plugins/antigravity-core-rules' && !isManagedDir(liveItem)) {
        skippedUnmanaged.push({ rel, liveItem });
      } else {
        toDelete.push({ rel, liveItem });
      }
    }
  }

  console.log('======================================================================');
  console.log('Antigravity Agent Rules Uninstaller (macOS / Linux)');
  console.log('  Target Home   : ' + opts.home);
  console.log('  Latest Backup : ' + latest + ` (mode: ${mode})`);
  console.log('======================================================================');
  console.log('');
  console.log('Planned actions:');
  for (const r of toRestore) console.log('  [RESTORE from backup] ' + r.liveItem);
  for (const d of toDelete) console.log('  [DELETE (managed)]    ' + d.liveItem);
  for (const s of skippedUnmanaged) console.log(`  [SKIP (unmanaged)]    ${s.liveItem} (no ${MANAGED_MARKER} marker)`);
  if (!hookOnly && fs.existsSync(P.configJson)) {
    console.log('  [CLEANUP plugins]     ' + P.configJson);
  }
  if (!toRestore.length && !toDelete.length && (hookOnly || !fs.existsSync(P.configJson))) {
    console.log('  (nothing to do)');
  }
  console.log('');
  if (!(await confirm('Proceed with uninstall?', opts.force))) {
    console.log('Aborted by user. No files were modified.');
    return 0;
  }

  // 1. Restore pre-existing items from latest backup
  for (const r of toRestore) {
    if (fs.existsSync(r.liveItem)) {
      fs.rmSync(r.liveItem, { recursive: true, force: true });
    }
    copyItemRecursive(r.backupItem, r.liveItem);
  }

  // 2. Delete items that did not exist prior to installation
  for (const d of toDelete) {
    if (fs.existsSync(d.liveItem)) {
      fs.rmSync(d.liveItem, { recursive: true, force: true });
    }
  }

  // 3. Remove only the plugin entries owned by this repo from config.json
  if (!hookOnly && cfgObj && cfgObj.plugins && typeof cfgObj.plugins === 'object') {
    delete cfgObj.plugins[LEGACY_PLUGIN_NAME];
    for (const pName of PLUGIN_NAMES) {
      delete cfgObj.plugins[pName];
    }
    fs.writeFileSync(P.configJson, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');
  }

  console.log('');
  console.log(`SUCCESS: Uninstalled Antigravity Agent Rules and restored pre-install state from '${latest}'.`);
  return 0;
}

const opts = parseArgs(process.argv.slice(2));
process.exitCode = await (opts.action === 'install' ? install(opts) : uninstall(opts));
