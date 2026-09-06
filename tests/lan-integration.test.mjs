import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { lanDevStatus, lanScan } from '../scripts/lan.mjs';

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
      timeoutMs: 200,
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
