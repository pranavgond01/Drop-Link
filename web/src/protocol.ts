export const CHUNK_SIZE = 64 * 1024;
export const MAX_ALLOWED_CHUNK_SIZE = 128 * 1024;

/**
 * High-throughput buffer threshold.
 * 1MB queue keeps the WebRTC SCTP data pipe saturated for 50-100+ MB/s transfers.
 */
export const MAX_BUFFERED_AMOUNT = 1024 * 1024;

/**
 * Application-level flow-control window.
 * ACKs every 32 chunks (~2 MB) to eliminate roundtrip latency stalls.
 */
export const CHUNK_WINDOW = 32;

export type SignalDescription = {
  type: "offer" | "answer";
  sdp?: string;
};

export type SignalPayload =
  | {
      kind: "description";
      description: SignalDescription;
    }
  | {
      kind: "candidate";
      candidate: RTCIceCandidateInit;
    };

export type TransferStart = {
  kind: "file-start";
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256?: string;
  totalChunks?: number;
};

export type TransferEnd = {
  kind: "file-end";
  id: string;
  sha256?: string;
};

export type TransferPause = {
  kind: "file-pause";
  id: string;
};

export type TransferResume = {
  kind: "file-resume";
  id: string;
};

export type TransferCancel = {
  kind: "cancel";
  id?: string;
  reason?: string;
};

export type ChunkAck = {
  kind: "chunk-ack";
  id: string;
  chunkIndex: number;
};

export type ControlMessage =
  | TransferStart
  | TransferEnd
  | TransferPause
  | TransferResume
  | TransferCancel
  | ChunkAck;

const VALID_CONTROL_KINDS = new Set([
  "file-start",
  "file-end",
  "file-pause",
  "file-resume",
  "cancel",
  "chunk-ack",
]);

export function isControlMessage(value: unknown): value is ControlMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.kind === "string" && VALID_CONTROL_KINDS.has(item.kind);
}

export function makeFileId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Sanitizes a filename to protect against path traversal and forbidden filesystem characters.
 */
export function sanitizeFileName(rawName: string): string {
  if (typeof rawName !== "string") {
    return "received_file.bin";
  }

  // Strip path traversal sequences and separators
  let clean = rawName
    .replace(/[/\\]+/g, "_")
    .replace(/\.\.+/g, ".")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/_+/g, "_")
    .trim();

  // Block Windows reserved filenames
  const reservedRegex = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (reservedRegex.test(clean)) {
    clean = `file_${clean}`;
  }

  // Prevent leading dot or trailing spaces/dots
  clean = clean.replace(/^[. ]+/, "").replace(/[. ]+$/, "");

  // Fallback if empty
  if (!clean) {
    return "received_file.bin";
  }

  // Enforce reasonable length limit (180 characters) preserving extension
  if (clean.length > 180) {
    const extIndex = clean.lastIndexOf(".");
    if (extIndex > 0 && clean.length - extIndex < 16) {
      const ext = clean.slice(extIndex);
      clean = clean.slice(0, 180 - ext.length) + ext;
    } else {
      clean = clean.slice(0, 180);
    }
  }

  return clean;
}

/**
 * Calculates SHA-256 hash using the Web Crypto API.
 */
export async function calculateSha256(data: ArrayBuffer): Promise<string> {
  if (
    typeof crypto !== "undefined" &&
    crypto.subtle &&
    typeof crypto.subtle.digest === "function"
  ) {
    try {
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return "";
    }
  }
  return "";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  const value = bytes / 1024 ** index;
  return `${
    value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)
  } ${units[index]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = Math.ceil(seconds % 60);
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}
