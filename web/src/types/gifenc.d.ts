declare module 'gifenc' {
  export type GifPalette = number[][];
  export interface GifWriterOptions {
    palette?: GifPalette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
  }
  export interface GifWriter {
    writeFrame(indexed: Uint8Array, width: number, height: number, options?: GifWriterOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(options?: Record<string, unknown>): GifWriter;
  export function quantize(data: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: string; oneBitAlpha?: boolean }): GifPalette;
  export function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: string): Uint8Array;
}
