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

test('a measured count outranks a mined one that renders (H6056: 6 stretches, 12 is the count)', async () => {
  const entry = await portfolioEntry('H6056');
  assert.equal(entry.signalrgb.totalLeds, 6); // the mined count renders, at half resolution
  const p = priors(entry);
  assert.equal(p.razer.status, 'verified');
  assert.deepEqual(p.razer.votes[0].source, 'hardware');
  assert.equal(p.razer.votes[0].pixels, 12);
  // The mined vote stays visible beside it, as the total across subdevices, not a 0.
  assert.deepEqual(p.razer.votes.find((v) => v.source === 'signalrgb'), { source: 'signalrgb', pixels: 6 });
  // Promoted on a differenced one-hot walk that counted all 12 positions. The cap is
  // from a camera stop-test; no sustained rate is claimed without an eye-watched stop.
  assert.equal(RAZER_PROFILES.H6056.pixels, 12);
  assert.equal(RAZER_PROFILES.H6056.verified, true);
  assert.equal(RAZER_PROFILES.H6056.frameHz, null);
  assert.equal(RAZER_PROFILES.H6056.maxHz, 40);
  assert.equal(entry.ourHardware.razer.maxHz, 40);
  assert.ok(entry.ourHardware.razer.rateVerified);
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
