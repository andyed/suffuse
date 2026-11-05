// Holds and hand-over. Hold files go to a temp directory, never ~/.suffuse;
// keepalives are stand-in child processes, and nothing here paints a lamp.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const holdsDirectory = await mkdtemp(join(tmpdir(), 'suffuse-holds-'));
process.env.SUFFUSE_HOLDS_DIR = holdsDirectory;
const { listHolds, readHold, stopKeepalive, takeOverHold, writeHold } = await import('../scripts/lan.mjs');

test.after(() => rm(holdsDirectory, { recursive: true, force: true }));

function standInKeepalive() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('stopKeepalive stops a live hold\'s keepalive and waits for it to exit', async () => {
  const { child, exited } = standInKeepalive();
  const stopped = await stopKeepalive({ pid: child.pid, expiresAt: Date.now() + 60_000 });
  assert.equal(stopped, true);
  assert.equal((await exited).signal, 'SIGTERM');
});

test('stopKeepalive never signals an expired hold, itself, or a malformed pid', async () => {
  const { child, exited } = standInKeepalive();
  try {
    // Past its expiry the loop has exited on its own, and the pid may be reused.
    assert.equal(await stopKeepalive({ pid: child.pid, expiresAt: Date.now() - 1 }), false);
    assert.equal(isAlive(child.pid), true);
    assert.equal(await stopKeepalive({ pid: process.pid, expiresAt: Date.now() + 60_000 }), false);
    assert.equal(await stopKeepalive({ pid: 'nope', expiresAt: Date.now() + 60_000 }), false);
    assert.equal(await stopKeepalive(null), false);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

test('takeOverHold stops the keepalive before it drops the hold, and restores nothing', async () => {
  const ip = '127.0.0.21';
  const { child, exited } = standInKeepalive();
  await writeHold(ip, { pid: child.pid, expiresAt: Date.now() + 60_000, label: 'Red Moon' });
  const taken = await takeOverHold(ip);
  assert.equal(taken.label, 'Red Moon');
  assert.equal((await exited).signal, 'SIGTERM');
  assert.equal(await readHold(ip), null);
  assert.deepEqual((await listHolds()).filter(hold => hold.ip === ip), []);
});

test('takeOverHold on an unheld or expired lamp returns null', async () => {
  assert.equal(await takeOverHold('127.0.0.22'), null);
  await writeHold('127.0.0.23', { pid: 2 ** 22 + 7, expiresAt: Date.now() - 1000, label: null });
  assert.equal(await takeOverHold('127.0.0.23'), null);
  assert.equal(await readHold('127.0.0.23'), null);
});

test('a solid over a live hold is still refused unless handed over on purpose', async () => {
  const { lanSetColor } = await import('../scripts/lan.mjs');
  const ip = '127.0.0.24';
  await writeHold(ip, { pid: 2 ** 22 + 9, expiresAt: Date.now() + 60_000, label: null });
  try {
    await assert.rejects(lanSetColor(ip, '#ff0000'), error => error.code === 'device-held' && /--hand-over/.test(error.message));
  } finally {
    await rm(join(holdsDirectory, '127-0-0-24.json'), { force: true });
  }
});

test('holdOwner tells a released hold, our own, and a newer owner apart', async () => {
  const { holdOwner } = await import('../scripts/lan.mjs');
  assert.equal(holdOwner(null, 10), 'none');
  assert.equal(holdOwner({ pid: 10 }, 10), 'self');
  assert.equal(holdOwner({ pid: '10' }, 10), 'self');
  assert.equal(holdOwner({ pid: 11 }, 10), 'other');
});

// The loop tests run the keepalive in-process against 127.0.0.1, so its razer
// frames go to a local port with no listener; no lamp is painted.
test('a superseded keepalive stops without repainting or releasing the newer hold', async () => {
  const { runHoldLoop } = await import('../scripts/lan.mjs');
  const ip = '127.0.0.1';
  const startedAt = Date.now();
  const loop = runHoldLoop(ip, [[1, 2, 3]], 5, { periodMs: 30 });
  await new Promise(resolve => setTimeout(resolve, 120));
  await writeHold(ip, { pid: 2 ** 22 + 11, expiresAt: Date.now() + 60_000, label: 'newer look' });
  await loop;
  assert.ok(Date.now() - startedAt < 2000, 'the old loop ran on toward its own TTL');
  const hold = await readHold(ip);
  assert.equal(hold?.label, 'newer look', 'the old loop deleted the newer hold');
  await rm(join(holdsDirectory, '127-0-0-1.json'), { force: true });
});

test('a keepalive that reaches its TTL still hands the lamp back', async () => {
  const { runHoldLoop } = await import('../scripts/lan.mjs');
  await runHoldLoop('127.0.0.1', [[1, 2, 3]], 0.15, { periodMs: 30 });
  assert.equal(await readHold('127.0.0.1'), null);
});

test('releaseHold stops the keepalive and waits for it before the disable', async () => {
  const { releaseHold } = await import('../scripts/lan.mjs');
  const ip = '127.0.0.1';
  const { child, exited } = standInKeepalive();
  await writeHold(ip, { pid: child.pid, expiresAt: Date.now() + 60_000, label: null });
  const released = await releaseHold(ip);
  assert.equal(released.pid, child.pid);
  const outcome = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
  assert.equal(outcome?.signal, 'SIGTERM');
  assert.equal(await readHold(ip), null);
});
