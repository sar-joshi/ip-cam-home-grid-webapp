export type IconName =
  | "grid"
  | "lock"
  | "play"
  | "stop"
  | "mute"
  | "sound"
  | "expand"
  | "collapse"
  | "grip"
  | "camera"
  | "close"
  | "check"
  | "retry"
  | "snapshot"
  | "record";
const paths: Record<IconName, React.ReactNode> = {
  snapshot: (
    <>
      <path d="M8 5 9 3h6l1 2h4v15H4V5Z" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  record: <circle cx="12" cy="12" r="7" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  mute: (
    <>
      <path d="M11 4 6 8H3v8h3l5 4ZM16 9l5 6m0-6-5 6" />
    </>
  ),
  sound: (
    <>
      <path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  collapse: <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5" />,
  grip: (
    <>
      <path
        d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
        strokeWidth="3"
      />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="12" cy="12" r="3" />
      <path d="M17 8h.01" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  retry: (
    <>
      <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
    </>
  ),
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Icon name="grid" size={22} />
      </span>
      HomeGrid
    </span>
  );
}
