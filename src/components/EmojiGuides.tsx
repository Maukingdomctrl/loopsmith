"use client";

interface Props {
  visible: boolean;
  mode?: "face" | "fullbody";
}

export default function EmojiGuides({
  visible,
  mode = "face",
}: Props) {
  if (!visible) return null;

  return (
    <svg
      className="absolute inset-0 h-full w-full pointer-events-none"
      viewBox="0 0 512 512"
    >
      {/* Safe Area */}
      <circle
        cx="256"
        cy="256"
        r="240"
        fill="none"
        stroke="#64748B"
        strokeWidth="1.5"
        strokeDasharray="8 8"
        opacity="0.45"
      />

      {/* Vertical Center */}
      <line
        x1="256"
        y1="16"
        x2="256"
        y2="496"
        stroke="#22C55E"
        strokeWidth="1.5"
        strokeDasharray="6 6"
        opacity="0.7"
      />

      {/* Horizontal Center */}
      <line
        x1="16"
        y1="256"
        x2="496"
        y2="256"
        stroke="#22C55E"
        strokeWidth="1.5"
        strokeDasharray="6 6"
        opacity="0.35"
      />

      {mode === "face" && (
        <>
          {/* Eye Line */}
          <line
            x1="40"
            y1="173"
            x2="472"
            y2="173"
            stroke="#60A5FA"
            strokeWidth="1.5"
            strokeDasharray="6 6"
            opacity="0.8"
          />

          {/* Face Circle */}
          <circle
            cx="256"
            cy="173"
            r="83"
            fill="none"
            stroke="#A78BFA"
            strokeWidth="1.5"
            strokeDasharray="5 5"
            opacity="0.7"
          />
        </>
      )}

      {mode === "fullbody" && (
        <>
          {/* Shoulder Line */}
          <line
            x1="40"
            y1="176"
            x2="472"
            y2="176"
            stroke="#60A5FA"
            strokeWidth="1.5"
            strokeDasharray="6 6"
            opacity="0.6"
          />

          {/* Feet Baseline */}
          <line
            x1="40"
            y1="424"
            x2="472"
            y2="424"
            stroke="#F59E0B"
            strokeWidth="1.5"
            strokeDasharray="6 6"
            opacity="0.9"
          />
        </>
      )}
    </svg>
  );
}