import { DB } from "./db";

// Reserved Windows filenames
const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function sanitizeFilename(name: string): string {
  if (!name || typeof name !== "string") {
    return "unnamed";
  }

  // Remove or replace invalid filename characters
  // Windows: < > : " / \ | ? * \0 (null)
  // Also remove control characters and path separators
  let sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".") // Collapse multiple dots
    .trim();

  // Remove trailing dots and spaces (Windows issue)
  sanitized = sanitized.replace(/[. ]+$/, "");

  // Handle empty result
  if (!sanitized) {
    return "unnamed";
  }

  // Handle Windows reserved names
  const upper = sanitized.toUpperCase();
  if (WINDOWS_RESERVED.has(upper) || upper.match(/^COM\d$/)) {
    sanitized = "_" + sanitized;
  }

  // Truncate to 200 chars to be safe
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  return sanitized;
}

DB.run(`CREATE TABLE IF NOT EXISTS mediaSources (
  mediaSourceId TEXT NOT NULL PRIMARY KEY, 
  itemId TEXT NOT NULL,
  itemName TEXT NOT NULL,
  sourceName TEXT NOT NULL,
  size INTEGER NOT NULL,
  container TEXT NOT NULL,
  bitrate INTEGER NOT NULL,
  chunks BLOB,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);`);

// indexing itemId
DB.run(
  `CREATE INDEX IF NOT EXISTS mediaSources_itemId_index ON mediaSources (itemId);`,
);

export interface MediaSource {
  mediaSourceId: string;
  itemId: string;
  itemName: string;
  sourceName: string;
  size: number;
  container: string;
  bitrate: number;
  chunks: Uint8Array | null;
  createdAt: string;
  updatedAt: string;
}

const stmtByItemId = DB.prepare<MediaSource, [string]>(
  `SELECT * FROM mediaSources WHERE itemId = ?;`,
);

const stmtByMediaSourceId = DB.prepare<MediaSource, [string]>(
  `SELECT * FROM mediaSources WHERE mediaSourceId = ?;`,
);

const stmtTouchMediaSource = DB.prepare<MediaSource, [string]>(
  `UPDATE mediaSources SET updatedAt = CURRENT_TIMESTAMP WHERE mediaSourceId = ?;`,
);

const stmtInsertMediaSource = DB.prepare(
  `INSERT OR IGNORE INTO mediaSources (mediaSourceId, itemId, itemName, sourceName, size, container, bitrate)
   VALUES (?, ?, ?, ?, ?, ?, ?);`,
);

const stmtHasMediaSource = DB.prepare<MediaSource, [string]>(
  `SELECT mediaSourceId FROM mediaSources WHERE mediaSourceId = ?;`,
);

const stmtUpdateChunks = DB.prepare<void, [Buffer | null, string]>(
  `UPDATE mediaSources SET chunks = ? WHERE mediaSourceId = ?;`,
);

export function getMediaSourcesByItemId(itemId: string): MediaSource[] {
  return stmtByItemId.all(itemId);
}

export function getMediaSource(mediaSourceId: string) {
  return stmtByMediaSourceId.get(mediaSourceId);
}

export function touchMediaSource(mediaSourceId: string) {
  stmtTouchMediaSource.run(mediaSourceId);
}

export function updateChunks(mediaSourceId: string, chunk: Buffer | null) {
  console.log("updateChunks", chunk);
  stmtUpdateChunks.run(chunk, mediaSourceId);
}

export function insertMediaSource(
  mediaSource: Omit<MediaSource, "createdAt" | "updatedAt" | "chunks">,
) {
  if (
    !mediaSource.mediaSourceId ||
    typeof mediaSource.mediaSourceId !== "string"
  )
    return false;

  // Check if already exists
  if (hasMediaSource(mediaSource.mediaSourceId)) {
    return false;
  }

  if (!mediaSource.itemId || typeof mediaSource.itemId !== "string") {
    return false;
  }

  if (!mediaSource.itemName || typeof mediaSource.itemName !== "string")
    return false;

  if (!mediaSource.sourceName || typeof mediaSource.sourceName !== "string") {
    return false;
  }

  if (!mediaSource.container || typeof mediaSource.container !== "string") {
    return false;
  }

  if (isNaN(mediaSource.size)) {
    return false;
  }

  if (mediaSource.container === "m3u8" || mediaSource.container === "hls") {
    return false;
  }

  if (isNaN(mediaSource.bitrate)) {
    return false;
  }

  stmtInsertMediaSource.run(
    mediaSource.mediaSourceId,
    mediaSource.itemId,
    mediaSource.itemName,
    mediaSource.sourceName,
    mediaSource.size,
    mediaSource.container,
    mediaSource.bitrate,
  );
  return true;
}

export function hasMediaSource(mediaSourceId: string) {
  return !!stmtHasMediaSource.get(mediaSourceId);
}

export function processMediaSource(data: any): number {
  const itemId = data.Id;
  const mediaSources = data.MediaSources ?? [];
  const year = data.ProductionYear;
  const rawItemName = data.Name;
  const itemName = sanitizeFilename(
    !isNaN(year) && year >= 1000 ? `${rawItemName} (${year})` : rawItemName,
  );

  let inserted = 0;
  for (const ms of mediaSources) {
    if (
      insertMediaSource({
        mediaSourceId: ms.Id,
        itemId,
        itemName,
        sourceName: sanitizeFilename(ms.Name),
        size: ms.Size,
        container: ms.Container,
        bitrate: ms.Bitrate,
      })
    ) {
      inserted++;
    }
  }
  return inserted;
}
