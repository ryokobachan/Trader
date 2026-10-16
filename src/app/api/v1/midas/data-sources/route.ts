import { dataDiscoveryResponse } from "@api/data/route.server";

export async function GET(request: Request): Promise<Response> {
  const response = dataDiscoveryResponse(request, "catalog");
  response.headers.set("Deprecation", "true");
  response.headers.set("Link", "</api/v1/data>; rel=\"successor-version\"");
  return response;
}
