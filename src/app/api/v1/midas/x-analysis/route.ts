import { retiredResearchResponse } from "@api/shared-data/legacy.server";
export async function GET(): Promise<Response> {
  return retiredResearchResponse(["x-mentions", "x-author-scores", "x-author-strategies"]);
}
