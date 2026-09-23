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

## Current MVP limitations

This version uses IndexedDB for received chunks and creates a Blob when the transfer completes.

A later large-file version should use streaming file APIs / OPFS where browser support allows it and add:

- true pause/resume
- reconnect resume
- SHA-256 integrity validation
- multi-device discovery
- QR camera scanning
- TURN
- transfer encryption/session confirmation
- PWA installation
- native Android/iOS wrappers