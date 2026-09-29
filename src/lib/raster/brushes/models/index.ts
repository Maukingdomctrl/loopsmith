import type { BrushModel, ModelContext, ModelKind } from "../types";
import { SoftModel } from "./soft";
import { HardModel } from "./hard";
import { TextureModel } from "./texture";
import { WaterModel } from "./water";

/**
 * The single place a `ModelKind` becomes a model. Adding a material is one
 * class implementing `BrushModel` and one line here — the stroke, the curve,
 * the preview and the compositing path are shared and untouched.
 */
export function createModel(kind: ModelKind, ctx: ModelContext): BrushModel {
  switch (kind) {
    case "soft":
      return new SoftModel(ctx);
    case "hard":
      return new HardModel(ctx);
    case "texture":
      return new TextureModel(ctx);
    case "water":
      return new WaterModel(ctx);
  }
}
