import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ChangeEvent,
  CSSProperties,
} from 'react';

import {
  QRCodeSVG,
} from 'qrcode.react';

import {
  CHUNK_SIZE,
  formatBytes,
  formatDuration,
  isControlMessage,
  makeFileId,
} from './protocol';

import type {
  ControlMessage,
  SignalPayload,
} from './protocol';

import {
  clearReceivedFile,
  listTransferHistory,
  readReceivedFile,
  saveReceivedChunk,
  saveTransferHistory,
} from './db';

import type {
  TransferHistory,
} from './db';

import {
  PeerLink,
} from './webrtc';

import type {
  PeerState,
} from './webrtc';

const DEFAULT_ICE_SERVERS:
  RTCIceServer[] = [
    {
      urls:
        'stun:stun.l.google.com:19302',
    },
    {
      urls:
        'stun:stun.cloudflare.com:3478',
    },
  ];

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  `${
    location.protocol === 'https:'
      ? 'wss'
      : 'ws'
  }://${location.hostname || 'localhost'}:8080`;

type Role =
  | 'idle'
  | 'host'
  | 'guest';

type Status =
  | 'offline'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'transferring'
  | 'complete'
  | 'error';

type Direction =
  | 'send'
  | 'receive';

type ProgressState = {
  active: boolean;
  direction: Direction;
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
  received: number;
  chunkIndex: number;
  startedAt: number;
};

const initialProgress:
  ProgressState = {
  active: false,
  direction: 'send',
  name: '',
  size: 0,
  transferred: 0,
  percent: 0,
  speed: 0,
  eta: 0,
};

function getInitialRoom(): string {
  try {
    return (
      new URLSearchParams(
        location.search
      )
        .get('room')
        ?.toUpperCase() || ''
    );
  } catch {
    return '';
  }
}

function deviceName(): string {
  const ua =
    navigator.userAgent.toLowerCase();

  if (
    /iphone|ipad|ipod/.test(ua)
  ) {
    return 'iPhone';
  }

  if (/android/.test(ua)) {
    return 'Android';
  }

  if (
    /macintosh|mac os x/.test(ua)
  ) {
    return 'Mac';
  }

  if (/windows/.test(ua)) {
    return 'Windows';
  }

  if (/linux/.test(ua)) {
    return 'Linux';
  }

  return 'Browser';
}

function statusCopy(
  status: Status,
  role: Role,
  peer: boolean
): string {
  if (
    status === 'offline'
  ) {
    return 'Create a room or join a peer';
  }

  if (
    status === 'waiting'
  ) {
    return 'Waiting for another device to connect';
  }

  if (
    status === 'connecting'
  ) {
    return 'Negotiating an encrypted WebRTC channel';
  }

  if (
    status === 'connected'
  ) {
    return 'Direct peer channel is ready';
  }

  if (
    status === 'transferring'
  ) {
    return 'Streaming file chunks directly between peers';
  }

  if (
    status === 'complete'
  ) {
    return 'Transfer finished successfully';
  }

  if (
    status === 'error'
  ) {
    return 'The peer connection needs attention';
  }

  return role === 'host' &&
    !peer
    ? 'Waiting for another device'
    : 'Ready';
}

function shortId(
  value: string
): string {
  return value
    ? `${value.slice(0, 3)}…${value.slice(-3)}`
    : '—';
}

function formatRate(
  bytesPerSecond: number
): string {
  return `${formatBytes(
    bytesPerSecond
  )}/s`;
}

function DeviceGlyph({
  peer = false,
}: {
  peer?: boolean;
}) {
  return (
    <div
      className={`device-glyph ${
        peer ? 'is-peer' : ''
      }`}
      aria-hidden="true"
    >
      <div className="glyph-screen" />
      <div className="glyph-edge glyph-edge-top" />
      <div className="glyph-edge glyph-edge-bottom" />
      <div className="glyph-pulse" />
    </div>
  );
}

