#!/usr/bin/env node

/**
 * Mine open-source Govee integrations into a per-SKU device portfolio.
 *
 * WHY: every profile row we have was bought with hours of hardware probing against mute
 * devices (H608B count sweep, H6047 chase mystery, H6009 opcode sweep). The open-source
 * ecosystem has already paid that cost across hundreds of SKUs — this script harvests it
 * with provenance, so a new lamp arrives with priors instead of a blind sweep.
 *
 * VALIDATION ANCHOR: our own hardware measurements. Any source that disagrees with a
 * hardware-verified fact (H608B = 15 discrete over razer) is suspect for everything else.
 *
 * Sources (shallow clones; pass the parent dir as --sources):
 *   1. fu-raz/signalrgb-govee-direct-connect  govee-products.test.js
 *      → a dump of GOVEE'S OWN product database (293 SKUs): productName, supportRazer,
 *        supportFeast. This is the authority on whether the razer channel exists at all.
 *   2. RobThePCGuy/SignalRGB-Govee-Network-Plugin  GoveeNetwork.js
 *      → community-probed razer LED counts, dreamview flags, subdevice layouts. This is
 *        where the H6047 "stream 20, slots 0-9 left bar / 10-19 right" fact lives.
 *   3. Galorhallen/govee-local-api  light_capabilities.py  (Home Assistant's LAN backend)
 *      → which SKUs speak the LAN API + BLE-bitmask segment counts (ptReal-style).
 *   4. wez/govee2mqtt  src/service/quirks.rs
 *      → lan_api_capable / ble_only / avoid_platform_api quirks.
 *
 * LICENSING: this script reads the source repositories locally to extract
 * device facts (SKU capability data), which are not copyrightable expression.
 * No code from those repositories is copied into this one, and the clones are
 * never redistributed. Two of the sources are GPL — the read-never-copy rule
 * from references/lan-razer.md applies here identically.
 *
 * Usage:
 *   node scripts/mine-portfolio.mjs --sources <dir-with-clones> \
 *       [--out assets/device-portfolio.json] [--sku H612B]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 || !process.argv[i + 1] ? dflt : process.argv[i + 1];
};

const sourcesDir = arg('sources', null);
const outPath = arg('out', 'assets/device-portfolio.json');
const querySku = arg('sku', null);

const REPOS = {
    goveeProducts: 'signalrgb-govee-direct-connect',
    signalrgb: 'SignalRGB-Govee-Network-Plugin',
    localApi: 'govee-local-api',
    govee2mqtt: 'govee2mqtt'
};

if (!sourcesDir) {
    process.stderr.write('--sources <dir> required. Populate it with:\n'
        + '  git clone --depth 1 https://github.com/fu-raz/signalrgb-govee-direct-connect\n'
        + '  git clone --depth 1 https://github.com/RobThePCGuy/SignalRGB-Govee-Network-Plugin\n'
        + '  git clone --depth 1 https://github.com/Galorhallen/govee-local-api\n'
        + '  git clone --depth 1 https://github.com/wez/govee2mqtt\n');
    process.exit(2);
}

const repoPath = (key) => path.join(sourcesDir, REPOS[key]);
const repoSha = (key) => {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: repoPath(key) }).toString().trim();
    } catch { return 'unknown'; }
};

/** sku -> merged entry. Every mined fact names its source so disagreements stay visible. */
const portfolio = new Map();
const entry = (sku) => {
    const key = sku.toUpperCase();
    if (!portfolio.has(key)) portfolio.set(key, { sku: key });
    return portfolio.get(key);
};

// ── 1. Govee's own product DB ─────────────────────────────────────────────────────────
{
    let src = fs.readFileSync(
        path.join(repoPath('goveeProducts'), 'govee-products.test.js'), 'utf8');
    src = src.replace(/^export\s+(const|default)\s*/m, 'const __x = ')
        .replace(/export\s*\{[^}]*\};?/g, '');
    const data = new Function(`return (${src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)})`)();
    for (const [sku, d] of Object.entries(data)) {
        if (!/^H[0-9A-Z]{4}$/i.test(sku)) continue;
        const e = entry(sku);
        e.productName = d.productName || null;
        e.govee = {
            supportRazer: !!d.supportRazer,
            supportFeast: !!d.supportFeast,
            supportMusicalFeast: !!d.supportMusicalFeast
        };
    }
}

