import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  CSSProperties,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import PlatformShowcase from "./PlatformShowcase";
import {
  CHUNK_SIZE,
  CHUNK_WINDOW,
  MAX_ALLOWED_CHUNK_SIZE,
  calculateSha256,
  formatBytes,
  formatDuration,
  isControlMessage,
  makeFileId,
  sanitizeFileName,
} from "./protocol";
import type {
  ControlMessage,
  SignalPayload,
} from "./protocol";
import {
  clearAllChunks,
  clearReceivedFile,
  listTransferHistory,
  readReceivedFile,
  saveReceivedChunk,
  saveReceivedChunksBatch,
  saveTransferHistory,
} from "./db";
import type {
  TransferHistory,
} from "./db";
import { PeerLink } from "./webrtc";
import type { PeerState } from "./webrtc";

type Role = "idle" | "host" | "guest";
type Status =
  | "offline"
  | "waiting"
  | "connecting"
  | "connected"
  | "transferring"
  | "complete"
  | "error";
type Direction = "send" | "receive";
type ChannelState = "closed" | "connecting" | "open";

type ProgressState = {
  active: boolean;
  paused: boolean;
  direction: Direction;
  id?: string;
  name: string;
  size: number;
  transferred: number;
  percent: number;
  speed: number;
  eta: number;
};

type ReceiveState = {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256?: string;
  totalChunks?: number;
  received: number;
  chunkIndex: number;
  startedAt: number;
};

