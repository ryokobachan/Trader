import { createNasdaqOptionsClient, OptionsDataError, validOptionsDate } from "@api/options/nasdaq.server";

const client = createNasdaqOptionsClient();
type RouteContext = { params: Promise<{ symbol: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { symbol: rawSymbol } = await context.params;
  const symbol = rawSymbol.normalize("NFKC").trim().toUpperCase();
  const url = new URL(request.url);
  const expiration = url.searchParams.get("expiration") ?? undefined;
  const range = url.searchParams.get("range") ?? "all";
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || (expiration !== undefined && !validOptionsDate(expiration)) || (range !== "near" && range !== "all")) {
    return Response.json({ error: { code: "invalid_request", message: "銘柄・満期日・表示範囲を確認してください。" } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const snapshot = await client.getOptions({ symbol, expiration, range });
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof OptionsDataError ? error.code : "unavailable";
    return Response.json({ error: { code, message: "オプション情報を取得できませんでした。" } }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
