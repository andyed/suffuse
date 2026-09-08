// LAN transport for Govee devices: documented local API (scan/devStatus/colorwc)
// plus the undocumented `razer` per-LED channel used by Razer Synapse, Govee
// Desktop, SignalRGB and LedFx.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The cloud Developer Platform has endpoint- and device-specific rate limits
// and cannot address individual LEDs on most fixtures. The LAN API has no rate ceiling that
// matters (razer measured at 40 Hz sustained with no device-side queue) and
// reaches per-LED on RGBIC hardware. It is also keyless — which cuts both
// ways: no auth gate protects the user's lights, so every write here sits
// behind the same confirm gates as the cloud path.
//
// ── Provenance and licence ──────────────────────────────────────────────────
// The razer byte layout below is stated as protocol FACT, re-derived and
// hardware-verified (H608B, 2026-08-15); it is not copied from any GPL source.
// Beware prose write-ups of this protocol: every published description states
// the length field as a single byte. It is 16-bit big-endian — an
// implementation built from a blog post works up to 84 LEDs and then silently
// corrupts. assertRazerEncoderSane() below guards our own arithmetic.
//
// ── The three hardware lessons everything here encodes ──────────────────────
// 1. The channel is MUTE. No replies, no error surface; devStatus never
//    reflects per-LED state. A malformed frame and a perfect one are
//    indistinguishable from the socket, so validation must happen before the
//    wire and claims after a write must stay modest.
// 2. The pixel count must MATCH the fixture. A wrong count is silently
//    ignored and reads exactly like an unsupported device. Only verified
//    SKU profiles may compile to per-LED.
// 3. Writers CONTEND: a whole-device colorwc repaints every pixel and
//    flattens a live per-LED look (measured — last writer wins). While a hold
//    is active this module refuses colorwc to the same device.

import dgram from 'node:dgram';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { GoveeSkillError, rgbInteger } from './core.mjs';

const CMD_PORT = 4003;
const SCAN_PORT = 4001;
const REPLY_PORT = 4002;
const MULTICAST_ADDR = '239.255.255.250';

/** Documented-API pacing: colorwc drains at ~10-12 cmd/s and QUEUES (never drops). */
export const COLORWC_MAX_HZ = 8;
/** Razer channel: measured clean at 40 Hz; the true ceiling is above and unmeasured. */
export const RAZER_MAX_HZ = 40;
/** Re-arm cadence for held looks — well inside the device's ~60s dead-man window. */
export const HOLD_PERIOD_MS = 20000;
/** Default and ceiling for how long a held look may persist. Bounded by design:
 * an abandoned agent session must not hold a room indefinitely. */
export const HOLD_DEFAULT_SECONDS = 900;
export const HOLD_MAX_SECONDS = 4 * 60 * 60;

