export const DEFAULT_MIDAS_API_BASE_URL = "http://127.0.0.1:8787";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const INTEGER_PATTERN = /^(0|[1-9]\d*)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const X_ACCOUNT_HANDLE_PATTERN = /^[a-z0-9_]{1,50}$/i;
const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
});

export type MidasResearchSurface =
  | "institutional-portfolios"
  | "ideas"
  | "data-sources"
  | "x-analysis";

export type MidasResearchProxyDependencies = Readonly<{
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

type IntegerQueryRule = Readonly<{
  kind: "integer";
  min: number;
  max: number;
}>;

type TextQueryRule = Readonly<{
  kind: "text";
  maxLength: number;
}>;

type EnumQueryRule = Readonly<{
  kind: "enum";
  values: readonly string[];
}>;

type ForcedQueryRule = Readonly<{
  kind: "forced";
}>;

type QueryRule = IntegerQueryRule | TextQueryRule | EnumQueryRule | ForcedQueryRule;

type SurfaceConfiguration = Readonly<{
  upstreamPath: string;
  allowedQuery: Readonly<Record<string, QueryRule>>;
  forcedQuery: Readonly<Record<string, string>>;
}>;

const SURFACE_CONFIGURATIONS: Readonly<Record<MidasResearchSurface, SurfaceConfiguration>> = {
  "institutional-portfolios": {
    upstreamPath: "/api/reports",
    allowedQuery: {
      page: { kind: "integer", min: 1, max: 10_000 },
      pageSize: { kind: "integer", min: 1, max: 50 },
      q: { kind: "text", maxLength: 200 },
      sort: {
        kind: "enum",
        values: [
          "datetime",
          "totalReturn",
          "maxDrawdown",
          "recoveryFactor",
          "sharpe",
          "audit",
          "custom",
          "winRate",
        ],
      },
      sort_key: {
        kind: "enum",
        values: [
          "profit",
          "max_drawdown",
          "recovery_factor",
          "sharpe",
          "win_rate",
          "audit",
          "custom",
          "datetime",
        ],
      },
      sort_duration: {
        kind: "enum",
        values: ["1M", "3M", "6M", "1Y", "3Y", "all"],
      },
      adoption: {
        kind: "enum",
        values: ["adopted", "not_adopted"],
      },
      category: { kind: "forced" },
    },
    forcedQuery: { category: "institutional" },
  },
  ideas: {
    upstreamPath: "/api/ideas",
    allowedQuery: {
      q: { kind: "text", maxLength: 200 },
      view: { kind: "forced" },
    },
    forcedQuery: { view: "list" },
  },
  "data-sources": {
    upstreamPath: "/api/materials",
    allowedQuery: {
      view: { kind: "forced" },
    },
    forcedQuery: { view: "list" },
  },
  "x-analysis": {
    upstreamPath: "/api/x-analysis",
    allowedQuery: {
      symbolLimit: { kind: "integer", min: 1, max: 50 },
      symbolOffset: { kind: "integer", min: 0, max: 10_000 },
      symbolQuery: { kind: "text", maxLength: 200 },
    },
    forcedQuery: {},
  },
};

type ValidatedQuery =
  | Readonly<{ ok: true; params: URLSearchParams }>
  | Readonly<{ ok: false }>;

class MidasResearchTimeoutError extends Error {}

function requestIdFor(request: Request): string {
  return request.headers.get("x-request-id")?.trim().slice(0, 128) || crypto.randomUUID();
}

function jsonResponse(payload: unknown, status: number, requestId: string): Response {
  return Response.json(payload, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "X-Request-Id": requestId,
    },
  });
}

function invalidQueryResponse(requestId: string): Response {
  return jsonResponse({
    error: {
      code: "invalid_query",
      message: "Midas research query parameters are invalid.",
    },
    requestId,
  }, 400, requestId);
}

function unavailableResponse(requestId: string, timedOut: boolean): Response {
  return jsonResponse({
    error: {
      code: timedOut ? "midas_timeout" : "midas_unavailable",
      message: timedOut
        ? "Midas research data did not respond in time."
        : "Midas research data is currently unavailable.",
    },
    requestId,
  }, 503, requestId);
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

function baseUrlFor(override: string | undefined): URL | null {
  const configured = override ?? process.env.TRADER_MIDAS_API_BASE_URL;
  const value = configured?.trim() || DEFAULT_MIDAS_API_BASE_URL;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
      || (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    url.pathname = "/";
    return url;
  } catch {
    return null;
  }
}

function normalizedText(value: string, maxLength: number): string | null {
  const normalized = value.normalize("NFKC").trim();
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) return null;
  if ([...normalized].length > maxLength) return null;
  return normalized;
}

