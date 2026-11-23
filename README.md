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






On browser/device A:

Create drop room

On browser/device B:

Enter the six character room code.

Once the center core becomes:

LIVE / P2P LINK

select or drag a file.



## Production

Use:

HTTPS
+
WSS
+
TURN

for production internet-wide reliability.

TURN should be added for networks where direct WebRTC ICE connectivity cannot be established.


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