// ── Per-SKU spatial profiles ─────────────────────────────────────────────────
// A SKU absent here is not per-LED addressable as far as Suffuse is concerned.
// `verified` means the pixel count was confirmed against physical hardware by
// a discrete chase (every pixel individually lit and counted). An unverified
// profile compiles with a warning: its count is community-sourced, and on this
// mute channel a wrong count is silently ignored — only eyes can promote it.
// Rule for mined capability flags (learned on the H612B): a mined POSITIVE is
// trustworthy, a mined NEGATIVE is only "unknown" — vendor flags describe app
// support, not what the LAN firmware accepts.
//
// `chromaGamma` — per-SKU colour correction for fixtures that map bytes to LED
// duty LINEARLY. Every pixel Suffuse compiles is sRGB-shaped (a byte of 10 means
// ~0.3% of full light); a linear fixture emits 4% for it, so a red like [82,0,10]
// lights PINK while a gamma-calibrated fixture shows it red. Measured by photo and
// eye 2026-09-07 (psychodeli-webgl-port, Red Moon): identical frames were red on
// the H16C0 (LuminBlend+, "proprietary gamma calibration") and pink end to end on
// the H61D3 and H612B, constant across brightness — a ratio, not a dim-end
// artefact. See chromaGamma() below. null = unmeasured = no correction; never
// inherit a neighbour's value — a guessed gamma on a calibrated lamp thins every
// mixed colour it shows. To measure: paint every pixel [255,0,25] (10% blue); a
// linear fixture reads pink, a calibrated one red; then raise gamma on a red look
// until the pink is gone without oranges and teals going thin.
export const RAZER_PROFILES = Object.freeze({
  // chromaGamma 2: "pinkish" in the 2026-09-07 photo, milder than the H61D3/H612B;
  // isolated with a per-SKU override the same day, 2 read as an upgrade by eye.
  H608B: Object.freeze({ pixels: 15, blend: 'discrete', verified: true, chromaGamma: 2 }),
  // Community zone-probe (SignalRGB), 2026-08-16: 20 slots — 0-9 up the left bar,
  // 10-19 up the right — and the firmware remaps SHORTER packets unpredictably,
  // so always stream all 20. The earlier 8-zone "interpolating" reading described
  // short-packet behavior, not the addressing model. Unverified pending a
  // discrete chase by eye.
  H6047: Object.freeze({ pixels: 20, blend: 'discrete', verified: false, chromaGamma: null }),
  // Field-verified 2026-08-16: individual lights render at count=10 (a wrong
  // count renders nothing, so a rendering 10 IS the count). Govee's own product
  // DB says supportRazer: 0 for this SKU — that flag describes Desktop/Chroma
  // app support, not the LAN firmware. Read a mined 0 as unknown, never absent.
  // chromaGamma [2.2, 2.2, 3]: Red Moon reds rendered PINK end to end (photo 2026-09-07);
  // the raw probe [255,0,25] read pink too. By eye: 2.2 helped a lot, 3 read redder; then
  // Golden Hour read pinkish under a scalar 3 (2026-09-08) — one exponent crushes green as
  // hard as blue. Per channel: 2.2 on red and green, 3 on blue keeps the gold.
  H612B: Object.freeze({ pixels: 10, blend: 'discrete', verified: true, chromaGamma: [2.2, 2.2, 3] }),
  // Floor Lamp 3 Lite — field-verified 2026-08-18: a one-hot red segment walked
  // all seven positions, index 0 bottom through index 6 top, with every other
  // region dark. A normal 30 Hz Electron stream then ran smoothly for 20 seconds,
  // stopped immediately with no visible backlog, and restored cleanly.
  // chromaGamma: LuminBlend+ — rendered the same Red Moon frames RED. Keep null.
  H16C0: Object.freeze({ pixels: 7, blend: 'discrete', verified: true, chromaGamma: null }),
  // 3m Neon Rope Light 2 — 7 px field-verified 2026-09-05 (psychodeli-webgl-port):
  // a wrong count renders nothing, so a rendering 7 IS the count. The mined prior
  // said 15 (lanApi.segments) and at 15 the rope rendered ONE collapsed colour that
  // still tracked the palette — which reads exactly like a working whole-device lamp.
  // SignalRGB's ledCount for the 5m H61D5 sibling is also 7, so this looks like a
  // fixed 7-segment architecture; treat lanApi.segments as suspect for H61D2-D6.
  // chromaGamma [2.2, 2.2, 3]: same evidence as the H612B (photo + eye, 2026-09-07/08).
  H61D3: Object.freeze({ pixels: 7, blend: 'discrete', verified: true, chromaGamma: [2.2, 2.2, 3] })
});

export function razerProfile(sku) {
  return RAZER_PROFILES[String(sku ?? '').toUpperCase().trim()] ?? null;
}

// ── Razer frame encoding ────────────────────────────────────────────────────
//   enable    BB 00 01 B1 01 0A
//   disable   BB 00 01 B1 00 0B
//   led data  BB <len_hi> <len_lo> B0 <mode> <count> (R G B)*count <xor>
//             len = 2 + 3*count, counted AFTER the B0 byte, 16-BIT BIG-ENDIAN
//             xor = XOR of every preceding byte
// Wrapped as {"msg":{"cmd":"razer","data":{"pt":"<base64>"}}} to device:4003,
// written with a trailing NUL.

const xorAll = bytes => bytes.reduce((acc, b) => acc ^ b, 0);

export function encodeRazerEnable(on) {
  const pkt = [0xbb, 0x00, 0x01, 0xb1, on ? 0x01 : 0x00];
  pkt.push(xorAll(pkt));
  return Buffer.from(pkt);
}

