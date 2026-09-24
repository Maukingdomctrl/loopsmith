import type { EmojiTemplate } from "@/lib/templateTypes";

export const yawn: EmojiTemplate = {
  id: "yawn",
  name: "Yawn",

  category: "face",
  type: "emoji",

  preview: "/templates/face/yawn/preview.png",

  animation: {
    fps: 12,
    defaultFrames: 8,
    loop: true,
  },

  geometry: {
    canvas: 128,
    safeArea: 108,
    defaultScale: 1.1,
    anchor: "center",
    centerY: -2,
  },

  export: {
    size: 128,
    targetKB: 220,
  },

  tags: ["sleepy", "mouth", "expression"],
};