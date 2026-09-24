declare module "gif.js.optimized" {
  export default class GIF {
    constructor(options: {
      workers?: number;
      quality?: number;
      width: number;
      height: number;
      workerScript?: string;
      transparent?: string | null;
    });

    addFrame(
      image: CanvasImageSource,
      options?: {
        delay?: number;
        copy?: boolean;
      }
    ): void;

    on(event: "finished", callback: (blob: Blob) => void): void;

    render(): void;
  }
}