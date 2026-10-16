import { DATA_CATALOG, DATA_CATALOG_VERSION, type DataDefinition, type DataParameter } from "../../src/tooling/data-catalog";
import { DataRequestError, dataDefinition } from "./request";

export const DATA_CATALOG_FILTERS = {
  category: ["input", "result", "snapshot", "metadata"],
  subject: ["symbol", "macro", "option-contract", "institution", "account", "strategy", "system"],
  backtest: ["usable", "conditional", "analysis-only", "result-only", "not-applicable"],
} as const;
function parameterSchema(rule: DataParameter) {
  return { type: rule.type === "integer" ? "integer" : "string", description: rule.description,
    ...(rule.type === "date" ? { format: "date" } : rule.type === "datetime" ? { format: "date-time" } : {}),
    ...(rule.type === "symbol" ? { pattern: rule.pattern ?? "^[A-Z][A-Z0-9.-]{0,14}$" } : rule.pattern ? { pattern: rule.pattern } : {}),
    ...(rule.type === "flag" ? { enum: ["1"] } : rule.values ? { enum: rule.values } : {}),
    ...(rule.min === undefined ? {} : { minimum: rule.min }), ...(rule.max === undefined ? {} : { maximum: rule.max }),
    ...(rule.type === "integer" ? {} : { maxLength: rule.maxLength ?? 2048 }),
  };
}
export function describeData(id: string) {
  const definition = dataDefinition(id);
  return { schemaVersion: DATA_CATALOG_VERSION, ...definition, endpoint: `/api/v1/data/${id}`,
    parameterSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(definition.parameters).map(([key, rule]) => [key, parameterSchema(rule)])), required: Object.entries(definition.parameters).filter(([, rule]) => rule.required).map(([key]) => key),
      ...(id.startsWith("sec-") ? { anyOf: [{ required: ["symbol"] }, { required: ["cik"] }] } : {}),
      ...(id === "options-history" ? { oneOf: [{ required: ["contract"], not: { anyOf: ["expiration", "side", "strike"].map(key => ({ required: [key] })) } }, { required: ["expiration", "side", "strike"], not: { required: ["contract"] } }] } : {}),
    },
  };
}
export function discoverData(filters: Iterable<readonly [string, string]> = []) {
  const selected = new Map<string, string>();
  for (const [key, value] of filters) {
    if (!Object.hasOwn(DATA_CATALOG_FILTERS, key) || selected.has(key) || !(DATA_CATALOG_FILTERS[key as keyof typeof DATA_CATALOG_FILTERS] as readonly string[]).includes(value)) throw new DataRequestError("invalid_arguments", `Invalid catalog filter: ${key}`);
    selected.set(key, value);
  }
  return { schemaVersion: DATA_CATALOG_VERSION,
    datasets: DATA_CATALOG.filter(item => [...selected].every(([key, value]) => item[key as keyof DataDefinition] === value)).map(item => describeData(item.id)),
    filters: DATA_CATALOG_FILTERS,
    notes: ["Capability catalog; upstream configuration and retained coverage may differ.", "Data retrieval returns native JSON and performs no dataset writes or strategy execution.", "Read metadataPaths for native data, source/provenance, dates, missing values, coverage and warnings."],
  };
}
export function dataOpenApi() {
  const jsonResponse = { description: "Native dataset JSON; partial and empty results are valid. Inspect documented provenance and coverage paths.", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } };
  const paths: Record<string, unknown> = {
    "/api/v1/data": { get: { operationId: "listData", summary: "Discover available datasets", parameters: Object.entries(DATA_CATALOG_FILTERS).map(([name, values]) => ({ name, in: "query", schema: { type: "string", enum: values } })), responses: { "200": jsonResponse } } },
    "/api/v1/data/openapi.json": { get: { operationId: "dataOpenApi", summary: "Read this OpenAPI document", responses: { "200": jsonResponse } } },
  };
  for (const item of DATA_CATALOG) {
    paths[`/api/v1/data/${item.id}`] = { get: {
      operationId: `get_${item.id.replaceAll("-", "_")}`, summary: item.description,
      description: `${item.history}\n${item.notes.join("\n")}\nResponse: ${item.response}`,
      "x-trader-category": item.category, "x-trader-backtest": item.backtest, "x-trader-metadata-paths": item.metadataPaths,
      "x-trader-parameter-schema": describeData(item.id).parameterSchema,
      parameters: Object.entries(item.parameters).map(([name, rule]) => ({ name, in: "query", required: !!rule.required, schema: parameterSchema(rule) })),
      responses: { "200": jsonResponse, "400": { description: "Invalid parameters; JSON error" }, "401": { description: "Authentication required by owner-scoped dataset" }, "404": { description: "Dataset or record not found" }, "502": { description: "Source unavailable; JSON error" }, "503": { description: "Source not configured or at capacity; JSON error" } },
    } };
    paths[`/api/v1/data/${item.id}/describe`] = { get: { operationId: `describe_${item.id.replaceAll("-", "_")}`, summary: `Describe ${item.id}`, responses: { "200": jsonResponse } } };
  }
  return { openapi: "3.1.0", info: { title: "Trader Data API", version: "1.0.0", description: "Read-only discovery and data access. Native response contracts are preserved. Owner-scoped datasets retain existing authentication; credentials for upstream providers remain on the server." }, paths };
}
