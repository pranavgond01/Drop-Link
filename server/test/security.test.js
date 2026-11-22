import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createSignalingServer } from '../src/index.js';

let serverInstance;
let wssInstance;
let serverPort;

before(async () => {
  const res = createSignalingServer();
  serverInstance = res.server;
  wssInstance = res.wss;

  await new Promise((resolve) => {
    serverInstance.listen(0, '127.0.0.1', () => {
      serverPort = serverInstance.address().port;
      resolve();
    });
  });
});

after(async () => {
  wssInstance.close();
  await new Promise((resolve) => serverInstance.close(resolve));
});

function createClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);
  const queue = [];
  const waiters = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length > 0) {
      waiters.shift()(msg);
    } else {
      queue.push(msg);
    }
  });

  const nextMessage = (timeoutMs = 4000) => {
    return new Promise((resolve, reject) => {
      if (queue.length > 0) return resolve(queue.shift());
      const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };

  const waitOpen = () =>
    new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  return { ws, waitOpen, nextMessage };
}

test('Brute force join lockout after repeated failed attempts', async () => {
  const client = createClient();
  await client.waitOpen();
  await client.nextMessage(); // server-ready

  // 5 failed attempts with non-existent rooms
  for (let i = 0; i < 5; i++) {
    client.ws.send(JSON.stringify({ type: 'join-room', room: `FAKE${i}9` }));
    const res = await client.nextMessage();
    assert.equal(res.type, 'error');
  }

  // 6th attempt should be locked out
  client.ws.send(JSON.stringify({ type: 'join-room', room: 'FAKEX9' }));
  const lockedRes = await client.nextMessage();
  assert.equal(lockedRes.type, 'error');
  assert.match(lockedRes.message, /Too many failed join attempts/i);

  client.ws.close();
});

test('Oversized payload rejection', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);
  await new Promise((resolve) => ws.on('open', resolve));

  const hugeString = 'X'.repeat(70 * 1024); // 70 KB > 64 KB limit
  ws.send(hugeString);

  // Connection should be closed by server with code 1009 (Message Too Big)
  const closeEvent = await new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  assert.equal(closeEvent.code, 1009);
});
