import type {
  ControlMessage,
  SignalPayload,
} from './protocol';

import {
  MAX_BUFFERED_AMOUNT,
} from './protocol';

export type PeerState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

type PeerOptions = {
  onState: (
    state: PeerState
  ) => void;

  onMessage: (
    message:
      | string
      | ArrayBuffer
  ) => void;

  onError: (
    message: string
  ) => void;

  onSignal: (
    payload: SignalPayload
  ) => void;
};

export class PeerLink {
  private readonly pc: RTCPeerConnection;

  private channel:
    | RTCDataChannel
    | null = null;

  private readonly options: PeerOptions;

  private pendingCandidates:
    RTCIceCandidateInit[] = [];

  private remoteDescriptionReady =
    false;

  private closed = false;

  constructor(
    options: PeerOptions,
    iceServers: RTCIceServer[]
  ) {
    this.options = options;

    this.pc =
      new RTCPeerConnection({
        iceServers,
      });

    this.pc.onicecandidate =
      (event) => {
        if (!event.candidate) {
          return;
        }

        this.options.onSignal({
          kind: 'candidate',

          candidate:
            event.candidate.toJSON(),
        });
      };

    this.pc.onconnectionstatechange =
      () => {
        const state =
          this.pc.connectionState;

        if (
          state === 'connecting'
        ) {
          this.options.onState(
            'connecting'
          );
        }

        if (
          state === 'connected'
        ) {
          this.options.onState(
            'connected'
          );
        }

        if (
          state === 'disconnected'
        ) {
          this.options.onState(
            'disconnected'
          );
        }

        if (
          state === 'failed'
        ) {
          this.options.onState(
            'failed'
          );
        }

        if (
          state === 'closed'
        ) {
          this.options.onState(
            'closed'
          );
        }
      };

    this.pc.ondatachannel =
      (event) => {
        this.attachDataChannel(
          event.channel
        );
      };

    this.pc.oniceconnectionstatechange =
      () => {
        if (
          this.pc.iceConnectionState ===
          'failed'
        ) {
          this.options.onError(
            'ICE negotiation failed. A TURN server may be required on this network.'
          );
        }
      };

    this.pc.onnegotiationneeded =
      () => {
        // The host explicitly creates
        // the first offer.
      };
  }

  async createOffer(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.ensureDataChannel();

    const offer =
      await this.pc.createOffer();

    await this.pc.setLocalDescription(
      offer
    );

    this.options.onSignal({
      kind: 'description',

      description: {
        type: 'offer',
        sdp:
          offer.sdp ??
          undefined,
      },
    });
  }

  async handleSignal(
    payload: SignalPayload
  ): Promise<void> {
    if (this.closed) {
      return;
    }

    if (
      payload.kind ===
      'description'
    ) {
      const {
        description,
      } = payload;

      if (
        description.type ===
        'offer'
      ) {
        await this.pc.setRemoteDescription(
          description
        );

        this.remoteDescriptionReady =
          true;

        await this.flushCandidates();

        const answer =
          await this.pc.createAnswer();

        await this.pc.setLocalDescription(
          answer
        );

        this.options.onSignal({
          kind: 'description',

          description: {
            type: 'answer',
            sdp:
              answer.sdp ??
              undefined,
          },
        });

        return;
      }

      if (
        description.type ===
        'answer'
      ) {
        await this.pc.setRemoteDescription(
          description
        );

        this.remoteDescriptionReady =
          true;

        await this.flushCandidates();

        return;
      }
    }

    if (
      payload.kind ===
      'candidate'
    ) {
      if (
        !this.remoteDescriptionReady
      ) {
        this.pendingCandidates.push(
          payload.candidate
        );

        return;
      }

      try {
        await this.pc.addIceCandidate(
          payload.candidate
        );
      } catch (error) {
        this.options.onError(
          `ICE candidate error: ${
            error instanceof Error
              ? error.message
              : 'unknown error'
          }`
        );
      }
    }
  }

