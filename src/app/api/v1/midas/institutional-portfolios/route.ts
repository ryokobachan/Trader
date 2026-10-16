import { retiredResearchResponse } from "@api/shared-data/legacy.server";
export async function GET(): Promise<Response> {
  return retiredResearchResponse(["institutional-filings", "institutional-holdings", "strategy-performance"]);
}
