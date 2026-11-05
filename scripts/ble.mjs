// BLE transport for Govee devices — keyless live control for hardware the LAN
// API structurally cannot reach (the H6009 class: cloud-listed, but no LAN
// Control at all).
//
// ── Scope ───────────────────────────────────────────────────────────────────
// One-shot control only: scan, connect, write power/colour/brightness, drain,
// disconnect. Suffuse deliberately does NOT hold BLE sessions open the way it
// holds LAN per-LED looks: a connected central locks the lamp away from the
// owner's Govee Home app (one central at a time), and there is no readback to
// tell anyone it happened. A one-shot borrows the lamp for seconds and hands
// it back.
//
// ── Provenance ──────────────────────────────────────────────────────────────
// Every constant here was measured against physical hardware (H6009, 2026-08)
// and is documented in references/ble.md. The reference implementation is the
// Psychodeli+ Electron session transport (same author); this module re-derives
// the one-shot subset in Suffuse's idiom rather than porting session
// machinery (keep-alive loops, reconnect ladders, sleep/wake recovery) that a
// process-per-command CLI cannot use.
//
// ── The link contract (all parts required; any one missing fails SILENTLY) ──
// 1. FULL service discovery + ~350 ms settle after connect. Filtered discovery
//    returns a characteristic that looks valid and does nothing.
// 2. Serialized writes per peripheral — overlapping writes on one
//    characteristic deadlock. This module is safe by construction: a one-shot
//    is a single sequential flow, so no two writes can ever overlap. Any
//    future session mode must re-introduce an explicit write chain.
// 3. Keep-alive every ~5 s against the ~14 s idle drop — NOT needed here
//    because a one-shot never idles, but the frame and constant are exported
//    for that future session mode.
// Plus two settles with no substitute: ~1000 ms after power-on (the lamp's
// controller boots and drops everything it receives meanwhile — measured:
// colour 104 ms after power-on was silently discarded) and ~250 ms drain after
// the last write (writeWithoutResponse resolves when the OS accepts the
// buffer, not when the radio transmits; disconnecting immediately destroys the
// queued packet — measured live).

import { GoveeSkillError, rgbInteger } from './core.mjs';

export const BLE_SERVICE_UUID = '000102030405060708090a0b0c0d1910';
export const BLE_WRITE_UUID = '000102030405060708090a0b0c0d2b11';
/** Advertised read+notify endpoint. The H6009 rejects both operations in practice. */
export const BLE_NOTIFY_UUID = '000102030405060708090a0b0c0d2b10';

/** ~14 s measured idle drop; 5 s keep-alive holds a session open. Unused by
 * one-shot control; exported for a future session mode. */
export const BLE_KEEPALIVE_MS = 5000;
export const BLE_CONNECT_SETTLE_MS = 350;
export const BLE_POWER_ON_SETTLE_MS = 1000;
export const BLE_WRITE_DRAIN_MS = 250;
/** Conservative pacing between consecutive one-shot writes (~10 Hz ceiling). */
export const BLE_WRITE_GAP_MS = 100;
export const BLE_CONNECT_TIMEOUT_MS = 8000;
export const BLE_WRITE_TIMEOUT_MS = 2500;

/**
 * BLE has no state readback (the notify characteristic rejects reads on real
 * hardware), so capture-and-restore is impossible. The receipt instead records
 * this DECLARED restore point — warm white, matching the reference
 * implementation — and says honestly that it is a declaration, not a capture.
 */
export const BLE_RESTORE_POINT = Object.freeze({ color: '#ffb46e', brightness: 100 });

const clamp255 = value => Math.max(0, Math.min(255, Math.round(value || 0)));

/** Build a 20-byte Govee BLE frame: payload bytes, zero padding, XOR checksum in byte 19. */
export function bleFrame(bytes) {
  if (!Array.isArray(bytes) || bytes.length > 19) {
    throw new GoveeSkillError('A BLE frame carries at most 19 payload bytes', 'invalid-frame');
  }
  const frame = Buffer.alloc(20);
  bytes.forEach((byte, index) => { frame[index] = byte & 0xff; });
  let xor = 0;
  for (let index = 0; index < 19; index += 1) xor ^= frame[index];
  frame[19] = xor;
  return frame;
}

