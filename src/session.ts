import { Readable } from "node:stream";
import { CHUNK_SIZE, File, FileHandle, FILES } from "./file";
import { config } from "./config";
import { randomUUID } from "node:crypto";
import { cleanUpRequestHeaders } from "./utils";
import playbackBodyData from "./playback.json";
import { getMediaSource, type MediaSource } from "./item";

const PLAYBACK_BODY = JSON.stringify(playbackBodyData);

export type SessionType = "primary" | "passthrough" | "passive";

export class Streamer {
  #url: string | URL;
  #headers: Headers;
  #order: number;
  #startByte: number;
  #currentChunk: number;
  #file: File;
  #abortController: AbortController;
  #running = false;

  constructor(
    url: string | URL,
    headers: Headers,
    chunk: number,
    file: File,
    order: number,
    parentSignal?: AbortSignal,
  ) {
    this.#startByte = chunk * CHUNK_SIZE;
    this.#currentChunk = chunk;
    this.#headers = cleanUpRequestHeaders(headers, {
      range: `bytes=${this.#startByte}-`,
    });
    this.#url = url;
    this.#order = order;
    this.#file = file;
    this.#abortController = new AbortController();
    this.#running = true;

    if (parentSignal) {
      parentSignal.addEventListener("abort", () => this.stop(), { once: true });
    }
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#abortController.abort();
  }

  async start() {
    let chunkWriter;

    try {
      const response = await fetch(this.#url, {
        headers: this.#headers,
        signal: this.#abortController.signal,
      });

      if (!response.ok) {
        console.error(
          "[Streamer] Response not ok",
          response.status,
          response.statusText,
        );
        return;
      }

      if (!response.body) {
        console.error("[Streamer] No response body");
        return;
      }

      // check if the response range matches
      const responseRange = response.headers.get("Content-Range");
      if (
        responseRange !==
        `bytes ${this.#startByte}-${this.#file.size - 1}/${this.#file.size}`
      ) {
        console.error("[Streamer] Invalid Response Range:", responseRange);
        return;
      }

      // stream the response in chunk
      const readable = Readable.fromWeb(response.body as ReadableStream, {
        signal: this.#abortController.signal,
      });
      const buffer = Buffer.alloc(CHUNK_SIZE);
      let length = 0;

      try {
        chunkWriter = this.#file.claimChunk(this.#currentChunk++);
      } catch (e) {
        // chunk already processed
        return;
      }

      for await (const buf of readable) {
        if (this.#abortController.signal.aborted) {
          chunkWriter.reject(new Error("Aborted"));
          chunkWriter = undefined;
          return;
        }
        if (!(buf instanceof Buffer)) {
          chunkWriter.reject(new Error("Invalid buffer error"));
          chunkWriter = undefined;
          return;
        }

        let offset = 0;
        while (length + buf.length - offset > CHUNK_SIZE) {
          const remaining = CHUNK_SIZE - length;
          buf.copy(buffer, length, offset, remaining);
          length = 0;
          offset += remaining;

          // sync resolve, this makes sure the reader doesn't our run the streamer
          chunkWriter.resolve(Buffer.from(buffer)).catch((err) => {
            console.log("Error writing chunk", err);
          });
          chunkWriter = undefined;

          try {
            chunkWriter = this.#file.claimChunk(this.#currentChunk++);
          } catch (e) {
            // chunk already processed
            return;
          }
        }

        buf.copy(buffer, length, offset, buf.length - offset);
        length += buf.length - offset;
      }

      // sync resolve, this makes sure the reader doesn't our run the streamer
      chunkWriter
        .resolve(Buffer.from(buffer.subarray(0, length)), true)
        .catch((err) => {
          console.error("Error writing chunk", err);
        });
      chunkWriter = undefined;
    } catch (e) {
      if (chunkWriter) {
        chunkWriter.reject(e);
        chunkWriter = undefined;
      }
      if ((e as Error).name === "AbortError") {
        console.log("[Streamer] Aborted");
      } else {
        console.error("[Streamer] Error:", e);
      }
    } finally {
      if (chunkWriter) {
        chunkWriter.reject(new Error("Unexpected error"));
        chunkWriter = undefined;
      }
      this.stop();
    }
  }
}

export abstract class Session {
  // the session type
  // - primary: watching & caching
  // - passthrough: watching & passthrough
  // - passive: fake download
  #type: SessionType;
  #id: string;

  get id() {
    return this.#id;
  }

  get type() {
    return this.#type;
  }

