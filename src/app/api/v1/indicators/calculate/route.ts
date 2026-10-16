import { boundedJson, createTalibClient, MAX_TALIB_REQUEST_BYTES, TalibError, talibErrorResponse } from "@api/indicators/talib.server";
import { providerEnvironment } from "../../../../platform/provider-environment.server";

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new TalibError("invalid_request");
    const payload = await boundedJson(request, MAX_TALIB_REQUEST_BYTES);
    return Response.json(await createTalibClient(providerEnvironment()).calculate(payload, request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return talibErrorResponse(error); }
}
