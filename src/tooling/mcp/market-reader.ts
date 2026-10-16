import { TraderDataError } from "../../../clients/javascript/trader-data.mjs";
import { dataDefinition, prepareDataRequest } from "../../../api/data/request";
import { GET as quote } from "../../app/api/v1/symbols/[symbol]/summary/route";
import { GET as bars } from "../../app/api/v1/symbols/[symbol]/bars/route";
import { GET as workspace } from "../../app/api/v1/symbols/[symbol]/workspace/route";
import { GET as options } from "../../app/api/v1/symbols/[symbol]/options/route";
import { GET as history } from "../../app/api/v1/symbols/[symbol]/options/prices/route";
import { GET as ratings } from "../../app/api/v1/symbols/[symbol]/analyst-ratings/route";
import { GET as indicators } from "../../app/api/v1/indicators/route";
import { GET as technicals } from "../../app/api/v1/symbols/[symbol]/technicals/route";
import { GET as sources } from "../../app/api/v1/research/sources/route";
import { GET as direct } from "../../app/api/v1/research/sources/[sourceId]/route";
import { MCP_SERVERS } from "./servers";
import type { McpDataReader } from "./server";

/** Only Market handlers are bundled. No app server, database, or HTTP self-request. */
export function createMarketReader(timeoutMs = 60_000): McpDataReader {
  return {
    async get(dataset, parameters, { signal }) {
      if (dataset !== "source-status" && !Object.values(MCP_SERVERS.market.tools).some(id => id === dataset)) throw new TraderDataError("unknown_dataset", "Not a Market dataset.");
      const prepared = prepareDataRequest(dataDefinition(dataset), Object.entries(parameters).map(([key, value]) => [key, String(value)]));
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, deadline]);
      // This URL only provides routing/query semantics to in-process handlers; it is never fetched.
      const request = new Request(new URL(prepared.nativePath, "https://market.invalid"), { signal: combined });
      const context = { params: Promise.resolve({ symbol: prepared.parameters.get("symbol")! }) };
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new TraderDataError(deadline.aborted ? "timeout" : "cancelled", "Market request stopped."));
        if (combined.aborted) abort(); else combined.addEventListener("abort", abort, { once: true });
      });
      const read = async () => {
        const response = dataset === "source-status" ? await sources()
          : dataset === "quote" ? await quote(request, context)
          : dataset === "bars" ? await bars(request, context)
          : ["workspace", "financials", "profile", "fundamentals", "earnings", "analyst", "news", "research", "corporate-actions"].includes(dataset) ? await workspace(request, context)
          : dataset === "options-chain" ? await options(request, context)
          : dataset === "options-history" ? await history(request, context)
          : dataset === "analyst-ratings" ? await ratings(request, context)
          : dataset === "technical-indicators" ? await indicators(request)
          : dataset === "technicals" ? await technicals(request, context)
          : await direct(request, { params: Promise.resolve({ sourceId: dataset }) });
        const payload = await response.json() as Record<string, unknown>;
        if (!response.ok) {
          const error = payload.error as { code?: string; message?: string } | undefined;
          throw new TraderDataError(error?.code ?? "upstream_error", error?.message ?? "Market data unavailable.", response.status);
        }
        return payload;
      };
      try { return await Promise.race([read(), cancelled]); }
      finally { combined.removeEventListener("abort", abort); }
    },
  };
}
