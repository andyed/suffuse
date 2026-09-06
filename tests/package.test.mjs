import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createMcpServer, MCP_TOOL_METADATA, requireWriteGate } from '../mcp/server.mjs';
import {
  compilePaletteRecipe,
  diagnosePaletteBands,
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
  assert.equal(summarizePalettes(catalog).length, 4);
});

test('compiles a deterministic perceptual dusk recipe with advisory diagnostics', () => {
  const resolved = compilePaletteRecipe({
    topology: 'sequential',
    space: 'oklch',
    anchors: ['#24134F', '#F2A65A'],
    huePath: 'shorter',
    bands: 4,
    lightnessCurve: 'rising',
    chromaCurve: 'free'
  });
  assert.deepEqual(resolved.bands.map(band => band.color), [
    '#24134F', '#733568', '#C06265', '#F2A65A'
  ]);
  assert.deepEqual(resolved.diagnostics.gamutMappedBands, []);
  assert.deepEqual(resolved.diagnostics.warnings, []);
});

test('warns when adjacent authored bands are perceptually similar', () => {
  const diagnostics = diagnosePaletteBands([
    { color: '#222222' },
    { color: '#232323' },
    { color: '#FFFFFF' }
  ]);
  assert.ok(diagnostics.warnings.some(warning => warning.code === 'adjacent-similarity'));
});

test('palette CLI is local, read-only, and lists colors', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/govee.mjs', 'palettes'], { cwd: root });
  const output = JSON.parse(stdout);
  assert.equal(output.readOnly, true);
  assert.equal(output.source, 'bundled');
  assert.ok(output.palettes.some(palette => palette.name === 'dusk' && palette.colors.length === 4));
  assert.ok(output.palettes.some(palette => (
    palette.name === 'dusk-perceptual'
    && palette.source === 'recipe'
    && palette.colors.join(',') === '#24134F,#733568,#C06265,#F2A65A'
  )));
});

test('package and skill expose the Suffuse identity', async () => {
  const packageDocument = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const skill = await (await import('node:fs/promises')).readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const readme = await (await import('node:fs/promises')).readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(packageDocument.name, 'suffuse');
  assert.equal(packageDocument.version, '0.6.0');
  assert.match(packageDocument.description, /MCP server and Agent Skill/);
  assert.equal(packageDocument.repository.url, 'git+https://github.com/andyed/suffuse.git');
  assert.match(skill, /^---\nname: suffuse\n/);
  assert.doesNotMatch(skill.split('---')[1], /\n(?:license|metadata):/);
  assert.match(readme, /<h1 align="center">Suffuse<\/h1>/);
  assert.match(readme, /assets\/brand\/suffuse-mark\.svg/);
  assert.match(readme, /An MCP server and Agent Skill for safe Govee control/);
  assert.ok(readme.indexOf('## MCP \+ Agent Skill') < readme.indexOf('## Optional palette authoring'));
  assert.match(readme, /What the Govee API key unlocks/);
  assert.match(readme, /key authenticates Govee cloud access; it does \*\*not\*\* enable physical writes/);
  assert.match(readme, /https:\/\/psychodeli\.com/);
  assert.match(readme, /https:\/\/apps\.apple\.com\/us\/app\/psychodeli\/id6782244331/);
  assert.match(readme, /Android \| Closed test:/);
  assert.match(readme, /https:\/\/groups\.google\.com\/g\/psychodeli-testers/);
  assert.match(readme, /https:\/\/play\.google\.com\/apps\/testing\/com\.psychodeli\.android/);
  assert.match(readme, /Desktop apps \| Closed beta/);
});

test('ships an exact 1200x630 Open Graph card', async () => {
  const png = await readFile(new URL('../assets/brand/suffuse-og-1200x630.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('managed installer deduplicates shared Codex and OpenClaw paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suffuse-home-'));
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
    'govee_inspect_household',
    'govee_list_scenes',
    'govee_compile_score',
    'govee_apply_score',
    'govee_restore',
    'govee_lan_scan',
    'govee_lan_paint',
    'govee_lan_release',
    'govee_ble_scan',
    'govee_ble_set'
  ]);
  const prior = process.env.GOVEE_MCP_ALLOW_WRITES;
  delete process.env.GOVEE_MCP_ALLOW_WRITES;
  assert.throws(() => requireWriteGate(true), /writes are disabled/);
  if (prior === undefined) delete process.env.GOVEE_MCP_ALLOW_WRITES;
  else process.env.GOVEE_MCP_ALLOW_WRITES = prior;
});
