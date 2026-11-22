import "./platform-showcase.css";

type Platform =
  | "iphone"
  | "android"
  | "windows"
  | "mac"
  | "linux";

type PlatformIconProps = {
  platform: Platform;
};

function PlatformIcon({
  platform,
}: PlatformIconProps) {
  if (platform === "iphone") {
    return (
      <svg
        viewBox="0 0 64 64"
        className="platform-svg"
        aria-hidden="true"
      >
        <rect
          x="17"
          y="7"
          width="30"
          height="50"
          rx="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />

        <rect
          x="27"
          y="11"
          width="10"
          height="2.5"
          rx="1.25"
          fill="currentColor"
          opacity=".75"
        />

        <circle
          cx="32"
          cy="51"
          r="2"
          fill="currentColor"
          opacity=".7"
        />

        <path
          d="M32 24c-4.8-6.8-12.1-3.1-12.1 3.9 0 5.8 4.8 12 7.6 12 2.2 0 2.6-1.5 4.5-1.5s2.5 1.5 4.6 1.5c2.9 0 7.3-5.6 7.3-11.7 0-4.5-3.7-7.7-7.3-7.8-2.3 0-4.2 1.6-4.6 1.6z"
          fill="currentColor"
          opacity=".95"
        />

        <path
          d="M36.3 18.4c1-1.4 1.7-3.3 1.5-4.9-1.7.1-3.7 1.1-4.8 2.5-.9 1.1-1.7 3-1.5 4.6 1.9.1 3.8-1 4.8-2.2z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (platform === "android") {
    return (
      <svg
        viewBox="0 0 64 64"
        className="platform-svg"
        aria-hidden="true"
      >
        <g fill="currentColor">
          <rect
            x="17"
            y="25"
            width="30"
            height="22"
            rx="7"
          />

          <rect
            x="12"
            y="28"
            width="5"
            height="15"
            rx="2.5"
          />

          <rect
            x="47"
            y="28"
            width="5"
            height="15"
            rx="2.5"
          />

          <rect
            x="21"
            y="47"
            width="7"
            height="10"
            rx="3"
          />

          <rect
            x="36"
            y="47"
            width="7"
            height="10"
            rx="3"
          />

          <path
            d="M21 25c1.2-6.1 5.2-9.2 11-9.2S41.8 18.9 43 25H21z"
          />

          <circle
            cx="27"
            cy="22"
            r="1.7"
            fill="#071006"
          />

          <circle
            cx="37"
            cy="22"
            r="1.7"
            fill="#071006"
          />

          <path
            d="M25 15 21.5 9.5M39 15l3.5-5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      </svg>
    );
  }

  if (platform === "windows") {
    return (
      <svg
        viewBox="0 0 64 64"
        className="platform-svg"
        aria-hidden="true"
      >
        <path
          d="M7 11 29 8v21H7z"
          fill="currentColor"
        />

        <path
          d="M33 7.5 57 4v25H33z"
          fill="currentColor"
          opacity=".8"
        />

        <path
          d="M7 33h22v22L7 52z"
          fill="currentColor"
          opacity=".8"
        />

        <path
          d="M33 33h24v27l-24-4z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (platform === "mac") {
    return (
      <svg
        viewBox="0 0 64 64"
        className="platform-svg"
        aria-hidden="true"
      >
        <path
          d="M39.8 18.3c-2.2 0-4.8 1.6-6.1 1.6-1.4 0-3.5-1.5-5.6-1.5-4 0-7.8 2.5-9.8 6.4-4.2 7.4-1.1 18.2 3 24.1 2 2.9 4.4 6 7.5 5.9 3-.1 4.1-1.9 7.8-1.9 3.6 0 4.7 1.9 7.8 1.8 3.2-.1 5.1-2.9 7-5.8 2.2-3.3 3.1-6.4 3.2-6.5-.1 0-6.1-2.4-6.2-9.4-.1-5.9 4.8-8.8 5-8.9-2.8-4.1-7-4.6-8.5-4.7-3.9-.4-7.3 2.3-9.1 2.3z"
          fill="currentColor"
        />

        <path
          d="M39.8 13.2c1.7-2 2.8-4.8 2.5-7.5-2.5.1-5.5 1.7-7.3 3.8-1.6 1.8-3 4.6-2.6 7.2 2.8.2 5.7-1.5 7.4-3.5z"
          fill="currentColor"
          opacity=".75"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 64 64"
      className="platform-svg"
      aria-hidden="true"
    >
      <path
        d="M50.7 31.6c2.2-4.2 1.7-9.6-1.6-13-3.4-3.4-8.6-4-12.9-1.8-2.8-1.5-6.2-1.8-9.3-.7-5 1.7-8.4 6.6-8.4 11.9 0 1.2.2 2.5.5 3.6-3.6 2.1-6 6-6 10.6 0 6.8 5.5 12.3 12.3 12.3 3.2 0 6.1-1.2 8.3-3.2 2.1 1.7 4.8 2.7 7.7 2.7 6.8 0 12.3-5.5 12.3-12.3 0-4.1-2-7.8-5.1-10.1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M27 29c-2 1-3.5 3.1-3.5 5.6M37 29c2 1 3.5 3.1 3.5 5.6M27 42c3 2.2 7 2.2 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlatformLogo({
  platform,
  name,
  sub,
}: {
  platform: Platform;
  name: string;
  sub: string;
}) {
  return (
    <div className="platform-logo">
      <div className="platform-logo-icon">
        <PlatformIcon
          platform={platform}
        />
      </div>

      <div>
        <strong>{name}</strong>

        <span>{sub}</span>
      </div>
    </div>
  );
}

function TransferCard({
  from,
  to,
  fromName,
  toName,
  accent,
}: {
  from: Platform;
  to: Platform;
  fromName: string;
  toName: string;
  accent:
    | "cyan"
    | "lime"
    | "purple";
}) {
  return (
    <div
      className={`transfer-card accent-${accent}`}
    >
      <div className="transfer-card-head">
        <span>
          FILE TRANSFER
        </span>

        <i>
          P2P
        </i>
      </div>

      <div className="transfer-route">
        <div className="transfer-device">
          <div className="transfer-device-icon">
            <PlatformIcon
              platform={from}
            />
          </div>

          <strong>
            {fromName}
          </strong>
        </div>

        <div className="transfer-arrow">
          <div className="transfer-arrow-line" />

          <span>→</span>
        </div>

        <div className="transfer-device">
          <div className="transfer-device-icon">
            <PlatformIcon
              platform={to}
            />
          </div>

          <strong>
            {toName}
          </strong>
        </div>
      </div>

      <div className="transfer-card-foot">
        <span>
          DIRECT CHANNEL
        </span>

        <b>
          WEBRTC
        </b>
      </div>
    </div>
  );
}

export default function PlatformShowcase() {
  return (
    <section className="platform-showcase">
      <div className="platform-showcase-head">
        <div>
          <div className="panel-kicker">
            05 / EVERYWHERE
          </div>

          <h2>
            One drop.
            <br />
            <em>Every device.</em>
          </h2>
        </div>

        <p>
          DropLink is built for the devices
          you already use. Open the browser,
          connect the two devices and move
          your files without creating a cloud
          storage account.
        </p>
      </div>

      <div className="platform-strip">
        <PlatformLogo
          platform="iphone"
          name="iPhone"
          sub="iOS / Safari"
        />

        <span className="platform-strip-arrow">
          ↔
        </span>

        <PlatformLogo
          platform="android"
          name="Android"
          sub="Chrome / Browser"
        />

        <span className="platform-strip-arrow">
          ↔
        </span>

        <PlatformLogo
          platform="windows"
          name="Windows"
          sub="Chrome / Edge"
        />

        <span className="platform-strip-arrow">
          ↔
        </span>

        <PlatformLogo
          platform="mac"
          name="macOS"
          sub="Safari / Chrome"
        />

        <span className="platform-strip-arrow">
          ↔
        </span>

        <PlatformLogo
          platform="linux"
          name="Linux"
          sub="Modern browser"
        />
      </div>

      <div className="transfer-cards">
        <TransferCard
          from="iphone"
          to="android"
          fromName="iPhone"
          toName="Android"
          accent="cyan"
        />

        <TransferCard
          from="android"
          to="windows"
          fromName="Android"
          toName="Windows"
          accent="lime"
        />

        <TransferCard
          from="windows"
          to="android"
          fromName="Windows"
          toName="Android"
          accent="purple"
        />

        <TransferCard
          from="mac"
          to="iphone"
          fromName="macOS"
          toName="iPhone"
          accent="cyan"
        />

        <TransferCard
          from="linux"
          to="android"
          fromName="Linux"
          toName="Android"
          accent="lime"
        />

        <TransferCard
          from="iphone"
          to="windows"
          fromName="iPhone"
          toName="Windows"
          accent="purple"
        />
      </div>

      <div className="why-droplink">
        <div className="why-heading">
          <div className="panel-kicker">
            WHY DROPLINK
          </div>

          <h3>
            Simple on the surface.
            <br />
            <span>Serious underneath.</span>
          </h3>
        </div>

        <div className="why-grid">
          <div className="why-card">
            <div className="why-number">
              01
            </div>

            <strong>
              No permanent cloud
              storage
            </strong>

            <p>
              DropLink does not need a
              traditional upload bucket for
              the file. The signaling server
              coordinates the connection.
            </p>
          </div>

          <div className="why-card">
            <div className="why-number">
              02
            </div>

            <strong>
              Browser first
            </strong>

            <p>
              No special desktop client is
              required for the core
              experience. Open DropLink on
              both devices and pair them.
            </p>
          </div>

          <div className="why-card">
            <div className="why-number">
              03
            </div>

            <strong>
              WebRTC transport
            </strong>

            <p>
              Once the peers negotiate a
              connection, file data can move
              directly between the browsers.
            </p>
          </div>

          <div className="why-card">
            <div className="why-number">
              04
            </div>

            <strong>
              Built for huge transfers
            </strong>

            <p>
              Files are streamed in binary
              chunks with backpressure instead
              of loading the entire transfer
              into memory at once.
            </p>
          </div>
        </div>
      </div>

      <div className="showcase-bottom">
        <span>
          IPHONE ↔ ANDROID
        </span>

        <span>
          ANDROID ↔ WINDOWS
        </span>

        <span>
          WINDOWS ↔ MACOS
        </span>

        <span>
          LINUX ↔ ANY BROWSER
        </span>
      </div>
    </section>
  );
}