#!/usr/bin/env node
/**
 * drive.mjs — play a scripted light sequence and emit a timeline the analyzer can score.
 *
 * WHY THIS EXISTS
 *   The Govee `razer` channel has NO readback. The device is mute: it never replies, and
 *   `devStatus` does not reflect segment state. A malformed frame and a perfect one are
 *   indistinguishable from the socket, so every per-LED result Suffuse reports carries
 *   `verified: false` — only eyes can confirm. This harness is those eyes, made
 *   repeatable: a camera pointed at the room closes the loop. This half drives KNOWN
 *   patterns and records exactly what was sent when; `analyze.py` scores a video
 *   against it.
 *
 *   The `chase` phase is the discrete-chase test that references/lan-razer.md names as
 *   the only admission route to a `verified: true` entry in RAZER_PROFILES: one lit
 *   pixel walked across the fixture, every position visually counted.
 *
 * THE SYNC PROBLEM
 *   Recording starts by hand, so the video's t=0 is unknown. Every run therefore begins
 *   with a CLAPPER: three full-white pulses at a fixed 1s cadence, which the analyzer
 *   finds as evenly-spaced global brightness peaks. Everything after is measured from
 *   the last one.
 *
 * ROI DISCOVERY
 *   Rather than asking anyone to draw boxes, the CALIBRATE phase lights each fixture
 *   alone, full white, everything else black. Whatever brightens in that window IS that
 *   fixture. Costs a few seconds and survives the camera being moved between runs.
 *
 * ⚠️ Do NOT run this while anything else owns the lamps: two writers make every result
 * meaningless. The script refuses to start if UDP :4002 is taken, and refuses fixtures
 * with an active Suffuse hold.
 *
 * Usage:
 *   node verify/drive.mjs --fixtures 192.168.1.34:15,192.168.1.84:20
 *   node verify/drive.mjs --fixtures ... --out verify/runs/2026-08-18
 *
 * Then: python3 verify/analyze.py <video> <out>/timeline.json
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertRazerEncoderSane,
  encodeRazerEnable,
  encodeRazerFrame,
  listHolds
} from '../scripts/lan.mjs';

const CMD_PORT = 4003;
const REPLY_PORT = 4002;
const CLAPPER_PULSES = 3;
const CLAPPER_PERIOD_MS = 1000;
const CLAPPER_ON_MS = 250;

const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const RED = [255, 0, 0], BLUE = [0, 0, 255];

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || !process.argv[i + 1] ? dflt : process.argv[i + 1];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "ip:count,ip:count" -> [{ip, leds}] */
function parseFixtures(spec) {
  if (!spec) throw new Error('--fixtures required, e.g. 192.168.1.34:15');
  return spec.split(',').map((s) => {
    const [ip, n] = s.split(':');
    const leds = Number(n);
    if (!ip || !Number.isFinite(leds) || leds < 1) throw new Error(`bad fixture "${s}"`);
    // The count is not cosmetic: a device given the wrong LED count ignores the frame
    // entirely, which looks exactly like an unsupported device.
    return { ip, leds };
  });
}

const fixtures = parseFixtures(arg('fixtures'));
const outDir = arg('out', `verify/runs/run-${Date.now()}`);
const holdMs = Number(arg('hold', 4000));

assertRazerEncoderSane();

// Refuse fixtures another Suffuse session is holding — the hold file is the
// contention lock, and a driver that ignored it would be the second writer.
const holds = await listHolds();
for (const f of fixtures) {
  const active = holds.find((h) => h.ip === f.ip);
  if (active) {
    throw new Error(`${f.ip} has an active Suffuse hold (pid ${active.pid}). Release it first.`);
  }
}

// ---------------------------------------------------------------- socket

// Bound to :4002 deliberately, and NOT reuseAddr: this is the exclusivity check.
const sock = dgram.createSocket({ type: 'udp4' });
await new Promise((resolve, reject) => {
  sock.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new Error(
        'UDP :4002 is held by another local light controller.\n' +
        'Quit it first — two writers on the same lamps invalidate every measurement.'));
    } else reject(err);
  });
  sock.bind(REPLY_PORT, resolve);
});

const sendRazer = (ip, pkt) => {
  const msg = { msg: { cmd: 'razer', data: { pt: pkt.toString('base64') } } };
  const buffer = Buffer.concat([Buffer.from(JSON.stringify(msg), 'utf8'), Buffer.from([0])]);
  sock.send(buffer, CMD_PORT, ip);
};

// ---------------------------------------------------------------- timeline

const t0 = Date.now();
const timeline = [];
/** Record what the room was told to show, and when, relative to script start. */
const mark = (phase, detail) => timeline.push({ t: Date.now() - t0, phase, ...detail });

