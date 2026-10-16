import { resolveTradingViewLogo } from "@api/company-logo.server";

export async function GET(_request: Request, context: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await context.params;
  try {
    const source = await resolveTradingViewLogo(symbol.trim().toUpperCase());
    if (source) return new Response(null, {
      status: 302,
      headers: { Location: source, "Cache-Control": "public, max-age=86400" },
    });
    return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