  constructor(id: string, type: SessionType) {
    this.#id = id;
    this.#type = type;
  }

  abstract getUrl(): Promise<string | null> | string | null;
  abstract getHeaders(): Headers;
  abstract read(bytes: number, signal: AbortSignal): Readable;
}

export abstract class CacheSession extends Session {
  private file?: FileHandle;
  #mediaSource: MediaSource;
  #read = false;

  get mediaSource() {
    return this.#mediaSource;
  }

  constructor(id: string, type: "primary" | "passive", mediaSourceId: string) {
    const mediaSource = getMediaSource(mediaSourceId);
    if (!mediaSource) throw new Error("media not found");
    super(id, type);
    this.#mediaSource = mediaSource;
    try {
      this.file = FILES.open(mediaSourceId);
    } catch (e) {
      console.error(e);
      this.file = undefined;
    }
  }

  async *readChunks(bytes: number, signal: AbortSignal) {
    if (!this.file) throw new Error("File not found");
    const count = this.file.data.chunkCount;
    const startChunk = Math.floor(bytes / CHUNK_SIZE);
    for (let i = startChunk; i < count; i++) {
      if (signal.aborted) {
        console.log("[CacheSession] Read aborted at chunk", i);
        return;
      }

      const chunk = this.file.data.readChunk(i);

      // the chunk doesn't exist, hint the upstream streamer to stream
      if (chunk.unavailable) {
        const url = await this.getUrl();
        // end the stream
        if (!url) throw new Error("No upstream URL");
        console.log(url);

        if (signal.aborted) {
          console.log("[CacheSession] Read aborted before starting streamer");
          return;
        }

        const streamer = new Streamer(
          new URL(url, config.upstream.url),
          this.getHeaders(),
          i,
          this.file.data,
          this.type === "passive" ? 1 : 0,
          signal,
        );

        streamer.start();
      }

      // special case for first chunk
      if (i === startChunk) {
        const buffer = await chunk.read();
        const offset = bytes - startChunk * CHUNK_SIZE;
        yield buffer.subarray(offset);
        continue;
      }

      // special case for last chunk
      if (i === count - 1) {
        const buffer = await chunk.read();
        yield buffer.subarray(
          0,
          this.file.data.size - (count - 1) * CHUNK_SIZE,
        );
        continue;
      }

      yield await chunk.read();
    }
  }

  override read(bytes: number, signal: AbortSignal): Readable {
    if (this.#read) {
      throw new Error("Concurrent read not allowed");
    }
    this.#read = true;

    const readable = Readable.from(this.readChunks(bytes, signal));
    return readable;
  }
}

export class PrimarySession extends CacheSession {
  private streamUrl: string;
  private headers: Headers;

  constructor(
    url: string,
    headers: Headers,
    playSessionId: string,
    mediaSourceId: string,
  ) {
    super(playSessionId, "primary", mediaSourceId);
    this.headers = cleanUpRequestHeaders(headers);
    this.streamUrl = url;
  }

  override getUrl() {
    return this.streamUrl;
  }

  override getHeaders() {
    return this.headers;
  }
}

export class PassiveSession extends CacheSession {
  private apiKey: string;
  private itemId: string;
  private mediaSourceId: string;
  private headers: Headers;

  constructor(
    itemId: string,
    mediaSourceId: string,
    headers: Headers,
    apiKey: string,
  ) {
    super(randomUUID(), "passive", mediaSourceId);
    this.headers = cleanUpRequestHeaders(headers, {
      "user-agent": "Yamby/2.0.2.7(Android",
    });
    this.mediaSourceId = mediaSourceId;
    this.itemId = itemId;
    this.apiKey = apiKey;
  }

  async getUrl() {
    try {
      const requestPath = new URL(
        `${config.upstream.url}/emby/Items/${this.itemId}/PlaybackInfo`,
      );

      requestPath.searchParams.append("api_key", this.apiKey);
      requestPath.searchParams.append("mediaSourceId", this.mediaSourceId);

      const playbackInfo = await fetch(requestPath, {
        method: "POST",
        headers: cleanUpRequestHeaders(this.headers, {
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: PLAYBACK_BODY,
      });

      if (!playbackInfo.ok) return null;
      const playbackInfoJson: any = await playbackInfo.json();
      const mediaSource = playbackInfoJson.MediaSources.find(
        (ms: any) => ms.Id === this.mediaSourceId,
      );

      if (!mediaSource) return null;
      return mediaSource.DirectStreamUrl;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  override getHeaders() {
    return this.headers;
  }
}
