"use client";

import type { ReactNode } from "react";
import { ChevronsLeft } from "lucide-react";

interface Props {
  /** Panel name, shown vertically and used in labels. */
  label: string;
  icon: ReactNode;
  /** Optional count badge (e.g. number of layers). */
  count?: number;
  onExpand: () => void;
}

/** A right-hand panel collapsed to a 48px rail. */
export default function PanelRail({ label, icon, count, onExpand }: Props) {
  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center gap-3 border-l border-line bg-panel pt-3">
      <button
        onClick={onExpand}
        title={`Show ${label.toLowerCase()}`}
        aria-label={`Expand ${label.toLowerCase()} panel`}
        className="flex h-8 w-8 items-center justify-center rounded-ctrl text-icon hoverable"
      >
        <ChevronsLeft size={17} />
      </button>
      <button
        onClick={onExpand}
        title={`Show ${label.toLowerCase()}`}
        aria-hidden
        tabIndex={-1}
        className="flex flex-col items-center gap-3 rounded-ctrl px-1 py-2 text-icon-accent hoverable"
      >
        {icon}
        <span className="section-title [writing-mode:vertical-rl] rotate-180">{label}</span>
        {count !== undefined && (
          <span className="rounded-[5px] bg-ctrl px-1.5 py-px font-mono text-[11px] text-ink-2">
            {count}
          </span>
        )}
      </button>
    </aside>
  );
}