export function encodeRazerFrame(colors) {
  if (!Array.isArray(colors) || colors.length === 0) {
    throw new GoveeSkillError('A razer frame requires at least one RGB triple', 'invalid-frame');
  }
  if (colors.length > 255) {
    throw new GoveeSkillError('A razer frame carries at most 255 pixels', 'invalid-frame');
  }
  const len = 2 + 3 * colors.length;
  const pkt = [0xbb, (len >> 8) & 0xff, len & 0xff, 0xb0, 0x01, colors.length];
  for (const color of colors) {
    for (const channel of color) {
      const v = Math.round(channel);
      if (!Number.isFinite(v) || v < 0 || v > 255) {
        throw new GoveeSkillError('Razer pixel channels must be integers 0-255', 'invalid-frame');
      }
      pkt.push(v);
    }
  }
  pkt.push(xorAll(pkt));
  return Buffer.from(pkt);
}

/**
 * The channel is mute, so construction time is the only error surface there is.
 * Both constants are hardcoded in independent implementations, which makes them
 * an external check on our length, checksum and byte order at once. The 86-LED
 * probe would catch a single-byte length field (260 = 0x0104 truncates to 0x04).
 */
export function assertRazerEncoderSane() {
  if (encodeRazerEnable(true).toString('hex') !== 'bb0001b1010a') {
    throw new GoveeSkillError('razer enable encoding drifted', 'encoder-drift');
  }
  if (encodeRazerEnable(false).toString('hex') !== 'bb0001b1000b') {
    throw new GoveeSkillError('razer disable encoding drifted', 'encoder-drift');
  }
  const wide = encodeRazerFrame(Array.from({ length: 86 }, () => [1, 2, 3]));
  if (wide[1] !== 0x01 || wide[2] !== 0x04) {
    throw new GoveeSkillError('razer length field is not 16-bit big-endian', 'encoder-drift');
  }
  return true;
}

// ── Chroma gamma ────────────────────────────────────────────────────────────
/**
 * Re-encode each pixel's MINOR channels against its dominant one,
 * c' = max · (c/max)^gamma, for fixtures whose LED duty follows the byte linearly
 * (see RAZER_PROFILES). The dominant channel is untouched, so brightness is
 * preserved; only the leakage of the minor channels is crushed toward what the
 * sRGB byte meant. A minor channel that lands below one LSB is ZERO, not rounded
 * up: pure [255,0,0] read best by eye while gamma 3 still left "a bit pink" from
 * single-LSB blue (2026-09-07). gamma 1, null or non-positive is the identity.
 * Pure; integer triples out, ready for encodeRazerFrame.
 */
// Saturation band over which the correction fades in: identity at or below LO, full at
// or above HI. The encoding is relative to the dominant channel and a near-white has
// every channel near it, so an unweighted gamma 3 turned a 5% screen tint into a 14%
// lavender segment on a neon rope (Sunshine, 2026-09-07). The leakage this removes
// lives on chromatic pixels; a near-neutral must leave as it arrived.
export const CHROMA_GAMMA_FADE = Object.freeze({ lo: 0.05, hi: 0.35 });

/**
 * One exponent for every channel, or `[gr, gg, gb]`. Per channel exists because one exponent
 * tuned on saturated red — where only blue leaks — crushes GREEN as hard as blue: Golden
 * Hour's gold [255,200,100] left a scalar 3 as [255,112,9] and read pinkish (2026-09-08).
 * Returns null for anything that is not a positive exponent, or the identity.
 */
export function normalizeChromaGamma(gamma) {
  if (Array.isArray(gamma) && gamma.length === 3) {
    const v = gamma.map(Number);
    if (!v.every(x => Number.isFinite(x) && x > 0)) return null;
    return v.every(x => x === 1) ? null : v;
  }
  const g = Number(gamma);
  return Number.isFinite(g) && g > 0 && g !== 1 ? [g, g, g] : null;
}

export function chromaGamma(colors, gamma) {
  const gv = normalizeChromaGamma(gamma);
  if (!Array.isArray(colors) || !gv) return colors;
  return colors.map(color => {
    const ch = [0, 1, 2].map(i => Math.max(0, Number(color?.[i]) || 0));
    const m = Math.max(...ch);
    if (!(m > 0)) return [0, 0, 0];
    const sat = (m - Math.min(...ch)) / m;
    const u = Math.max(0, Math.min(1, (sat - CHROMA_GAMMA_FADE.lo) / (CHROMA_GAMMA_FADE.hi - CHROMA_GAMMA_FADE.lo)));
    const fade = u * u * (3 - 2 * u);
    return ch.map((v, k) => {
      const ge = 1 + (gv[k] - 1) * fade;
      if (v === m || ge === 1) return Math.round(v);
      const enc = m * Math.pow(v / m, ge);
      return enc >= 1 ? Math.round(enc) : 0;
    });
  });
}