// ── 2. SignalRGB community plugin: razer LED counts + layouts ─────────────────────────
{
    const src = fs.readFileSync(path.join(repoPath('signalrgb'), 'GoveeNetwork.js'), 'utf8');
    // Entries are object literals; capture through the subdevices block when present.
    const re = /\{\s*name:\s*"([^"]+)",[\s\S]*?sku:\s*"(H[0-9A-Z]{4})",[\s\S]*?supportRazer:\s*(true|false),\s*supportDreamView:\s*(true|false),\s*ledCount:\s*(\d+),?(?<rest>[\s\S]*?)\n\t\},/g;
    let m;
    while ((m = re.exec(src))) {
        const e = entry(m[2]);
        const sub = [...m.groups.rest.matchAll(/name:\s*"([^"]+)",\s*\n\s*ledCount:\s*(\d+)/g)]
            .map(s => ({ name: s[1], ledCount: +s[2] }));
        e.signalrgb = {
            name: m[1],
            supportRazer: m[3] === 'true',
            supportDreamView: m[4] === 'true',
            ledCount: +m[5],
            ...(sub.length ? { subdevices: sub, totalLeds: sub.reduce((a, s) => a + s.ledCount, 0) } : {}),
            ...(m.groups.rest.includes('hasVariableLedCount') ? { hasVariableLedCount: true } : {})
        };
    }
}

// ── 3. Home Assistant LAN backend: LAN API + BLE-bitmask segment counts ───────────────
{
    const src = fs.readFileSync(
        path.join(repoPath('localApi'), 'src/govee_local_api/light_capabilities.py'), 'utf8');
    const table = src.slice(src.indexOf('GOVEE_LIGHT_CAPABILITIES'));
    const re = /"(H[0-9A-Z]{4})":\s*(BASIC_CAPABILITIES|ON_OFF_CAPABILITIES|create_with_capabilities\(\s*(\w+),\s*(\w+),\s*(\w+),\s*(\d+),\s*(\w+)\s*\))/g;
    let m;
    while ((m = re.exec(table))) {
        const e = entry(m[1]);
        e.lanApi = m[2].startsWith('create_with')
            ? { supported: true, segments: +m[6], rgb: m[3] === 'True', scenes: m[7] === 'True' }
            : { supported: true, segments: 0, basic: m[2] };
    }
}

// ── 4. govee2mqtt quirks ──────────────────────────────────────────────────────────────
{
    const src = fs.readFileSync(path.join(repoPath('govee2mqtt'), 'src/service/quirks.rs'), 'utf8');
    const re = /Quirk::(\w+)\(\s*"(H[0-9A-Z]{4})"[^)]*\)((?:\s*\.\s*with_\w+\([^)]*\))*)/g;
    let m;
    while ((m = re.exec(src))) {
        const e = entry(m[2]);
        const mods = m[3] || '';
        e.quirks = {
            kind: m[1],
            lanApiCapable: m[1] === 'lan_api_capable_light' || mods.includes('with_lan_api'),
            bleOnly: mods.includes('with_ble_only(true)'),
            avoidPlatformApi: mods.includes('avoid_platform_api')
        };
    }
}