  sendControl(
    message: ControlMessage
  ): boolean {
    if (
      !this.channel ||
      this.channel.readyState !==
        'open'
    ) {
      return false;
    }

    this.channel.send(
      JSON.stringify(message)
    );

    return true;
  }

  async sendChunk(
    buffer: ArrayBuffer
  ): Promise<boolean> {
    if (
      !this.channel ||
      this.channel.readyState !==
        'open'
    ) {
      return false;
    }

    await this.waitForBufferRoom();

    if (
      !this.channel ||
      this.channel.readyState !==
        'open'
    ) {
      return false;
    }

    this.channel.send(buffer);

    return true;
  }

  getStats(): {
    state: RTCPeerConnectionState;
    channel: RTCDataChannelState;
  } {
    return {
      state:
        this.pc.connectionState,

      channel:
        this.channel?.readyState ??
        'closed',
    };
  }

  close(): void {
    this.closed = true;

    try {
      this.channel?.close();
    } catch {
      // Ignore.
    }

    try {
      this.pc.close();
    } catch {
      // Ignore.
    }

    this.options.onState(
      'closed'
    );
  }

  private ensureDataChannel(): RTCDataChannel {
    if (
      this.channel &&
      this.channel.readyState !==
        'closed'
    ) {
      return this.channel;
    }

    const channel =
      this.pc.createDataChannel(
        'droplink-files',
        {
          ordered: true,
        }
      );

    this.attachDataChannel(
      channel
    );

    return channel;
  }

  private attachDataChannel(
    channel: RTCDataChannel
  ): void {
    this.channel = channel;

    channel.binaryType =
      'arraybuffer';

    channel.bufferedAmountLowThreshold =
      MAX_BUFFERED_AMOUNT;

    channel.onopen = () => {
      this.options.onState(
        'connected'
      );
    };

    channel.onclose = () => {
      this.options.onState(
        'disconnected'
      );
    };

    channel.onerror = () => {
      this.options.onError(
        'WebRTC data channel reported an error.'
      );
    };

    channel.onmessage = (
      event
    ) => {
      if (
        typeof event.data ===
        'string'
      ) {
        this.options.onMessage(
          event.data
        );

        return;
      }

      if (
        event.data instanceof
        ArrayBuffer
      ) {
        this.options.onMessage(
          event.data
        );

        return;
      }

      if (
        event.data instanceof Blob
      ) {
        event.data
          .arrayBuffer()
          .then((buffer) => {
            this.options.onMessage(
              buffer
            );
          });
      }
    };
  }

  private async flushCandidates(): Promise<void> {
    if (
      !this.remoteDescriptionReady ||
      this.pendingCandidates.length ===
        0
    ) {
      return;
    }

    const queue = [
      ...this.pendingCandidates,
    ];

    this.pendingCandidates = [];

    for (
      const candidate of queue
    ) {
      try {
        await this.pc.addIceCandidate(
          candidate
        );
      } catch (error) {
        this.options.onError(
          `Queued ICE candidate failed: ${
            error instanceof Error
              ? error.message
              : 'unknown error'
          }`
        );
      }
    }
  }

  private async waitForBufferRoom(): Promise<void> {
    const channel =
      this.channel;

    if (!channel) {
      return;
    }

    if (
      channel.bufferedAmount <=
      MAX_BUFFERED_AMOUNT
    ) {
      return;
    }

    await new Promise<void>(
      (resolve) => {
        const done = () => {
          channel.removeEventListener(
            'bufferedamountlow',
            done
          );

          resolve();
        };

        channel.addEventListener(
          'bufferedamountlow',
          done,
          {
            once: true,
          }
        );

        if (
          channel.bufferedAmount <=
          MAX_BUFFERED_AMOUNT
        ) {
          done();
        }
      }
    );
  }
}