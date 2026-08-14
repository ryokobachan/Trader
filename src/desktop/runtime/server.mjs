import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BunD1Database } from "./d1-bun.mjs";

const DEFAULT_HOST = "127.0.0.1";
const SESSION_COOKIE = "unicorn_desktop_session";
const BOOTSTRAP_PATH = "/__unicorn_desktop_bootstrap";

const MIME_TYPES = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function parseArguments(argv) {
  const options = { root: resolve(import.meta.dir, ".."), host: DEFAULT_HOST, port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === "--root") options.root = resolve(value);
    else if (name === "--host") options.host = value;
    else if (name === "--port") options.port = Number(value);
    else if (name === "--database") options.database = resolve(value);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (options.host !== DEFAULT_HOST) {
    throw new Error("The desktop runtime must bind to 127.0.0.1.");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535.");
  }
  return options;
}

function defaultDataDirectory() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Unicorn");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || homedir(), "Unicorn");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "unicorn");
}

function safeAssetPath(clientRoot, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const candidate = resolve(clientRoot, pathname.replace(/^\/+/, ""));
  const location = relative(clientRoot, candidate);
  if (location === "" || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    return null;
  }
  return candidate;
}

function createAssetFetcher(clientRoot) {
  return {
    async fetch(request) {
      const path = safeAssetPath(clientRoot, request.url);
      if (!path || !existsSync(path) || !statSync(path).isFile()) {
        if (process.env.UNICORN_DESKTOP_DEBUG === "1") {
          console.error("Desktop asset not found", { requestUrl: request.url, path });
        }
        return new Response("Not found", { status: 404 });
      }
      const extension = extname(path).toLowerCase();
      const immutable = path.includes(`${sep}assets${sep}`);
      return new Response(Bun.file(path), {
        headers: {
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
          "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  };
}

async function serveAssetIfPresent(assetFetcher, clientRoot, request) {
  const path = safeAssetPath(clientRoot, request.url);
  if (!path || !existsSync(path) || !statSync(path).isFile()) return null;
  return assetFetcher.fetch(request);
}

function createPassThroughImages() {
  return {
    input(stream) {
      return {
        transform() {
          return this;
        },
        output({ format }) {
          return {
            async response() {
              const normalized = format === "jpg" ? "jpeg" : format;
              return new Response(stream, {
                headers: { "Content-Type": `image/${normalized || "png"}` },
              });
            },
          };
        },
      };
    },
  };
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function forbidden() {
  return Response.json(
    { error: { code: "desktop_session_required", message: "Desktop session is required." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https://financialmodelingprep.com; connect-src 'self'; worker-src 'self' blob:",
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function normalizeRequest(request, origin) {
  const source = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("host", new URL(origin).host);
  headers.delete("forwarded");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  return new Request(`${origin}${source.pathname}${source.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer(),
    signal: request.signal,
  });
}

const options = parseArguments(Bun.argv.slice(2));
const workerEntry = join(options.root, "dist", "server", "index.js");
const clientRoot = join(options.root, "dist", "client");
if (!existsSync(workerEntry) || !existsSync(clientRoot)) {
  throw new Error("Desktop runtime requires a completed Unicorn build in dist/.");
}

const databasePath = options.database
  ?? join(process.env.UNICORN_DESKTOP_DATA_DIR || defaultDataDirectory(), "unicorn.sqlite3");
const database = new BunD1Database(databasePath);
const { default: worker } = await import(pathToFileURL(workerEntry).href);
const sessionToken = crypto.randomUUID().replaceAll("-", "")
  + crypto.randomUUID().replaceAll("-", "");
const bootstrapToken = crypto.randomUUID().replaceAll("-", "");
const pendingWork = new Set();
let bootstrapAvailable = true;
let serverOrigin = "";

const executionContext = {
  waitUntil(promise) {
    const tracked = Promise.resolve(promise).finally(() => pendingWork.delete(tracked));
    pendingWork.add(tracked);
  },
  passThroughOnException() {},
};

const assetFetcher = createAssetFetcher(clientRoot);
const environment = {
  ...process.env,
  DB: database,
  ASSETS: assetFetcher,
  IMAGES: createPassThroughImages(),
};

const server = Bun.serve({
  hostname: options.host,
  port: options.port,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (process.env.UNICORN_DESKTOP_DEBUG === "1") {
      console.error("Desktop request", request.method, url.pathname);
    }
    if (url.hostname !== DEFAULT_HOST) return forbidden();

    if (url.pathname === "/__unicorn_desktop_health") {
      return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
    }

    if (
      request.method === "GET"
      && url.pathname === `${BOOTSTRAP_PATH}/${bootstrapToken}`
      && bootstrapAvailable
    ) {
      bootstrapAvailable = false;
      return new Response(null, {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          "Location": "/",
          "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    }

    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      cookieValue(request, SESSION_COOKIE) !== sessionToken
      || (origin && origin !== serverOrigin)
      || fetchSite === "cross-site"
    ) {
      return forbidden();
    }

    if (
      process.env.UNICORN_DESKTOP_DEBUG === "1"
      && request.method === "POST"
      && url.pathname === "/__unicorn_desktop_client_error"
    ) {
      const message = (await request.text()).slice(0, 2_000);
      console.error("Desktop client error", message);
      return new Response(null, { status: 204 });
    }

    try {
      const assetResponse = await serveAssetIfPresent(assetFetcher, clientRoot, request);
      if (assetResponse) return secureResponse(assetResponse);
      return secureResponse(
        await worker.fetch(await normalizeRequest(request, serverOrigin), environment, executionContext),
      );
    } catch (error) {
      console.error("Unicorn desktop request failed", error);
      return Response.json(
        { error: { code: "desktop_runtime_error", message: "The desktop runtime could not complete the request." } },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
});

serverOrigin = `http://${options.host}:${server.port}`;
const bootstrapUrl = `${serverOrigin}${BOOTSTRAP_PATH}/${bootstrapToken}`;
console.log(JSON.stringify({
  type: "unicorn-desktop-ready",
  origin: serverOrigin,
  bootstrapUrl,
  database: basename(databasePath),
}));

async function shutdown() {
  server.stop(true);
  await Promise.allSettled([...pendingWork]);
  database.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.resume();
process.stdin.once("end", shutdown);