const DEFAULT_ICE_SERVERS: RTCIceServer[] = (() => {
  try {
    const custom = import.meta.env.VITE_ICE_SERVERS;
    if (custom) {
      return JSON.parse(custom) as RTCIceServer[];
    }
  } catch {
    // Fall back to public STUN
  }
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
})();

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  (location.port === "5173"
    ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:8080`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const initialProgress: ProgressState = {
  active: false,
  paused: false,
  direction: "send",
  id: undefined,
  name: "",
  size: 0,
  transferred: 0,
  percent: 0,
  speed: 0,
  eta: 0,
};

function getInitialRoom() {
  try {
    return new URLSearchParams(location.search)
      .get("room")
      ?.toUpperCase() || "";
  } catch {
    return "";
  }
}

function getDeviceName() {
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "iPhone";
  if (/android/.test(ua)) return "Android";
  if (/macintosh|mac os x/.test(ua)) return "Mac";
  if (/windows/.test(ua)) return "Windows";
  if (/linux/.test(ua)) return "Linux";
  return "Browser";
}

function shortId(value: string) {
  return value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "—";
}

function statusCopy(status: Status) {
  switch (status) {
    case "offline":
      return "Create a room or join a peer";
    case "waiting":
      return "Waiting for another device to connect";
    case "connecting":
      return "Negotiating an encrypted WebRTC channel";
    case "connected":
      return "Direct peer channel is ready";
    case "transferring":
      return "Streaming file chunks directly between peers";
    case "complete":
      return "Transfer finished successfully";
    case "error":
      return "The peer connection needs attention";
  }
}

function DeviceGlyph({ peer = false }: { peer?: boolean }) {
  return (
    <div className={`device-glyph ${peer ? "is-peer" : ""}`} aria-hidden="true">
      <div className="glyph-screen" />
      <div className="glyph-edge glyph-edge-top" />
      <div className="glyph-edge glyph-edge-bottom" />
      <div className="glyph-pulse" />
    </div>
  );
}

function PacketField({ active, complete, error }: { active: boolean; complete: boolean; error: boolean }) {
  return (
    <div className={`packet-field ${active ? "is-active" : ""} ${complete ? "is-complete" : ""} ${error ? "is-error" : ""}`}>
      {Array.from({ length: 14 }).map((_, index) => (
        <span key={index} className={`packet packet-${index + 1}`} />
      ))}
    </div>
  );
}

function CoreStatus({ status, progress }: { status: Status; progress: ProgressState }) {
  if (progress.paused) {
    return <><b>PAUSED</b><span>TRANSFER HOLD</span></>;
  }
  if (status === "transferring") {
    return <><b>{progress.percent.toFixed(0)}%</b><span>TRANSFER</span></>;
  }
  if (status === "connected") {
    return <><b>LIVE</b><span>P2P LINK</span></>;
  }
  if (status === "connecting") {
    return <><b>SYNC</b><span>HANDSHAKE</span></>;
  }
  if (status === "complete") {
    return <><b>DONE</b><span>100% SENT</span></>;
  }
  if (status === "waiting") {
    return <><b>WAIT</b><span>PAIRING</span></>;
  }
  if (status === "error") {
    return <><b>ERR</b><span>RETRY</span></>;
  }
  return <><b>READY</b><span>ZERO-CLOUD</span></>;
}

export default function App() {
  const [role, setRole] = useState<Role>("idle");
  const [status, setStatus] = useState<Status>("offline");
  const [channelState, setChannelState] = useState<ChannelState>("closed");
  const [roomId, setRoomId] = useState("");
  const [inputRoom, setInputRoom] = useState(getInitialRoom());
  const [peerId, setPeerId] = useState("");
  const [peerOnline, setPeerOnline] = useState(false);
  const [serverOnline, setServerOnline] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(initialProgress);
  const [history, setHistory] = useState<TransferHistory[]>([]);
  const [errorText, setErrorText] = useState("");
  const [activityText, setActivityText] = useState("Ready.");
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloadReady, setDownloadReady] = useState<{
    url: string;
    name: string;
    size: number;
    sha256?: string;
  } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<PeerLink | null>(null);
  const receiveRef = useRef<ReceiveState | null>(null);
  const transferRef = useRef({ id: "", paused: false, cancelled: false });
  const pauseResolverRef = useRef<(() => void) | null>(null);
  const lastAckRef = useRef({ id: "", chunkIndex: -1 });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const receiveWriteChainRef = useRef(Promise.resolve());
  const receiveChunkBufferRef = useRef<{ index: number; blob: Blob }[]>([]);
  const mountedRef = useRef(true);
  const progressActiveRef = useRef(false);
  const peerOnlineRef = useRef(false);
  const downloadReadyRef = useRef<typeof downloadReady>(null);
  const handleDataMessageRef = useRef<(message: string | ArrayBuffer) => Promise<void>>(async () => {});

  const localDevice = useMemo(getDeviceName, []);

  useEffect(() => {
    downloadReadyRef.current = downloadReady;
  }, [downloadReady]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        await clearAllChunks();
        setHistory(await listTransferHistory(8));
      } catch {
        // Local history is optional.
      }
    })();
    return () => {
      mountedRef.current = false;
      socketRef.current?.close();
      peerRef.current?.close();
      if (downloadReadyRef.current?.url) {
        URL.revokeObjectURL(downloadReadyRef.current.url);
      }
    };
  }, []);

  useEffect(() => {
    progressActiveRef.current = progress.active;
    peerOnlineRef.current = peerOnline;
  }, [progress.active, peerOnline]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listTransferHistory(8));
    } catch {
      // Ignore local-history failures.
    }
  }, []);

  const wakeTransfer = useCallback(() => {
    const resolver = pauseResolverRef.current;
    pauseResolverRef.current = null;
    resolver?.();
  }, []);

  const waitForResume = useCallback(async (id: string) => {
    while (true) {
      const current = transferRef.current;
      if (current.id !== id || current.cancelled) return false;
      if (!current.paused) return true;
      await new Promise<void>((resolve) => {
        pauseResolverRef.current = resolve;
      });
    }
  }, []);

  const waitForAck = useCallback(async (id: string, targetChunk: number) => {
    const startedAt = Date.now();

    while (true) {
      const current = transferRef.current;

      if (current.id !== id || current.cancelled) {
        return false;
      }

      if (lastAckRef.current.id === id && lastAckRef.current.chunkIndex >= targetChunk) {
        return true;
      }

      if (Date.now() - startedAt > 30000) {
        return false;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 25);
      });
    }
  }, []);

  const sendSignal = useCallback((payload: SignalPayload) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "signal", data: payload }));
    } catch (err) {
      console.error("[DropLink] Failed to send signal:", err);
    }
  }, []);

  const setupPeer = useCallback(() => {
    peerRef.current?.close();
    setChannelState("closed");

    const peer = new PeerLink({
      onState: (next: PeerState) => {
        if (next === "connecting" || next === "new") {
          setChannelState("connecting");
          if (mountedRef.current) setStatus("connecting");
        }

        if (next === "connected") {
          setChannelState("open");
          setPeerOnline(true);
          peerOnlineRef.current = true;
          setStatus((current) => current === "transferring" ? current : "connected");
          setActivityText("Secure data channel open. Ready to send.");
        }

        if (next === "disconnected") {
          setChannelState("closed");
          setPeerOnline(false);
          peerOnlineRef.current = false;
          if (!progressActiveRef.current) setStatus("waiting");
        }

        if (next === "failed") {
          setChannelState("closed");
          setPeerOnline(false);
          peerOnlineRef.current = false;
          setErrorText("WebRTC connection failed. Reconnect both devices.");
          setStatus("error");
        }

        if (next === "closed") {
          setChannelState("closed");
        }
      },
      onChannelState: (state) => {
        setChannelState(state);
        if (state === "open") {
          setPeerOnline(true);
          peerOnlineRef.current = true;
          setStatus((current) => current === "transferring" ? current : "connected");
          setActivityText("Data channel OPEN — files can be transferred.");
        }
        if (state === "closed") {
          setPeerOnline(false);
          peerOnlineRef.current = false;
        }
      },
      onMessage: (message) => {
        void handleDataMessageRef.current(message);
      },
      onError: (message) => {
        console.error("[DropLink]", message);
        setErrorText(message);
        setStatus("error");
        setActivityText(message);
      },
      onSignal: sendSignal,
    }, DEFAULT_ICE_SERVERS);

    peerRef.current = peer;
  }, [sendSignal]);

  const handleServerMessage = useCallback(async (raw: string) => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      setErrorText("Invalid signaling message.");
      setStatus("error");
      return;
    }

    if (!message || typeof message !== "object") return;
    const packet = message as Record<string, unknown>;

    switch (packet.type) {
      case "server-ready":
        setServerOnline(true);
        return;

      case "room-created":
        setRoomId(String(packet.room || ""));
        setRole("host");
        setStatus("waiting");
        setActivityText("Room created. Share the code or QR.");
        return;

      case "room-joined":
        setRoomId(String(packet.room || ""));
        setRole("guest");
        setStatus("connecting");
        setActivityText("Joined room. Waiting for WebRTC handshake.");
        return;

      case "peer-joined":
        setPeerOnline(false);
        setPeerId(makeFileId());
        setStatus("connecting");
        setActivityText("Peer found. Creating secure connection…");
        await peerRef.current?.createOffer();
        return;

      case "peer-left":
        setPeerOnline(false);
        setPeerId("");
        if (progressActiveRef.current) {
          transferRef.current.cancelled = true;
          wakeTransfer();
        }
        setStatus("waiting");
        setProgress(initialProgress);
        setActivityText("Peer disconnected.");
        return;

      case "signal":
        try {
          await peerRef.current?.handleSignal(packet.data as SignalPayload);
        } catch (error) {
          const text = error instanceof Error ? error.message : "WebRTC signaling failed.";
          setErrorText(text);
          setStatus("error");
        }
        return;

      case "error":
        setErrorText(String(packet.message || "Signaling error."));
        setStatus("error");
        return;

      case "room-closed":
        setErrorText(String(packet.reason || "Room closed."));
        setStatus("offline");
        setRoomId("");
        setPeerId("");
        setRole("idle");
        peerRef.current?.close();
        return;
    }
  }, [wakeTransfer]);

  const connectSocket = useCallback((action: { type: "create-room" } | { type: "join-room"; room: string }) => {
    socketRef.current?.close();
    peerRef.current?.close();
    setServerOnline(false);
    setPeerOnline(false);
    peerOnlineRef.current = false;
    setPeerId("");
    setErrorText("");
    setActivityText("Connecting to signaling server…");
    setProgress(initialProgress);
    transferRef.current = { id: "", paused: false, cancelled: false };
    lastAckRef.current = { id: "", chunkIndex: -1 };
    setupPeer();

    const ws = new WebSocket(SIGNALING_URL);
    socketRef.current = ws;

    ws.onopen = () => {
      setServerOnline(true);
      try {
        ws.send(JSON.stringify(action));
      } catch (err) {
        console.error("[DropLink] Failed to send initial action:", err);
      }
    };

    ws.onmessage = (event) => {
      void handleServerMessage(String(event.data));
    };

    ws.onerror = () => {
      setServerOnline(false);
      setErrorText(`Could not reach signaling server: ${SIGNALING_URL}`);
      setActivityText("Signaling connection failed.");
      setStatus("error");
    };

    ws.onclose = () => {
      setServerOnline(false);
    };
  }, [handleServerMessage, setupPeer]);

  const createRoom = useCallback(() => {
    connectSocket({ type: "create-room" });
  }, [connectSocket]);

  const joinRoom = useCallback(() => {
    const room = inputRoom.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(room)) {
      setErrorText("Enter a valid 6-character room code.");
      setStatus("error");
      return;
    }
    connectSocket({ type: "join-room", room });
  }, [connectSocket, inputRoom]);

  const leaveRoom = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      try {
        socketRef.current.send(JSON.stringify({ type: "leave-room" }));
      } catch {
        // Ignore
      }
    }
    socketRef.current?.close();
    peerRef.current?.close();
    socketRef.current = null;
    peerRef.current = null;
    setRole("idle");
    setStatus("offline");
    setChannelState("closed");
    setRoomId("");
    setPeerId("");
    setPeerOnline(false);
    peerOnlineRef.current = false;
    transferRef.current = { id: "", paused: false, cancelled: false };
    setProgress(initialProgress);
    setErrorText("");
    setActivityText("Disconnected from room.");

    if (downloadReady?.url) {
      URL.revokeObjectURL(downloadReady.url);
      setDownloadReady(null);
    }
  }, [downloadReady]);

  const abortReceive = useCallback((id?: string) => {
    const target = id || receiveRef.current?.id;
    if (target) {
      void clearReceivedFile(target).catch(() => {});
    }
    receiveRef.current = null;
    receiveChunkBufferRef.current = [];
    receiveWriteChainRef.current = Promise.resolve();
    setProgress(initialProgress);
    setStatus(peerOnlineRef.current ? "connected" : "waiting");
  }, []);

  const handleDataMessage = useCallback(async (message: string | ArrayBuffer) => {
    if (typeof message === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        setErrorText("Received invalid control data.");
        return;
      }

      if (!isControlMessage(parsed)) return;
      const packet = parsed as ControlMessage;

      if (packet.kind === "file-start") {
        const safeName = sanitizeFileName(packet.name);
        transferRef.current = { id: packet.id, paused: false, cancelled: false };
        lastAckRef.current = { id: packet.id, chunkIndex: -1 };
        receiveRef.current = {
          id: packet.id,
          name: safeName,
          size: packet.size,
          type: packet.type,
          lastModified: packet.lastModified,
          sha256: packet.sha256,
          totalChunks: packet.totalChunks,
          received: 0,
          chunkIndex: 0,
          startedAt: performance.now(),
        };
        receiveChunkBufferRef.current = [];
        receiveWriteChainRef.current = Promise.resolve();

        setDownloadReady((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return null;
        });

        setErrorText("");
        setStatus("transferring");
        setProgress({
          active: true,
          paused: false,
          direction: "receive",
          id: packet.id,
          name: safeName,
          size: packet.size,
          transferred: 0,
          percent: 0,
          speed: 0,
          eta: 0,
        });
        setActivityText(`Receiving ${safeName}…`);
        return;
      }

      if (packet.kind === "chunk-ack") {
        if (lastAckRef.current.id !== packet.id) {
          lastAckRef.current = { id: packet.id, chunkIndex: packet.chunkIndex };
        } else {
          lastAckRef.current.chunkIndex = Math.max(
            lastAckRef.current.chunkIndex,
            packet.chunkIndex
          );
        }

        setActivityText(`Peer confirmed chunk ${packet.chunkIndex + 1}.`);
        return;
      }

      if (packet.kind === "file-pause" || packet.kind === "file-resume") {
        if (transferRef.current.id !== packet.id) return;
        const paused = packet.kind === "file-pause";
        transferRef.current.paused = paused;
        setProgress((current) => ({ ...current, active: true, paused }));
        setActivityText(paused ? "Transfer paused by peer." : "Transfer resumed by peer.");
        if (!paused) wakeTransfer();
        return;
      }

      if (packet.kind === "cancel") {
        transferRef.current.cancelled = true;
        transferRef.current.paused = false;
        abortReceive(packet.id);
        wakeTransfer();
        setActivityText(packet.reason || "Transfer cancelled.");
        return;
      }

      if (packet.kind === "file-end") {
        const current = receiveRef.current;
        if (!current || current.id !== packet.id) return;

        // Flush any remaining buffered chunks to IndexedDB
        if (receiveChunkBufferRef.current.length > 0) {
          const remaining = receiveChunkBufferRef.current.splice(0);
          receiveWriteChainRef.current = receiveWriteChainRef.current.then(() =>
            saveReceivedChunksBatch(current.id, remaining)
          );
        }

        await receiveWriteChainRef.current;

        try {
          const blob = await readReceivedFile(current.id);

          if (blob.size !== current.size) {
            throw new Error(
              `Integrity error: received size (${blob.size} B) does not match expected size (${current.size} B).`
            );
          }

          const expectedHash = packet.sha256 || current.sha256;
          let verifiedHash = "";

          // Compute SHA-256 for files <= 25MB. For large files (e.g. 2GB), size and
          // SCTP transport checksum verify integrity without freezing the browser tab.
          if (expectedHash && current.size <= 25 * 1024 * 1024) {
            setActivityText("Verifying data integrity…");
            try {
              const buf = await blob.arrayBuffer();
              verifiedHash = await calculateSha256(buf);

              if (verifiedHash && verifiedHash.toLowerCase() !== expectedHash.toLowerCase()) {
                throw new Error("Data corruption detected: SHA-256 checksum mismatch.");
              }
            } catch (err) {
              console.warn("[DropLink] Hash check skipped:", err);
            }
          }

          setDownloadReady((prev) => {
            if (prev?.url) URL.revokeObjectURL(prev.url);
            const url = URL.createObjectURL(blob);
            return {
              url,
              name: current.name,
              size: blob.size,
              sha256: verifiedHash || expectedHash,
            };
          });

          await saveTransferHistory({
            id: current.id,
            direction: "receive",
            name: current.name,
            size: current.size,
            type: current.type,
            status: "complete",
            createdAt: Date.now() - Math.max(0, performance.now() - current.startedAt),
            finishedAt: Date.now(),
            sha256: verifiedHash || expectedHash,
          });

          setProgress({
            active: false,
            paused: false,
            direction: "receive",
            id: current.id,
            name: current.name,
            size: current.size,
            transferred: current.size,
            percent: 100,
            speed: current.size / Math.max(0.001, (performance.now() - current.startedAt) / 1000),
            eta: 0,
          });

          setStatus("complete");
          setActivityText(
            verifiedHash
              ? `${current.name} verified & received. Ready to download.`
              : `${current.name} received. Ready to download.`
          );

          await clearReceivedFile(current.id);
          receiveRef.current = null;
          transferRef.current = { id: "", paused: false, cancelled: false };
          await refreshHistory();
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : "Could not finalize received file.");
          setStatus("error");
          await clearReceivedFile(current.id).catch(() => {});
          receiveRef.current = null;
        }
        return;
      }
      return;
    }

    const current = receiveRef.current;
    if (!current || transferRef.current.cancelled) return;

    const chunk = message;

    // Guard against malformed or oversized chunk payload attack
    if (chunk.byteLength > MAX_ALLOWED_CHUNK_SIZE) {
      setErrorText("Security violation: received chunk exceeds allowed size.");
      setStatus("error");
      abortReceive();
      return;
    }

    if (current.received + chunk.byteLength > current.size + CHUNK_SIZE) {
      setErrorText("Security violation: received bytes exceed expected file size.");
      setStatus("error");
      abortReceive();
      return;
    }

    const index = current.chunkIndex++;
    current.received += chunk.byteLength;

    // High-performance batch buffering: writes multiple chunks in a single IndexedDB transaction
    receiveChunkBufferRef.current.push({
      index,
      blob: new Blob([chunk]),
    });

    const isWindowEnd = (index + 1) % CHUNK_WINDOW === 0;
    const isFileEnd = current.received >= current.size;

    if (receiveChunkBufferRef.current.length >= 16 || isFileEnd) {
      const batch = receiveChunkBufferRef.current.splice(0);
      receiveWriteChainRef.current = receiveWriteChainRef.current
        .then(() => saveReceivedChunksBatch(current.id, batch))
        .catch((error) => {
          console.error("[DropLink] batch receiver storage error", error);
          setErrorText(
            error instanceof Error
              ? `Could not store received data: ${error.message}`
              : "Could not store received data."
          );
          setStatus("error");
        });
    }

    if (isWindowEnd || isFileEnd) {
      const acked = peerRef.current?.sendControl({
        kind: "chunk-ack",
        id: current.id,
        chunkIndex: index,
      } as ControlMessage);

      if (!acked) {
        setErrorText("Could not acknowledge the received data.");
        setStatus("error");
      }
    }

    const elapsed = Math.max(
      0.001,
      (performance.now() - current.startedAt) / 1000
    );

    const speed = current.received / elapsed;
    const remaining = Math.max(0, current.size - current.received);

    setProgress({
      active: true,
      paused: transferRef.current.paused,
      direction: "receive",
      id: current.id,
      name: current.name,
      size: current.size,
      transferred: current.received,
      percent: current.size
        ? (current.received / current.size) * 100
        : 0,
      speed,
      eta: speed > 0 ? remaining / speed : 0,
    });
  }, [abortReceive, refreshHistory, wakeTransfer]);

  handleDataMessageRef.current = handleDataMessage;

  const sendFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;

    const peer = peerRef.current;
    if (!peer) {
      setErrorText("There is no WebRTC peer yet.");
      setStatus("error");
      return;
    }

    if (transferRef.current.id) {
      setErrorText("A transfer is already active.");
      return;
    }

    setErrorText("");
    setActivityText("Checking secure data channel…");

    const ready = await peer.waitUntilOpen(30000);
    if (!ready) {
      const stats = peer.getStats();
      const message = `Data channel is not ready. Channel=${stats.channel}, WebRTC=${stats.state}, ICE=${stats.ice}`;
      setErrorText(message);
      setActivityText(message);
      setStatus("error");
      return;
    }

    for (const file of files) {
      const id = makeFileId();
      let sha256: string | undefined;

      // For small files (<=25MB), compute SHA-256 quickly.
      // For large files (e.g. 500MB, 2GB), start streaming IMMEDIATELY
      // without loading gigabytes into RAM or stalling before sending.
      if (file.size <= 25 * 1024 * 1024) {
        try {
          const buf = await file.arrayBuffer();
          sha256 = await calculateSha256(buf);
        } catch {
          // Ignore
        }
      }

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;

      transferRef.current = {
        id,
        paused: false,
        cancelled: false,
      };

      lastAckRef.current = {
        id,
        chunkIndex: -1,
      };

      const startedAt = performance.now();

      console.info(
        "[DropLink] INSTANT STREAM START",
        file.name,
        file.size,
        file.type
      );

      const started = peer.sendControl({
        kind: "file-start",
        id,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified,
        sha256: sha256 || undefined,
        totalChunks,
      });

      if (!started) {
        transferRef.current = {
          id: "",
          paused: false,
          cancelled: false,
        };

        setErrorText(
          `Could not start ${file.name}. Data channel state: ${peer.dataChannelState}`
        );
        setStatus("error");
        return;
      }

      setStatus("transferring");
      setActivityText(`Streaming ${file.name}…`);

      setProgress({
        active: true,
        paused: false,
        direction: "send",
        id,
        name: file.name,
        size: file.size,
        transferred: 0,
        percent: 0,
        speed: 0,
        eta: 0,
      });

      let offset = 0;
      let chunkIndex = 0;

      while (offset < file.size) {
        const canContinue = await waitForResume(id);
        if (!canContinue) break;

        if (!peer.isOpen()) {
          transferRef.current.cancelled = true;
          break;
        }

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        // Direct zero-overhead streaming: read only 64KB on demand from disk
        const chunk = await file.slice(offset, end).arrayBuffer();
        const sent = await peer.sendChunk(chunk);

        if (!sent) {
          transferRef.current.cancelled = true;
          setErrorText("The WebRTC data channel closed while sending.");
          setStatus("error");
          break;
        }

        offset += chunk.byteLength;
        const sentIndex = chunkIndex;
        chunkIndex += 1;

        const isWindowEnd = chunkIndex % CHUNK_WINDOW === 0;
        const isLastChunk = offset >= file.size;

        const elapsed = Math.max(
          0.001,
          (performance.now() - startedAt) / 1000
        );

        const speed = offset / elapsed;
        const remaining = Math.max(0, file.size - offset);

        setProgress({
          active: true,
          paused: transferRef.current.paused,
          direction: "send",
          id,
          name: file.name,
          size: file.size,
          transferred: offset,
          percent: file.size ? (offset / file.size) * 100 : 100,
          speed,
          eta: speed > 0 ? remaining / speed : 0,
        });

        if (isWindowEnd || isLastChunk) {
          setActivityText(
            `Waiting for peer confirmation • chunk ${sentIndex + 1}`
          );

          const acknowledged = await waitForAck(id, sentIndex);
          if (!acknowledged) {
            transferRef.current.cancelled = true;
            setErrorText(
              "The receiver did not acknowledge the file data. The connection may have dropped."
            );
            setActivityText("Transfer stopped while waiting for receiver confirmation.");
            setStatus("error");
            break;
          }
        }
      }

      if (transferRef.current.cancelled || transferRef.current.id !== id) {
        peer.sendControl({
          kind: "cancel",
          id,
          reason: "Transfer stopped.",
        });

        transferRef.current = {
          id: "",
          paused: false,
          cancelled: false,
        };

        setProgress(initialProgress);
        setStatus(peerOnlineRef.current ? "connected" : "waiting");
        break;
      }

      const ended = peer.sendControl({
        kind: "file-end",
        id,
        sha256: sha256 || undefined,
      });

      if (!ended) {
        setErrorText("Could not send file-end message.");
        setStatus("error");
        return;
      }

      await saveTransferHistory({
        id,
        direction: "send",
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        status: "complete",
        createdAt: Date.now() - Math.max(0, performance.now() - startedAt),
        finishedAt: Date.now(),
        sha256: sha256 || undefined,
      });

      setProgress({
        active: false,
        paused: false,
        direction: "send",
        id,
        name: file.name,
        size: file.size,
        transferred: file.size,
        percent: 100,
        speed: file.size / Math.max(0.001, (performance.now() - startedAt) / 1000),
        eta: 0,
      });

      setStatus("complete");
      setActivityText(`${file.name} sent successfully.`);

      transferRef.current = {
        id: "",
        paused: false,
        cancelled: false,
      };

      await refreshHistory();
    }
  }, [
    refreshHistory,
    waitForAck,
    waitForResume,
  ]);

  const pauseTransfer = useCallback(() => {
    const current = transferRef.current;
    if (!current.id || current.cancelled) return;

    current.paused = !current.paused;
    const kind = current.paused ? "file-pause" : "file-resume";

    peerRef.current?.sendControl({ kind, id: current.id } as ControlMessage);
    setProgress((value) => ({ ...value, paused: current.paused, active: true }));
    setActivityText(current.paused ? "Transfer paused." : "Transfer resumed.");
    if (!current.paused) wakeTransfer();
  }, [wakeTransfer]);

  const stopTransfer = useCallback(() => {
    const current = transferRef.current;
    current.cancelled = true;
    current.paused = false;
    abortReceive(current.id);
    peerRef.current?.sendControl({
      kind: "cancel",
      id: current.id || undefined,
      reason: "Transfer stopped by user.",
    });
    wakeTransfer();
    transferRef.current = { id: "", paused: false, cancelled: false };
    setActivityText("Transfer stopped.");
    setErrorText("");
  }, [abortReceive, wakeTransfer]);

  const openFilePicker = useCallback(() => {
    if (channelState !== "open") {
      setErrorText("Connect another device before selecting a file.");
      setStatus("error");
      return;
    }

    fileInputRef.current?.click();
  }, [channelState]);

  const onFilesSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;

    if (files?.length) {
      setActivityText(
        `Selected ${files.length} file${
          files.length === 1 ? "" : "s"
        }. Starting transfer…`
      );

      void sendFiles(files);
    }

    event.target.value = "";
  }, [sendFiles]);

  const shareUrl = useMemo(() => {
    return roomId
      ? `${location.origin}${location.pathname}?room=${roomId}`
      : "";
  }, [roomId]);

  const copyRoom = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setErrorText("Clipboard access was blocked.");
    }
  }, [shareUrl]);

  const transferSpeed = progress.speed ? `${formatBytes(progress.speed)}/s` : "—";
  const transferEta = progress.eta ? formatDuration(progress.eta) : "—";

  const coreStyle = {
    "--progress": `${progress.percent}%`,
  } as CSSProperties;

  return (
    <main className={`app status-${status}`}>
      <div className="noise" />
      <div className="background-orb orb-a" />
      <div className="background-orb orb-b" />

      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /><span /></div>
          <div>
            <div className="brand">Drop<span>Link</span></div>
            <div className="brand-sub">PEER / PEER // TRANSFER</div>
          </div>
        </div>
        <div className="topbar-right">
          {roomId && (
            <button className="leave-pill-button" onClick={leaveRoom} title="Disconnect from room">
              LEAVE ROOM
            </button>
          )}
          <div className={`server-pill ${serverOnline ? "online" : ""}`}>
            <i />{serverOnline ? "SIGNAL ONLINE" : "SIGNAL OFFLINE"}
          </div>
          <div className="secure-pill">E2E / DTLS</div>
        </div>
      </header>

      <section className="hero-grid">
        <aside className="control-panel glass-panel">
          <div className="panel-kicker">01 / PAIR</div>
          <h1>Drop files.<br /><em>Not servers.</em></h1>
          <p className="panel-copy">
            Open DropLink on two devices, create a private room and connect directly through WebRTC. The signaling service coordinates the handshake; the file stream stays encrypted and peer-to-peer.
          </p>

          <div className="pair-actions">
            <button className="primary-button" onClick={createRoom}>
              <span className="button-dot" />
              Create drop room
              <span className="button-arrow">↗</span>
            </button>
            <div className="join-row">
              <input
                value={inputRoom}
                onChange={(event) => setInputRoom(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                placeholder="ENTER CODE"
                maxLength={6}
                spellCheck={false}
              />
              <button className="secondary-button" onClick={joinRoom}>JOIN</button>
            </div>
          </div>

          <div className="mini-specs">
            <div><span>TRAVEL</span><b>WEBRTC</b></div>
            <div><span>CHANNEL</span><b>{channelState.toUpperCase()}</b></div>
            <div><span>SECURITY</span><b>E2E SHA-256</b></div>
          </div>

          <div className="activity-card">
            <div className="activity-dot" />
            <span>{activityText}</span>
          </div>
        </aside>

        <section className="scene-panel">
          <div className="scene-head">
            <div>
              <div className="panel-kicker">02 / LINK STATE</div>
              <h2>{statusCopy(status)}</h2>
            </div>
            <div className="scene-metrics">
              <span>NODE <b>{localDevice.toUpperCase()}</b></span>
              <span>ROOM <b>{roomId || "------"}</b></span>
            </div>
          </div>

          <div className="scene">
            <div className="scene-grid" />
            <div className="scene-horizon" />
            <div className="scene-glow glow-left" />
            <div className="scene-glow glow-right" />

            <div className="node-card node-local">
              <div className="node-top"><span>LOCAL NODE</span><i>{role === "host" ? "HOST" : "CLIENT"}</i></div>
              <DeviceGlyph />
              <strong>{localDevice}</strong>
              <small>this browser</small>
            </div>

            <div className="node-card node-peer">
              <div className="node-top"><span>REMOTE NODE</span><i>{peerOnline ? "ONLINE" : status === "connecting" ? "SYNC" : "IDLE"}</i></div>
              <DeviceGlyph peer />
              <strong>{peerOnline ? "Peer device" : "Waiting…"}</strong>
              <small>{peerOnline ? shortId(peerId) : "share room code"}</small>
            </div>

            <div className="connection-beam beam-left" />
            <div className="connection-beam beam-right" />

            <div className="reactive-core-wrap">
              <div className="reactive-core" style={coreStyle}>
                <div className="core-shadow" />
                <div className="core-ring ring-outer" />
                <div className="core-ring ring-mid" />
                <div className="core-ring ring-inner" />
                <div className="core-shell" />
                <div className="core-energy" />
                <div className="core-progress" />
                <PacketField active={status === "transferring" && !progress.paused} complete={status === "complete"} error={status === "error"} />
                <div className="core-center">
                  <span>DL / CORE</span>
                  <CoreStatus status={status} progress={progress} />
                </div>
              </div>
              <div className="core-route route-a">LOCAL</div>
              <div className="core-route route-b">PEER</div>
            </div>

            <div className={`route-packets ${status === "transferring" && !progress.paused ? "active" : ""}`}>
              {Array.from({ length: 6 }).map((_, index) => <i key={index} style={{ "--i": index } as CSSProperties} />)}
            </div>

            <div className="floor-label floor-left">ENCRYPTED PATH</div>
            <div className="floor-label floor-right">ZERO CLOUD STORE</div>
          </div>

          <div className="telemetry-row">
            <div className="telemetry-card"><span>CHANNEL</span><b>{channelState === "open" ? "DATA OPEN" : channelState.toUpperCase()}</b></div>
            <div className="telemetry-card"><span>STREAM</span><b>{progress.active ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.size)}` : "—"}</b></div>
            <div className="telemetry-card"><span>SPEED</span><b>{transferSpeed}</b></div>
            <div className="telemetry-card"><span>ETA</span><b>{transferEta}</b></div>
          </div>
        </section>

        <aside className="transfer-panel glass-panel">
          <div className="panel-kicker">03 / TRANSFER</div>
          <div className="transfer-panel-head">
            <div>
              <h3>{progress.active ? progress.name : "Send something"}</h3>
              <p>{progress.active ? (progress.paused ? "Transfer is paused." : "Streaming directly between peers with SHA-256 verification.") : peerOnline ? "Peer is ready to receive." : "Pair another device first."}</p>
            </div>
            {progress.active && (
              <div className="transfer-controls">
                <button className="pause-button" onClick={pauseTransfer}>{progress.paused ? "RESUME" : "PAUSE"}</button>
                <button className="cancel-button" onClick={stopTransfer}>STOP</button>
              </div>
            )}
          </div>

          <div
            className={`drop-zone ${
              dragActive ? "drag-active" : ""
            } ${channelState === "open" ? "ready" : ""}`}
            role="button"
            tabIndex={0}
            onClick={openFilePicker}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openFilePicker();
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              if (channelState !== "open") {
                setErrorText("Connect another device before sending files.");
                setStatus("error");
                return;
              }
              if (event.dataTransfer.files.length) {
                void sendFiles(event.dataTransfer.files);
              }
            }}
          >
            <input
              ref={fileInputRef}
              className="visually-hidden-file-input"
              type="file"
              multiple
              onChange={onFilesSelected}
              tabIndex={-1}
            />
            <div className="drop-orb"><span>+</span></div>
            <strong>
              {channelState === "open"
                ? "DROP FILES HERE"
                : "PAIR TO UNLOCK"}
            </strong>
            <small>or tap to browse · end-to-end verified transfer</small>
          </div>

          {progress.active && (
            <div className="transfer-progress-card">
              <div className="transfer-progress-top"><span>{progress.direction === "send" ? "SENDING" : "RECEIVING"}</span><b>{progress.percent.toFixed(0)}%</b></div>
              <div className="transfer-progress-track"><span style={{ width: `${progress.percent}%` }} /></div>
              <div className="transfer-progress-meta"><span>{formatBytes(progress.transferred)}</span><span>{formatBytes(progress.size)}</span></div>
            </div>
          )}

          {downloadReady && (
            <div className="download-ready-card">
              <div>
                <span className="transfer-success-tag">
                  ✓ VERIFIED COMPLETE {downloadReady.sha256 ? "• SHA-256 MATCH" : ""}
                </span>
                <strong>{downloadReady.name}</strong>
                <small>{formatBytes(downloadReady.size)} · ready to save</small>
                {downloadReady.sha256 && (
                  <div className="hash-code">
                    SHA-256: <code>{downloadReady.sha256.slice(0, 16)}…</code>
                  </div>
                )}
              </div>
              <a className="download-button" href={downloadReady.url} download={downloadReady.name}>DOWNLOAD FILE ↓</a>
            </div>
          )}

          {roomId ? (
            <div className="room-card">
              <div className="room-card-top">
                <div><span>PAIRING ROOM</span><strong>{roomId}</strong></div>
                <div className="qr-frame"><QRCodeSVG value={shareUrl} size={106} bgColor="transparent" fgColor="#dfffd0" includeMargin={false} /></div>
              </div>
              <div className="room-actions">
                <button onClick={copyRoom}>{copied ? "COPIED" : "COPY LINK"}</button>
                <button onClick={() => { if (navigator.share) void navigator.share({ title: "DropLink", text: `Join my DropLink room: ${roomId}`, url: shareUrl }); }}>SHARE</button>
                <button className="leave-button" onClick={leaveRoom}>LEAVE</button>
              </div>
            </div>
          ) : (
            <div className="empty-room-card"><span>NO ACTIVE ROOM</span><b>CREATE OR JOIN A DROP</b></div>
          )}

          {errorText && <div className="error-box"><span>!</span><div>{errorText}</div></div>}
        </aside>
      </section>

      <PlatformShowcase />

      <section className="bottom-grid">
        <div className="history-panel glass-panel">
          <div className="history-head"><div><div className="panel-kicker">04 / LOCAL HISTORY</div><h3>Recent transfers</h3></div><span>{history.length ? `${history.length} stored locally` : "Nothing yet"}</span></div>
          {history.length ? (
            <div className="history-list">
              {history.map((item) => (
                <div className="history-row" key={item.id}>
                  <div className="history-icon">{item.direction === "send" ? "↑" : "↓"}</div>
                  <div className="history-file">
                    <strong>{item.name}</strong>
                    <small>
                      {formatBytes(item.size)} · {new Date(item.finishedAt).toLocaleTimeString()}
                      {item.sha256 ? ` · SHA: ${item.sha256.slice(0, 8)}…` : ""}
                    </small>
                  </div>
                  <span className="history-status">{item.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="history-empty">Completed transfers appear here. History is stored locally in IndexedDB.</div>
          )}
        </div>
        <div className="footer-note"><span>DROP-01</span><p>Browser-first P2P transfer using WebRTC. Signaling coordinates the peers; the application server does not receive the file as a normal upload.</p><span>v1.2 / SECURE TRANSFER CORE</span></div>
      </section>
    </main>
  );
}
