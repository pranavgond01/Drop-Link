import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const rooms = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createRoomCode() {
  let code = '';

  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));

  return code;
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, except = null) {
  for (const peer of room.peers) {
    if (peer !== except) {
      sendJson(peer, payload);
    }
  }
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);

  if (!room) {
    return;
  }

  if (
    room.peers.size === 0 ||
    Date.now() - room.createdAt > TTL_MS
  ) {
    for (const peer of room.peers) {
      sendJson(peer, {
        type: 'room-closed',
        reason: 'Room expired or closed.',
      });

      try {
        peer.close();
      } catch {
        // Ignore close errors.
      }
    }

    rooms.delete(roomCode);
  }
}

function leaveRoom(ws) {
  const roomCode = ws.meta?.roomCode;

  if (!roomCode) {
    return;
  }

  const room = rooms.get(roomCode);

  ws.meta.roomCode = null;
  ws.meta.role = null;

  if (!room) {
    return;
  }

  room.peers.delete(ws);

  broadcast(
    room,
    {
      type: 'peer-left',
    },
    ws
  );

  if (room.peers.size === 0) {
    rooms.delete(roomCode);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
    });

    res.end(
      JSON.stringify({
        ok: true,
        service: 'droplink-signaling',
        rooms: rooms.size,
        time: new Date().toISOString(),
      })
    );

    return;
  }

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
  });

  res.end('DropLink signaling server is running.');
});

const wss = new WebSocketServer({
  server,
});

wss.on('connection', (ws) => {
  ws.meta = {
    roomCode: null,
    role: null,
  };

  sendJson(ws, {
    type: 'server-ready',
    service: 'droplink-signaling',
    version: 1,
  });

  ws.on('message', (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, {
        type: 'error',
        message: 'Invalid JSON message.',
      });

      return;
    }

    if (
      !message ||
      typeof message.type !== 'string'
    ) {
      sendJson(ws, {
        type: 'error',
        message: 'Missing message type.',
      });

      return;
    }

    if (message.type === 'create-room') {
      if (ws.meta.roomCode) {
        sendJson(ws, {
          type: 'error',
          message: 'You are already in a room.',
        });

        return;
      }

      const roomCode = createRoomCode();

      const room = {
        code: roomCode,
        host: ws,
        peers: new Set([ws]),
        createdAt: Date.now(),
      };

      rooms.set(roomCode, room);

      ws.meta.roomCode = roomCode;
      ws.meta.role = 'host';

      sendJson(ws, {
        type: 'room-created',
        room: roomCode,
        role: 'host',
      });

      return;
    }

    if (message.type === 'join-room') {
      if (ws.meta.roomCode) {
        sendJson(ws, {
          type: 'error',
          message: 'You are already in a room.',
        });

        return;
      }

      const roomCode = String(
        message.room || ''
      )
        .trim()
        .toUpperCase();

      const room = rooms.get(roomCode);

      if (!room) {
        sendJson(ws, {
          type: 'error',
          message: 'Room not found.',
        });

        return;
      }

      cleanupRoom(roomCode);

      const refreshedRoom = rooms.get(roomCode);

      if (!refreshedRoom) {
        sendJson(ws, {
          type: 'error',
          message: 'Room expired.',
        });

        return;
      }

      if (refreshedRoom.peers.size >= 2) {
        sendJson(ws, {
          type: 'error',
          message: 'Room is full.',
        });

        return;
      }

      refreshedRoom.peers.add(ws);

      ws.meta.roomCode = roomCode;
      ws.meta.role = 'guest';

      sendJson(ws, {
        type: 'room-joined',
        room: roomCode,
        role: 'guest',
      });

      sendJson(refreshedRoom.host, {
        type: 'peer-joined',
        room: roomCode,
      });

      return;
    }

    if (message.type === 'signal') {
      const roomCode = ws.meta.roomCode;

      const room = roomCode
        ? rooms.get(roomCode)
        : null;

      if (!room) {
        sendJson(ws, {
          type: 'error',
          message: 'No active room.',
        });

        return;
      }

      broadcast(
        room,
        {
          type: 'signal',
          from: ws.meta.role,
          data: message.data,
        },
        ws
      );

      return;
    }

    if (message.type === 'leave-room') {
      leaveRoom(ws);
      return;
    }

    if (message.type === 'ping') {
      sendJson(ws, {
        type: 'pong',
        at: Date.now(),
      });

      return;
    }

    sendJson(ws, {
      type: 'error',
      message: `Unknown message type: ${message.type}`,
    });
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

setInterval(() => {
  for (const code of rooms.keys()) {
    cleanupRoom(code);
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(
    `DropLink signaling: ws://${HOST}:${PORT}`
  );

  console.log(
    `Health check: http://127.0.0.1:${PORT}/health`
  );
});