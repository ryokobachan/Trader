import { dataDiscoveryResponse } from "@api/data/route.server";
export function GET(request: Request) { return dataDiscoveryResponse(request, "catalog"); }