// ── Bands → pixels ──────────────────────────────────────────────────────────

/**
 * Lay a LightScore gradient across a fixture's pixels. Pure, and the only
 * per-LED authoring surface Suffuse exposes ON PURPOSE: band order is
 * preserved, so adjacent pixels stay adjacent in authored intent and the
 * interpolating-fixture rainbow trap (red beside blue lerps the long way
 * round the hue wheel) cannot be expressed. Weights map to pixel counts by
 * largest remainder, so the result is exactly `pixels` long — the count
 * contract is lesson 2 above.
 */
export function bandsToPixels(bands, pixels) {
  if (!Array.isArray(bands) || !bands.length) {
    throw new GoveeSkillError('bandsToPixels requires at least one band', 'invalid-frame');
  }
  if (!Number.isInteger(pixels) || pixels < 1 || pixels > 255) {
    throw new GoveeSkillError('pixels must be an integer 1-255', 'invalid-frame');
  }
  const weights = bands.map(band => (Number.isFinite(band?.weight) && band.weight > 0 ? band.weight : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const ideal = weights.map(w => (w / total) * pixels);
  const counts = ideal.map(Math.floor);
  let remaining = pixels - counts.reduce((a, b) => a + b, 0);
  const order = ideal
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; remaining > 0; i = (i + 1) % order.length, remaining--) {
    counts[order[i].index] += 1;
  }
  const out = [];
  bands.forEach((band, index) => {
    const value = rgbInteger(band.color);
    const rgb = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    for (let i = 0; i < counts[index]; i++) out.push(rgb);
  });
  // Rounding can leave a zero-count band on tiny fixtures; the frame is still
  // exactly `pixels` long, which is the contract that matters.
  return out;
}

// ── Sockets ─────────────────────────────────────────────────────────────────

function sendJson(socket, ip, port, message) {
  // Trailing NUL matches the reference implementations; devices tolerate its
  // absence on documented commands, but the razer parser is not documented and
  // the byte is free.
  const buffer = Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])]);
  socket.send(buffer, port, ip);
}

/** Fire-and-forget socket for writes. Works even when another local controller
 * owns the reply port, because no reply ever comes back on this channel. */
async function openSendSocket() {
  const socket = dgram.createSocket({ type: 'udp4' });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, resolve);
  });
  return socket;
}

/**
 * Reply socket on :4002 — Govee devices answer scan/devStatus to that fixed
 * port, not to the sender's source port. Deliberately NOT reuseAddr: sharing
 * the port with another controller (the Psychodeli+ app, LedFx…) silently
 * steals replies from one of the two. Failing loudly is the honest behaviour.
 */
async function openReplySocket(replyPort = REPLY_PORT) {
  const socket = dgram.createSocket({ type: 'udp4' });
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(replyPort, resolve);
    });
  } catch (error) {
    socket.close();
    if (error?.code === 'EADDRINUSE') {
      throw new GoveeSkillError(
        `UDP :${replyPort} is held by another local light controller; quit it before discovery or state reads`,
        'reply-port-busy'
      );
    }
    throw error;
  }
  return socket;
}

// ── Discovery and state ─────────────────────────────────────────────────────

/**
 * Multicast first, then a unicast sweep of the local /24 — ALWAYS both.
 * Multicast reply behaviour is intermittent per device (APs drop the group,
 * lamps rejoin lazily), so "answered multicast" says nothing about the others,
 * and multicast silence must never be read as "no LAN support".
 */
export async function lanScan({
  timeoutMs = 6000,
  subnet = null,
  scanIps = null,
  includeMulticast = true,
  replyPort = REPLY_PORT,
  scanPort = SCAN_PORT,
  commandPort = CMD_PORT,
  multicastAddress = MULTICAST_ADDR
} = {}) {
  const socket = await openReplySocket(replyPort);
  const found = new Map();
  socket.on('message', (buffer, rinfo) => {
    try {
      const parsed = JSON.parse(buffer.toString('utf8').replace(/\0+$/, ''));
      const data = parsed?.msg?.data;
      if (parsed?.msg?.cmd === 'scan' && data?.device) {
        found.set(data.device, {
          device: data.device,
          sku: data.sku ?? null,
          ip: data.ip ?? rinfo.address,
          wifiVersionSoft: data.wifiVersionSoft ?? null,
          razer: razerProfile(data.sku)
        });
      }
    } catch { /* not ours */ }
  });

  const scan = { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } };
  if (includeMulticast) {
    try {
      socket.setBroadcast(true);
      sendJson(socket, multicastAddress, scanPort, scan);
    } catch { /* multicast unavailable; the sweep still runs */ }
  }

  const targets = Array.isArray(scanIps) ? scanIps : null;
  if (targets) {
    for (const ip of targets) {
      sendJson(socket, ip, scanPort, scan);
      if (commandPort !== scanPort) sendJson(socket, ip, commandPort, scan);
    }
  } else {
    const base = subnet ?? localSubnet();
    for (let host = 1; base && host <= 254; host++) {
      sendJson(socket, `${base}.${host}`, scanPort, scan);
      sendJson(socket, `${base}.${host}`, commandPort, scan);
      if (host % 32 === 0) await sleep(50);
    }
  }
  await sleep(timeoutMs);
  socket.close();
  return [...found.values()];
}

