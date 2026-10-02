"use client";

export type TransparencyTool = "brush" | "lasso" | "wand";

interface Props {
  enabled: boolean;
  tool: TransparencyTool;
  feather: number;
  tolerance: number;
  onEnabledChange: (v: boolean) => void;
  onToolChange: (tool: TransparencyTool) => void;
  onFeatherChange: (v: number) => void;
  onToleranceChange: (v: number) => void;
}

export default function TransparencyPanel({
  enabled,
  tool,
  onEnabledChange,
  onToolChange,
}: Props) {
  return (
    <div className="mt-3 space-y-3">
      <label className="flex items-center justify-between text-sm">
        <span>Eraser brush</span>
        <input
          type="checkbox"
          checked={enabled && tool === "brush"}
          onChange={(e) => {
            onToolChange("brush");
            onEnabledChange(e.target.checked);
          }}
          className=""
        />
      </label>
      <p className="text-[11px] leading-snug text-ink-3">
        When on, drag on the canvas to erase. Turn it off to move the artwork again.
      </p>
    </div>
  );
}