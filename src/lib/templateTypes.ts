export type TemplateCategory =
  | "face"
  | "animal"
  | "dance"
  | "text";

export type TemplateType = "emoji" | "sticker";

export interface EmojiTemplate {
  id: string;
  name: string;

  category: TemplateCategory;
  type: TemplateType;

  preview: string;

  animation: {
    fps: number;
    defaultFrames: number;
    loop: boolean;
  };

  geometry: {
    canvas: 128 | 320;
    safeArea: number;
    defaultScale: number;
    anchor: "center";
    centerY: number;
  };

  export: {
    size: 128 | 320;
    targetKB: number;
  };

  tags: readonly string[];
}