/** Cloudflare Worker entry point for Unicorn. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { installProviderEnvironmentBindings } from "../app/platform/provider-environment.server";
import { installD1Binding } from "../db";
import {
  WATCHLIST_AFTER_HOURS_STREAM_PATH,
  handleWatchlistAfterHoursWebSocketUpgrade,
} from "../app/platform/watchlist-after-hours-websocket.server";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    installProviderEnvironmentBindings(env as unknown as Readonly<Record<string, unknown>>);
    installD1Binding(env.DB);
    const url = new URL(request.url);

    if (
      url.pathname === WATCHLIST_AFTER_HOURS_STREAM_PATH
      && request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return handleWatchlistAfterHoursWebSocketUpgrade(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
