import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { lanDevStatus, lanDevStatusRead, lanScan } from '../scripts/lan.mjs';

function parseMessage(buffer) {
  return JSON.parse(buffer.toString('utf8').replace(/\0+$/, ''));
}

async function startFakeDevice() {
  const socket = dgram.createSocket('udp4');
  const commands = [];
  socket.on('message', (buffer, remote) => {
    const message = parseMessage(buffer);
    const command = message?.msg?.cmd;
    commands.push(command);
    if (command === 'scan') {
      const response = {
        msg: {
          cmd: 'scan',
          data: {
            device: 'AA:BB:CC:11:22:33',
            sku: 'H608B',
            ip: '127.0.0.1',
            wifiVersionSoft: '9.9.9-test'
          }
        }
      };
      socket.send(Buffer.from(JSON.stringify(response)), remote.port, remote.address);
    } else if (command === 'devStatus') {
      const response = {
        msg: {
          cmd: 'devStatus',
          data: {
            onOff: 1,
            brightness: 42,
            color: { r: 12, g: 34, b: 56 },
            colorTemInKelvin: 0
          }
        }
      };
      socket.send(Buffer.from(JSON.stringify(response)), remote.port, remote.address);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  return {
    socket,
    commands,
    port: socket.address().port,
    close: () => new Promise(resolve => socket.close(resolve))
  };
}

test('loopback Govee device exercises LAN discovery and live state readback', async () => {
  const fake = await startFakeDevice();
  try {
    const devices = await lanScan({
      timeoutMs: 80,
      scanIps: ['127.0.0.1'],
      includeMulticast: false,
      replyPort: 0,
      scanPort: fake.port,
      commandPort: fake.port
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].device, 'AA:BB:CC:11:22:33');
    assert.equal(devices[0].sku, 'H608B');
    assert.equal(devices[0].ip, '127.0.0.1');

    const state = await lanDevStatus('127.0.0.1', {
      replyMs: 200,
      replyPort: 0,
      commandPort: fake.port
    });
    assert.equal(state.onOff, 1);
    assert.equal(state.brightness, 42);
    assert.deepEqual(state.color, { r: 12, g: 34, b: 56 });
    assert.ok(fake.commands.includes('scan'));
    assert.ok(fake.commands.includes('devStatus'));
  } finally {
    await fake.close();
  }
});

// A lamp that drops or delays devStatus replies — the Wi-Fi conditions behind
// the 2026-10-17 "offline on first start" reports (psychodeli-webgl-port).
async function startSlowStatusDevice({ dropAsks = 0, delayMs = 0 } = {}) {
  const socket = dgram.createSocket('udp4');
  let asks = 0;
  const pending = new Set();
  socket.on('message', (buffer, remote) => {
    if (parseMessage(buffer)?.msg?.cmd !== 'devStatus') return;
    asks += 1;
    if (asks <= dropAsks) return;
    const reply = { msg: { cmd: 'devStatus', data: { onOff: 1, brightness: 7, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } } };
    const timer = setTimeout(() => {
      pending.delete(timer);
      socket.send(Buffer.from(JSON.stringify(reply)), remote.port, remote.address);
    }, delayMs);
    pending.add(timer);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  return {
    port: socket.address().port,
    asks: () => asks,
    close: () => {
      for (const timer of pending) clearTimeout(timer);
      return new Promise(resolve => socket.close(resolve));
    }
  };
}

const statusOptions = port => ({ replyMs: 120, replyPort: 0, commandPort: port });

test('devStatus asks again when the first reply is lost, and says which ask answered', async () => {
  const fake = await startSlowStatusDevice({ dropAsks: 2 });
  try {
    const read = await lanDevStatusRead('127.0.0.1', statusOptions(fake.port));
    assert.equal(read.state.brightness, 7);
    assert.equal(read.asks, 3);
    assert.equal(read.answeredOnAsk, 3);
  } finally {
    await fake.close();
  }
});

test('a late reply to an earlier devStatus ask still counts', async () => {
  // Every reply lands 180 ms after its ask, past the 120 ms window: the reply to
  // ask 1 arrives inside ask 2's window and must be accepted, not discarded.
  const fake = await startSlowStatusDevice({ delayMs: 180 });
  try {
    const read = await lanDevStatusRead('127.0.0.1', statusOptions(fake.port));
    assert.equal(read.state.brightness, 7);
    assert.equal(read.asks, 2);
    assert.equal(read.answeredOnAsk, 2);
  } finally {
    await fake.close();
  }
});

test('a prompt lamp costs one ask, not the window', async () => {
  const fake = await startSlowStatusDevice();
  try {
    const read = await lanDevStatusRead('127.0.0.1', { ...statusOptions(fake.port), replyMs: 2000 });
    assert.equal(read.asks, 1);
    assert.equal(read.answeredOnAsk, 1);
    assert.ok(read.elapsedMs < 1000, `answered in ${read.elapsedMs} ms`);
  } finally {
    await fake.close();
  }
});

test('devStatus gives up after the configured asks and reports none answered', async () => {
  const fake = await startSlowStatusDevice({ dropAsks: Infinity });
  try {
    const read = await lanDevStatusRead('127.0.0.1', statusOptions(fake.port));
    assert.equal(read.state, null);
    assert.equal(read.asks, 3);
    assert.equal(read.answeredOnAsk, null);
    assert.equal(fake.asks(), 3);
  } finally {
    await fake.close();
  }
});
