import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createMcpServer, MCP_TOOL_METADATA, requireWriteGate } from '../mcp/server.mjs';
import {
  loadPaletteCatalog,
  materializePaletteScore,
  summarizePalettes
} from '../scripts/palettes.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('..', import.meta.url);

test('resolves a named palette into a valid 3-5-band score', async () => {
  const score = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/dusk-palette.score.json', import.meta.url), 'utf8'));
  const catalog = await loadPaletteCatalog();
  const resolved = materializePaletteScore(score, catalog);
  assert.equal(resolved.look.palette, 'dusk');
  assert.equal(resolved.look.bands.length, 4);
  assert.equal(summarizePalettes(catalog).length, 3);
});

test('palette CLI is local, read-only, and lists colors', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/govee.mjs', 'palettes'], { cwd: root });
  const output = JSON.parse(stdout);
  assert.equal(output.readOnly, true);
  assert.equal(output.source, 'bundled');
  assert.ok(output.palettes.some(palette => palette.name === 'dusk' && palette.colors.length === 4));
});

test('managed installer deduplicates shared Codex and OpenClaw paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ai-govee-lights-home-'));
  try {
    const common = ['--target', 'all', '--scope', 'user', '--home', home];
    const planned = JSON.parse((await execFileAsync(process.execPath, ['scripts/manage.mjs', 'plan', ...common], { cwd: root })).stdout);
    assert.equal(planned.plans.length, 2);
    assert.deepEqual(planned.plans.find(plan => plan.destination.includes('.agents')).consumers, ['codex', 'openclaw']);

    const installed = JSON.parse((await execFileAsync(process.execPath, ['scripts/manage.mjs', 'install', ...common], { cwd: root })).stdout);
    for (const plan of installed.plans) {
      assert.equal((await lstat(plan.destination)).isSymbolicLink(), true);
      assert.equal(resolve(join(plan.destination, '..'), await readlink(plan.destination)), installed.source);
    }

    const removed = JSON.parse((await execFileAsync(process.execPath, ['scripts/manage.mjs', 'uninstall', ...common], { cwd: root })).stdout);
    assert.ok(removed.plans.every(plan => plan.state === 'removed'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('MCP surface registers focused tools and keeps writes disabled by default', async () => {
  const server = await createMcpServer();
  assert.ok(server);
  assert.deepEqual(MCP_TOOL_METADATA.map(tool => tool.name), [
    'govee_list_palettes',
    'govee_validate_score',
    'govee_inspect_devices',
    'govee_list_scenes',
    'govee_compile_score',
    'govee_apply_score',
    'govee_restore'
  ]);
  const prior = process.env.GOVEE_MCP_ALLOW_WRITES;
  delete process.env.GOVEE_MCP_ALLOW_WRITES;
  assert.throws(() => requireWriteGate(true), /writes are disabled/);
  if (prior === undefined) delete process.env.GOVEE_MCP_ALLOW_WRITES;
  else process.env.GOVEE_MCP_ALLOW_WRITES = prior;
});
