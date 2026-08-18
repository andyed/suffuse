// BLE transport tests. Everything here runs WITHOUT the optional noble
// dependency and without hardware: the encoder tests pin exact byte vectors
// (the only error surface a write-without-response channel has), and the
// transport tests inject a fake central.
//
// The colour vector 33050dffb46e…1e is the frame logged working against a
// real H6009 (2026-08-09) — a cross-implementation expectation shared with
// the Psychodeli reference transport, same role as the OpenRGB constants in
// the razer tests: change it in one place, change it everywhere.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  BLE_FRAMES,
  BLE_POWER_ON_SETTLE_MS,
  BLE_WRITE_UUID,
  assertBleEncoderSane,
  bleFrame,
  bleResolve,
  bleScan,
  bleScanSummaries,
  bleSet,
  peripheralSummary
} from '../scripts/ble.mjs';

// ── Encoder vectors ─────────────────────────────────────────────────────────

test('frames are 20 bytes with an XOR checksum in byte 19', () => {
  const frame = bleFrame([0x33, 0x01, 0x01]);
  assert.equal(frame.length, 20);
  assert.equal(frame.toString('hex'), `330101${'00'.repeat(16)}33`);
});

test('frame rejects more than 19 payload bytes', () => {
  assert.throws(() => bleFrame(Array.from({ length: 20 }, () => 0)), /at most 19/);
});

test('power frames', () => {
  assert.equal(BLE_FRAMES.power(true).toString('hex'), `330101${'00'.repeat(16)}33`);
  assert.equal(BLE_FRAMES.power(false).toString('hex'), `330100${'00'.repeat(16)}32`);
});

test('brightness frame clamps to 0-100', () => {
  assert.equal(BLE_FRAMES.brightness(100).toString('hex'), `330464${'00'.repeat(16)}53`);
  assert.equal(BLE_FRAMES.brightness(250).toString('hex'), `330464${'00'.repeat(16)}53`);
});

test('colour uses the RGBWW 0x0D opcode — hardware-verified vector', () => {
  // Warm white 255,180,110: the exact frame logged working on a real H6009.
  assert.equal(
    BLE_FRAMES.color(255, 180, 110).toString('hex'),
    `33050dffb46e${'00'.repeat(13)}1e`
  );
});

test('keep-alive vector', () => {
  assert.equal(BLE_FRAMES.keepAlive().toString('hex'), `aa01${'00'.repeat(17)}ab`);
});

test('encoder sanity check passes', () => {
  assert.equal(assertBleEncoderSane(), true);
});

// ── Fake central ────────────────────────────────────────────────────────────

function fakePeripheral({ id, name = '', serviceUuids = [] }) {
  const writes = [];
  const decoy = {
    // Same shape, wrong endpoint: binding this one is the classic silent
    // failure the full-discovery rule exists to prevent.
    uuid: '000102030405060708090a0b0c0d2b10',
    properties: ['read', 'notify'],
    writeAsync: async () => { throw new Error('wrote to the notify characteristic'); }
  };
  const control = {
    uuid: BLE_WRITE_UUID,
    properties: ['read', 'writeWithoutResponse'],
    writeAsync: async (buffer, withoutResponse) => {
      writes.push({ hex: buffer.toString('hex'), withoutResponse, at: Date.now() });
    }
  };
  return {
    id,
    rssi: -58,
    advertisement: { localName: name, serviceUuids },
    writes,
    disconnects: 0,
    connectAsync: async () => {},
    discoverAllServicesAndCharacteristicsAsync: async () => ({
      services: [],
      characteristics: [decoy, control]
    }),
    async disconnectAsync() { this.disconnects += 1; }
  };
}

function fakeNoble(peripherals) {
  const central = new EventEmitter();
  central.state = 'poweredOn';
  central.startScanningAsync = async () => {
    queueMicrotask(() => peripherals.forEach(peripheral => central.emit('discover', peripheral)));
  };
  central.stopScanningAsync = async () => {};
  return central;
}

// ── Scan and resolve ────────────────────────────────────────────────────────

