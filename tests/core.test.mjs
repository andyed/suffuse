import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  compileLightScore,
  devicesFromDocument,
  mergeDeviceCapabilities,
  redactPlan,
  segmentArrayLimits,
  segmentIndices,
  selectDevice,
  validateLightScore
} from '../scripts/core.mjs';

const execFileAsync = promisify(execFile);
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('validates the authored 3-5 band contract', () => {
  assert.throws(() => validateLightScore({
    version: 1,
    name: 'Too small',
    target: { sku: 'H0001' },
    look: { kind: 'gradient', bands: [{ color: '#000000' }, { color: '#ffffff' }] }
  }), /3 through 5 bands/);
});

test('compiles every advertised segment into ordered gradient bands', async () => {
  const devices = devicesFromDocument(await fixture('segmented-device.json'));
  const score = await fixture('dusk-gradient.score.json');
  const plan = compileLightScore(score, selectDevice(devices, score.target));
  assert.equal(plan.executionMode, 'gradient');
  const bands = plan.operations.filter(operation => operation.label.startsWith('gradient-band'));
  assert.equal(bands.length, 4);
  assert.deepEqual(
    bands.flatMap(operation => operation.payload.capability.value.segment),
    Array.from({ length: 12 }, (_, index) => index)
  );
  assert.deepEqual(bands.map(operation => operation.payload.capability.value.segment.length), [3, 3, 3, 3]);
  const toggleIndex = plan.operations.findIndex(operation => operation.label === 'gradient:on');
  const firstBandIndex = plan.operations.findIndex(operation => operation.label.startsWith('gradient-band'));
  assert.ok(toggleIndex >= 0 && toggleIndex < firstBandIndex);
  assert.equal(plan.operations[toggleIndex].payload.capability.value, 1);
});

test('splits authored bands to honor the advertised per-command segment maximum', async () => {
  const devices = devicesFromDocument(await fixture('segmented-device.json'));
  const score = await fixture('dusk-gradient.score.json');
  const segment = devices[0].capabilities.find(item => item.instance === 'segmentedColorRgb');
  segment.parameters.fields[0] = {
    fieldName: 'segment',
    dataType: 'Array',
    size: { min: 1, max: 3 },
    elementRange: { min: 0, max: 14 }
  };
  assert.deepEqual(segmentArrayLimits(segment), { min: 1, max: 3 });

  const plan = compileLightScore(score, devices[0]);
  const bands = plan.operations.filter(operation => operation.label.startsWith('gradient-band'));
  assert.equal(bands.length, 7);
  assert.ok(bands.every(operation => operation.payload.capability.value.segment.length <= 3));
  assert.deepEqual(
    bands.flatMap(operation => operation.payload.capability.value.segment),
    Array.from({ length: 15 }, (_, index) => index)
  );
});

test('uses an explicitly declared solid fallback without calling it a gradient', async () => {
  const devices = devicesFromDocument(await fixture('solid-device.json'));
  const score = await fixture('dusk-gradient.score.json');
  score.target = { sku: 'H0002', name: 'Fixture Lamp' };
  const plan = compileLightScore(score, selectDevice(devices, score.target));
  assert.equal(plan.executionMode, 'solid-fallback');
  assert.match(plan.warnings[0], /not advertised/);
  assert.equal(plan.operations.at(-1).payload.capability.instance, 'colorRgb');
});

test('merges a dedicated dynamic-scene catalog before compiling an exact scene name', async () => {
  const devices = devicesFromDocument(await fixture('segmented-device.json'));
  const scenes = await fixture('dynamic-scenes.json');
  const score = await fixture('sunset-glow.score.json');
  const device = mergeDeviceCapabilities(devices[0], [scenes]);
  const plan = compileLightScore(score, device);
  assert.equal(plan.executionMode, 'scene');
  const scene = plan.operations.find(operation => operation.label === 'scene:Sunset Glow');
  assert.deepEqual(scene.payload.capability.value, { paramId: 4282, id: 3855 });
});

test('can resolve a named scene for a gradient fallback catalog', async () => {
  const devices = devicesFromDocument(await fixture('solid-device.json'));
  const scenes = await fixture('dynamic-scenes.json');
  const score = await fixture('dusk-gradient.score.json');
  score.target = { sku: 'H0002', name: 'Fixture Lamp' };
  score.look.fallbackScene = 'Sunset Glow';
  const device = mergeDeviceCapabilities(devices[0], [scenes]);
  const plan = compileLightScore(score, device);
  assert.equal(plan.executionMode, 'scene-fallback');
  assert.equal(plan.operations.at(-1).label, 'scene:Sunset Glow');
});

test('fails when segmentedColorRgb lacks a safe index domain and no fallback exists', async () => {
  const devices = devicesFromDocument(await fixture('segmented-device.json'));
  const score = await fixture('dusk-gradient.score.json');
  score.fallback = [];
  const segment = devices[0].capabilities.find(item => item.instance === 'segmentedColorRgb');
  segment.parameters.fields[0] = { fieldName: 'segment', dataType: 'Array' };
  assert.deepEqual(segmentIndices(segment), { indices: [], source: 'missing' });
  assert.throws(() => compileLightScore(score, devices[0]), /without a safe segment domain/);
});

test('fails on ambiguous target selection', async () => {
  const devices = devicesFromDocument(await fixture('solid-device.json'));
  devices.push({ ...devices[0], device: 'another-id', deviceName: 'Another Fixture Lamp' });
  assert.throws(() => selectDevice(devices, { sku: 'H0002' }), /More than one device/);
});

test('redacts household identifiers from a plan', async () => {
  const devices = devicesFromDocument(await fixture('segmented-device.json'));
  const score = await fixture('dusk-gradient.score.json');
  const redacted = JSON.stringify(redactPlan(compileLightScore(score, devices[0])));
  assert.doesNotMatch(redacted, /AA:BB|Fixture Downlights/);
});

test('fixture inspection is read-only and redacted by default', async () => {
  const root = new URL('..', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/govee.mjs',
    'inspect',
    '--fixture',
    'tests/fixtures/segmented-device.json',
    '--sku',
    'H0001'
  ], { cwd: root });
  const output = JSON.parse(stdout);
  assert.equal(output.readOnly, true);
  assert.equal(output.source, 'fixture');
  assert.equal(output.devices[0].segmentedColor.count, 12);
  assert.doesNotMatch(stdout, /AA:BB|Fixture Downlights/);
});

test('compiles a named bundled palette and records its provenance', async () => {
  const root = new URL('..', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/govee.mjs',
    'compile',
    '--score',
    'tests/fixtures/dusk-palette.score.json',
    '--capabilities',
    'tests/fixtures/segmented-device.json'
  ], { cwd: root });
  const output = JSON.parse(stdout);
  assert.equal(output.paletteName, 'dusk');
  assert.equal(output.executionMode, 'gradient');
  assert.equal(output.operations.filter(operation => operation.label.startsWith('gradient-band')).length, 4);
});

test('apply refuses fixture data even when a write flag is supplied', async () => {
  const root = new URL('..', import.meta.url);
  await assert.rejects(execFileAsync(process.execPath, [
    'scripts/govee.mjs',
    'apply',
    '--fixture',
    'tests/fixtures/segmented-device.json',
    '--confirm-write'
  ], { cwd: root }), error => {
    assert.match(error.stderr, /fixture-write-blocked/);
    return true;
  });
});
