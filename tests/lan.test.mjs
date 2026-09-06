// LAN transport — the pure parts. Discovery and documented state sockets have
// a loopback fake-device integration test; physical writes remain hardware-only.
// What CI must hold most tightly is the encoding and the compile, because the razer
// channel is MUTE: a malformed frame never errors, it just paints nothing and
// reads as an unsupported device. Construction-time checks are the only error
// surface this transport has.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRazerEncoderSane,
  bandsToPixels,
  clampHoldSeconds,
  encodeRazerEnable,
  encodeRazerFrame,
  HOLD_DEFAULT_SECONDS,
  HOLD_MAX_SECONDS,
  lanRestoreOperations,
  razerProfile,
  RAZER_PROFILES
} from '../scripts/lan.mjs';

test('razer enable and disable reproduce the independently published constants', () => {
  // Hardcoded in independent implementations of this protocol — an external
  // check on our length, checksum and byte order at once.
  assert.equal(encodeRazerEnable(true).toString('hex'), 'bb0001b1010a');
  assert.equal(encodeRazerEnable(false).toString('hex'), 'bb0001b1000b');
});

test('razer frame length is 16-bit big-endian, not one byte', () => {
  // Every prose description of this protocol states a single length byte.
  // 86 LEDs → len = 2 + 258 = 260 = 0x0104; a one-byte field truncates to 0x04
  // and the device silently ignores the frame from LED 85 up.
  const frame = encodeRazerFrame(Array.from({ length: 86 }, () => [1, 2, 3]));
  assert.equal(frame[1], 0x01);
  assert.equal(frame[2], 0x04);
});

test('razer frame carries header, mode, count, RGB triples and an XOR checksum', () => {
  const frame = encodeRazerFrame([[255, 0, 0], [0, 0, 255]]);
  assert.equal(frame[0], 0xbb);
  assert.equal(frame[3], 0xb0);
  assert.equal(frame[4], 0x01);
  assert.equal(frame[5], 2);
  assert.deepEqual([...frame.subarray(6, 12)], [255, 0, 0, 0, 0, 255]);
  let checksum = 0;
  for (let i = 0; i < frame.length - 1; i++) checksum ^= frame[i];
  assert.equal(frame[frame.length - 1], checksum);
});

test('razer frames refuse to be malformed rather than silently wrong', () => {
  assert.throws(() => encodeRazerFrame([]), /at least one/);
  assert.throws(() => encodeRazerFrame(Array.from({ length: 256 }, () => [1, 1, 1])), /at most 255/);
  assert.throws(() => encodeRazerFrame([[300, 0, 0]]), /0-255/);
  assert.throws(() => encodeRazerFrame([[Number.NaN, 0, 0]]), /0-255/);
});

test('the encoder self-check passes on the shipped encoder', () => {
  assert.equal(assertRazerEncoderSane(), true);
});

test('bandsToPixels emits exactly the requested pixel count', () => {
  // The count contract: a frame whose count differs from the fixture's real
  // LED count is silently ignored — indistinguishable from an unsupported
  // device. Measured: 2/10/30 pixels against a 15-LED string showed nothing.
  const bands = [{ color: '#ff0000' }, { color: '#00ff00' }, { color: '#0000ff' }];
  for (const pixels of [3, 7, 15, 100, 255]) {
    assert.equal(bandsToPixels(bands, pixels).length, pixels);
  }
});

test('bandsToPixels preserves band order — hue adjacency by construction', () => {
  // Interpolating fixtures lerp between supplied stops the long way round the
  // hue wheel; band order is the schema-level guarantee an agent cannot break.
  const pixels = bandsToPixels(
    [{ color: '#ff0000' }, { color: '#ffa500' }, { color: '#ffff00' }],
    9
  );
  assert.deepEqual(pixels[0], [255, 0, 0]);
  assert.deepEqual(pixels[4], [255, 165, 0]);
  assert.deepEqual(pixels[8], [255, 255, 0]);
});

test('bandsToPixels honours weights by largest remainder', () => {
  const pixels = bandsToPixels(
    [{ color: '#ff0000', weight: 2 }, { color: '#0000ff', weight: 1 }],
    15
  );
  const reds = pixels.filter(([r, , b]) => r === 255 && b === 0).length;
  assert.equal(reds, 10);
  assert.equal(pixels.length, 15);
});

test('bandsToPixels validates its inputs', () => {
  assert.throws(() => bandsToPixels([], 15), /at least one band/);
  assert.throws(() => bandsToPixels([{ color: '#ff0000' }], 0), /1-255/);
  assert.throws(() => bandsToPixels([{ color: '#ff0000' }], 300), /1-255/);
  assert.throws(() => bandsToPixels([{ color: 'red' }], 5), /Invalid RGB/);
});

test('profiles gate per-LED to hardware-verified pixel counts', () => {
  assert.equal(razerProfile('H608B').pixels, 15);
  assert.equal(razerProfile('H608B').verified, true);
  assert.equal(razerProfile('h608b').pixels, 15);          // case-insensitive
  assert.equal(razerProfile('H6047').verified, false);     // ships marked, compiles with a warning
  assert.equal(razerProfile('H16C0').pixels, 7);
  assert.equal(razerProfile('H16C0').blend, 'discrete');
  assert.equal(razerProfile('H16C0').verified, true);
  assert.equal(razerProfile('H6199'), null);               // unknown SKUs never guess
  for (const profile of Object.values(RAZER_PROFILES)) {
    assert.ok(Number.isInteger(profile.pixels) && profile.pixels >= 1 && profile.pixels <= 255);
    assert.ok(['discrete', 'interpolating'].includes(profile.blend));
  }
});

test('holds are bounded by construction', () => {
  // An abandoned agent session must not hold a room indefinitely.
  assert.equal(clampHoldSeconds(undefined), HOLD_DEFAULT_SECONDS);
  assert.equal(clampHoldSeconds(0), 0);
  assert.equal(clampHoldSeconds(-5), 0);
  assert.equal(clampHoldSeconds(HOLD_MAX_SECONDS + 1), HOLD_MAX_SECONDS);
  assert.equal(clampHoldSeconds(60), 60);
});

// ── Restore mapping (cold-room findings, 2026-08-18) ────────────────────────
// A cold agent's reading-light run surfaced both cases below against real
// hardware: the H608B in CCT mode reported RGB {0,0,0} + colorTemInKelvin 3600,
// and the naive mapping would have restored it to BLACK.

test('restore replays Kelvin, not the black RGB a CCT-mode device reports', () => {
  const ops = lanRestoreOperations('192.168.1.34', {
    onOff: 1, brightness: 67, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 3600
  });
  assert.equal(ops.length, 2);
  assert.equal(ops[1].colorTemInKelvin, 3600);
  assert.equal(ops[1].color, null);
  assert.equal(ops[1].brightness, 67);
});

test('restore treats black RGB with no Kelvin as unknown, never replays black', () => {
  const ops = lanRestoreOperations('192.168.1.34', {
    onOff: 1, brightness: 44, color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 0
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].action, 'razer-disable');
});

test('restore replays a genuine RGB capture as hex with brightness', () => {
  const ops = lanRestoreOperations('192.168.1.90', {
    onOff: 1, brightness: 44, color: { r: 255, g: 255, b: 0 }, colorTemInKelvin: 0
  });
  assert.equal(ops[1].color, '#ffff00');
  assert.equal(ops[1].brightness, 44);
});
