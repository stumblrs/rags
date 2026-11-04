import type { AvatarCategory } from "@/lib/store";

/* Inline SVG icons recreated to match the reference (line weight ~1.8, white on purple). */
export const ChatGlyph = () => (
  <svg width="28" height="26" viewBox="0 0 28 26" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round">
    <path d="M5 3h18a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H12l-6 5v-5H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" />
    <circle cx="9" cy="11" r="1.2" fill="#fff" stroke="none" />
    <circle cx="14" cy="11" r="1.2" fill="#fff" stroke="none" />
    <circle cx="19" cy="11" r="1.2" fill="#fff" stroke="none" />
  </svg>
);

export const RobotGlyph = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round">
    <line x1="14" y1="3" x2="14" y2="7" />
    <circle cx="14" cy="2.5" r="1.5" fill="#fff" />
    <rect x="5" y="7" width="18" height="14" rx="4" />
    <circle cx="10.5" cy="13.5" r="1.7" fill="#fff" stroke="none" />
    <circle cx="17.5" cy="13.5" r="1.7" fill="#fff" stroke="none" />
    <path d="M10 17.5h8" strokeLinecap="round" />
  </svg>
);

export const FriendlyGlyph = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="13" cy="13" r="9.5" />
    <circle cx="9.8" cy="11" r="1.2" fill="#fff" stroke="none" />
    <circle cx="16.2" cy="11" r="1.2" fill="#fff" stroke="none" />
    <path d="M9.2 15.2c1 1.8 2.3 2.6 3.8 2.6s2.8-.8 3.8-2.6" />
  </svg>
);

export const GeometricGlyph = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round">
    <polygon points="13,3 23,8.5 23,17.5 13,23 3,17.5 3,8.5" />
    <polygon points="13,7.5 18.5,16.5 7.5,16.5" />
  </svg>
);

/** Abstract interlocking "knot" mark for the assistant badge (original vector, not a third-party logo). */
export const AiMark = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#fff" strokeWidth="1.7">
    {[0, 60, 120, 180, 240, 300].map((r) => (
      <path key={r} transform={`rotate(${r} 14 14)`} d="M14 4.5c3.2 0 5.5 2.3 5.5 5.2v5.6l-5.5 3.2" strokeLinecap="round" />
    ))}
  </svg>
);

export const AvatarGlyph = ({
  avatar,
  customUrl,
  forHeader = false,
}: {
  avatar?: AvatarCategory;
  customUrl?: string;
  forHeader?: boolean;
}) => {
  if (avatar === "custom" && customUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={customUrl}
        alt="Assistant avatar"
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
      />
    );
  }
  if (avatar === "robot") return <RobotGlyph />;
  if (avatar === "friendly") return <FriendlyGlyph />;
  if (avatar === "geometric") return <GeometricGlyph />;
  if (avatar === "neural") return <AiMark />;
  return forHeader ? <ChatGlyph /> : <AiMark />;
};

export const UserGlyph = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="#5a1f7a" strokeWidth="1.8">
    <circle cx="13" cy="10" r="4.5" />
    <path d="M5 22c1.2-4 4.4-6 8-6s6.8 2 8 6" strokeLinecap="round" />
  </svg>
);

export const SendGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff">
    <path d="M3 3.5l18 8.5-18 8.5 3-8.5-3-8.5zm3 8.5h8" stroke="#fff" strokeWidth="0.5" />
  </svg>
);

export const Dots = ({ style }: { style?: React.CSSProperties }) => (
  <div className="dots" style={style} aria-hidden>
    <i /><i /><i />
  </div>
);

export const LockGlyph = () => (
  <svg width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="#d8c2ff" strokeWidth="1.4">
    <rect x="2" y="7" width="10" height="8" rx="2" />
    <path d="M4 7V5a3 3 0 0 1 6 0v2" />
  </svg>
);
