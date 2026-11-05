import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPortfolio, portfolioEntry, priors } from '../scripts/portfolio.mjs';
import { RAZER_PROFILES } from '../scripts/lan.mjs';

test('portfolio is present, provenance-pinned, and substantial', async () => {
  const data = await loadPortfolio();
  assert.ok(Object.keys(data.devices).length >= 300);
  assert.ok(data.minedAt);
  // Every source names its commit so a claim can be traced to the bytes it came from.
  for (const source of Object.values(data.sources)) assert.match(source, /@[0-9a-f]+$|@unknown$/);
  assert.ok(data.validation.includes('H608B'));
});

test('hardware anchors agree with RAZER_PROFILES', async () => {
  // The portfolio and the shipping profiles must never diverge on measured facts.
  for (const [sku, profile] of Object.entries(RAZER_PROFILES)) {
    const entry = await portfolioEntry(sku);
    assert.ok(entry, `${sku} missing from portfolio`);
    const hw = entry.ourHardware?.razer;
    if (profile.verified) {
      assert.equal(hw?.pixels, profile.pixels, `${sku}: portfolio hardware pixels != profile`);
    }
    if (profile.frameHz !== null) {
      assert.equal(hw?.frameHz, profile.frameHz, `${sku}: portfolio frameHz != profile`);
      assert.equal(hw?.maxHz, profile.maxHz, `${sku}: portfolio maxHz != profile`);
      assert.ok(hw?.rateVerified || /Hz/.test(hw?.verified ?? ''), `${sku}: a shipped rate needs its evidence`);
    }
    if (profile.chromaGamma !== null) {
      assert.deepEqual(hw?.chromaGamma, profile.chromaGamma, `${sku}: portfolio chromaGamma != profile`);
      assert.ok(hw?.chromaGammaVerified, `${sku}: a shipped chromaGamma needs its evidence`);
    }
  }
});

test('mined negatives read as unknown, never unsupported (H612B rule)', async () => {
  const entry = await portfolioEntry('H612B');
  assert.equal(entry.govee.supportRazer, false); // Govee's own DB denies it...
  const p = priors(entry);
  assert.equal(p.razer.status, 'verified');      // ...and the hardware vote outranks the flag.
  assert.equal(p.razer.votes[0].source, 'hardware');
  assert.equal(p.razer.votes[0].pixels, 10);
});

test('priors never fabricate a negative', async () => {
  const data = await loadPortfolio();
  for (const entry of Object.values(data.devices)) {
    const p = priors(entry);
    assert.ok(['verified', 'corroborated', 'unknown'].includes(p.razer.status));
    assert.ok(['corroborated', 'unknown'].includes(p.lanApi.status));
  }
  assert.equal(priors(null), null);
  assert.equal(await portfolioEntry('H0000'), null);
});