export const BLE_FRAMES = Object.freeze({
  power: on => bleFrame([0x33, 0x01, on ? 0x01 : 0x00]),
  brightness: value => bleFrame([0x33, 0x04, Math.max(0, Math.min(100, Math.round(value)))]),
  /**
   * COLOUR — sub-opcode 0x0D, NOT the 0x02 every published reverse-engineering
   * documents. 0x02 is the RGB-only device encoding; on RGBWW hardware (H6009)
   * it is ACCEPTED by the characteristic and visibly inert. Determined by
   * sweeping variants against a real bulb; see references/ble.md.
   */
  color: (r, g, b) => bleFrame([0x33, 0x05, 0x0d, clamp255(r), clamp255(g), clamp255(b)]),
  keepAlive: () => bleFrame([0xaa, 0x01])
});

/**
 * The channel is write-without-response with no error surface, so construction
 * time is the only checkpoint there is. The colour vector is pinned to the
 * frame logged working against a real H6009 (33 05 0d ff b4 6e …), which makes
 * this an external check on padding, opcode and checksum at once — the same
 * role assertRazerEncoderSane() plays for the LAN channel.
 */
export function assertBleEncoderSane() {
  const color = BLE_FRAMES.color(255, 180, 110).toString('hex');
  if (color !== `33050dffb46e${'00'.repeat(13)}1e`) {
    throw new GoveeSkillError('BLE colour frame encoding drifted', 'encoder-drift');
  }
  if (BLE_FRAMES.keepAlive().toString('hex') !== `aa01${'00'.repeat(17)}ab`) {
    throw new GoveeSkillError('BLE keep-alive frame encoding drifted', 'encoder-drift');
  }
  return true;
}

// ── Host access ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GoveeSkillError(`${label} timed out after ${timeoutMs}ms`, 'ble-timeout')), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * noble is an OPTIONAL dependency: Suffuse's cloud and LAN surfaces must keep
 * working on hosts where a native BLE stack cannot build or is not wanted.
 * The failure message carries the two known remediations because both failure
 * modes are silent-by-default and cost hours the first time:
 *  - the module is simply absent (optional install skipped or failed);
 *  - macOS TCC KILLS (SIGABRT, no prompt) any unsigned/adhoc-signed process
 *    that touches CoreBluetooth. Terminal-launched node is attributed to the
 *    terminal app, which must hold Bluetooth permission. See references/ble.md.
 */
let cachedNoble = null;

export async function loadNoble() {
  if (cachedNoble) return cachedNoble;
  try {
    const module_ = await import('@stoprocent/noble');
    cachedNoble = module_.default ?? module_;
    return cachedNoble;
  } catch (error) {
    throw new GoveeSkillError(
      'BLE support needs the optional dependency @stoprocent/noble '
      + `(npm install @stoprocent/noble). Load failed: ${error.message}. `
      + 'On macOS, the responsible process (usually your terminal app) must have '
      + 'Bluetooth permission — an unsigned process touching CoreBluetooth is '
      + 'killed without a prompt, not asked. See references/ble.md.',
      'ble-unavailable'
    );
  }
}

/** Tear down the native central so a CLI process can exit promptly. */
export function bleStop() {
  try { cachedNoble?.stop?.(); } catch { /* already down */ }
  cachedNoble = null;
}

async function waitPoweredOn(noble, timeoutMs = 6000) {
  if (noble.state === 'poweredOn') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener('stateChange', onState);
      reject(new GoveeSkillError(`Bluetooth is not powered on (state=${noble.state})`, 'bluetooth-off'));
    }, timeoutMs);
    const onState = state => {
      if (state === 'poweredOn') {
        clearTimeout(timer);
        noble.removeListener('stateChange', onState);
        resolve();
      }
    };
    noble.on('stateChange', onState);
  });
}

