#!/usr/bin/env node

import { access, lstat, mkdir, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoveeSkillError } from './core.mjs';
import { loadPaletteCatalog } from './palettes.mjs';

const SKILL_NAME = 'suffuse';
const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGETS = new Set(['codex', 'claude', 'openclaw', 'all']);
const SCOPES = new Set(['user', 'project']);

function usage() {
  return `Usage:
  manage.mjs doctor [--source PATH]
  manage.mjs plan|status|install|uninstall [--target codex|claude|openclaw|all]
              [--scope user|project] [--home PATH] [--project PATH] [--source PATH]
  manage.mjs mcp-config [--source PATH]

Install creates managed symbolic links and never overwrites existing paths.`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new GoveeSkillError(`Missing value for --${key}`, 'invalid-arguments');
    args[key] = value;
    index += 1;
  }
  return args;
}

function targetPlans(args) {
  const target = args.target ?? 'all';
  const scope = args.scope ?? 'user';
  if (!TARGETS.has(target)) throw new GoveeSkillError(`Unknown target: ${target}`, 'invalid-target');
  if (!SCOPES.has(scope)) throw new GoveeSkillError(`Unknown scope: ${scope}`, 'invalid-scope');

  const consumers = target === 'all' ? ['codex', 'claude', 'openclaw'] : [target];
  const home = resolve(args.home ?? homedir());
  const project = resolve(args.project ?? process.cwd());
  const grouped = new Map();

  for (const consumer of consumers) {
    const root = scope === 'user'
      ? consumer === 'claude' ? join(home, '.claude', 'skills') : join(home, '.agents', 'skills')
      : consumer === 'claude' ? join(project, '.claude', 'skills') : join(project, '.agents', 'skills');
    const destination = join(root, SKILL_NAME);
    const current = grouped.get(destination) ?? { destination, consumers: [] };
    current.consumers.push(consumer);
    grouped.set(destination, current);
  }

  return [...grouped.values()];
}

async function linkState(destination, source) {
  try {
    const stat = await lstat(destination);
    if (!stat.isSymbolicLink()) return { state: 'conflict', detail: 'existing path is not a symbolic link' };
    const raw = await readlink(destination);
    const linked = resolve(dirname(destination), raw);
    return linked === source
      ? { state: 'installed', detail: source }
      : { state: 'conflict', detail: `symbolic link points to ${linked}` };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', detail: null };
    throw error;
  }
}

async function validateSource(path) {
  const source = await realpath(resolve(path));
  await access(join(source, 'SKILL.md'));
  return source;
}

async function inspectPlans(args) {
  const source = await validateSource(args.source ?? SOURCE_ROOT);
  const plans = [];
  for (const plan of targetPlans(args)) {
    plans.push({ ...plan, ...(await linkState(plan.destination, source)) });
  }
  return { source, scope: args.scope ?? 'user', plans };
}

async function install(args) {
  const report = await inspectPlans(args);
  for (const plan of report.plans) {
    if (plan.state === 'installed') continue;
    if (plan.state === 'conflict') {
      throw new GoveeSkillError(`Refusing to overwrite ${plan.destination}: ${plan.detail}`, 'install-conflict');
    }
    await mkdir(dirname(plan.destination), { recursive: true });
    await symlink(report.source, plan.destination, 'dir');
    plan.state = 'installed';
    plan.detail = report.source;
  }
  return report;
}

async function uninstall(args) {
  const report = await inspectPlans(args);
  for (const plan of report.plans) {
    if (plan.state === 'missing') continue;
    if (plan.state !== 'installed') {
      throw new GoveeSkillError(`Refusing to remove ${plan.destination}: ${plan.detail}`, 'uninstall-conflict');
    }
    await unlink(plan.destination);
    plan.state = 'removed';
    plan.detail = null;
  }
  return report;
}

async function doctor(args) {
  const source = await validateSource(args.source ?? SOURCE_ROOT);
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  const checks = {
    node: { ok: major >= 20, version: process.versions.node, required: '>=20' },
    skill: { ok: true, source },
    apiKey: { configured: !!String(process.env.GOVEE_API_KEY ?? '').trim(), valueExposed: false },
    mcpWrites: { enabled: process.env.GOVEE_MCP_ALLOW_WRITES === '1' },
    palettes: { ok: false },
    runtimeDependencies: { ok: false }
  };
  try {
    const catalog = await loadPaletteCatalog(join(source, 'assets', 'palettes.json'));
    checks.palettes = { ok: true, count: catalog.palettes.length };
  } catch (error) {
    checks.palettes = { ok: false, error: error.message };
  }
  try {
    await Promise.all([
      access(join(source, 'node_modules', '@modelcontextprotocol', 'server', 'package.json')),
      access(join(source, 'node_modules', 'culori', 'package.json'))
    ]);
    checks.runtimeDependencies = { ok: true, packages: ['@modelcontextprotocol/server', 'culori'] };
  } catch {
    checks.runtimeDependencies = { ok: false, action: 'Run npm install in the skill repository.' };
  }
  checks.ok = checks.node.ok && checks.skill.ok && checks.palettes.ok && checks.runtimeDependencies.ok;
  return checks;
}

async function mcpConfig(args) {
  const source = await validateSource(args.source ?? SOURCE_ROOT);
  const server = join(source, 'mcp', 'server.mjs');
  return {
    source,
    readOnlyDefault: true,
    codexToml: [
      '[mcp_servers.suffuse]',
      'command = "node"',
      `args = [${JSON.stringify(server)}]`,
      'env_vars = ["GOVEE_API_KEY", "GOVEE_MCP_ALLOW_WRITES"]',
      'default_tools_approval_mode = "writes"'
    ].join('\n'),
    claude: 'The bundled .mcp.json starts this server when the repository is loaded as a Claude skills-directory plugin.',
    openclaw: 'Use the shared skill and deterministic CLI; MCP client wiring is intentionally not assumed.'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || ['help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let output;
  if (command === 'doctor') output = await doctor(args);
  else if (command === 'plan' || command === 'status') output = await inspectPlans(args);
  else if (command === 'install') output = await install(args);
  else if (command === 'uninstall') output = await uninstall(args);
  else if (command === 'mcp-config') output = await mcpConfig(args);
  else throw new GoveeSkillError(`Unknown command: ${command}`, 'invalid-command');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
  const code = error instanceof GoveeSkillError ? error.code : 'unexpected-error';
  process.stderr.write(`suffuse-manage [${code}]: ${error.message}\n`);
  process.exitCode = 1;
});
