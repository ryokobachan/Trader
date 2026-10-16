import { getDataResponse } from "@api/data/route.server";
export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  return getDataResponse(request, (await context.params).datasetId);
}