function peripheralSummary(peripheral) {
  const name = peripheral.advertisement?.localName || '';
  // Names come as Govee_H6009_EED7 or ihoment_H6009_EED7 — anchor the SKU to
  // underscore boundaries, or "ihoment" itself matches an H-prefixed pattern
  // (observed live: sku parsed as "HOMENT").
  const skuMatch = name.match(/(?:^|_)(H[0-9A-Z]{4,5})(?=_|$)/i);
  return {
    id: peripheral.id,
    name: name || '(unnamed)',
    sku: skuMatch ? skuMatch[1].toUpperCase() : null,
    rssi: peripheral.rssi ?? null
  };
}

function looksGovee(peripheral) {
  const name = peripheral.advertisement?.localName || '';
  if (/govee|ihoment/i.test(name)) return true;
  return (peripheral.advertisement?.serviceUuids || [])
    .some(uuid => String(uuid).replace(/-/g, '').toLowerCase() === BLE_SERVICE_UUID);
}

/**
 * Scan for Govee peripherals. Filtering by name OR advertised service: names
 * vary by SKU and firmware ("Govee_H6009_XXXX", "ihoment_…", sometimes blank),
 * while any lamp this module can drive must expose the control service.
 *
 * `match(peripheral)` lets a caller stop the scan at first sight of its
 * target; discovery routinely takes seconds and a one-shot should not pay the
 * full window when the lamp answered in the first one.
 */
export async function bleScan({ timeoutMs = 8000, noble = null, match = null } = {}) {
  const central = noble ?? await loadNoble();
  await waitPoweredOn(central);
  const found = new Map();
  let matched = null;

  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      central.removeListener('discover', onDiscover);
      central.stopScanningAsync().catch(() => {}).finally(resolve);
    };
    const timer = setTimeout(finish, timeoutMs);
    const onDiscover = peripheral => {
      if (!looksGovee(peripheral)) return;
      if (!found.has(peripheral.id)) found.set(peripheral.id, peripheral);
      if (match && !matched && match(peripheral)) {
        matched = peripheral;
        finish();
      }
    };
    central.on('discover', onDiscover);
    // A connected peripheral stops advertising, so a scan can never rediscover
    // a lamp another central currently holds — absence here is not absence.
    central.startScanningAsync([], false).catch(error => {
      clearTimeout(timer);
      central.removeListener('discover', onDiscover);
      reject(new GoveeSkillError(`BLE scan failed: ${error.message}`, 'ble-scan-failed'));
    });
  });

  return { peripherals: [...found.values()], matched };
}

/** Renderer-safe scan summaries for the CLI/MCP surface. */
export async function bleScanSummaries(options = {}) {
  const { peripherals } = await bleScan(options);
  return peripherals.map(peripheralSummary);
}

// ── One-shot control ────────────────────────────────────────────────────────

async function connectWriteCharacteristic(peripheral) {
  await withTimeout(peripheral.connectAsync(), BLE_CONNECT_TIMEOUT_MS, 'connect');
  try {
    // Settle, then FULL discovery. Discovering too early — or using filtered
    // discovery — yields characteristic handles that look valid and silently
    // do nothing; both were observed on real hardware.
    await sleep(BLE_CONNECT_SETTLE_MS);
    const { characteristics } = await withTimeout(
      peripheral.discoverAllServicesAndCharacteristicsAsync(),
      BLE_CONNECT_TIMEOUT_MS,
      'service discovery'
    );
    const write = (characteristics || []).find(characteristic =>
      String(characteristic.uuid || '').replace(/-/g, '').toLowerCase() === BLE_WRITE_UUID);
    if (!write) {
      throw new GoveeSkillError('Govee control characteristic not found on peripheral', 'characteristic-not-found');
    }
    return write;
  } catch (error) {
    await peripheral.disconnectAsync().catch(() => {});
    throw error;
  }
}

