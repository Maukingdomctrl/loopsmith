"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** A collapsed-by-default section row: 38px, title left, chevron right, no borders. */
export default function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="-mx-2 flex h-[38px] cursor-pointer select-none list-none items-center rounded-ctrl px-2 text-[14px] font-medium text-ink hoverable [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{title}</span>
        <ChevronRight
          size={16}
          className="text-icon transition-transform duration-200 group-open:rotate-90"
        />
      </summary>
      <div className="pb-3 pt-2">{children}</div>
    </details>
  );
}