function validatedQuery(
  searchParams: URLSearchParams,
  configuration: SurfaceConfiguration,
): ValidatedQuery {
  const validated = new URLSearchParams();
  const seen = new Set<string>();

  for (const [name, rawValue] of searchParams) {
    if (seen.has(name)) return { ok: false };
    seen.add(name);
    if (!Object.prototype.hasOwnProperty.call(configuration.allowedQuery, name)) {
      return { ok: false };
    }

    const rule = configuration.allowedQuery[name];
    if (!rule) return { ok: false };
    if (rule.kind === "forced") continue;

    const value = rawValue.normalize("NFKC").trim();
    if (rule.kind === "integer") {
      if (!INTEGER_PATTERN.test(value)) return { ok: false };
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < rule.min || parsed > rule.max) {
        return { ok: false };
      }
      validated.set(name, String(parsed));
      continue;
    }

    if (rule.kind === "enum") {
      if (!rule.values.includes(value)) return { ok: false };
      validated.set(name, value);
      continue;
    }

    const text = normalizedText(rawValue, rule.maxLength);
    if (text === null) return { ok: false };
    if (text !== "") validated.set(name, text);
  }

  for (const [name, value] of Object.entries(configuration.forcedQuery)) {
    validated.set(name, value);
  }
  return { ok: true, params: validated };
}

export async function proxyMidasResearchRequest(
  request: Request,
  surface: MidasResearchSurface,
  dependencies: MidasResearchProxyDependencies = {},
): Promise<Response> {
  const configuration = SURFACE_CONFIGURATIONS[surface];
  return proxyMidasRequest(request, configuration, dependencies);
}

export async function proxyMidasXAccountDetailRequest(
  request: Request,
  authorHandle: string,
  dependencies: MidasResearchProxyDependencies = {},
): Promise<Response> {
  const normalizedHandle = authorHandle
    .normalize("NFKC")
    .replace(/^@+/, "")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!X_ACCOUNT_HANDLE_PATTERN.test(normalizedHandle)) {
    const requestId = requestIdFor(request);
    return invalidQueryResponse(requestId);
  }

  return proxyMidasRequest(request, {
    upstreamPath: `/api/x-analysis/${normalizedHandle}`,
    allowedQuery: {
      mentionLimit: { kind: "integer", min: 1, max: 100 },
      mentionOffset: { kind: "integer", min: 0, max: 100_000 },
      mentionSymbol: { kind: "text", maxLength: 20 },
    },
    forcedQuery: {},
  }, dependencies);
}

async function proxyMidasRequest(
  request: Request,
  configuration: SurfaceConfiguration,
  dependencies: MidasResearchProxyDependencies,
): Promise<Response> {
  const requestId = requestIdFor(request);
  const query = validatedQuery(new URL(request.url).searchParams, configuration);
  if (!query.ok) return invalidQueryResponse(requestId);

  const baseUrl = baseUrlFor(dependencies.baseUrl);
  if (!baseUrl) return unavailableResponse(requestId, false);

  const upstreamUrl = new URL(baseUrl);
  upstreamUrl.pathname = configuration.upstreamPath;
  upstreamUrl.search = query.params.toString();

  const controller = new AbortController();
  const abortForCaller = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", abortForCaller, { once: true });

  const timeoutMs = boundedTimeout(dependencies.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new MidasResearchTimeoutError());
    }, timeoutMs);
  });

  try {
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const upstreamResponse = await Promise.race([
      // Vinext's development fetch adapter rejects redirect/cache RequestInit
      // options. Send only explicit headers and verify the final origin below.
      fetchImplementation(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
        },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!upstreamResponse.ok) return unavailableResponse(requestId, false);
    if (upstreamResponse.url) {
      let finalUrl: URL;
      try {
        finalUrl = new URL(upstreamResponse.url);
      } catch {
        return unavailableResponse(requestId, false);
      }
      if (finalUrl.origin !== baseUrl.origin) {
        return unavailableResponse(requestId, false);
      }
    }

    const payload = await Promise.race([
      upstreamResponse.json(),
      timeoutPromise,
    ]);
    return jsonResponse(payload, 200, requestId);
  } catch (error) {
    return unavailableResponse(
      requestId,
      timedOut || error instanceof MidasResearchTimeoutError,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortForCaller);
  }
}
