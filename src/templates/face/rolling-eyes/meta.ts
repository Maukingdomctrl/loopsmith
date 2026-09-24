import type { EmojiTemplate } from "@/lib/templateTypes";

export const rollingEyes: EmojiTemplate = {
  id: "rolling-eyes",
  name: "Rolling Eyes",

  category: "face",
  type: "emoji",

  preview: "/templates/face/rolling-eyes/preview.png",

  animation: {
    fps: 12,
    defaultFrames: 8,
    loop: true,
  },

  geometry: {
    canvas: 128,
    safeArea: 108,
    defaultScale: 1.12,
    anchor: "center",
    centerY: -2,
  },

  export: {
    size: 128,
    targetKB: 220,
  },

  tags: ["eyes", "expression", "face"],
};