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
  feather,
  tolerance,
  onEnabledChange,
  onToolChange,
  onFeatherChange,
  onToleranceChange,
}: Props) {
  return (
    <div className="border-t border-white/10 pt-4 mt-4 space-y-3">
      <div className="text-xs font-semibold text-zinc-400">TRANSPARENCY</div>

      <label className="flex justify-between text-sm">
        <span>Enable</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
      </label>

      <select
        value={tool}
        onChange={(e) => onToolChange(e.target.value as TransparencyTool)}
        className="w-full rounded bg-zinc-800 p-2 text-sm"
      >
        <option value="brush">Brush</option>
        <option value="lasso">Lasso</option>
        <option value="wand">Magic Wand</option>
      </select>

      <div>
        <div className="flex justify-between text-xs">
          <span>Feather</span>
          <span>{feather}px</span>
        </div>
        <input
          type="range"
          min={0}
          max={5}
          value={feather}
          onChange={(e) => onFeatherChange(Number(e.target.value))}
          className="w-full"
        />
      </div>

      <div>
        <div className="flex justify-between text-xs">
          <span>Tolerance</span>
          <span>{tolerance}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={tolerance}
          onChange={(e) => onToleranceChange(Number(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  );
}