test('scan keeps Govee-named and service-advertising peripherals, drops the rest', async () => {
  const noble = fakeNoble([
    fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' }),
    fakePeripheral({ id: 'b', name: 'SomeSpeaker' }),
    fakePeripheral({ id: 'c', name: '', serviceUuids: ['00010203-0405-0607-0809-0a0b0c0d1910'] })
  ]);
  const summaries = await bleScanSummaries({ noble, timeoutMs: 30 });
  assert.deepEqual(summaries.map(entry => entry.id).sort(), ['a', 'c']);
});

test('peripheral summary parses the SKU out of the advertised name', () => {
  const summary = peripheralSummary(fakePeripheral({ id: 'a', name: 'Govee_H6009_EED7' }));
  assert.equal(summary.sku, 'H6009');
  assert.equal(summary.name, 'Govee_H6009_EED7');
  // "ihoment" must not itself read as an H-prefixed SKU (observed live).
  const ihoment = peripheralSummary(fakePeripheral({ id: 'b', name: 'ihoment_H6009_BE07' }));
  assert.equal(ihoment.sku, 'H6009');
});

test('scan with a match predicate stops early and returns the match', async () => {
  const target = fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' });
  const noble = fakeNoble([target]);
  const started = Date.now();
  const { matched } = await bleScan({
    noble,
    timeoutMs: 5000,
    match: peripheral => peripheral.id === 'a'
  });
  assert.equal(matched, target);
  assert.ok(Date.now() - started < 1000, 'match should not wait out the scan window');
});

test('resolve refuses ambiguity rather than guessing', async () => {
  const noble = fakeNoble([
    fakePeripheral({ id: 'a', name: 'ihoment_H6009_AAAA' }),
    fakePeripheral({ id: 'b', name: 'ihoment_H6009_BBBB' })
  ]);
  await assert.rejects(
    bleResolve({ name: 'H6009', timeoutMs: 30, noble }),
    error => error.code === 'ambiguous-device'
  );
});

test('resolve reports not-found with the stopped-advertising caveat', async () => {
  const noble = fakeNoble([]);
  await assert.rejects(
    bleResolve({ name: 'H6009', timeoutMs: 30, noble }),
    error => error.code === 'device-not-found' && /stops advertising/.test(error.message)
  );
});

// ── One-shot set ────────────────────────────────────────────────────────────

test('set writes power, colour, brightness in order and pays the power-on settle', async () => {
  const peripheral = fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' });
  const outcome = await bleSet(peripheral, { power: true, color: '#ffb46e', brightness: 35 });

  assert.deepEqual(outcome.sent.map(entry => entry.channel), ['power', 'color', 'brightness']);
  assert.equal(outcome.verified, false);
  assert.equal(peripheral.writes[0].hex, `330101${'00'.repeat(16)}33`);
  assert.equal(peripheral.writes[1].hex, `33050dffb46e${'00'.repeat(13)}1e`);
  assert.equal(peripheral.writes[2].hex, `330423${'00'.repeat(16)}14`);
  assert.ok(peripheral.writes.every(entry => entry.withoutResponse), 'writes must be write-without-response');
  // A colour sent while the controller boots is silently dropped; the settle
  // is the only defence a channel with no readback has.
  const gap = peripheral.writes[1].at - peripheral.writes[0].at;
  assert.ok(gap >= BLE_POWER_ON_SETTLE_MS - 50, `colour followed power-on after only ${gap}ms`);
  assert.equal(peripheral.disconnects, 1);
});

test('set skips colour and brightness when powering off', async () => {
  const peripheral = fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' });
  const outcome = await bleSet(peripheral, { power: false, color: '#ff0000', brightness: 80 });
  assert.deepEqual(outcome.sent.map(entry => entry.channel), ['power']);
  assert.equal(peripheral.disconnects, 1);
});

test('set requires at least one channel', async () => {
  const peripheral = fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' });
  await assert.rejects(bleSet(peripheral, {}), error => error.code === 'invalid-arguments');
});

test('set disconnects even when discovery finds no control characteristic', async () => {
  const peripheral = fakePeripheral({ id: 'a', name: 'ihoment_H6009_EED7' });
  peripheral.discoverAllServicesAndCharacteristicsAsync = async () => ({ services: [], characteristics: [] });
  await assert.rejects(
    bleSet(peripheral, { color: '#ff0000' }),
    error => error.code === 'characteristic-not-found'
  );
  assert.equal(peripheral.disconnects, 1);
});