/**
 * One-shot set: connect, write the requested channels in a deliberate order,
 * drain, disconnect. Order matters and is not negotiable:
 *   power → (power-on settle) → colour → gap → brightness → drain
 * A write resolving true means the OS accepted the buffer — NOT that the lamp
 * obeyed. This channel has no delivery receipt; the returned record reports
 * what was SENT and the caller must claim no more than that.
 */
export async function bleSet(peripheral, { power = null, color = null, brightness = null } = {}) {
  if (power === null && color === null && brightness === null) {
    throw new GoveeSkillError('bleSet requires at least one of power, color, brightness', 'invalid-arguments');
  }
  assertBleEncoderSane();
  const writeChar = await connectWriteCharacteristic(peripheral);
  const sent = [];
  const write = async (label, frame) => {
    // writeWithoutResponse — the endpoint advertises no acknowledged-write
    // property at all, so requesting one cannot work.
    await withTimeout(writeChar.writeAsync(frame, true), BLE_WRITE_TIMEOUT_MS, `write ${label}`);
    sent.push({ channel: label, frame: frame.toString('hex') });
  };
  try {
    let first = true;
    const gap = async () => { if (!first) await sleep(BLE_WRITE_GAP_MS); first = false; };
    if (power !== null) {
      await gap();
      await write('power', BLE_FRAMES.power(!!power));
      // A lamp that was off is booting its controller now and will drop
      // whatever arrives next. There is no readback to ask, and no way to know
      // whether it was already on, so the settle is paid unconditionally.
      if (power) await sleep(BLE_POWER_ON_SETTLE_MS);
    }
    if (color !== null && power !== false) {
      const value = rgbInteger(color);
      await gap();
      await write('color', BLE_FRAMES.color((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff));
    }
    if (brightness !== null && power !== false) {
      await gap();
      await write('brightness', BLE_FRAMES.brightness(brightness));
    }
    // Let the last packet leave the radio before tearing the link down.
    await sleep(BLE_WRITE_DRAIN_MS);
  } finally {
    await peripheral.disconnectAsync().catch(() => {});
  }
  return { sent, verified: false };
}

/**
 * Resolve one peripheral by id or name fragment, scanning until first match.
 * Ambiguity is an error, not a guess — same posture as the LAN path.
 *
 * Every resolve is a FRESH scan; never reuse a peripheral from an earlier
 * discovery. Windows refused a reconnect to a bulb that had not advertised
 * since its last link closed (psychodeli-webgl-port, after a BLE hand-over,
 * 2026-10-17). A lamp that has not advertised again is not reachable yet,
 * whatever a cached handle says.
 */
export async function bleResolve({ id = null, name = null, timeoutMs = 8000, noble = null } = {}) {
  const wantId = id ? String(id).trim() : null;
  const wantName = name ? String(name).trim().toLowerCase() : null;
  if (!wantId && !wantName) {
    throw new GoveeSkillError('ble device selection requires --id or --name', 'invalid-arguments');
  }
  const matches = peripheral => {
    if (wantId) return peripheral.id === wantId;
    return (peripheral.advertisement?.localName || '').toLowerCase().includes(wantName);
  };
  // Early exit is only safe when the selector is unique by construction. A
  // name fragment must scan the FULL window, or ambiguity would silently
  // resolve to whichever lamp advertised first — a guess wearing a match.
  const { peripherals, matched } = await bleScan({
    timeoutMs,
    noble,
    match: wantId ? matches : null
  });
  if (matched) return matched;
  const candidates = peripherals.filter(matches);
  if (!candidates.length) {
    throw new GoveeSkillError(
      'No matching BLE peripheral found. A lamp held by another central (the Govee '
      + 'Home app, another controller) stops advertising and cannot be discovered.',
      'device-not-found'
    );
  }
  if (candidates.length > 1) {
    throw new GoveeSkillError(
      `Multiple BLE peripherals match (${candidates.map(p => peripheralSummary(p).name).join(', ')}); pin one with --id`,
      'ambiguous-device'
    );
  }
  return candidates[0];
}

export { peripheralSummary };