const paintAll = (colorsFor) => {
  for (const f of fixtures) sendRazer(f.ip, encodeRazerFrame(colorsFor(f)));
};
const fill = (n, c) => Array.from({ length: n }, () => c);

/** Hold a state, re-sending so it survives the ~60s dead-man and any dropped UDP packet. */
async function hold(ms, colorsFor) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    paintAll(colorsFor);
    await sleep(150);
  }
}

// ---------------------------------------------------------------- phases

async function clapper(label) {
  // Fixed cadence is what makes this findable: the analyzer looks for evenly-spaced
  // brightness peaks rather than "a bright bit somewhere".
  mark('clapper', { label, pulses: CLAPPER_PULSES, periodMs: CLAPPER_PERIOD_MS });
  for (let i = 0; i < CLAPPER_PULSES; i++) {
    const at = Date.now() - t0;
    paintAll((f) => fill(f.leds, WHITE));
    timeline.push({ t: at, phase: 'clapper_pulse', index: i });
    await sleep(CLAPPER_ON_MS);
    paintAll((f) => fill(f.leds, BLACK));
    await sleep(CLAPPER_PERIOD_MS - CLAPPER_ON_MS);
  }
}

/** Light each fixture alone so the analyzer can learn where it is in frame. */
async function calibrate() {
  for (const target of fixtures) {
    mark('calibrate', { fixture: target.ip, leds: target.leds });
    await hold(3000, (f) => fill(f.leds, f.ip === target.ip ? WHITE : BLACK));
    await hold(500, (f) => fill(f.leds, BLACK));
  }
}

/** Does the fixture render two colours at once? The decisive segmentation test. */
async function spatial() {
  for (const target of fixtures) {
    const half = Math.floor(target.leds / 2);
    mark('spatial', { fixture: target.ip, leds: target.leds, half, a: RED, b: BLUE });
    await hold(holdMs, (f) => (f.ip === target.ip
      ? [...fill(half, RED), ...fill(f.leds - half, BLUE)]
      : fill(f.leds, BLACK)));
  }
}

/**
 * One lit pixel walking the fixture. Distinguishes true per-LED addressing (a discrete
 * spot advances) from endpoint blending (a smear that cannot resolve a single pixel).
 * This is the RAZER_PROFILES admission test.
 */
async function chase() {
  const stepMs = 400;
  for (const target of fixtures) {
    mark('chase', { fixture: target.ip, leds: target.leds, stepMs, laps: 2 });
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < target.leds; i++) {
        const colors = fill(target.leds, BLACK);
        colors[i] = WHITE;
        timeline.push({ t: Date.now() - t0, phase: 'chase_step', fixture: target.ip, index: i });
        for (const f of fixtures) {
          sendRazer(f.ip, encodeRazerFrame(f.ip === target.ip ? colors : fill(f.leds, BLACK)));
        }
        await sleep(stepMs);
      }
    }
    await hold(500, (f) => fill(f.leds, BLACK));
  }
}

/** Black → white step at a recorded instant; the analyzer measures how late it lands. */
async function latency() {
  for (let i = 0; i < 4; i++) {
    await hold(900, (f) => fill(f.leds, BLACK));
    const at = Date.now() - t0;
    timeline.push({ t: at, phase: 'latency_step', index: i });
    await hold(600, (f) => fill(f.leds, WHITE));
  }
}

// ---------------------------------------------------------------- run

console.log(`fixtures: ${fixtures.map((f) => `${f.ip}(${f.leds})`).join(', ')}`);
console.log('START RECORDING NOW — 5s until the sync clapper.\n');
await sleep(5000);

for (const f of fixtures) {
  sendRazer(f.ip, encodeRazerEnable(true));
}
await sleep(150);

try {
  await clapper('start');
  await calibrate();
  await spatial();
  await chase();
  await latency();
  await clapper('end');            // a second clapper bounds the run and catches drift
} finally {
  for (const f of fixtures) sendRazer(f.ip, encodeRazerEnable(false));
  await sleep(200);
  sock.close();
}

fs.mkdirSync(outDir, { recursive: true });
const timelinePath = path.join(outDir, 'timeline.json');
fs.writeFileSync(timelinePath, JSON.stringify({
  startedAt: new Date(t0).toISOString(),
  durationMs: Date.now() - t0,
  clapper: { pulses: CLAPPER_PULSES, periodMs: CLAPPER_PERIOD_MS, onMs: CLAPPER_ON_MS },
  fixtures,
  events: timeline,
}, null, 2));

console.log(`\nSTOP RECORDING. timeline → ${timelinePath}`);
console.log(`next: python3 verify/analyze.py <video> ${timelinePath}`);
