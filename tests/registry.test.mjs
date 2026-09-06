import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDoctorReport,
  buildHouseholdRegistry,
  normalizeDeviceIdentity,
  summarizeHouseholdRegistry
} from '../scripts/registry.mjs';

const observedAt = '2026-08-22T20:00:00.000Z';

test('registry merges cloud and LAN only on an exact normalized device id', () => {
  const registry = buildHouseholdRegistry({
    observedAt,
    cloudDevices: [{
      device: 'AA:BB:CC:11:22:33',
      deviceName: 'Reading Lamp',
      sku: 'H608B',
      type: 'devices.types.light',
      capabilities: [{ instance: 'colorRgb' }]
    }],
    lanDevices: [{ device: 'aabbcc112233', sku: 'H608B', ip: '192.168.1.34' }]
  });
  assert.equal(registry.devices.length, 1);
  assert.deepEqual(registry.devices[0].transports, ['cloud', 'lan']);
  assert.equal(registry.devices[0].identityConfidence, 'exact-device-id');
  assert.deepEqual(registry.devices[0].observations.map(item => item.reachability), ['unknown', 'observed']);
  assert.ok(registry.devices[0].observations.every(item => item.observedAt === observedAt));
});

test('registry refuses suffix-based identity guesses', () => {
  const registry = buildHouseholdRegistry({
    observedAt,
    cloudDevices: [{ device: 'AA:BB:CC:11:22:33', deviceName: 'Cloud Lamp', sku: 'H608B' }],
    lanDevices: [{ device: 'FF:EE:DD:11:22:33', sku: 'H608B', ip: '192.168.1.35' }]
  });
  assert.equal(registry.devices.length, 2);
  assert.ok(registry.devices.every(device => device.identityConfidence === 'single-source'));
});

test('registry refuses ambiguous duplicate identities even when the id is exact', () => {
  const registry = buildHouseholdRegistry({
    observedAt,
    cloudDevices: [
      { device: 'AA:BB:CC:11:22:33', deviceName: 'Lamp One', sku: 'H608B' },
      { device: 'AA:BB:CC:11:22:33', deviceName: 'Lamp Two', sku: 'H608B' }
    ],
    lanDevices: [{ device: 'AA:BB:CC:11:22:33', sku: 'H608B', ip: '192.168.1.35' }]
  });
  assert.equal(registry.devices.length, 3);
  assert.ok(registry.devices.every(device => device.identityConfidence === 'single-source'));
});

test('registry records source conflicts without discarding either observation', () => {
  const registry = buildHouseholdRegistry({
    observedAt,
    cloudDevices: [{ device: 'AA:BB:CC:11:22:33', deviceName: 'Lamp', sku: 'H608B' }],
    lanDevices: [{ device: 'AA-BB-CC-11-22-33', sku: 'H6047', ip: '192.168.1.35' }]
  });
  assert.equal(registry.devices[0].conflicts[0].field, 'sku');
  assert.equal(registry.devices[0].observations.length, 2);
});

test('registry summaries redact household identifiers by default', () => {
  const registry = buildHouseholdRegistry({
    observedAt,
    cloudDevices: [{ device: 'AA:BB:CC:11:22:33', deviceName: 'Reading Lamp', sku: 'H608B' }],
    lanDevices: [{ device: 'AA:BB:CC:11:22:33', sku: 'H608B', ip: '192.168.1.34' }],
    sources: { cloud: { status: 'ok', deviceCount: 1 }, lan: { status: 'ok', deviceCount: 1 } }
  });
  const summary = summarizeHouseholdRegistry(registry);
  assert.equal(summary.devices[0].name, '[redacted]');
  assert.ok(summary.devices[0].observations.every(item => !('deviceId' in item) && !('address' in item)));
  assert.equal(summary.mergedDeviceCount, 1);

  const privateSummary = summarizeHouseholdRegistry(registry, { showIdentifiers: true });
  assert.equal(privateSummary.devices[0].name, 'Reading Lamp');
  assert.equal(privateSummary.devices[0].observations[1].address, '192.168.1.34');
});

test('doctor reports partial operation without laundering missing sources into failure', () => {
  const report = buildDoctorReport({
    generatedAt: observedAt,
    deviceCount: 1,
    mergedDeviceCount: 0,
    sourceStatus: {
      cloud: { status: 'not-configured', deviceCount: 0 },
      lan: { status: 'ok', deviceCount: 1 }
    }
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.checks.registry.status, 'ok');
  assert.match(report.recommendations[0], /GOVEE_API_KEY/);
});

test('normalization is exact after separator and case removal', () => {
  assert.equal(normalizeDeviceIdentity('aa:bb-cc 11.22.33'), 'AABBCC112233');
  assert.notEqual(normalizeDeviceIdentity('AA:BB:CC:11:22:33'), normalizeDeviceIdentity('FF:EE:DD:11:22:33'));
  assert.equal(normalizeDeviceIdentity('device'), '');
});
