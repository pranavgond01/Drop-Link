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

function createTestClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);
  const queue = [];
  const waiters = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  const nextMessage = (timeoutMs = 5000) => {
    return new Promise((resolve, reject) => {
      if (queue.length > 0) {
        return resolve(queue.shift());
      }
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

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

test('HTTP /health endpoint returns security headers and status', async () => {
  const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.service, 'droplink-signaling');
});

test('HTTP unknown endpoint returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${serverPort}/unknown-route`);
  assert.equal(res.status, 404);
});

test('HTTP POST to /health returns 405 Method Not Allowed', async () => {
  const res = await fetch(`http://127.0.0.1:${serverPort}/health`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('WebSocket handshake and server-ready message', async () => {
  const client = createTestClient();
  await client.waitOpen();
  const readyMsg = await client.nextMessage();
  assert.equal(readyMsg.type, 'server-ready');
  assert.equal(readyMsg.service, 'droplink-signaling');
  client.ws.close();
});

test('Room creation, joining, signaling, and cleanup', async () => {
  const host = createTestClient();
  await host.waitOpen();
  const hostReady = await host.nextMessage();
  assert.equal(hostReady.type, 'server-ready');

  // Host creates room
  host.ws.send(JSON.stringify({ type: 'create-room' }));
  const createdMsg = await host.nextMessage();
  assert.equal(createdMsg.type, 'room-created');
  assert.equal(createdMsg.role, 'host');
  assert.match(createdMsg.room, /^[A-Z0-9]{6}$/);

  const roomCode = createdMsg.room;

  // Guest joins room
  const guest = createTestClient();
  await guest.waitOpen();
  const guestReady = await guest.nextMessage();
  assert.equal(guestReady.type, 'server-ready');

  guest.ws.send(JSON.stringify({ type: 'join-room', room: roomCode }));

  const [guestJoined, hostNotified] = await Promise.all([
    guest.nextMessage(),
    host.nextMessage(),
  ]);

  assert.equal(guestJoined.type, 'room-joined');
  assert.equal(guestJoined.role, 'guest');
  assert.equal(guestJoined.room, roomCode);

  assert.equal(hostNotified.type, 'peer-joined');
  assert.equal(hostNotified.room, roomCode);

  // Signaling from host to guest
  host.ws.send(JSON.stringify({
    type: 'signal',
    data: { kind: 'description', description: { type: 'offer', sdp: 'fake-sdp' } },
  }));

  const guestSignal = await guest.nextMessage();
  assert.equal(guestSignal.type, 'signal');
  assert.equal(guestSignal.from, 'host');
  assert.equal(guestSignal.data.kind, 'description');

  // Third peer attempting to join full room gets rejected
  const intruder = createTestClient();
  await intruder.waitOpen();
  await intruder.nextMessage(); // server-ready
  intruder.ws.send(JSON.stringify({ type: 'join-room', room: roomCode }));
  const intruderRes = await intruder.nextMessage();
  assert.equal(intruderRes.type, 'error');
  assert.match(intruderRes.message, /already full/i);
  intruder.ws.close();

  // Host disconnects, guest receives room-closed
  host.ws.close();
  const guestClosed = await guest.nextMessage();
  assert.equal(guestClosed.type, 'room-closed');

  guest.ws.close();
});

test('Invalid room code rejects with error', async () => {
  const client = createTestClient();
  await client.waitOpen();
  await client.nextMessage();

  client.ws.send(JSON.stringify({ type: 'join-room', room: 'INVALID_CODE_123' }));
  const res = await client.nextMessage();
  assert.equal(res.type, 'error');
  assert.match(res.message, /Invalid room code format/i);

  client.ws.close();
});
