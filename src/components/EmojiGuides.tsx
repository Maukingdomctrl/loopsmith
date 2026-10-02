"use client";

import { guideLavender, guideSage, primary } from "@/styles/tokens";

interface Props {
  visible: boolean;
  mode?: "face" | "fullbody";
}

/** Thin, dotted, quiet: 1px with a 3/9 dash. */
const line = { strokeWidth: 1, strokeDasharray: "3 9", fill: "none" } as const;

/**
 * Emoji guides. The guide lines sit in one group whose opacity follows the
 * pointer (see `.guide-layer` in globals.css): quiet when idle, clearer when
 * the pointer is over the canvas, full while drawing or dragging. The centre
 * crosshair stays outside that group at a steady strength.
 */
export default function EmojiGuides({
  visible,
  mode = "face",
}: Props) {
  if (!visible) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 512 512"
      aria-hidden
    >
      <g className="guide-layer">
        {/* Safe area */}
        <circle cx="256" cy="256" r="240" stroke={guideLavender} strokeOpacity={0.5} {...line} />
        {/* Centre lines */}
        <path d="M256 16V496" stroke={guideSage} strokeOpacity={0.5} {...line} />
        <path d="M16 256H496" stroke={guideSage} strokeOpacity={0.45} {...line} />

        {mode === "face" && (
          <>
            {/* Eye line */}
            <path d="M40 173H472" stroke={guideLavender} strokeOpacity={0.4} {...line} />
            {/* Face */}
            <circle cx="256" cy="173" r="83" stroke={guideLavender} strokeOpacity={0.55} {...line} />
          </>
        )}

        {mode === "fullbody" && (
          <>
            {/* Shoulder line */}
            <path d="M40 176H472" stroke={guideLavender} strokeOpacity={0.45} {...line} />
            {/* Feet baseline */}
            <path d="M40 424H472" stroke={guideSage} strokeOpacity={0.55} {...line} />
          </>
        )}
      </g>

      {/* Centre crosshair: outside the group, always at the same strength. */}
      <g stroke={primary} strokeOpacity={0.65} strokeWidth={1.5} strokeLinecap="round" fill="none">
        <circle cx="256" cy="256" r="9" />
        <path d="M256 242v8M256 262v8M242 256h8M262 256h8" />
      </g>
    </svg>
  );
}
