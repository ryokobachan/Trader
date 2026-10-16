import { directSourceResponse } from "@api/direct-sources/route.server";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";

export async function GET(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  return directSourceResponse(request, sourceId, { environment: providerEnvironment() });
}
