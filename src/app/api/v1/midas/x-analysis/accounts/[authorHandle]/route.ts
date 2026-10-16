import { retiredResearchResponse } from "@api/shared-data/legacy.server";
export async function GET(): Promise<Response> {
  return retiredResearchResponse(["x-accounts", "x-posts", "x-mentions", "x-mention-outcomes"]);
}
