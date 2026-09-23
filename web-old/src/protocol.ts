export const CHUNK_SIZE = 256 * 1024;

export const MAX_BUFFERED_AMOUNT =
  4 * CHUNK_SIZE;

export type SignalDescription = {
  type: 'offer' | 'answer';
  sdp?: string;
};

export type SignalPayload =
  | {
      kind: 'description';
      description: SignalDescription;
    }
  | {
      kind: 'candidate';
      candidate: RTCIceCandidateInit;
    };

export type TransferStart = {
  kind: 'file-start';
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

export type TransferEnd = {
  kind: 'file-end';
  id: string;
  sha256?: string;
};

export type TransferCancel = {
  kind: 'cancel';
  id?: string;
  reason?: string;
};

export type ControlMessage =
  | TransferStart
  | TransferEnd
  | TransferCancel;

export function isControlMessage(
  value: unknown
): value is ControlMessage {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return false;
  }

  const message =
    value as Record<string, unknown>;

  return typeof message.kind === 'string';
}

export function makeFileId(): string {
  const bytes = new Uint8Array(12);

  crypto.getRandomValues(bytes);

  return Array.from(
    bytes,
    (byte) =>
      byte.toString(16).padStart(2, '0')
  ).join('');
}

export function formatBytes(
  bytes: number
): string {
  if (
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return '0 B';
  }

  const units = [
    'B',
    'KB',
    'MB',
    'GB',
    'TB',
  ];

  const index = Math.min(
    Math.floor(
      Math.log(bytes) / Math.log(1024)
    ),
    units.length - 1
  );

  const value =
    bytes / Math.pow(1024, index);

  return `${
    value >= 100 || index === 0
      ? value.toFixed(0)
      : value.toFixed(1)
  } ${units[index]}`;
}

export function formatDuration(
  seconds: number
): string {
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return '—';
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  }

  const minutes =
    Math.floor(seconds / 60);

  const remaining =
    Math.ceil(seconds % 60);

  return `${minutes}m ${String(
    remaining
  ).padStart(2, '0')}s`;
}