import { proxyMidasResearchRequest } from "../../../../platform/midas-research.server";

export async function GET(request: Request): Promise<Response> {
  return proxyMidasResearchRequest(request, "ideas");
}
