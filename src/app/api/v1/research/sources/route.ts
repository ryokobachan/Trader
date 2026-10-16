import { DIRECT_SOURCES } from "@api/direct-sources/catalog";
import { providerEnvironment } from "../../../../platform/provider-environment.server";

export async function GET() {
  const environment = providerEnvironment();
  return Response.json({
    sources: DIRECT_SOURCES.map(source => ({ ...source, configured: source.credential === null || Boolean(environment[source.credential]?.trim()) })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