function localSubnet() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address.split('.').slice(0, 3).join('.');
      }
    }
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Read onOff/brightness/color over LAN. This is the KEYLESS pre-write capture:
 * unlike the razer channel, devStatus genuinely answers. Capture happens before
 * any write — replies queue behind pending commands, so mid-write readback lies. */
export async function lanDevStatus(ip, {
  timeoutMs = 3000,
  replyPort = REPLY_PORT,
  commandPort = CMD_PORT
} = {}) {
  const socket = await openReplySocket(replyPort);
  const state = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.on('message', (buffer, rinfo) => {
      // :4002 is one shared reply port for EVERY device on the LAN, and a lamp
      // answering a stale or third-party poll is indistinguishable by payload
      // (devStatus carries no device id). Found by a cold-room agent 2026-08-18:
      // sequential polls cross-attributed replies between fixtures, and because
      // lan paint uses this capture, a receipt could record the WRONG device's
      // state as its restore point. The sender address is the only identity.
      if (rinfo.address !== ip) return;
      try {
        const parsed = JSON.parse(buffer.toString('utf8').replace(/\0+$/, ''));
        if (parsed?.msg?.cmd === 'devStatus') {
          clearTimeout(timer);
          resolve(parsed.msg.data ?? null);
        }
      } catch { /* not ours */ }
    });
    sendJson(socket, ip, commandPort, { msg: { cmd: 'devStatus', data: {} } });
  });
  socket.close();
  return state;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export async function lanSetColor(ip, color, { brightness = null, colorTemInKelvin = 0 } = {}) {
  await refuseIfHeld(ip);
  const socket = await openSendSocket();
  // CCT mode: colorwc with a Kelvin value and zeroed RGB selects white-temperature
  // mode — the same wire shape the device itself reports from devStatus. A caller
  // passing kelvin > 0 may pass color null.
  const kelvin = Number.isFinite(colorTemInKelvin) && colorTemInKelvin > 0 ? Math.round(colorTemInKelvin) : 0;
  const value = kelvin > 0 && color == null ? 0 : rgbInteger(color);
  sendJson(socket, ip, CMD_PORT, {
    msg: {
      cmd: 'colorwc',
      data: {
        color: { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff },
        colorTemInKelvin: kelvin
      }
    }
  });
  if (Number.isFinite(brightness)) {
    await sleep(150); // stay far inside the documented channel's ~10-12 cmd/s drain
    sendJson(socket, ip, CMD_PORT, { msg: { cmd: 'brightness', data: { value: Math.round(brightness) } } });
  }
  await sleep(100);
  socket.close();
}

/**
 * Map a devStatus capture to restore operations. Pure, because the mapping has
 * a trap a cold-room agent walked into on 2026-08-18: a device in WHITE-
 * TEMPERATURE mode reports its RGB as {0,0,0}, so naively restoring "the
 * captured colour" sends the lamp to BLACK instead of back to its Kelvin
 * white. Kelvin wins when present; an all-zero RGB with no Kelvin is treated
 * as unknown rather than replayed as black.
 */
