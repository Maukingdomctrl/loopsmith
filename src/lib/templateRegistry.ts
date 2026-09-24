import type { EmojiTemplate } from "./templateTypes";

import { rollingEyes } from "@/templates/face/rolling-eyes/meta";
import { yawn } from "@/templates/face/yawn/meta";

export const templateRegistry: EmojiTemplate[] = [
  rollingEyes,
  yawn,
];

export const categories = [
  { id: "face", name: "Face" },
  { id: "animal", name: "Animal" },
  { id: "dance", name: "Dance" },
  { id: "text", name: "Text" },
] as const;