function PacketField({
  active,
  complete,
  error,
}: {
  active: boolean;
  complete: boolean;
  error: boolean;
}) {
  return (
    <div
      className={`packet-field ${
        active ? 'is-active' : ''
      } ${
        complete
          ? 'is-complete'
          : ''
      } ${
        error ? 'is-error' : ''
      }`}
    >
      {Array.from({
        length: 14,
      }).map(
        (_, index) => (
          <span
            key={index}
            className={`packet packet-${
              index + 1
            }`}
          />
        )
      )}
    </div>
  );
}

function CoreStatus({
  status,
  progress,
}: {
  status: Status;
  progress: ProgressState;
}) {
  if (
    status === 'transferring'
  ) {
    return (
      <>
        <b>
          {progress.percent.toFixed(0)}
          %
        </b>
        <span>TRANSFER</span>
      </>
    );
  }

  if (
    status === 'connected'
  ) {
    return (
      <>
        <b>LIVE</b>
        <span>P2P LINK</span>
      </>
    );
  }

  if (
    status === 'connecting'
  ) {
    return (
      <>
        <b>SYNC</b>
        <span>HANDSHAKE</span>
      </>
    );
  }

  if (
    status === 'complete'
  ) {
    return (
      <>
        <b>DONE</b>
        <span>100% SENT</span>
      </>
    );
  }

  if (
    status === 'waiting'
  ) {
    return (
      <>
        <b>WAIT</b>
        <span>PAIRING</span>
      </>
    );
  }

  if (
    status === 'error'
  ) {
    return (
      <>
        <b>ERR</b>
        <span>RETRY</span>
      </>
    );
  }

  return (
    <>
      <b>READY</b>
      <span>ZERO-CLOUD</span>
    </>
  );
}