export function lanRestoreOperations(ip, captured) {
  const operations = [{ transport: 'lan', action: 'razer-disable', ip }];
  if (!captured) return operations;
  const brightness = Number.isFinite(captured.brightness) ? captured.brightness : null;
  const kelvin = Number(captured.colorTemInKelvin);
  const rgb = captured.color;
  if (Number.isFinite(kelvin) && kelvin > 0) {
    operations.push({ transport: 'lan', action: 'colorwc', ip, color: null, colorTemInKelvin: kelvin, brightness });
  } else if (rgb && ((rgb.r | 0) || (rgb.g | 0) || (rgb.b | 0))) {
    operations.push({
      transport: 'lan',
      action: 'colorwc',
      ip,
      color: `#${[rgb.r, rgb.g, rgb.b].map(v => Number(v ?? 0).toString(16).padStart(2, '0')).join('')}`,
      brightness
    });
  }
  // else: colour state unknown (black RGB, no Kelvin) — no colour op is honest;
  // the caller's coverage warning carries the gap.
  return operations;
}

export async function lanPaintPixels(ip, colors) {
  assertRazerEncoderSane();
  const socket = await openSendSocket();
  const wrap = pkt => ({ msg: { cmd: 'razer', data: { pt: pkt.toString('base64') } } });
  sendJson(socket, ip, CMD_PORT, wrap(encodeRazerEnable(true)));
  await sleep(150);
  sendJson(socket, ip, CMD_PORT, wrap(encodeRazerFrame(colors)));
  await sleep(100);
  socket.close();
}

export async function lanRazerDisable(ip) {
  const socket = await openSendSocket();
  sendJson(socket, ip, CMD_PORT, { msg: { cmd: 'razer', data: { pt: encodeRazerEnable(false).toString('base64') } } });
  await sleep(100);
  socket.close();
}

// ── Holds ───────────────────────────────────────────────────────────────────
// A razer look is ephemeral by hardware design: ~60s without LED data and the
// device reverts to its own effects. Instead of hiding that, a hold makes the
// duration explicit — a detached keepalive repaints every HOLD_PERIOD_MS until
// its TTL, then the light hands itself back. Deleting the hold file releases
// early. The hold file doubles as the contention lock (lesson 3).

const HOLDS_DIR = join(homedir(), '.suffuse', 'holds');
const holdPath = ip => join(HOLDS_DIR, `${ip.replaceAll('.', '-')}.json`);

export function clampHoldSeconds(seconds) {
  const value = Number.isFinite(seconds) ? seconds : HOLD_DEFAULT_SECONDS;
  if (value <= 0) return 0;
  return Math.min(value, HOLD_MAX_SECONDS);
}

export async function readHold(ip) {
  try {
    return JSON.parse(await readFile(holdPath(ip), 'utf8'));
  } catch {
    return null;
  }
}

async function refuseIfHeld(ip) {
  const hold = await readHold(ip);
  if (hold && Date.now() < hold.expiresAt) {
    throw new GoveeSkillError(
      `Device ${ip} is held by a per-LED look until ${new Date(hold.expiresAt).toISOString()}; ` +
      'a whole-device color write would repaint every pixel and flatten it (last writer wins). ' +
      'Release the hold first.',
      'device-held'
    );
  }
}

export async function writeHold(ip, { pid, expiresAt, label = null }) {
  await mkdir(HOLDS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(holdPath(ip), `${JSON.stringify({ ip, pid, expiresAt, label }, null, 2)}\n`, { mode: 0o600 });
}

export async function releaseHold(ip) {
  const hold = await readHold(ip);
  await rm(holdPath(ip), { force: true });
  if (hold?.pid) {
    try { process.kill(hold.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await lanRazerDisable(ip);
  return hold;
}

export async function listHolds() {
  try {
    const files = await readdir(HOLDS_DIR);
    const holds = [];
    for (const file of files) {
      try { holds.push(JSON.parse(await readFile(join(HOLDS_DIR, file), 'utf8'))); } catch { /* skip */ }
    }
    return holds;
  } catch {
    return [];
  }
}

/**
 * The detached keepalive loop. Runs in its own process (spawned by the CLI),
 * repaints until TTL or until the hold file disappears, then disables razer so
 * the device returns to its own state. Exit is always a release.
 */
export async function runHoldLoop(ip, colors, ttlSeconds) {
  const expiresAt = Date.now() + clampHoldSeconds(ttlSeconds) * 1000;
  await writeHold(ip, { pid: process.pid, expiresAt });
  try {
    while (Date.now() < expiresAt) {
      if (!(await readHold(ip))) return; // released externally; releaseHold sent the disable
      await lanPaintPixels(ip, colors);
      await sleep(Math.min(HOLD_PERIOD_MS, Math.max(0, expiresAt - Date.now())));
    }
  } finally {
    await rm(holdPath(ip), { force: true });
    await lanRazerDisable(ip);
  }
}
