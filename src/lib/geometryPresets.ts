export type GeometryPreset =
  | "face"
  | "animal"
  | "dance"
  | "text"
  | "sticker";

export const geometryPresets = {
  face: {
    scale: 1.12,
    centerY: -2,
    safeArea: 108,
  },

  animal: {
    scale: 1.08,
    centerY: -1,
    safeArea: 108,
  },

  dance: {
    scale: 0.9,
    centerY: 4,
    safeArea: 116,
  },

  text: {
    scale: 1.18,
    centerY: 0,
    safeArea: 112,
  },

  sticker: {
    scale: 0.94,
    centerY: 0,
    safeArea: 288,
  },
} as const;