import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../../web/dist');

const rooms = new Map();
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// High-Concurrency & Anti-DDoS Configuration
const MAX_TOTAL_ROOMS = 50_000;
const MAX_PAYLOAD_SIZE = 64 * 1024; // 64 KB max WebSocket frame
const MAX_CONCURRENT_PER_IP = 250; // generous for large corporate/school Wi-Fi networks
const MAX_MESSAGES_PER_SEC = 100;
const MAX_ROOM_CREATIONS_PER_MIN = 60;
const MAX_FAILED_JOINS_BEFORE_LOCKOUT = 5;
const LOCKOUT_DURATION_MS = 30_000;

// Memory Threshold for Overload Protection (in MB)
const MAX_HEAP_MB = 1024;

// In-memory rate limiting state
const ipConnections = new Map();
const ipRoomCreations = new Map();
const ipFailedJoins = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip, creationsMap, maxPerMin) {
  const now = Date.now();
  const timestamps = (creationsMap.get(ip) || []).filter((t) => now - t < 60_000);
  if (timestamps.length >= maxPerMin) {
    return false;
  }
  timestamps.push(now);
  creationsMap.set(ip, timestamps);
  return true;
}

function isJoinLocked(ip) {
  const state = ipFailedJoins.get(ip);
  if (!state) return false;
  if (state.lockedUntil && Date.now() < state.lockedUntil) {
    return true;
  }
  if (state.lockedUntil && Date.now() >= state.lockedUntil) {
    ipFailedJoins.delete(ip);
    return false;
  }
  return false;
}

function recordFailedJoin(ip) {
  const now = Date.now();
  const state = ipFailedJoins.get(ip) || { count: 0, lockedUntil: 0 };
  state.count += 1;
  if (state.count >= MAX_FAILED_JOINS_BEFORE_LOCKOUT) {
    state.lockedUntil = now + LOCKOUT_DURATION_MS;
    console.warn(`[Security] IP ${ip} temporarily throttled due to repeated failed room joins.`);
  }
  ipFailedJoins.set(ip, state);
}

function resetFailedJoins(ip) {
  ipFailedJoins.delete(ip);
}

function createRoomCode() {
  let code = '';
  let attempts = 0;
  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]
    ).join('');
    attempts += 1;
    if (attempts > 10_000) {
      throw new Error('Room code space exhausted.');
    }
  } while (rooms.has(code));
  return code;
}

export function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      // Socket closed or error during write
    }
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
  if (!room) return;
  const isExpired = Date.now() - room.createdAt > TTL_MS;
  const isEmpty = room.peers.size === 0;

  if (isEmpty || isExpired) {
    for (const peer of room.peers) {
      sendJson(peer, {
        type: 'room-closed',
        reason: isExpired ? 'Room expired after 2 hours.' : 'Room was closed.',
      });
      try {
        peer.close();
      } catch {
        // Ignore
      }
    }
    rooms.delete(roomCode);
  }
}

function leave(ws) {
  const roomCode = ws.meta?.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  const role = ws.meta?.role;

  ws.meta.roomCode = null;
  ws.meta.role = null;

  if (!room) return;

  room.peers.delete(ws);

  if (room.peers.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (role === 'host') {
    broadcast(room, {
      type: 'room-closed',
      reason: 'The host has left the room.',
    });
    for (const peer of room.peers) {
      peer.meta.roomCode = null;
      peer.meta.role = null;
    }
    rooms.delete(roomCode);
  } else {
    broadcast(room, { type: 'peer-left' }, ws);
  }
}

function serveStaticFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Only fall back to index.html for SPA browser navigation (Accept: text/html)
      const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
      if (acceptsHtml) {
        const indexPath = path.join(DIST_DIR, 'index.html');
        fs.readFile(indexPath, (readErr, content) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(content);
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    // Long caching for hashed assets, no-cache for index.html
    const isHashed = filePath.includes('assets');
    const cacheControl = isHashed ? 'public, max-age=31536000, immutable' : 'no-cache';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': cacheControl,
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
    stream.pipe(res);
  });
}

