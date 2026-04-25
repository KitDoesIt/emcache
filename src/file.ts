import * as fs from "node:fs";
import { platform } from "node:os";
import { BitArray } from "./bitarray";
import { getMediaSource, updateChunks, type MediaSource } from "./item";
import { config } from "./config";
import { join, resolve } from "node:path";

// hardcoded parameters
export const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
export const MIN_CHUNK_SAVE_INTERVAL = 5 * 1000; // 5 seconds

export class File {
  private file: number;
  private path: string;
  private fileSize: number;
  private lastChunkSaveTime: number;
  private mediaSourceId: string;

  private chunks?: BitArray;
  private pending?: Map<
    number,
    {
      promise: Promise<Buffer>;
      resolve: (value: Buffer) => void;
      reject: (reason: any) => void;
      claimed: boolean;
    }
  >;

  private constructor(path: string, mediaSourceId: string) {
    this.file = 0;
    this.path = path;
    this.fileSize = 0;
    this.lastChunkSaveTime = 0;
    this.mediaSourceId = mediaSourceId;
  }

  get size(): number {
    return this.fileSize;
  }

  get chunkCount(): number {
    return Math.ceil(this.fileSize / CHUNK_SIZE);
  }

  static open(mediaSource: MediaSource): File {
    const dir = resolve(config.storage, mediaSource.itemName);
    fs.mkdirSync(dir, { recursive: true });

    const path = join(
      dir,
      mediaSource.sourceName + "." + mediaSource.container,
    );

    const file = new File(path, mediaSource.mediaSourceId);
    if (fs.existsSync(file.path)) {
      // load finished file
      file.file = fs.openSync(file.path, "r+");
      file.fileSize = fs.fstatSync(file.file).size;

      // only load the file if it is the same size as the expected size
      if (file.fileSize === mediaSource.size) {
        return file;
      }

      fs.closeSync(file.file);
    }

    if (mediaSource.chunks && fs.existsSync(file.path + ".progress")) {
      // buffer
      const buffer = Buffer.from(mediaSource.chunks);

      // DEBUG: randomly void one byte
      const first = Math.floor(4 + Math.random() * buffer.length);
      buffer[first] = 0;

      // load in-progress file
      file.chunks = BitArray.fromBuffer(buffer);

      file.pending = new Map();
      file.file = fs.openSync(file.path + ".progress", "r+");
      file.fileSize = fs.fstatSync(file.file).size;

      // only load the progress if it is the same size as the expected size
      if (
        file.fileSize === mediaSource.size &&
        file.chunks.size === Math.ceil(file.fileSize / CHUNK_SIZE)
      ) {
        return file;
      }

      fs.closeSync(file.file);
    }

    // create new file
    file.fileSize = mediaSource.size;
    file.file = fs.openSync(file.path + ".progress", "w+");
    fs.ftruncateSync(file.file, file.fileSize);

    // create chunk bitarray
    file.chunks = new BitArray(Math.ceil(file.fileSize / CHUNK_SIZE));
    file.pending = new Map();
    return file;
  }

  close() {
    this.writeChunkState();
    fs.closeSync(this.file);
  }

  writeChunkState() {
    if (!this.chunks) return;
    updateChunks(this.mediaSourceId, this.chunks.toBuffer());
  }

  readFromFile(index: number) {
    return new Promise<Buffer>((resolve, reject) => {
      const position = index * CHUNK_SIZE;
      const expectedSize = Math.min(CHUNK_SIZE, this.fileSize - position);
      fs.read(
        this.file,
        Buffer.alloc(expectedSize),
        0,
        expectedSize,
        position,
        (err, bytesRead, buffer) => {
          if (err) reject(err);
          if (bytesRead !== expectedSize) {
            reject(new Error("Unexpected bytes read"));
          }
          resolve(buffer);
        },
      );
    });
  }

