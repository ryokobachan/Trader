import { DATA_CATALOG, type DataDefinition } from "../../src/tooling/data-catalog";
import { optionPriceHistoryIdentity } from "../options/price-history.server";

export class DataRequestError extends Error {
  constructor(readonly code: "invalid_arguments" | "unknown_dataset", message: string) { super(message); }
}
const fail = (message: string): never => { throw new DataRequestError("invalid_arguments", message); };
export function dataDefinition(id: string): DataDefinition {
  const definition = DATA_CATALOG.find(item => item.id === id);
  if (!definition) throw new DataRequestError("unknown_dataset", "Unknown dataset; inspect the data catalog.");
  return definition;
}
function validDate(value: string): boolean {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

/** One public parameter contract shared by CLI, HTTP and embedded callers. */
export function prepareDataRequest(definition: DataDefinition, entries: Iterable<readonly [string, string]>) {
  const parameters = new Map<string, string>();
  for (const [key, raw] of entries) {
    if (parameters.has(key)) fail(`Duplicate parameter: ${key}`);
    const rule = Object.hasOwn(definition.parameters, key) ? definition.parameters[key] : undefined;
    if (!rule) throw new DataRequestError("invalid_arguments", `Unknown parameter ${key} for ${definition.id}`);
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > (rule.maxLength ?? 2048)) fail(`Invalid value for ${key}`);
    let value = raw;
    if (rule.type === "symbol") {
      value = value.normalize("NFKC").trim().toUpperCase();
      if (!new RegExp(rule.pattern ?? "^[A-Z][A-Z0-9.-]{0,14}$").test(value)) fail(`Invalid ${key}`);
    } else if (rule.type === "date" && !validDate(value)) fail(`${key} must be a real YYYY-MM-DD date`);
    else if (rule.type === "datetime" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))) fail(`${key} must be a zoned ISO datetime`);
    else if (rule.type === "choice" && !rule.values?.includes(value)) fail(`${key} must be one of ${rule.values?.join(", ")}`);
    else if (rule.type === "integer" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (rule.min ?? 0) || Number(value) > (rule.max ?? Number.MAX_SAFE_INTEGER))) fail(`${key} must be an integer from ${rule.min} to ${rule.max}`);
    else if (rule.type === "flag" && value !== "1") fail(`${key} must be 1`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail(`Invalid ${key}`);
    parameters.set(key, value);
  }
  for (const [key, rule] of Object.entries(definition.parameters)) if (rule.required && !parameters.has(key)) fail(`${key} is required`);
  if (definition.id.startsWith("sec-") && !parameters.has("symbol") && !parameters.has("cik")) fail("symbol or cik is required");
  if (parameters.has("cik") && !/^\d{1,10}$/.test(parameters.get("cik")!)) fail("cik must have 1–10 digits");
  if (parameters.has("from") && parameters.has("to") && parameters.get("from")! > parameters.get("to")!) fail("from must not be after to");
  if (definition.id === "analyst-ratings" && parameters.has("from") && parameters.has("to") && Date.parse(parameters.get("to")!) - Date.parse(parameters.get("from")!) > 3650 * 86400000) fail("Analyst history date window must not exceed 3650 days");
  if (definition.id === "options-history") {
    const tuple = ["expiration", "side", "strike"].filter(key => parameters.has(key));
    let contractId = parameters.get("contract");
    if (contractId && tuple.length) fail("Use contract OR expiration/side/strike, not both");
    if (!contractId) {
      if (tuple.length !== 3) fail("Supply contract or all of expiration, side and strike");
      const expiration = parameters.get("expiration")!;
      const strike = parameters.get("strike")!;
      if (!expiration.startsWith("20") || !/^\d{1,5}(?:\.\d{1,3})?$/.test(strike) || Number(strike) <= 0) fail("Contract expiration must be 2000–2099 and strike must be positive, below 100000, with at most 3 decimals");
      const [whole, decimal = ""] = strike.split(".");
      const strikeCode = String(Number(whole) * 1000 + Number(decimal.padEnd(3, "0"))).padStart(8, "0");
      contractId = `${parameters.get("symbol")}${expiration.slice(2).replaceAll("-", "")}${parameters.get("side") === "call" ? "C" : "P"}${strikeCode}`;
    }
    try { contractId = optionPriceHistoryIdentity({ symbol: parameters.get("symbol")!, contractId }).contractId; }
    catch { fail("contract must be a valid OCC ID matching symbol"); }
    for (const key of tuple) parameters.delete(key);
    parameters.set("contract", contractId!);
  }
  let nativePath = definition.path;
  const nativeQuery = new URLSearchParams(definition.fixedQuery);
  const pathParameters: Record<string, string> = {};
  for (const [key, value] of parameters) {
    if (nativePath.includes(`:${key}`)) {
      nativePath = nativePath.replace(`:${key}`, encodeURIComponent(value));
      pathParameters[key] = value;
    } else nativeQuery.set(definition.parameters[key].query ?? key, value);
  }
  if (nativeQuery.size) nativePath += `?${nativeQuery}`;
  const query = new URLSearchParams([...parameters]);
  return { definition, parameters, pathParameters, nativePath, canonicalPath: `/api/v1/data/${definition.id}${query.size ? `?${query}` : ""}` };
}
