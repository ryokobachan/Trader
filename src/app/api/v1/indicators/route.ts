import { createTalibClient, talibErrorResponse } from "@api/indicators/talib.server";
import { providerEnvironment } from "../../../platform/provider-environment.server";

export async function GET(request: Request) {
  try {
    return Response.json(await createTalibClient(providerEnvironment()).catalog(request.signal), { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (error) { return talibErrorResponse(error); }
}
