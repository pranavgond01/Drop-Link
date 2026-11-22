# DropLink

Browser-first peer-to-peer file transfer MVP.

## Stack

Frontend:
- React
- Vite
- TypeScript

Signaling:
- Node.js
- WebSocket

Transfer:
- WebRTC RTCDataChannel

Local storage:
- IndexedDB

## Architecture

Browser A
       |
       | WebSocket signaling
       v
DropLink signaling server
       ^
       | WebSocket signaling
       |
Browser B

After WebRTC negotiation:

Browser A
    <====== WebRTC DataChannel ======>
Browser B

The signaling server coordinates:
- room creation
- room joining
- SDP offer
- SDP answer
- ICE candidates

The file is sent through the WebRTC data channel.

## Start server

Windows PowerShell:

cd C:\droplink\server
npm install
npm run dev

## Start frontend

Open another PowerShell:

cd C:\droplink\web
npm install
npm run dev

Then open:

http://localhost:5173

## Test

On browser/device A:

Create drop room

On browser/device B:

Enter the six character room code.

Once the center core becomes:

LIVE / P2P LINK

select or drag a file.

## LAN

Vite is configured with host=true.

Find your Windows PC's LAN IP:

ipconfig

Then another device can open:

http://YOUR-PC-IP:5173

The signaling connection automatically uses:

ws://YOUR-PC-IP:8080

Windows Firewall may need to allow Node.js/Vite on Private networks.

## Production

Use:

HTTPS
+
WSS
+
TURN

for production internet-wide reliability.

TURN should be added for networks where direct WebRTC ICE connectivity cannot be established.

## Testing

Run signaling server tests:
```powershell
cd C:\droplink\server
npm test
```

Run frontend protocol and security tests:
```powershell
cd C:\droplink\web
npm test
npm run build
```

## Security Features

DropLink incorporates several layers of security:
- **End-to-End Integrity**: Automatic SHA-256 checksum calculation on sender and cryptographic verification on receiver before download.
- **Path Traversal Protection & Filename Sanitization**: Incoming file names are stripped of path components, control characters, and reserved system names.
- **WebSocket Signaling Hardening**: Max payload limits (64 KB) to prevent memory allocation DoS attacks.
- **Signaling Rate Limiting**: Per-IP connection limits, room creation rate limiting, and brute-force lockout after repeated failed join attempts.
- **Heartbeat Ping/Pong**: Dead/half-open client socket termination every 30s to prevent zombie rooms.
- **Security Headers & CSP**: Content Security Policy, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, and Referrer-Policy on HTTP endpoints.

## Current MVP limitations

This version uses IndexedDB for received chunks and creates a Blob when the transfer completes.

A later version can add:

- true pause/resume
- reconnect resume
- multi-device discovery
- QR camera scanning
- TURN configuration
- PWA installation
- native Android/iOS wrappers