export default function App() {
  const [role, setRole] =
    useState<Role>('idle');

  const [status, setStatus] =
    useState<Status>('offline');

  const [roomId, setRoomId] =
    useState('');

  const [inputRoom, setInputRoom] =
    useState(getInitialRoom());

  const [peerId, setPeerId] =
    useState('');

  const [peerOnline, setPeerOnline] =
    useState(false);

  const [progress, setProgress] =
    useState<ProgressState>(
      initialProgress
    );

  const [history, setHistory] =
    useState<TransferHistory[]>(
      []
    );

  const [errorText, setErrorText] =
    useState('');

  const [copied, setCopied] =
    useState(false);

  const [dragActive, setDragActive] =
    useState(false);

  const [serverOnline, setServerOnline] =
    useState(false);

  const socketRef =
    useRef<WebSocket | null>(
      null
    );

  const peerRef =
    useRef<PeerLink | null>(
      null
    );

  const abortRef =
    useRef(false);

  const peerOnlineRef =
    useRef(peerOnline);

  const progressActiveRef =
    useRef(progress.active);

  const handleDataMessageRef =
    useRef<
      (
        message:
          | string
          | ArrayBuffer
      ) => Promise<void>
    >(async () => {});

  const receiveRef =
    useRef<ReceiveState | null>(
      null
    );

  const receiveWriteChainRef =
    useRef<Promise<void>>(
      Promise.resolve()
    );

  const localDevice =
    useMemo(
      deviceName,
      []
    );

  const refreshHistory =
    useCallback(
      async () => {
        try {
          setHistory(
            await listTransferHistory(
              8
            )
          );
        } catch {
          // Transfer still works even
          // when history is unavailable.
        }
      },
      []
    );

  useEffect(() => {
    peerOnlineRef.current =
      peerOnline;

    progressActiveRef.current =
      progress.active;
  }, [
    peerOnline,
    progress.active,
  ]);

  useEffect(() => {
    void refreshHistory();

    return () => {
      socketRef.current?.close();
      peerRef.current?.close();
    };
  }, [
    refreshHistory,
  ]);

  const sendSignal =
    useCallback(
      (
        payload: SignalPayload
      ) => {
        const ws =
          socketRef.current;

        if (
          !ws ||
          ws.readyState !==
            WebSocket.OPEN
        ) {
          return;
        }

        ws.send(
          JSON.stringify({
            type: 'signal',
            data: payload,
          })
        );
      },
      []
    );

  const setupPeer =
    useCallback(() => {
      peerRef.current?.close();

      const peer =
        new PeerLink(
          {
            onSignal:
              sendSignal,

            onState: (
              next: PeerState
            ) => {
              setPeerOnline(
                next ===
                  'connected'
              );

              if (
                next ===
                'connecting'
              ) {
                setStatus(
                  'connecting'
                );
              }

              if (
                next ===
                'connected'
              ) {
                setStatus(
                  (
                    current
                  ) =>
                    current ===
                    'transferring'
                      ? current
                      : 'connected'
                );
              }

              if (
                next === 'failed' ||
                next === 'closed'
              ) {
                setStatus(
                  'error'
                );
              }

              if (
                next ===
                'disconnected'
              ) {
                setStatus(
                  'waiting'
                );
              }
            },

            onError: (
              message
            ) => {
              setErrorText(
                message
              );

              setStatus(
                'error'
              );
            },

            onMessage: (
              message
            ) => {
              void handleDataMessageRef.current(
                message
              );
            },
          },

          DEFAULT_ICE_SERVERS
        );

      peerRef.current =
        peer;
    }, [
      sendSignal,
    ]);

  const handleServerMessage =
    useCallback(
      async (
        raw: string
      ) => {
        let message: any;

        try {
          message =
            JSON.parse(raw);
        } catch {
          setErrorText(
            'Signaling server sent invalid data.'
          );

          setStatus('error');

          return;
        }

        if (
          message.type ===
          'server-ready'
        ) {
          setServerOnline(
            true
          );

          return;
        }

        if (
          message.type ===
          'room-created'
        ) {
          setRoomId(
            message.room
          );

          setRole('host');
          setStatus('waiting');
          setErrorText('');

          return;
        }

        if (
          message.type ===
          'room-joined'
        ) {
          setRoomId(
            message.room
          );

          setRole('guest');
          setStatus(
            'connecting'
          );

          setErrorText('');

          return;
        }

        if (
          message.type ===
          'peer-joined'
        ) {
          setPeerOnline(
            true
          );

          setStatus(
            'connecting'
          );

          setPeerId(
            crypto.randomUUID()
          );

          await peerRef.current?.createOffer();

          return;
        }

        if (
          message.type ===
          'peer-left'
        ) {
          setPeerOnline(
            false
          );

          setPeerId('');

          if (
            progressActiveRef
              .current
          ) {
            abortRef.current =
              true;
          }

          setStatus(
            'waiting'
          );

          setProgress(
            initialProgress
          );

          return;
        }

        if (
          message.type ===
          'signal'
        ) {
          await peerRef.current?.handleSignal(
            message.data as SignalPayload
          );

          return;
        }

        if (
          message.type ===
          'error'
        ) {
          setErrorText(
            message.message ||
              'Signaling error.'
          );

          setStatus(
            'error'
          );

          return;
        }

        if (
          message.type ===
          'room-closed'
        ) {
          setErrorText(
            message.reason ||
              'Room closed.'
          );

          setStatus(
            'offline'
          );
        }
      },
      []
    );

  const connectSocket =
    useCallback(
      (
        action:
          | {
              type:
                'create-room';
            }
          | {
              type:
                'join-room';
              room: string;
            }
      ) => {
        socketRef.current?.close();

        setServerOnline(
          false
        );

        setErrorText('');
        setPeerOnline(
          false
        );

        setPeerId('');

        setProgress(
          initialProgress
        );

        abortRef.current =
          false;

        setupPeer();

        const ws =
          new WebSocket(
            SIGNALING_URL
          );

        socketRef.current =
          ws;

        ws.onopen = () => {
          setServerOnline(
            true
          );

          ws.send(
            JSON.stringify(
              action
            )
          );
        };

        ws.onmessage =
          (event) => {
            void handleServerMessage(
              String(
                event.data
              )
            );
          };

        ws.onerror = () => {
          setServerOnline(
            false
          );

          setErrorText(
            `Could not reach signaling server at ${SIGNALING_URL}`
          );

          setStatus(
            'error'
          );
        };

        ws.onclose = () => {
          setServerOnline(
            false
          );

          setPeerOnline(
            false
          );
        };
      },
      [
        handleServerMessage,
        setupPeer,
      ]
    );

  const createRoom =
    useCallback(
      () => {
        connectSocket({
          type:
            'create-room',
        });
      },
      [connectSocket]
    );

  const joinRoom =
    useCallback(
      () => {
        const room =
          inputRoom
            .trim()
            .toUpperCase();

        if (
          !/^[A-Z0-9]{6}$/.test(
            room
          )
        ) {
          setErrorText(
            'Enter a valid 6-character room code.'
          );

          setStatus('error');

          return;
        }

        connectSocket({
          type:
            'join-room',
          room,
        });
      },
      [
        connectSocket,
        inputRoom,
      ]
    );

  const handleDataMessage =
    useCallback(
      async (
        message:
          | string
          | ArrayBuffer
      ) => {
        if (
          typeof message ===
          'string'
        ) {
          let control:
            | unknown;

          try {
            control =
              JSON.parse(
                message
              );
          } catch {
            setErrorText(
              'Received an invalid transfer message.'
            );

            setStatus(
              'error'
            );

            return;
          }

          if (
            !isControlMessage(
              control
            )
          ) {
            return;
          }

          const packet =
            control as ControlMessage;

          if (
            packet.kind ===
            'file-start'
          ) {
            receiveRef.current =
              {
                id: packet.id,
                name: packet.name,
                size: packet.size,
                type:
                  packet.type,
                lastModified:
                  packet.lastModified,
                received: 0,
                chunkIndex: 0,
                startedAt:
                  performance.now(),
              };

            abortRef.current =
              false;

            setStatus(
              'transferring'
            );

            setProgress({
              active: true,
              direction:
                'receive',
              name:
                packet.name,
              size:
                packet.size,
              transferred: 0,
              percent: 0,
              speed: 0,
              eta: 0,
            });

            return;
          }

          if (
            packet.kind ===
            'cancel'
          ) {
            abortRef.current =
              true;

            setProgress(
              initialProgress
            );

            setStatus(
              peerOnlineRef.current
                ? 'connected'
                : 'waiting'
            );

            setErrorText(
              packet.reason ||
                'Transfer cancelled by peer.'
            );

            return;
          }

          if (
            packet.kind ===
            'file-end'
          ) {
            const current =
              receiveRef.current;

            if (
              !current ||
              current.id !==
                packet.id
            ) {
              return;
            }

            await receiveWriteChainRef.current;

            try {
              const blob =
                await readReceivedFile(
                  current.id
                );

              const url =
                URL.createObjectURL(
                  blob
                );

              const anchor =
                document.createElement(
                  'a'
                );

              anchor.href =
                url;

              anchor.download =
                current.name;

              document.body.appendChild(
                anchor
              );

              anchor.click();

              anchor.remove();

              setTimeout(
                () =>
                  URL.revokeObjectURL(
                    url
                  ),
                30_000
              );

              await saveTransferHistory(
                {
                  id:
                    current.id,

                  direction:
                    'receive',

                  name:
                    current.name,

                  size:
                    current.size,

                  type:
                    current.type,

                  status:
                    'complete',

                  createdAt:
                    Date.now() -
                    Math.max(
                      0,
                      performance.now() -
                        current.startedAt
                    ),

                  finishedAt:
                    Date.now(),
                }
              );

              await clearReceivedFile(
                current.id
              );

              setProgress({
                active: false,
                direction:
                  'receive',
                name:
                  current.name,
                size:
                  current.size,
                transferred:
                  current.size,
                percent: 100,
                speed: 0,
                eta: 0,
              });

              setStatus(
                'complete'
              );

              receiveRef.current =
                null;

              await refreshHistory();
            } catch (error) {
              setErrorText(
                error instanceof
                Error
                  ? error.message
                  : 'Could not assemble received file.'
              );

              setStatus(
                'error'
              );
            }
          }

          return;
        }

        const current =
          receiveRef.current;

        if (
          !current ||
          abortRef.current
        ) {
          return;
        }

        const chunk =
          message;

        const index =
          current.chunkIndex++;

        current.received +=
          chunk.byteLength;

        receiveWriteChainRef.current =
          receiveWriteChainRef.current.then(
            () =>
              saveReceivedChunk(
                current.id,
                index,
                new Blob([chunk])
              )
          );

        const elapsed =
          Math.max(
            0.001,
            (
              performance.now() -
              current.startedAt
            ) / 1000
          );

        const speed =
          current.received /
          elapsed;

        const remaining =
          Math.max(
            0,
            current.size -
              current.received
          );

        setProgress({
          active: true,
          direction:
            'receive',
          name:
            current.name,
          size:
            current.size,
          transferred:
            current.received,
          percent:
            current.size
              ? Math.min(
                  100,
                  (
                    current.received /
                    current.size
                  ) *
                    100
                )
              : 0,
          speed,
          eta:
            speed > 0
              ? remaining /
                speed
              : 0,
        });
      },
      [refreshHistory]
    );

  handleDataMessageRef.current =
    handleDataMessage;

  const sendFiles =
    useCallback(
      async (
        fileList:
          | FileList
          | File[]
      ) => {
        const peer =
          peerRef.current;

        if (
          !peer ||
          !peerOnline
        ) {
          setErrorText(
            'Connect another device before sending files.'
          );

          setStatus(
            'error'
          );

          return;
        }

        const files =
          Array.from(
            fileList
          );

        if (
          !files.length
        ) {
          return;
        }

        abortRef.current =
          false;

        for (
          const file of files
        ) {
          if (
            abortRef.current
          ) {
            break;
          }

          const id =
            makeFileId();

          const startedAt =
            performance.now();

          const ok =
            peer.sendControl({
              kind:
                'file-start',

              id,

              name:
                file.name,

              size:
                file.size,

              type:
                file.type ||
                'application/octet-stream',

              lastModified:
                file.lastModified,
            });

          if (!ok) {
            setErrorText(
              'Data channel is not open.'
            );

            setStatus(
              'error'
            );

            break;
          }

          setStatus(
            'transferring'
          );

          setProgress({
            active: true,
            direction:
              'send',
            name:
              file.name,
            size:
              file.size,
            transferred: 0,
            percent: 0,
            speed: 0,
            eta: 0,
          });

          let transferred =
            0;

          let offset = 0;

          while (
            offset <
              file.size &&
            !abortRef.current
          ) {
            const chunk =
              await file
                .slice(
                  offset,
                  offset +
                    CHUNK_SIZE
                )
                .arrayBuffer();

            const sent =
              await peer.sendChunk(
                chunk
              );

            if (!sent) {
              abortRef.current =
                true;

              break;
            }

            offset +=
              chunk.byteLength;

            transferred +=
              chunk.byteLength;

            const elapsed =
              Math.max(
                0.001,
                (
                  performance.now() -
                  startedAt
                ) / 1000
              );

            const speed =
              transferred /
              elapsed;

            const remaining =
              Math.max(
                0,
                file.size -
                  transferred
              );

            setProgress({
              active: true,
              direction:
                'send',

              name:
                file.name,

              size:
                file.size,

              transferred,

              percent:
                file.size
                  ? Math.min(
                      100,
                      (
                        transferred /
                        file.size
                      ) *
                        100
                    )
                  : 100,

              speed,

              eta:
                speed > 0
                  ? remaining /
                    speed
                  : 0,
            });
          }

          if (
            abortRef.current
          ) {
            peer.sendControl({
              kind:
                'cancel',

              id,

              reason:
                'Transfer cancelled.',
            });

            setProgress(
              initialProgress
            );

            setStatus(
              peerOnline
                ? 'connected'
                : 'waiting'
            );

            break;
          }

          peer.sendControl({
            kind:
              'file-end',

            id,
          });

          await saveTransferHistory(
            {
              id,

              direction:
                'send',

              name:
                file.name,

              size:
                file.size,

              type:
                file.type ||
                'application/octet-stream',

              status:
                'complete',

              createdAt:
                Date.now() -
                Math.max(
                  0,
                  performance.now() -
                    startedAt
                ),

              finishedAt:
                Date.now(),
            }
          );

          await refreshHistory();
        }

        if (
          !abortRef.current
        ) {
          setStatus(
            'complete'
          );

          setProgress(
            (current) => ({
              ...current,
              active: false,
              percent: 100,
              transferred:
                current.size,
            })
          );
        }
      },
      [
        peerOnline,
        refreshHistory,
      ]
    );

  const cancelTransfer =
    useCallback(() => {
      abortRef.current =
        true;

      peerRef.current?.sendControl(
        {
          kind:
            'cancel',

          reason:
            'Transfer cancelled by user.',
        }
      );

      receiveRef.current =
        null;

      setProgress(
        initialProgress
      );

      setStatus(
        peerOnline
          ? 'connected'
          : 'waiting'
      );
    }, [
      peerOnline,
    ]);

  const onFilesSelected =
    useCallback(
      (
        event: ChangeEvent<HTMLInputElement>
      ) => {
        if (
          event.target.files
        ) {
          void sendFiles(
            event.target.files
          );
        }

        event.target.value =
          '';
      },
      [sendFiles]
    );

  const shareUrl =
    useMemo(
      () =>
        roomId
          ? `${location.origin}${location.pathname}?room=${roomId}`
          : '',
      [roomId]
    );

  const copyRoom =
    useCallback(
      async () => {
        if (!roomId) {
          return;
        }

        try {
          await navigator.clipboard.writeText(
            shareUrl
          );

          setCopied(
            true
          );

          setTimeout(
            () =>
              setCopied(false),
            1600
          );
        } catch {
          setErrorText(
            'Clipboard access is blocked by this browser.'
          );
        }
      },
      [
        roomId,
        shareUrl,
      ]
    );

  const transferSpeed =
    progress.speed
      ? formatRate(
          progress.speed
        )
      : '—';

  const transferEta =
    progress.eta
      ? formatDuration(
          progress.eta
        )
      : '—';

  return (
    <main
      className={`app status-${status}`}
    >
      <div className="noise" />

      <div className="background-orb orb-a" />
      <div className="background-orb orb-b" />

      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>

          <div>
            <div className="brand">
              Drop<span>Link</span>
            </div>

            <div className="brand-sub">
              PEER / PEER // TRANSFER
            </div>
          </div>
        </div>

        <div className="topbar-right">
          <div
            className={`server-pill ${
              serverOnline
                ? 'online'
                : ''
            }`}
          >
            <i />

            {serverOnline
              ? 'SIGNAL ONLINE'
              : 'SIGNAL OFFLINE'}
          </div>

          <div className="secure-pill">
            DTLS
          </div>
        </div>
      </header>

      <section className="hero-grid">
        <aside className="control-panel glass-panel">
          <div className="panel-kicker">
            01 / PAIR
          </div>

          <h1>
            Drop files.
            <br />
            <em>
              Not servers.
            </em>
          </h1>

          <p className="panel-copy">
            A browser-native transfer
            tunnel. The signaling
            server coordinates the
            handshake; file bytes
            travel through the WebRTC
            data channel.
          </p>

          <div className="pair-actions">
            <button
              className="primary-button"
              onClick={createRoom}
            >
              <span className="button-dot" />

              Create drop room

              <span className="button-arrow">
                ↗
              </span>
            </button>

            <div className="join-row">
              <input
                value={inputRoom}
                onChange={(
                  event
                ) =>
                  setInputRoom(
                    event.target.value
                      .toUpperCase()
                      .replace(
                        /[^A-Z0-9]/g,
                        ''
                      )
                      .slice(
                        0,
                        6
                      )
                  )
                }
                placeholder="ENTER CODE"
                maxLength={6}
                spellCheck={false}
              />

              <button
                className="secondary-button"
                onClick={joinRoom}
              >
                JOIN
              </button>
            </div>
          </div>

          <div className="mini-specs">
            <div>
              <span>
                TRAVEL
              </span>

              <b>
                WEBRTC
              </b>
            </div>

            <div>
              <span>
                CODEC
              </span>

              <b>
                BINARY
              </b>
            </div>

            <div>
              <span>
                SERVER
              </span>

              <b>
                SIGNAL ONLY
              </b>
            </div>
          </div>
        </aside>

        <section className="scene-panel">
          <div className="scene-head">
            <div>
              <div className="panel-kicker">
                02 / LINK STATE
              </div>

              <h2>
                {statusCopy(
                  status,
                  role,
                  peerOnline
                )}
              </h2>
            </div>

            <div className="scene-metrics">
              <span>
                NODE
                <b>
                  {localDevice.toUpperCase()}
                </b>
              </span>

              <span>
                ROOM
                <b>
                  {roomId ||
                    '------'}
                </b>
              </span>
            </div>
          </div>

          <div className="scene">
            <div className="scene-grid" />
            <div className="scene-horizon" />

            <div className="scene-glow glow-left" />
            <div className="scene-glow glow-right" />

            <div className="node-card node-local">
              <div className="node-top">
                <span>
                  LOCAL NODE
                </span>

                <i>
                  {role ===
                  'host'
                    ? 'HOST'
                    : 'CLIENT'}
                </i>
              </div>

              <DeviceGlyph />

              <strong>
                {localDevice}
              </strong>

              <small>
                this browser
              </small>
            </div>

            <div className="node-card node-peer">
              <div className="node-top">
                <span>
                  REMOTE NODE
                </span>

                <i>
                  {peerOnline
                    ? 'ONLINE'
                    : status ===
                        'connecting'
                      ? 'SYNC'
                      : 'IDLE'}
                </i>
              </div>

              <DeviceGlyph peer />

              <strong>
                {peerOnline
                  ? 'Peer device'
                  : 'Waiting…'}
              </strong>

              <small>
                {peerOnline
                  ? shortId(
                      peerId
                    )
                  : 'share room code'}
              </small>
            </div>

            <div className="connection-beam beam-left" />
            <div className="connection-beam beam-right" />

            <div className="reactive-core-wrap">
              <div
                className="reactive-core"
                style={
                  {
                    '--progress': `${progress.percent}%`,
                  } as CSSProperties
                }
              >
                <div className="core-shadow" />

                <div className="core-ring ring-outer" />
                <div className="core-ring ring-mid" />
                <div className="core-ring ring-inner" />

                <div className="core-shell" />

                <div className="core-energy" />

                <div className="core-progress" />

                <PacketField
                  active={
                    status ===
                    'transferring'
                  }
                  complete={
                    status ===
                    'complete'
                  }
                  error={
                    status ===
                    'error'
                  }
                />

                <div className="core-center">
                  <span>
                    DL / CORE
                  </span>

                  <CoreStatus
                    status={
                      status
                    }
                    progress={
                      progress
                    }
                  />
                </div>
              </div>

              <div className="core-route route-a">
                LOCAL
              </div>

              <div className="core-route route-b">
                PEER
              </div>
            </div>

            <div
              className={`route-packets ${
                status ===
                'transferring'
                  ? 'active'
                  : ''
              }`}
            >
              {Array.from({
                length: 6,
              }).map(
                (_, index) => (
                  <i
                    key={index}
                    style={
                      {
                        '--i': index,
                      } as CSSProperties
                    }
                  />
                )
              )}
            </div>

            <div className="floor-label floor-left">
              PRIVATE PATH
            </div>

            <div className="floor-label floor-right">
              NO CLOUD STORE
            </div>
          </div>

          <div className="telemetry-row">
            <div className="telemetry-card">
              <span>
                CHANNEL
              </span>

              <b>
                {peerOnline
                  ? 'DIRECT DATA'
                  : 'AWAITING PEER'}
              </b>
            </div>

            <div className="telemetry-card">
              <span>
                STREAM
              </span>

              <b>
                {progress.active
                  ? `${formatBytes(
                      progress.transferred
                    )} / ${formatBytes(
                      progress.size
                    )}`
                  : '—'}
              </b>
            </div>

            <div className="telemetry-card">
              <span>
                SPEED
              </span>

              <b>
                {transferSpeed}
              </b>
            </div>

            <div className="telemetry-card">
              <span>
                ETA
              </span>

              <b>
                {transferEta}
              </b>
            </div>
          </div>
        </section>

        <aside className="transfer-panel glass-panel">
          <div className="panel-kicker">
            03 / TRANSFER
          </div>

          <div className="transfer-panel-head">
            <div>
              <h3>
                Send something
              </h3>

              <p>
                {peerOnline
                  ? 'Peer is ready to receive.'
                  : 'Pair another device first.'}
              </p>
            </div>

            {progress.active && (
              <button
                className="cancel-button"
                onClick={
                  cancelTransfer
                }
              >
                STOP
              </button>
            )}
          </div>

          <label
            className={`drop-zone ${
              dragActive
                ? 'drag-active'
                : ''
            } ${
              peerOnline
                ? 'ready'
                : ''
            }`}
            onDragEnter={(
              event
            ) => {
              event.preventDefault();
              setDragActive(
                true
              );
            }}
            onDragOver={(
              event
            ) => {
              event.preventDefault();
            }}
            onDragLeave={(
              event
            ) => {
              event.preventDefault();
              setDragActive(
                false
              );
            }}
            onDrop={(event) => {
              event.preventDefault();

              setDragActive(
                false
              );

              if (
                event.dataTransfer
                  .files.length
              ) {
                void sendFiles(
                  event.dataTransfer.files
                );
              }
            }}
          >
            <input
              type="file"
              multiple
              onChange={
                onFilesSelected
              }
            />

            <div className="drop-orb">
              <span>
                +
              </span>
            </div>

            <strong>
              {peerOnline
                ? 'DROP FILES HERE'
                : 'PAIR TO UNLOCK'}
            </strong>

            <small>
              or tap to browse ·
              multiple files
              supported
            </small>
          </label>

          {roomId ? (
            <div className="room-card">
              <div className="room-card-top">
                <div>
                  <span>
                    PAIRING ROOM
                  </span>

                  <strong>
                    {roomId}
                  </strong>
                </div>

                <div className="qr-frame">
                  <QRCodeSVG
                    value={
                      shareUrl
                    }
                    size={106}
                    bgColor="transparent"
                    fgColor="#dfffd0"
                    includeMargin={
                      false
                    }
                  />
                </div>
              </div>

              <div className="room-actions">
                <button
                  onClick={
                    copyRoom
                  }
                >
                  {copied
                    ? 'COPIED'
                    : 'COPY LINK'}
                </button>

                <button
                  onClick={() =>
                    navigator.share?.(
                      {
                        title:
                          'DropLink',

                        text:
                          `Join my DropLink room: ${roomId}`,

                        url:
                          shareUrl,
                      }
                    )
                  }
                >
                  SHARE
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-room-card">
              <span>
                NO ACTIVE ROOM
              </span>

              <b>
                CREATE OR JOIN A DROP
              </b>
            </div>
          )}

          {errorText && (
            <div className="error-box">
              <span>
                !
              </span>

              <div>
                {errorText}
              </div>
            </div>
          )}
        </aside>
      </section>

      <section className="bottom-grid">
        <div className="history-panel glass-panel">
          <div className="history-head">
            <div>
              <div className="panel-kicker">
                04 / LOCAL HISTORY
              </div>

              <h3>
                Recent transfers
              </h3>
            </div>

            <span>
              {history.length
                ? `${history.length} stored locally`
                : 'Nothing yet'}
            </span>
          </div>

          {history.length ? (
            <div className="history-list">
              {history.map(
                (item) => (
                  <div
                    className="history-row"
                    key={
                      item.id
                    }
                  >
                    <div className="history-icon">
                      {item.direction ===
                      'send'
                        ? '↑'
                        : '↓'}
                    </div>

                    <div className="history-file">
                      <strong>
                        {item.name}
                      </strong>

                      <small>
                        {formatBytes(
                          item.size
                        )}{' '}
                        ·{' '}
                        {new Date(
                          item.finishedAt
                        ).toLocaleTimeString()}
                      </small>
                    </div>

                    <span className="history-status">
                      {item.status}
                    </span>
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="history-empty">
              Completed transfers will
              appear here. They stay on
              this device in IndexedDB.
            </div>
          )}
        </div>

        <div className="footer-note">
          <span>
            DROP-01
          </span>

          <p>
            Built around browser
            WebRTC. Signaling
            coordinates the peers; the
            file stream is not uploaded
            to the DropLink server.
          </p>

          <span>
            v1.0 / LOCAL MVP
          </span>
        </div>
      </section>
    </main>
  );
}