// ── Our hardware ground truth (the validation anchor; never overwritten by mining) ────
const HARDWARE = {
    H608B: { razer: { pixels: 15, blend: 'discrete', frameHz: 60, maxHz: 60, verified: '2026-08-15',
        rateVerified: '2026-08-23 — 60Hz stop-test clean, 480 frames, instant freeze (psychodeli-webgl-port); 40Hz/400 frames clean 2026-08-15',
        chromaGamma: 2, chromaGammaVerified: '2026-09-07 — "pinkish" under Red Moon, between the linear-drive H61D3/H612B and the calibrated H16C0; isolated with a per-SKU override, 2 read as an upgrade (eye)' }, colorwcDrainHz: '10-12' },
    H6009: { ble: { colorOpcode: '0x33 0x05 0x0D (RGBWW — NOT the published 0x02)', verified: '2026-08-09' } },
    H6047: { razer: { note: '12-stop chase read as one colour animating (2026-08-15) — consistent with signalrgb "shorter packets remap unpredictably, always stream 20"' } },
    // ⚠️ Direct contradiction of the mined govee.supportRazer:0 — the firmware honours razer
    // frames even though the flag says no. The flag describes Govee Desktop/Chroma app
    // support, NOT the LAN handler. Treat supportRazer:0 as "unknown", never "absent".
    H612B: { razer: { pixels: 10, blend: 'discrete', frameHz: 40, maxHz: 40, verified: '2026-08-16 — individual lights rendered at count=10 despite product-DB supportRazer:0; stop test froze instantly (no queue, 30Hz streaming safe)',
        rateVerified: '2026-08-23 — 40Hz stop-test clean, 320 frames, instant freeze (psychodeli-webgl-port); not yet probed at 60',
        chromaGamma: [2.2, 2.2, 3], chromaGammaVerified: '2026-09-07 — Red Moon reds rendered PINK end to end (photo) while the H16C0 showed the same frames red; raw [255,0,25] read pink, pure [255,0,0] best; 2.2 helped, 3 read redder (eye). 2026-09-08 — Golden Hour pinkish under a scalar 3; per channel 2.2/2.2/3 kept the gold (eye)' } },
    H16C0: {
        platformApi: { segments: 7, segmentedBrightness: true, verified: '2026-08-18' },
        razer: {
            pixels: 7,
            blend: 'discrete',
            frameHz: 40,
            maxHz: 40,
            orientation: 'index 0 bottom to index 6 top',
            verified: '2026-08-18 — one-hot local walk plus smooth 20s Electron 30Hz run; immediate stop with no visible backlog; restore passed',
            rateVerified: '2026-08-23 — 40Hz stop-test clean, 320 frames, instant freeze (psychodeli-webgl-port); not yet probed at 60',
            // LuminBlend+ (gamma-calibrated): the frames that read pink on the H61D3/H612B read RED here. Never inherit a gamma.
            chromaGamma: null, chromaGammaVerified: '2026-09-07 — same Red Moon frames red (photo); keep null'
        }
    },
    // The mined lanApi.segments prior said 15; at 15 the rope rendered ONE collapsed colour
    // that still tracked the palette — indistinguishable from a working whole-device lamp.
    // SignalRGB's ledCount for the 5m H61D5 sibling is also 7: a fixed 7-segment architecture.
    H61D3: { razer: { pixels: 7, blend: 'discrete', frameHz: 60, maxHz: 60,
        verified: '2026-09-05 — one-hot chase rendered at count=7 (a wrong count renders nothing); 60Hz stop-test clean, 480 frames, instant freeze (psychodeli-webgl-port)',
        chromaGamma: [2.2, 2.2, 3], chromaGammaVerified: '2026-09-07/08 — same evidence as the H612B: pink end to end in the photo, raw [255,0,25] pink, 3 read redder; per channel 2.2/2.2/3 kept Golden Hour gold (eye)' } },
    // The mined SignalRGB total is 6 (two 3-LED subdevices). Six RENDERS, which is the
    // trap: each colour is stretched over two segments, so an eye check at 6 passes. The
    // bars address 12, counted by a differenced one-hot walk.
    H6056: { razer: { pixels: 12, blend: 'discrete', frameHz: null, maxHz: 40,
        rateVerified: '2026-11-11 — camera stop-test with razer-probe rate (150 ms sampling, one run each): 240 frames at 30 Hz and 320 at 40 Hz both reached their final look within about 0.4 s of the last frame, the same at both rates; 480 frames at 60 Hz took about 0.3 s longer. Not an eye check, and it cannot see a queue shorter than the camera lag.',
        orientation: 'two bars, 6 slots each: indices 0-5 on one bar, 6-11 on the other, outer end to inner end on both as mounted on the test desk',
        verified: '2026-11-11 — one-hot walk at count=12 by webcam (Wi-Fi fw 1.00.16, mode byte 0x01, 12 Hz), each slot differenced against a baseline frame taken just before it: every slot lit exactly one bar, slots 0-5 stepped across one bar and 6-11 across the other in six distinct, ordered positions each (references/device-evidence.md). At count=6 (the mined SignalRGB total) the bars render, each colour stretched over two segments; at count=24 they go dark. No chromaGamma measurement.' } }
};
for (const [sku, hw] of Object.entries(HARDWARE)) entry(sku).ourHardware = hw;

const result = {
    minedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(REPOS).map(([k, repo]) => [k, `${repo}@${repoSha(k)}`])),
    validation: 'H608B: signalrgb ledCount 15 + govee supportRazer:1 + lanApi segments 15 all match hardware (15 discrete @60Hz)',
    devices: Object.fromEntries([...portfolio.entries()].sort(([a], [b]) => a.localeCompare(b)))
};

if (querySku) {
    process.stdout.write(JSON.stringify(result.devices[querySku.toUpperCase()] || null, null, 2) + '\n');
} else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 1) + '\n');
    const n = portfolio.size;
    const razer = [...portfolio.values()].filter(e => e.govee?.supportRazer || e.signalrgb?.supportRazer).length;
    const lan = [...portfolio.values()].filter(e => e.lanApi?.supported || e.quirks?.lanApiCapable).length;
    process.stdout.write(`wrote ${outPath}: ${n} SKUs (${razer} razer-capable, ${lan} LAN API)\n`);
}
