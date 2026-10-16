import { dataDiscoveryResponse } from "@api/data/route.server";
export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  return dataDiscoveryResponse(request, "describe", (await context.params).datasetId);
}
