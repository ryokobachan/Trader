import { createTalibClient, TalibError, talibErrorResponse } from "@api/indicators/talib.server";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { GET as getBars } from "../bars/route";
import type { MarketBarsResponse } from "../../../../../platform/provider-contracts";

export async function GET(request: Request, context: { params: Promise<{ symbol: string }> }) {
  try {
    const url = new URL(request.url);
    const allowed = ["indicators", "parameters", "range", "interval", "count", "fresh"];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new TalibError("invalid_request");
    const names = (url.searchParams.get("indicators") ?? "RSI,MACD,ADX,CCI,MFI,BBANDS").split(",");
    if (!names.length || names.length > 8 || new Set(names).size !== names.length || names.some(name => !/^[A-Z][A-Z0-9_]{0,40}$/.test(name))) throw new TalibError("invalid_request");
    let parameters: Record<string, unknown> = {};
    try {
      parameters = JSON.parse(url.searchParams.get("parameters") ?? "{}");
      if (!parameters || Array.isArray(parameters) || typeof parameters !== "object" || Object.keys(parameters).some(name => !names.includes(name))) throw new Error();
    } catch { throw new TalibError("invalid_request"); }
    const barsUrl = new URL(request.url);
    barsUrl.searchParams.delete("indicators"); barsUrl.searchParams.delete("parameters");
    if (!barsUrl.searchParams.has("count")) barsUrl.searchParams.set("count", "500");
    const barsResponse = await getBars(new Request(barsUrl, { headers: request.headers, signal: request.signal }), context);
    if (!barsResponse.ok) return barsResponse;
    const source = await barsResponse.json() as MarketBarsResponse;
    const { items: inputItems, ...inputBars } = source.bars;
    const result = await createTalibClient(providerEnvironment()).calculate({
      bars: inputItems.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })),
      indicators: names.map(id => ({ id, ...(parameters[id] === undefined ? {} : { parameters: parameters[id] }) })),
    }, request.signal);
    return Response.json({ ...result, instrument: source.instrument, provenance: source.bars.provenance, dataMode: source.dataMode,
      inputBars, requestedCount: source.requestedCount, returnedCount: source.returnedCount, selectedProviders: source.selectedProviders,
      range: source.bars.range, interval: source.bars.interval }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return talibErrorResponse(error); }
}
