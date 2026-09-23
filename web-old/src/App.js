import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { assembleTransfer, deleteTransfer, getNextMissingChunk, getTransfer, putChunk, saveTransfer } from './db';
import { WebRtcPeer } from './webrtc';
const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL ?? 'ws://localhost:8080';
const CHUNK_SIZE = 64 * 1024;
function makeRoomId() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}
function makeId(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
}
function formatBytes(value) {
    if (value < 1024)
        return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
    }
    return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
function getDeviceLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua))
        return 'iPhone / iPad';
    if (/Android/i.test(ua))
        return 'Android';
    if (/Macintosh|Mac OS X/i.test(ua))
        return 'macOS';
    if (/Windows/i.test(ua))
        return 'Windows';
    if (/Linux/i.test(ua))
        return 'Linux';
    return 'Browser';
}
function shortDevice(label) {
    if (label.includes('iPhone') || label.includes('iPad'))
        return 'iOS';
    if (label === 'Windows')
        return 'WIN';
    if (label === 'macOS')
        return 'MAC';
    if (label === 'Linux')
        return 'LNX';
    if (label === 'Android')
        return 'AND';
    return 'WEB';
}
function DeviceGlyph({ kind, mirrored = false }) {
    return (_jsx("span", { className: `device-glyph device-${kind} ${mirrored ? 'is-mirrored' : ''}`, "aria-hidden": "true", children: kind === 'cloud' ? '✦' : kind === 'peer' ? '⌁' : '⌂' }));
}
export default function App() {
    const [role, setRole] = useState('idle');
    const [status, setStatus] = useState('offline');
    const [roomId, setRoomId] = useState('');
    const [inputRoom, setInputRoom] = useState('');
    const [clientId, setClientId] = useState('');
    const [remoteId, setRemoteId] = useState('');
    const [error, setError] = useState('');
    const [progress, setProgress] = useState(null);
    const [history, setHistory] = useState([]);
    const [localOnline, setLocalOnline] = useState(false);
    const [wsState, setWsState] = useState('Disconnected');
    const [dragActive, setDragActive] = useState(false);
    const [copied, setCopied] = useState(false);
    const wsRef = useRef(null);
    const peerRef = useRef(null);
    const filesRef = useRef(new Map());
    const activeReceiverRef = useRef(null);
    const sendIndexRef = useRef(0);
    const sendingRef = useRef(false);
    const deviceLabel = getDeviceLabel();
    const peerLabel = role === 'receiver' ? 'Sender' : 'Peer device';
    const shareUrl = useMemo(() => {
        if (!roomId)
            return '';
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomId);
        url.searchParams.set('join', '1');
        return url.toString();
    }, [roomId]);
    const loadHistory = async () => {
        setHistory([]);
    };
    void history;
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const room = params.get('room');
        if (room)
            setInputRoom(room.toUpperCase());
        void loadHistory();
        return () => {
            peerRef.current?.close();
            wsRef.current?.close();
        };
    }, []);
    const sendSignal = (message) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Signaling connection is not open.');
        }
        ws.send(JSON.stringify(message));
    };
    const setupPeer = (remote) => {
        peerRef.current?.close();
        const peer = new WebRtcPeer(clientId, remote, {
            onSignal: sendSignal,
            onControl: (message) => void handleControl(message),
            onBinary: (data) => void handleBinary(data),
            onConnection: (state) => {
                if (state === 'connected')
                    setStatus('connected');
                if (state === 'failed' || state === 'disconnected')
                    setStatus('error');
            },
        });
        peerRef.current = peer;
        setRemoteId(remote);
        return peer;
    };
    const connectWebSocket = (mode, desiredRoom) => {
        const ws = new WebSocket(SIGNAL_URL);
        wsRef.current = ws;
        setRole(mode);
        setStatus('connecting');
        setWsState('Connecting…');
        setError('');
        setCopied(false);
        ws.onopen = () => {
            setLocalOnline(true);
            setWsState('Signaling online');
            if (mode === 'sender') {
                ws.send(JSON.stringify({ type: 'create', roomId: desiredRoom }));
            }
            else {
                ws.send(JSON.stringify({ type: 'join', roomId: desiredRoom }));
            }
        };
        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'created') {
                setClientId(message.clientId);
                setRoomId(message.roomId);
                setStatus('waiting');
                return;
            }
            if (message.type === 'joined') {
                setClientId(message.clientId);
                setRoomId(message.roomId);
                setStatus(message.peers > 1 ? 'connecting' : 'waiting');
                return;
            }
            if (message.type === 'peer-joined') {
                setRemoteId(message.clientId);
                if (mode === 'sender') {
                    const peer = setupPeer(message.clientId);
                    peer.createChannel();
                    await peer.createOffer();
                }
                return;
            }
            if (message.type === 'offer') {
                setRemoteId(message.from);
                const peer = setupPeer(message.from);
                await peer.handleOffer(message.sdp);
                return;
            }
            if (message.type === 'answer') {
                await peerRef.current?.handleAnswer(message.sdp);
                return;
            }
            if (message.type === 'ice-candidate') {
                await peerRef.current?.handleIce(message.candidate);
                return;
            }
            if (message.type === 'peer-left') {
                setStatus('waiting');
                setRemoteId('');
                setError('The other device disconnected. Reconnect with the same room code to resume.');
                return;
            }
            if (message.type === 'error') {
                setStatus('error');
                setError(message.message);
            }
        };
        ws.onerror = () => {
            setLocalOnline(false);
            setWsState('Connection error');
            setStatus('error');
            setError('Could not reach the signaling server. Check VITE_SIGNAL_URL and the server process.');
        };
        ws.onclose = () => {
            setLocalOnline(false);
            setWsState('Disconnected');
        };
    };
    const createRoom = () => {
        const room = makeRoomId();
        connectWebSocket('sender', room);
    };
    const joinRoom = () => {
        const room = inputRoom.trim().toUpperCase();
        if (!/^[A-Z2-9]{6}$/.test(room)) {
            setError('Enter a valid 6-character room code.');
            return;
        }
        connectWebSocket('receiver', room);
    };
    const handleControl = async (message) => {
        if (message.type === 'hello')
            return;
        if (message.type === 'file-start') {
            const existing = await getTransfer(message.transferId);
            const record = existing ?? {
                transferId: message.transferId,
                name: message.name,
                size: message.size,
                mime: message.mime,
                chunkSize: message.chunkSize,
                totalChunks: message.totalChunks,
                receivedChunks: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                complete: false,
            };
            await saveTransfer(record);
            activeReceiverRef.current = record;
            const nextChunk = await getNextMissingChunk(message.transferId, message.totalChunks);
            setProgress({
                name: message.name,
                size: message.size,
                transferred: Math.min(message.size, nextChunk * message.chunkSize),
                percent: message.size ? Math.min(100, (nextChunk * message.chunkSize * 100) / message.size) : 0,
                direction: 'receive',
            });
            peerRef.current?.sendControl({
                type: 'resume-request',
                transferId: message.transferId,
                nextChunk,
            });
            setStatus('transferring');
            return;
        }
        if (message.type === 'resume-request') {
            const file = filesRef.current.get(message.transferId);
            if (!file) {
                peerRef.current?.sendControl({
                    type: 'error',
                    message: 'Sender file is no longer available. Please select the file again.',
                });
                return;
            }
            sendIndexRef.current = message.nextChunk;
            if (!sendingRef.current)
                void pumpFile(file, message.transferId);
            return;
        }
        if (message.type === 'file-complete') {
            const record = activeReceiverRef.current;
            if (!record || record.transferId !== message.transferId)
                return;
            record.complete = true;
            record.updatedAt = Date.now();
            await saveTransfer(record);
            setProgress((current) => current ? { ...current, transferred: current.size, percent: 100 } : current);
            setStatus('complete');
            try {
                const blob = await assembleTransfer(record.transferId, record.totalChunks);
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = record.name;
                anchor.click();
                window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
                await deleteTransfer(record.transferId);
            }
            catch (err) {
                setError(err instanceof Error ? err.message : 'Could not assemble received file.');
                setStatus('error');
            }
            return;
        }
        if (message.type === 'file-cancel') {
            setStatus('error');
            setError(message.reason ?? 'Transfer cancelled.');
            sendingRef.current = false;
        }
        if (message.type === 'error') {
            setStatus('error');
            setError(message.message);
            sendingRef.current = false;
        }
    };
    const handleBinary = async (data) => {
        const record = activeReceiverRef.current;
        if (!record)
            return;
        const nextChunk = record.receivedChunks;
        await putChunk(record.transferId, nextChunk, data);
        record.receivedChunks += 1;
        record.updatedAt = Date.now();
        await saveTransfer(record);
        const transferred = Math.min(record.size, record.receivedChunks * record.chunkSize);
        setProgress({
            name: record.name,
            size: record.size,
            transferred,
            percent: record.size ? Math.min(100, (transferred / record.size) * 100) : 0,
            direction: 'receive',
        });
    };
    const pumpFile = async (file, transferId) => {
        const channel = await peerRef.current?.waitForChannel();
        if (!channel)
            throw new Error('Data channel unavailable.');
        sendingRef.current = true;
        setStatus('transferring');
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const indexStart = Math.max(0, Math.min(totalChunks, sendIndexRef.current));
        for (let index = indexStart; index < totalChunks; index += 1) {
            if (!sendingRef.current)
                break;
            const start = index * CHUNK_SIZE;
            const end = Math.min(file.size, start + CHUNK_SIZE);
            const buffer = await file.slice(start, end).arrayBuffer();
            await new Promise((resolve, reject) => {
                const send = () => {
                    try {
                        peerRef.current?.sendBinary(buffer);
                        resolve();
                    }
                    catch (err) {
                        reject(err);
                    }
                };
                if (channel.bufferedAmount <= 4 * 1024 * 1024) {
                    send();
                    return;
                }
                const onLow = () => {
                    channel.removeEventListener('bufferedamountlow', onLow);
                    send();
                };
                channel.addEventListener('bufferedamountlow', onLow);
            });
            const transferred = Math.min(file.size, end);
            setProgress({
                name: file.name,
                size: file.size,
                transferred,
                percent: file.size ? (transferred / file.size) * 100 : 100,
                direction: 'send',
            });
            sendIndexRef.current = index + 1;
        }
        if (sendingRef.current && sendIndexRef.current >= totalChunks) {
            peerRef.current?.sendControl({ type: 'file-complete', transferId });
            setStatus('complete');
        }
        sendingRef.current = false;
    };
    const startFileTransfer = async (file) => {
        if (!peerRef.current || peerRef.current.connectionState !== 'connected') {
            setError('Connect another device before selecting a file.');
            return;
        }
        const transferId = makeId('transfer');
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        filesRef.current.set(transferId, file);
        const record = {
            transferId,
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            chunkSize: CHUNK_SIZE,
            totalChunks,
            receivedChunks: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            complete: false,
        };
        await saveTransfer(record);
        await peerRef.current.waitForChannel();
        peerRef.current.sendControl({
            type: 'file-start',
            transferId,
            name: file.name,
            size: file.size,
            mime: record.mime,
            chunkSize: CHUNK_SIZE,
            totalChunks,
        });
        setProgress({ name: file.name, size: file.size, transferred: 0, percent: 0, direction: 'send' });
    };
    const copyRoom = async () => {
        if (!shareUrl)
            return;
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
    };
    const onDrop = (event) => {
        event.preventDefault();
        setDragActive(false);
        const file = event.dataTransfer.files?.[0];
        if (file)
            void startFileTransfer(file);
    };
    const reset = () => {
        sendingRef.current = false;
        peerRef.current?.close();
        wsRef.current?.close();
        peerRef.current = null;
        wsRef.current = null;
        filesRef.current.clear();
        activeReceiverRef.current = null;
        setRole('idle');
        setStatus('offline');
        setRoomId('');
        setClientId('');
        setRemoteId('');
        setProgress(null);
        setError('');
        setLocalOnline(false);
        setWsState('Disconnected');
        setCopied(false);
    };
    const isConnected = status === 'connected' || status === 'transferring' || status === 'complete';
    const statusText = {
        offline: 'Ready to connect',
        waiting: 'Waiting for device',
        connecting: 'Negotiating P2P',
        connected: 'P2P link active',
        transferring: 'Moving data',
        complete: 'Transfer complete',
        error: 'Connection needs attention',
    }[status];
    return (_jsxs("main", { className: "scene-shell", children: [_jsx("div", { className: "scene-noise" }), _jsx("div", { className: "scene-orb scene-orb-a" }), _jsx("div", { className: "scene-orb scene-orb-b" }), _jsx("div", { className: "scene-orb scene-orb-c" }), _jsx("div", { className: "grid-floor" }), _jsxs("header", { className: "nav-bar", children: [_jsxs("div", { className: "brand-lockup", children: [_jsxs("div", { className: "brand-cube", "aria-hidden": "true", children: [_jsx("span", { className: "cube-face cube-face-top" }), _jsx("span", { className: "cube-face cube-face-front", children: "D" }), _jsx("span", { className: "cube-face cube-face-side" })] }), _jsxs("div", { children: [_jsx("div", { className: "brand-title", children: "DROPLINK" }), _jsx("div", { className: "brand-caption", children: "DIRECT DEVICE TRANSFER" })] })] }), _jsxs("div", { className: `network-status ${localOnline ? 'is-live' : ''}`, children: [_jsx("span", { className: "status-pulse" }), _jsx("span", { children: wsState }), _jsx("span", { className: "status-divider" }), _jsx("span", { children: shortDevice(deviceLabel) })] })] }), _jsxs("section", { className: "hero-stage", children: [_jsxs("div", { className: "hero-copy", children: [_jsxs("div", { className: "eyebrow-line", children: [_jsx("span", {}), " NO CLOUD. NO UPLOADS. JUST THE LINK."] }), _jsxs("h1", { children: ["Make the", _jsx("br", {}), _jsx("em", { children: "connection." })] }), _jsx("p", { children: "Send a file from one device to another through an encrypted WebRTC channel. The web server introduces the peers; it does not carry your file." })] }), _jsxs("div", { className: `connection-orbit status-${status} ${role !== 'idle' ? 'has-room' : ''}`, children: [_jsx("div", { className: "orbit-ring orbit-ring-one" }), _jsx("div", { className: "orbit-ring orbit-ring-two" }), _jsx("div", { className: "orbit-ring orbit-ring-three" }), _jsx("div", { className: "orbit-particle particle-one" }), _jsx("div", { className: "orbit-particle particle-two" }), _jsx("div", { className: "orbit-particle particle-three" }), _jsx("div", { className: "core-shadow" }), _jsx("div", { className: "transfer-core", children: _jsxs("div", { className: "core-inner", children: [_jsx("span", { className: "core-label", children: role === 'idle' ? 'P2P' : status === 'complete' ? 'DONE' : 'LINK' }), _jsx("strong", { children: role === 'idle' ? 'READY' : roomId || inputRoom || '••••••' }), _jsx("span", { className: "core-sub", children: role === 'idle' ? 'PRIVATE CHANNEL' : statusText.toUpperCase() })] }) }), _jsxs("div", { className: "device-card device-card-self", children: [_jsxs("div", { className: "device-card-top", children: [_jsx("span", { children: "THIS DEVICE" }), _jsx("i", { children: shortDevice(deviceLabel) })] }), _jsxs("div", { className: "device-card-main", children: [_jsx(DeviceGlyph, { kind: "self" }), _jsxs("div", { children: [_jsx("strong", { children: deviceLabel }), _jsx("small", { children: "local browser" })] })] }), _jsxs("div", { className: "signal-bars", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {}), _jsx("span", {})] })] }), _jsxs("div", { className: "device-card device-card-peer", children: [_jsxs("div", { className: "device-card-top", children: [_jsx("span", { children: role === 'receiver' ? 'SOURCE DEVICE' : 'DESTINATION' }), _jsx("i", { children: remoteId ? 'LINKED' : 'WAIT' })] }), _jsxs("div", { className: "device-card-main", children: [_jsx(DeviceGlyph, { kind: "peer", mirrored: role === 'receiver' }), _jsxs("div", { children: [_jsx("strong", { children: remoteId ? 'Peer device' : 'Waiting…' }), _jsx("small", { children: remoteId ? 'secure channel ready' : 'scan or enter room' })] })] }), _jsxs("div", { className: "signal-line", children: [_jsx("span", {}), remoteId ? 'connected' : 'standby'] })] }), _jsx("div", { className: "route-label route-left", children: "LOCAL" }), _jsx("div", { className: "route-label route-right", children: "PEER" }), _jsx("div", { className: "route-line route-line-left" }), _jsx("div", { className: "route-line route-line-right" })] })] }), _jsx("section", { className: "control-deck", children: role === 'idle' ? (_jsxs("div", { className: "launch-grid", children: [_jsxs("article", { className: "launch-card launch-card-primary", children: [_jsx("div", { className: "launch-card-glow" }), _jsx("div", { className: "card-number", children: "01" }), _jsx("div", { className: "card-icon", children: _jsx("span", { children: "\u2197" }) }), _jsx("div", { className: "card-kicker", children: "CREATE A PRIVATE LINK" }), _jsx("h2", { children: "Send from this device" }), _jsx("p", { children: "Spin up a temporary room, then share the code or QR. Your browser becomes the sender." }), _jsxs("button", { className: "action-pill action-pill-light", onClick: createRoom, children: [_jsx("span", { children: "CREATE DROP ROOM" }), _jsx("b", { children: "\u2197" })] })] }), _jsxs("article", { className: "launch-card launch-card-secondary", children: [_jsx("div", { className: "card-number", children: "02" }), _jsx("div", { className: "card-icon card-icon-dim", children: _jsx("span", { children: "\u2199" }) }), _jsx("div", { className: "card-kicker", children: "JOIN AN EXISTING LINK" }), _jsx("h2", { children: "Receive on this device" }), _jsx("p", { children: "Enter the six-character room or open a shared invite. No account or app store download required." }), _jsxs("div", { className: "join-console", children: [_jsx("input", { value: inputRoom, maxLength: 6, onChange: (event) => setInputRoom(event.target.value.toUpperCase()), placeholder: "A7K9QP", "aria-label": "Room code" }), _jsxs("button", { className: "action-pill action-pill-dark", onClick: joinRoom, children: [_jsx("span", { children: "JOIN" }), _jsx("b", { children: "\u2198" })] })] })] })] })) : (_jsxs("div", { className: "active-deck", children: [_jsxs("section", { className: "main-control-card", children: [_jsxs("div", { className: "deck-header", children: [_jsxs("div", { children: [_jsx("div", { className: "card-kicker", children: "TEMPORARY TRANSFER ROOM" }), _jsxs("div", { className: "room-id-row", children: [_jsx("strong", { children: roomId || inputRoom }), _jsxs("span", { className: `live-chip chip-${status}`, children: [_jsx("i", {}), " ", statusText] })] })] }), _jsx("button", { className: "mini-action", onClick: reset, children: "EXIT" })] }), role === 'sender' && status === 'waiting' ? (_jsxs("div", { className: "pairing-stage", children: [_jsxs("div", { className: "qr-frame", children: [_jsx("div", { className: "qr-corner qr-corner-tl" }), _jsx("div", { className: "qr-corner qr-corner-tr" }), _jsx("div", { className: "qr-corner qr-corner-bl" }), _jsx("div", { className: "qr-corner qr-corner-br" }), shareUrl && _jsx(QRCodeSVG, { value: shareUrl, size: 176, bgColor: "transparent", fgColor: "#f7fbff", includeMargin: false }), _jsx("span", { className: "qr-caption", children: "SCAN TO CONNECT" })] }), _jsxs("div", { className: "pairing-copy", children: [_jsxs("div", { className: "pairing-index", children: ["ROOM ", roomId] }), _jsx("h3", { children: "Open this link on the other device." }), _jsx("p", { children: "Keep both browsers open. Once the peer connects, the center core will light up and you can drop files straight into the channel." }), _jsx("div", { className: "pairing-actions", children: _jsxs("button", { className: "action-pill action-pill-light", onClick: copyRoom, children: [_jsx("span", { children: copied ? 'COPIED TO CLIPBOARD' : 'COPY INVITE LINK' }), _jsx("b", { children: copied ? '✓' : '↗' })] }) })] })] })) : (_jsxs("div", { className: "connected-banner", children: [_jsx("div", { className: "connected-symbol", children: _jsx(DeviceGlyph, { kind: "peer" }) }), _jsxs("div", { children: [_jsx("span", { children: "PEER CHANNEL" }), _jsx("strong", { children: remoteId ? 'Second device is linked' : 'Waiting for the second device' }), _jsx("p", { children: remoteId ? `Room ${roomId} is active. The transfer path is ready.` : 'The signaling link is alive. Finish pairing on the other device.' })] })] })), role === 'sender' && isConnected && (_jsxs("label", { className: `drop-portal ${dragActive ? 'is-dragging' : ''}`, onDragEnter: (event) => { event.preventDefault(); setDragActive(true); }, onDragOver: (event) => event.preventDefault(), onDragLeave: () => setDragActive(false), onDrop: onDrop, children: [_jsx("input", { type: "file", onChange: (event) => { const file = event.target.files?.[0]; if (file)
                                                void startFileTransfer(file); event.currentTarget.value = ''; } }), _jsx("div", { className: "portal-ring", children: _jsx("span", { children: "\uFF0B" }) }), _jsx("strong", { children: dragActive ? 'Release to send' : 'Drop a file into the portal' }), _jsx("span", { children: "or click to browse \u2022 64 KB transport chunks \u2022 browser-encrypted" })] })), progress && (_jsxs("div", { className: `transfer-console ${progress.percent >= 100 ? 'is-complete' : ''}`, children: [_jsxs("div", { className: "transfer-console-top", children: [_jsxs("div", { className: "transfer-file", children: [_jsx("span", { className: "file-orb", children: progress.direction === 'send' ? '↑' : '↓' }), _jsxs("div", { children: [_jsx("strong", { children: progress.name }), _jsxs("small", { children: [progress.direction === 'send' ? 'sending to peer' : 'receiving from peer', " \u2022 ", formatBytes(progress.size)] })] })] }), _jsxs("strong", { className: "transfer-percent", children: [progress.percent.toFixed(0), "%"] })] }), _jsx("div", { className: "transfer-track", children: _jsx("span", { style: { width: `${progress.percent}%` } }) }), _jsxs("div", { className: "transfer-foot", children: [_jsxs("span", { children: [formatBytes(progress.transferred), " transferred"] }), _jsx("span", { children: progress.percent >= 100 ? 'HANDOFF COMPLETE' : 'P2P STREAMING' })] })] })), error && _jsxs("div", { className: "error-console", children: [_jsx("span", { children: "!" }), _jsxs("div", { children: [_jsx("strong", { children: "Connection message" }), _jsx("p", { children: error })] })] })] }), _jsxs("aside", { className: "telemetry-stack", children: [_jsxs("article", { className: "telemetry-card telemetry-primary", children: [_jsxs("div", { className: "telemetry-head", children: [_jsx("span", { children: "PATH" }), _jsx("span", { children: status === 'complete' ? 'FINALIZED' : 'LIVE' })] }), _jsxs("div", { className: "path-visual", children: [_jsxs("div", { className: "path-node", children: [_jsx("b", { children: shortDevice(deviceLabel) }), _jsx("small", { children: "YOU" })] }), _jsxs("div", { className: "path-beam", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {})] }), _jsxs("div", { className: "path-node path-node-right", children: [_jsx("b", { children: remoteId ? 'PEER' : 'WAIT' }), _jsx("small", { children: "REMOTE" })] })] }), _jsx("p", { children: "Signaling is separate from file traffic. The payload stays on the peer channel." })] }), _jsxs("article", { className: "telemetry-card", children: [_jsxs("div", { className: "telemetry-head", children: [_jsx("span", { children: "SECURITY" }), _jsx("span", { children: "DTLS" })] }), _jsxs("div", { className: "telemetry-value", children: ["PRIVATE", _jsx("br", {}), "CHANNEL"] }), _jsx("p", { children: "WebRTC DataChannels are browser-encrypted. Your signaling server never receives the file bytes." })] }), _jsxs("article", { className: "telemetry-card", children: [_jsxs("div", { className: "telemetry-head", children: [_jsx("span", { children: "NEXT LAYER" }), _jsx("span", { children: "ROADMAP" })] }), _jsxs("div", { className: "roadmap-stack", children: [_jsx("span", { children: "RESUME" }), _jsx("span", { children: "TURN" }), _jsx("span", { children: "PWA" }), _jsx("span", { children: "MULTI-FILE" })] })] })] })] })) }), _jsxs("footer", { className: "scene-footer", children: [_jsx("span", { children: "DROPLINK 0.1 \u2022 DIRECT DEVICE TRANSFER" }), _jsx("span", { children: "WEBRTC / INDEXEDDB / QR PAIRING" })] })] }));
}
