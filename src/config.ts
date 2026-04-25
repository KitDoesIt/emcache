import { mkdirSync } from "node:fs";

// Environment-based configuration
export const config = {
  upstream: {
    // DO NOT USE THIS URL
    url: process.env.UPSTREAM_URL || "http://110.42.42.172:29530",
    // url: process.env.UPSTREAM_URL || "https://ping-mike.exe.xyz",
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
  },
  storage: process.env.STORAGE_PATH || "./storage",
  maxSessions: parseInt(process.env.MAX_SESSIONS || "100", 10),
} as const;

mkdirSync(config.storage, { recursive: true });

export type Config = typeof config;
