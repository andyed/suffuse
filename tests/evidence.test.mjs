import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  appendEvidence,
  createEvidenceTransaction,
  evidenceFromReceipt,
  openUncertainty,
  summarizeEvidence
} from '../scripts/evidence.mjs';

const at = new Date('2026-08-20T12:00:00.000Z');
const execFileAsync = promisify(execFile);
const root = new URL('..', import.meta.url);

test('cloud acceptance remains distinct from visual verification', () => {
  const evidence = createEvidenceTransaction({
    transport: 'cloud',
    requestedState: { executionMode: 'solid', operationCount: 1 },
    transportFacts: { protocolAcknowledgment: 'service-response' },
    id: 'tx-cloud',
    at
  });
  appendEvidence(evidence, {
    kind: 'query', status: 'captured', source: 'cloud-state', facts: { restoreOperationCount: 2 }
  }, { at });
  appendEvidence(evidence, {
    kind: 'protocol', status: 'accepted', source: 'govee-cloud', facts: { label: 'color', code: 200 }
  }, { at });
  appendEvidence(evidence, {
    kind: 'visual', status: 'not-observed', source: 'suffuse', facts: {}
  }, { at });
  openUncertainty(evidence, 'appearance-unverified', 'No visual observation is recorded.', { at });

  const summary = summarizeEvidence(evidence);
  assert.equal(summary.application.status, 'accepted');
  assert.equal(summary.application.appearance, 'not-observed');
  assert.equal(summary.application.statement, 'Command accepted but appearance unverified.');
  assert.deepEqual(summary.residualUncertainty, [{
    code: 'appearance-unverified', detail: 'No visual observation is recorded.'
  }]);
});

test('mute transports report sent without laundering it into acceptance', () => {
  const evidence = createEvidenceTransaction({
    transport: 'ble',
    requestedState: { executionMode: 'ble-one-shot', operationCount: 3 },
    id: 'tx-ble',
    at
  });
  appendEvidence(evidence, {
    kind: 'query', status: 'unavailable', source: 'ble', facts: { reason: 'no-readback' }
  }, { at });
  for (const channel of ['power', 'color', 'brightness']) {
    appendEvidence(evidence, {
      kind: 'protocol', status: 'sent-unacknowledged', source: 'ble-write-without-response', facts: { channel }
    }, { at });
  }
  appendEvidence(evidence, {
    kind: 'visual', status: 'not-observed', source: 'suffuse', facts: {}
  }, { at });

  const summary = summarizeEvidence(evidence);
  assert.equal(summary.selectedTransport, 'ble');
  assert.equal(summary.application.status, 'sent-unacknowledged');
  assert.equal(summary.application.protocolOperations, 3);
  assert.match(summary.application.statement, /without device acknowledgment/);
});

test('restoration attempt is classified separately from restoration coverage', () => {
  const evidence = createEvidenceTransaction({
    transport: 'lan', requestedState: { executionMode: 'lan-per-led' }, id: 'tx-restore', at
  });
  openUncertainty(evidence, 'restoration-coverage', 'Prior per-LED state is not queryable.', { at });
  appendEvidence(evidence, {
    kind: 'restoration', status: 'started', source: 'suffuse', facts: { operationCount: 2 }
  }, { at });
  appendEvidence(evidence, {
    kind: 'restoration', status: 'completed', source: 'lan', facts: { operationCount: 2 }
  }, { at });

  const summary = summarizeEvidence(evidence);
  assert.equal(summary.restoration.status, 'completed');
  assert.equal(summary.residualUncertainty[0].code, 'restoration-coverage');
});

test('legacy v1 receipts gain an inferred evidence boundary without changing their contract', () => {
  const evidence = evidenceFromReceipt({
    version: 1,
    createdAt: at.toISOString(),
    status: 'applied',
    transport: 'lan',
    plan: { executionMode: 'lan-per-led' },
    restoreOperations: [{ action: 'razer-disable' }],
    restoreCoverage: { warning: 'Prior per-LED state is unavailable.' }
  }, { id: 'legacy-tx' });
  const summary = summarizeEvidence(evidence);
  assert.equal(summary.transactionId, 'legacy-tx');
  assert.equal(summary.application.status, 'sent-unacknowledged');
  assert.equal(summary.queryResult.status, 'captured');
  assert.ok(summary.residualUncertainty.some(item => item.code === 'appearance-unverified'));
});

test('invalid evidence states fail closed', () => {
  const evidence = createEvidenceTransaction({
    transport: 'cloud', requestedState: {}, id: 'tx-invalid', at
  });
  assert.throws(() => appendEvidence(evidence, {
    kind: 'protocol', status: 'visually-confirmed', source: 'test', facts: {}
  }, { at }), /Invalid evidence event/);
});

test('read-only receipt inspection returns classification without household identifiers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suffuse-evidence-'));
  const path = join(directory, 'private.receipt.json');
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      createdAt: at.toISOString(),
      status: 'applied',
      transport: 'lan',
      plan: { executionMode: 'lan-per-led', target: { device: 'AA:BB:CC', ip: '192.168.1.34' } },
      restoreOperations: [{ action: 'razer-disable', ip: '192.168.1.34' }],
      restoreCoverage: { complete: false, warning: 'Prior per-LED state is unavailable.' }
    }));
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/govee.mjs', 'evidence', '--receipt', path
    ], { cwd: root });
    const output = JSON.parse(stdout);
    assert.equal(output.readOnly, true);
    assert.equal(output.evidence.selectedTransport, 'lan');
    assert.doesNotMatch(stdout, /AA:BB:CC|192\.168\.1\.34/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed restore attempt is persisted before any later retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suffuse-restore-evidence-'));
  const path = join(directory, 'private.receipt.json');
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      createdAt: at.toISOString(),
      status: 'applied',
      transport: 'cloud',
      plan: { executionMode: 'solid' },
      outcomes: [{ label: 'color', ok: true, code: 200 }],
      restoreOperations: [],
      restoreCoverage: { complete: false, warning: 'No state captured.' }
    }), { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, [
      'scripts/govee.mjs', 'restore', '--receipt', path, '--confirm-write'
    ], { cwd: root }), error => {
      assert.match(error.stderr, /restore-unavailable/);
      return true;
    });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    const summary = summarizeEvidence(persisted.evidence);
    assert.equal(summary.restoration.status, 'failed');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
