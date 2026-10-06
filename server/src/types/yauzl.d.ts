// yauzl 的自带类型不完整；补一个最小声明，避免整个模块被 any 化
declare module 'yauzl' {
  export interface Entry {
    fileName: string;
    compressedSize: number;
    uncompressedSize: number;
  }
  export interface ZipFile {
    readEntry(): void;
    close(): void;
    openReadStream(entry: Entry, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void): void;
    on(event: 'entry', listener: (entry: Entry) => void): this;
    on(event: string, listener: (...args: never[]) => void): this;
    removeListener(event: string, listener: (...args: never[]) => void): this;
    off(event: string, listener: (...args: never[]) => void): this;
  }
  export function open(path: string, options: { lazyEntries?: boolean; autoClose?: boolean }, cb: (err: Error | null, zip?: ZipFile) => void): void;
  export function fromBuffer(buffer: Buffer, options: { lazyEntries?: boolean; autoClose?: boolean }, cb: (err: Error | null, zip?: ZipFile) => void): void;
}
