import { PassiveSession } from "../session";
import type { Interceptor } from "../types";

export const enableDownload: Interceptor = {
  async onRequest(ctx) {
    const url = new URL(ctx.request.url.toLowerCase());
    const path = url.pathname;

    // Check if this is an Emby video stream/download route
    const match = path.match(/^\/emby\/items\/([0-9]+)\/download\/?$/);

    if (!match) {
      return;
    }
    console.log("[Download] Url", ctx.request.url);
    console.log("[Download] Intercepted:", ctx.request.method, path);
    console.log("[Download] Headers:");
    ctx.request.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });

    const range = ctx.request.headers.get("range") || "bytes=0-";
    if (!range) {
      return new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
      });
    }

    const startByte = parseInt(range.split("=")[1]?.split("-")[0] || "0", 10);
    if (isNaN(startByte)) {
      return new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
      });
    }

    const mediaSourceId = url.searchParams.get("mediasourceid");
    if (!mediaSourceId) {
      return new Response(undefined, {
        status: 404,
        statusText: "Not Found",
      });
    }

    const apiKey = url.searchParams.get("api_key");
    if (!apiKey) {
      return new Response(undefined, {
        status: 403,
        statusText: "Forbidden",
      });
    }

    const session = new PassiveSession(
      match[1]!,
      mediaSourceId,
      ctx.request.headers,
      apiKey,
    );

    return new Response(session.read(startByte, ctx.request.signal), {
      status: 206,
      headers: {
        "content-type": `application/octet-stream`,
        "cache-control": "private, no-transform",
        "content-length": session.mediaSource.size.toString(),
        "content-range": `bytes ${startByte}-${session.mediaSource.size - 1}/${session.mediaSource.size}`,
        date: new Date().toUTCString(),
        "accept-ranges": "bytes",
        "access-control-allow-headers":
          "Accept, Accept-Language, Authorization, Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Content-Length, Content-MD5, Content-Range, Content-Type, Date, Host, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Origin, OriginToken, Pragma, Range, Slug, Transfer-Encoding, Want-Digest, X-MediaBrowser-Token, X-Emby-Token, X-Emby-Client, X-Emby-Client-Version, X-Emby-Device-Id, X-Emby-Device-Name, X-Emby-Authorization",
        "access-control-allow-methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "access-control-allow-origin": "*",
      },
    });
  },
  async onResponse(ctx, response) {
    const path = new URL(ctx.request.url).pathname;

    // Only process JSON responses from relevant endpoints
    if (
      !path.startsWith("/emby/Items") &&
      !path.startsWith("/emby/Videos") &&
      !path.startsWith("/emby/Users")
    ) {
      return response;
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return response;
    }

    try {
      const text = await response.text();
      const json = JSON.parse(text);

      // Recursively set CanDownload = true
      const setCanDownload = (obj: unknown): void => {
        if (obj && typeof obj === "object") {
          const o = obj as Record<string, unknown>;
          if ("CanDownload" in o) o.CanDownload = true;
          // Also enable via policy (used by Emby clients)
          if (o.Policy && typeof o.Policy === "object") {
            (o.Policy as Record<string, unknown>).EnableContentDownloading =
              true;
          }
          // Recurse into arrays
          for (const key of Object.keys(o)) {
            if (Array.isArray(o[key])) {
              (o[key] as unknown[]).forEach(setCanDownload);
            }
          }
        }
      };

      setCanDownload(json);

      const newHeaders = new Headers(response.headers);

      return new Response(JSON.stringify(json), {
        status: response.status,
        headers: newHeaders,
      });
    } catch {
      // Not valid JSON, return as-is
      return response;
    }
  },
};