export function createSignalingServer() {
  const server = http.createServer((req, res) => {
    // Security headers for all HTTP responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/health') {
      const memoryUsage = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'droplink-signaling',
          rooms: rooms.size,
          activeIps: ipConnections.size,
          memoryMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          time: new Date().toISOString(),
        })
      );
      return;
    }

    // Serve built frontend assets if dist directory exists
    if (fs.existsSync(DIST_DIR)) {
      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = safePath === '/' ? path.join(DIST_DIR, 'index.html') : path.join(DIST_DIR, safePath);
      serveStaticFile(req, res, filePath);
      return;
    }

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('DropLink signaling server is running.');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.on('error', (err) => {
    console.error('[DropLink Server Error]', err.message);
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD_SIZE,
  });

  wss.on('error', (err) => {
    console.error('[DropLink WSS Error]', err.message);
  });

  // Heartbeat interval to terminate dead connections
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        leave(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, 30_000);
  heartbeatInterval.unref();

  // Periodic room TTL cleanup (runs every 15s)
  const cleanupInterval = setInterval(() => {
    for (const code of rooms.keys()) {
      cleanupRoom(code);
    }
  }, 15_000);
  cleanupInterval.unref();

  wss.on('connection', (ws, request) => {
    const ip = getClientIp(request);
    ws.isAlive = true;

    const currentConn = ipConnections.get(ip) || 0;
    if (currentConn >= MAX_CONCURRENT_PER_IP) {
      sendJson(ws, {
        type: 'error',
        message: 'Connection limit reached for this IP. Please wait a moment.',
      });
      ws.close(1008, 'Too Many Connections');
      return;
    }
    ipConnections.set(ip, currentConn + 1);

    ws.meta = {
      ip,
      roomCode: null,
      role: null,
      messageCount: 0,
      windowStart: Date.now(),
    };

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('error', (err) => {
      console.error(`[DropLink Client WS Error (${ip})]:`, err.message);
    });

    sendJson(ws, {
      type: 'server-ready',
      service: 'droplink-signaling',
      version: 1,
    });

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - ws.meta.windowStart > 1000) {
        ws.meta.messageCount = 0;
        ws.meta.windowStart = now;
      }
      ws.meta.messageCount += 1;
      if (ws.meta.messageCount > MAX_MESSAGES_PER_SEC) {
        sendJson(ws, { type: 'error', message: 'Message rate limit exceeded.' });
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendJson(ws, { type: 'error', message: 'Invalid JSON message.' });
        return;
      }

      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        sendJson(ws, { type: 'error', message: 'Missing or invalid message type.' });
        return;
      }

      if (message.type === 'ping') {
        ws.isAlive = true;
        sendJson(ws, { type: 'pong', at: Date.now() });
        return;
      }

      if (message.type === 'create-room') {
        if (ws.meta.roomCode) {
          sendJson(ws, { type: 'error', message: 'You are already in a room.' });
          return;
        }

        // Server capacity check to ensure site never crashes under load
        if (rooms.size >= MAX_TOTAL_ROOMS) {
          sendJson(ws, {
            type: 'error',
            message: 'Server room capacity reached. Please try again shortly.',
          });
          return;
        }

        // Memory load check
        const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
        if (heapMb > MAX_HEAP_MB) {
          console.warn(`[High Memory Warning] Heap usage ${Math.round(heapMb)}MB exceeds limit.`);
          sendJson(ws, {
            type: 'error',
            message: 'Server is currently experiencing high load. Please try again in a few moments.',
          });
          return;
        }

        if (!checkRateLimit(ip, ipRoomCreations, MAX_ROOM_CREATIONS_PER_MIN)) {
          sendJson(ws, {
            type: 'error',
            message: 'Room creation rate limit reached. Please wait a moment.',
          });
          return;
        }

        try {
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
        } catch (err) {
          sendJson(ws, { type: 'error', message: err.message || 'Could not create room.' });
        }
        return;
      }

      if (message.type === 'join-room') {
        if (ws.meta.roomCode) {
          sendJson(ws, { type: 'error', message: 'You are already in a room.' });
          return;
        }

        if (isJoinLocked(ip)) {
          sendJson(ws, {
            type: 'error',
            message: 'Too many failed join attempts. Please wait 30 seconds before trying again.',
          });
          return;
        }

        const rawRoom = String(message.room || '').trim().toUpperCase();
        if (!ROOM_CODE_REGEX.test(rawRoom)) {
          recordFailedJoin(ip);
          sendJson(ws, { type: 'error', message: 'Invalid room code format. Must be 6 characters.' });
          return;
        }

        const roomCode = rawRoom;
        cleanupRoom(roomCode);
        const room = rooms.get(roomCode);

        if (!room) {
          recordFailedJoin(ip);
          sendJson(ws, { type: 'error', message: 'Room not found or expired.' });
          return;
        }

        if (room.peers.size >= 2) {
          sendJson(ws, { type: 'error', message: 'Room is already full.' });
          return;
        }

        resetFailedJoins(ip);

        room.peers.add(ws);
        ws.meta.roomCode = roomCode;
        ws.meta.role = 'guest';

        sendJson(ws, {
          type: 'room-joined',
          room: roomCode,
          role: 'guest',
        });

        sendJson(room.host, {
          type: 'peer-joined',
          room: roomCode,
        });
        return;
      }

      if (message.type === 'signal') {
        const roomCode = ws.meta.roomCode;
        const room = roomCode ? rooms.get(roomCode) : null;

        if (!room) {
          sendJson(ws, { type: 'error', message: 'No active room.' });
          return;
        }

        const data = message.data;
        if (!data || typeof data !== 'object') {
          sendJson(ws, { type: 'error', message: 'Invalid signal payload.' });
          return;
        }

        if (data.kind !== 'description' && data.kind !== 'candidate') {
          sendJson(ws, { type: 'error', message: 'Unknown signal kind.' });
          return;
        }

        broadcast(
          room,
          {
            type: 'signal',
            from: ws.meta.role,
            data,
          },
          ws
        );
        return;
      }

      if (message.type === 'leave-room') {
        leave(ws);
        sendJson(ws, { type: 'room-left' });
        return;
      }

      sendJson(ws, { type: 'error', message: `Unknown message type: ${message.type}` });
    });

    ws.on('close', () => {
      leave(ws);
      const count = ipConnections.get(ip) || 1;
      if (count <= 1) {
        ipConnections.delete(ip);
      } else {
        ipConnections.set(ip, count - 1);
      }
    });
  });

  return { server, wss, rooms };
}

// Global crash handlers to guarantee zero-downtime
process.on('uncaughtException', (err) => {
  console.error('[DropLink Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[DropLink Unhandled Rejection]:', reason);
});

// Start standalone if executed directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { server } = createSignalingServer();
  server.listen(PORT, HOST, () => {
    console.log(`DropLink high-performance server running:`);
    console.log(`- Web App & Signaling: http://${HOST}:${PORT}`);
    console.log(`- WebSocket signaling:  ws://${HOST}:${PORT}`);
    console.log(`- Health & Telemetry:   http://${HOST}:${PORT}/health`);
  });

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
