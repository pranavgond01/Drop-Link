import type {
  ControlMessage,
  SignalPayload,
} from "./protocol";

import {
  MAX_BUFFERED_AMOUNT,
} from "./protocol";

export type PeerState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type ChannelState =
  | "closed"
  | "connecting"
  | "open";

type PeerOptions = {
  onState: (state: PeerState) => void;
  onChannelState: (state: ChannelState) => void;
  onMessage: (message: string | ArrayBuffer) => void;
  onError: (message: string) => void;
  onSignal: (payload: SignalPayload) => void;
};

export class PeerLink {
  private readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private readonly options: PeerOptions;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionReady = false;
  private closed = false;

  private readonly openWaiters = new Set<() => void>();

  constructor(options: PeerOptions, iceServers: RTCIceServer[]) {
    this.options = options;

    this.pc = new RTCPeerConnection({
      iceServers,
    });

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      try {
        this.options.onSignal({
          kind: "candidate",
          candidate: event.candidate.toJSON(),
        });
      } catch (err) {
        console.warn("[DropLink] Failed to send ICE candidate:", err);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;

      if (state === "new") {
        this.options.onState("new");
      } else if (state === "connecting") {
        this.options.onState("connecting");
      } else if (state === "connected") {
        this.options.onState(this.isOpen() ? "connected" : "connecting");
      } else if (state === "disconnected") {
        this.options.onState("disconnected");
      } else if (state === "failed") {
        this.options.onState("failed");
      } else if (state === "closed") {
        this.options.onState("closed");
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "failed") {
        this.options.onError(
          "ICE connection failed. A TURN server may be needed on restricted networks."
        );
      }
    };

    this.pc.ondatachannel = (event) => {
      this.attachDataChannel(event.channel);
    };

    this.options.onChannelState("closed");
  }

  async createOffer(): Promise<void> {
    if (this.closed) return;

    this.options.onState("connecting");

    try {
      const channel = this.ensureDataChannel();

      this.options.onChannelState(
        channel.readyState === "open" ? "open" : "connecting"
      );

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this.options.onSignal({
        kind: "description",
        description: {
          type: "offer",
          sdp: offer.sdp ?? undefined,
        },
      });
    } catch (error) {
      this.options.onError(
        `Failed to create WebRTC offer: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;

    try {
      if (payload.kind === "description") {
        const description = payload.description;

        if (description.type === "offer") {
          this.options.onState("connecting");

          await this.pc.setRemoteDescription(description);
          this.remoteDescriptionReady = true;

          await this.flushCandidates();

          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);

          this.options.onSignal({
            kind: "description",
            description: {
              type: "answer",
              sdp: answer.sdp ?? undefined,
            },
          });
          return;
        }

        if (description.type === "answer") {
          await this.pc.setRemoteDescription(description);
          this.remoteDescriptionReady = true;

          await this.flushCandidates();
          return;
        }
      }

      if (payload.kind === "candidate") {
        if (!payload.candidate || !payload.candidate.candidate) {
          return; // Ignore empty / end-of-candidate indicators
        }

        if (!this.remoteDescriptionReady) {
          this.pendingCandidates.push(payload.candidate);
          return;
        }

        try {
          await this.pc.addIceCandidate(payload.candidate);
        } catch (error) {
          console.warn("[DropLink] Add ICE candidate warning:", error);
        }
      }
    } catch (error) {
      this.options.onError(
        `WebRTC signal handling failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  get dataChannelState(): RTCDataChannelState {
    return this.channel?.readyState ?? "closed";
  }

  isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  async waitUntilOpen(timeoutMs = 30_000): Promise<boolean> {
    if (this.isOpen()) {
      return true;
    }

    if (this.closed) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let finished = false;

      const check = () => {
        if (finished) return;
        if (this.isOpen()) {
          finish(true);
        }
      };

      const finish = (value: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.openWaiters.delete(check);
        resolve(value);
      };

      const timer = window.setTimeout(() => {
        finish(this.isOpen());
      }, timeoutMs);

      this.openWaiters.add(check);
      check();
    });
  }

  sendControl(message: ControlMessage): boolean {
    if (!this.isOpen() || !this.channel) {
      return false;
    }

    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.options.onError(
        `Control message send failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      return false;
    }
  }

  async sendChunk(buffer: ArrayBuffer): Promise<boolean> {
    if (!this.isOpen()) {
      const ready = await this.waitUntilOpen(5_000);
      if (!ready) return false;
    }

    const room = await this.waitForBufferRoom();
    if (!room || !this.isOpen() || !this.channel) {
      return false;
    }

    try {
      this.channel.send(buffer);
      return true;
    } catch (error) {
      this.options.onError(
        `Chunk send failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      return false;
    }
  }

  getStats() {
    return {
      state: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      channel: this.dataChannelState,
      bufferedAmount: this.channel?.bufferedAmount ?? 0,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.openWaiters) {
      waiter();
    }
    this.openWaiters.clear();

    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch {
        // Ignore
      }
      this.channel = null;
    }

    try {
      this.pc.close();
    } catch {
      // Ignore
    }

    this.options.onChannelState("closed");
    this.options.onState("closed");
  }

  private ensureDataChannel(): RTCDataChannel {
    if (this.channel && this.channel.readyState !== "closed") {
      return this.channel;
    }

    const channel = this.pc.createDataChannel("droplink-files", {
      ordered: true,
    });

    this.attachDataChannel(channel);
    return channel;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (this.channel === channel) {
      return;
    }

    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = Math.floor(MAX_BUFFERED_AMOUNT / 2);

    this.options.onChannelState(
      channel.readyState === "open" ? "open" : "connecting"
    );

    channel.onopen = () => {
      this.options.onChannelState("open");
      this.options.onState("connected");

      const waiters = [...this.openWaiters];
      this.openWaiters.clear();
      for (const waiter of waiters) {
        waiter();
      }
    };

    channel.onclose = () => {
      this.options.onChannelState("closed");
      this.options.onState("disconnected");

      const waiters = [...this.openWaiters];
      this.openWaiters.clear();
      for (const waiter of waiters) {
        waiter();
      }
    };

    channel.onerror = (event) => {
      console.error("[DropLink] RTCDataChannel error:", event);
      this.options.onError("The WebRTC data channel encountered an error.");
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        this.options.onMessage(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        void event.data
          .arrayBuffer()
          .then((buffer) => this.options.onMessage(buffer))
          .catch((error) => {
            this.options.onError(
              `Could not read incoming Blob: ${
                error instanceof Error ? error.message : "unknown error"
              }`
            );
          });
      }
    };
  }

  private async flushCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0) return;

    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("[DropLink] Queued ICE candidate failed:", error);
      }
    }
  }

  private async waitForBufferRoom(): Promise<boolean> {
    const started = Date.now();

    while (!this.closed) {
      const channel = this.channel;
      if (!channel || channel.readyState !== "open") {
        return false;
      }

      if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
        return true;
      }

      if (Date.now() - started > 30_000) {
        this.options.onError(
          "WebRTC send buffer remained full for too long (backpressure timeout)."
        );
        return false;
      }

      // Wait for bufferedamountlow or a short polling tick fallback
      await new Promise<void>((resolve) => {
        let timer: number;
        const onLow = () => {
          window.clearTimeout(timer);
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", onLow, { once: true });
        timer = window.setTimeout(() => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        }, 30);
      });
    }

    return false;
  }
}
