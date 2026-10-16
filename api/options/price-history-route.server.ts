import { OptionPriceHistoryError, optionPriceHistoryIdentity } from "./price-history.server";
import type { OptionPriceHistoryRequest, OptionsPriceHistory } from "./price-history.server";

type RouteContext = { params: Promise<{ symbol: string }> };
type HistoryClient = { getHistory(request: OptionPriceHistoryRequest): Promise<OptionsPriceHistory> };
type HistoryClients = Record<"chartexchange" | "yahoo", HistoryClient>;
const HISTORY_FIELDS = ["open", "high", "low", "close", "volume", "openInterest"] as const;

function dateBound(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OptionPriceHistoryError("invalid_request");
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new OptionPriceHistoryError("invalid_request");
  return value;
}

function filterHistory(history: OptionsPriceHistory, from?: string, to?: string): OptionsPriceHistory {
  if (from === undefined && to === undefined) return history;
  const items = history.items.filter(item => (from === undefined || item.date >= from) && (to === undefined || item.date <= to));
  const missingBars = items.filter(item => HISTORY_FIELDS.every(field => item[field] === undefined)).length;
  return {
    ...history, items,
    requestWindow: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
    filteredCoverage: {
      firstDate: items[0]?.date ?? null, lastDate: items.at(-1)?.date ?? null,
      returnedBars: items.length, observedBars: items.length - missingBars, missingBars,
    },
  };
}

/** A selected source is never replaced by another feed or merged by calendar date. */
export function createOptionsPriceHistoryRoute(clients: HistoryClients) {
  return async function getHistory(request: Request, context: RouteContext) {
    try {
      const { symbol } = await context.params;
      const parameters = new URL(request.url).searchParams;
      const source = parameters.get("source") ?? "chartexchange";
      if (parameters.getAll("contractId").length !== 1 || parameters.getAll("source").length > 1
        || parameters.getAll("from").length > 1 || parameters.getAll("to").length > 1
        || (source !== "chartexchange" && source !== "yahoo")
        || [...parameters.keys()].some(key => !["contractId", "source", "from", "to"].includes(key))) throw new OptionPriceHistoryError("invalid_request");
      const from = dateBound(parameters.get("from")), to = dateBound(parameters.get("to"));
      if (from !== undefined && to !== undefined && from > to) throw new OptionPriceHistoryError("invalid_request");
      const identity = optionPriceHistoryIdentity({ symbol, contractId: parameters.get("contractId")! });
      const history = await clients[source].getHistory(identity);
      if (history.symbol !== identity.symbol || history.contractId !== identity.contractId || history.underlying.symbol !== identity.symbol
        || history.expiration !== identity.expiration || history.side !== identity.side || history.strike !== identity.strike
        || history.source !== (source === "chartexchange" ? "ChartExchange" : "Yahoo Finance")) throw new OptionPriceHistoryError("invalid_response");
      return Response.json(filterHistory(history, from, to), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const code = error instanceof OptionPriceHistoryError ? error.code : "unavailable";
      const status = code === "invalid_request" ? 400 : code === "not_found" ? 404 : code === "capacity" ? 503 : 502;
      const message = code === "invalid_request" ? "銘柄・オプション契約・取得元・期間を確認してください。"
        : code === "not_found" ? "この契約の履歴を提供元で確認できません。" : "オプションの履歴を取得できませんでした。";
      return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
    }
  };
}