  #queueChunk(index: number): {
    promise: Promise<Buffer>;
    resolve: (value: Buffer) => void;
    reject: (reason: any) => void;
    claimed: boolean;
  } {
    // create pending promise
    const pending = this.pending;
    if (!pending) throw new Error("The file has been finalized.");

    let pendingResolve;
    let pendingReject;
    const promise = new Promise<Buffer>((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });

    const result = {
      promise,
      resolve: pendingResolve!,
      reject: pendingReject!,
      claimed: false,
    };

    pending.set(index, result);
    return result;
  }

  readChunk(index: number): {
    unavailable: boolean;
    read: () => Promise<Buffer>;
  } {
    if (!this.chunks || !this.pending) {
      return {
        unavailable: false,
        read: () => this.readFromFile(index),
      };
    }

    // make sure it is not finished or already claimed
    if (this.chunks.get(index)) {
      return {
        unavailable: false,
        read: () => this.readFromFile(index),
      };
    }

    // reuse claim promise
    const claim = this.pending.get(index);
    if (claim) {
      return {
        unavailable: !claim.claimed,
        read: () => claim.promise,
      };
    }

    return {
      unavailable: true,
      read: () => this.#queueChunk(index).promise,
    };
  }

  claimChunk(index: number) {
    if (!this.chunks || !this.pending) {
      throw new Error("The file has been finalized.");
    }

    if (this.chunks.get(index)) {
      throw new Error("Chunk already finished.");
    }

    // create pending promise
    let pendingPromise = this.pending.get(index);
    if (!pendingPromise) {
      pendingPromise = this.#queueChunk(index);
    }

    if (pendingPromise.claimed) {
      throw new Error("Chunk already claimed.");
    }

    pendingPromise.claimed = true;

    const chunks = this.chunks;
    const pending = this.pending;

    return {
      resolve: (buffer: Buffer, forceWriteChunks = false) => {
        const position = index * CHUNK_SIZE;
        const expectedSize = Math.min(CHUNK_SIZE, this.fileSize - position);

        if (buffer.length !== expectedSize) {
          const error = new Error("Unexpected buffer size provided");
          pendingPromise.reject(error);
          pending.delete(index);
          throw error;
        }

        // just resolve the promise since we have the data already
        pendingPromise.resolve(buffer);

        // return a IO promise, this will be slower than the pending promise
        return new Promise<Buffer>((resolve, reject) => {
          fs.write(
            this.file,
            buffer,
            0,
            buffer.length,
            position,
            async (err, bytesWritten) => {
              if (err) {
                pending.delete(index);
                reject(err);
                return;
              }

              if (bytesWritten !== buffer.length) {
                pending.delete(index);
                reject(new Error("Unexpected bytes written"));
                return;
              }

              // mark chunk as finished
              chunks.set(index, true);
              pending.delete(index);

              if (chunks.count === chunks.size) {
                // finalize the file because all chunks are written to disk
                this.#finalize();
              } else if (
                forceWriteChunks ||
                Date.now() - this.lastChunkSaveTime > MIN_CHUNK_SAVE_INTERVAL
              ) {
                this.writeChunkState();
                this.lastChunkSaveTime = Date.now();
              }
              resolve(buffer);
            },
          );
        });
      },
      reject: (reason: any) => {
        pendingPromise.reject(reason);
        pending.delete(index);
      },
    };
  }

  #finalize() {
    // check if it is already finalized
    if (!this.chunks || !this.pending) return;

    // save finished chunk map
    updateChunks(this.mediaSourceId, this.chunks.toBuffer());
    this.chunks = undefined;
    this.pending = undefined;

    // force a sync write before renaming
    // this way after renaming is done the file is guaranteed to be written to disk
    fs.fdatasyncSync(this.file);

    // rename file
    if (platform() === "win32") {
      // on windows we need to close the file first
      fs.closeSync(this.file);
      fs.renameSync(this.path + ".progress", this.path);
      fs.openSync(this.path, "r+");
    } else {
      // on linux we can rename without worry about locks
      fs.renameSync(this.path + ".progress", this.path);
    }
  }
}

export class FileHandle {
  public data: File;
  #close: () => Promise<void>;
  #released = false;
  constructor(data: File, close: () => Promise<void>) {
    this.data = data;
    this.#close = close;
  }
  close() {
    if (this.#released) return;
    this.#released = true;
    return this.#close();
  }
}

class FileManager {
  private files: Map<
    string,
    {
      ref: number;
      file: File;
    }
  > = new Map();

  open(mediaSourceId: string): FileHandle {
    if (this.files.has(mediaSourceId)) {
      const file = this.files.get(mediaSourceId)!;
      file.ref++;
      return new FileHandle(file.file, async () => {
        file.ref--;
        if (file.ref === 0) {
          this.files.delete(mediaSourceId);
          return file.file.close();
        }
      });
    }

    const mediaSource = getMediaSource(mediaSourceId);
    if (!mediaSource) {
      throw new Error("Media source not found");
    }

    const file = {
      ref: 1,
      file: File.open(mediaSource),
    };

    this.files.set(mediaSourceId, file);
    return new FileHandle(file.file, async () => {
      file.ref--;
      if (file.ref === 0) {
        this.files.delete(mediaSourceId);
        return file.file.close();
      }
    });
  }
}

export const FILES = new FileManager();
