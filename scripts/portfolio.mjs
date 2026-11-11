#!/usr/bin/env node

/**
 * Read-only lookup over the mined device portfolio (assets/device-portfolio.json):
 * per-SKU priors harvested from four open-source Govee integrations, each fact
 * tagged with its source, anchored against this project's own hardware
 * measurements. See references/device-portfolio.md for provenance and the rules
 * for reading it.
 *
 * THE ONE RULE consumers must apply: a mined POSITIVE is trustworthy, a mined
 * NEGATIVE is only "unknown". Vendor capability flags describe what an app
 * offers, not what the firmware accepts (H612B: supportRazer 0, renders 10
 * discrete pixels). `priors()` below encodes this — it never returns
 * "unsupported", only "corroborated" or "unknown".
 *
 * And the second: "corroborated" is a CANDIDATE, never a drive decision. A
 * consumer may drive a mined count only after a person watched a contrasting
 * test and said it lit (the qualification contract in
 * references/device-portfolio.md); Suffuse's own lan paint refuses any SKU
 * without a RAZER_PROFILES entry.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const PORTFOLIO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'device-portfolio.json');

let cached = null;

export async function loadPortfolio() {
  if (!cached) cached = JSON.parse(await readFile(PORTFOLIO_PATH, 'utf8'));
  return cached;
}

export async function portfolioEntry(sku) {
  const { devices } = await loadPortfolio();
  return devices[String(sku ?? '').toUpperCase().trim()] ?? null;
}

/**
 * Distill an entry into agent-usable priors. Positive evidence is reported with
 * its source; absent or negative flags collapse to "unknown", never "no".
 */
export function priors(entry) {
  if (!entry) return null;
  const out = { sku: entry.sku, productName: entry.productName ?? null };

  const razerVotes = [];
  if (entry.ourHardware?.razer?.pixels) {
    razerVotes.push({ source: 'hardware', pixels: entry.ourHardware.razer.pixels, note: entry.ourHardware.razer.verified });
  }
  if (entry.signalrgb?.supportRazer) {
    // A subdivided fixture carries its count as totalLeds and a ledCount of 0 (H6047: 20, H6056: 6).
    razerVotes.push({ source: 'signalrgb', pixels: entry.signalrgb.totalLeds || entry.signalrgb.ledCount || null });
  }
  if (entry.govee?.supportRazer) {
    razerVotes.push({ source: 'govee-product-db', pixels: null });
  }
  out.razer = razerVotes.length
    ? { status: razerVotes[0].source === 'hardware' ? 'verified' : 'corroborated', votes: razerVotes }
    : { status: 'unknown', votes: [] }; // mined negatives do not exist; see header

  out.lanApi = entry.lanApi?.supported || entry.quirks?.lanApiCapable
    ? { status: 'corroborated', segments: entry.lanApi?.segments ?? null }
    : { status: 'unknown' };

  if (entry.quirks?.bleOnly) out.bleOnly = true;
  if (entry.quirks?.avoidPlatformApi) out.avoidPlatformApi = true;
  if (entry.signalrgb?.subdevices) out.subdevices = entry.signalrgb.subdevices;
  if (entry.ourHardware) out.hardware = entry.ourHardware;
  return out;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const sku = process.argv[2];
  const data = await loadPortfolio();
  if (!sku) {
    const devices = Object.values(data.devices);
    const razer = devices.filter((e) => e.govee?.supportRazer || e.signalrgb?.supportRazer).length;
    const lan = devices.filter((e) => e.lanApi?.supported || e.quirks?.lanApiCapable).length;
    process.stdout.write(`${devices.length} SKUs (${razer} razer-flagged, ${lan} LAN API), mined ${data.minedAt}\n`);
    process.stdout.write(`sources: ${Object.values(data.sources).join(', ')}\n`);
    process.stdout.write('usage: node scripts/portfolio.mjs <SKU>\n');
  } else {
    const entry = await portfolioEntry(sku);
    if (!entry) {
      process.stdout.write(`${sku.toUpperCase()}: not in portfolio — that means UNKNOWN, not unsupported.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({ priors: priors(entry), raw: entry }, null, 2) + '\n');
    }
  }
}
