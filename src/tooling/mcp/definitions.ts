import { readFileSync } from "node:fs";
import { load, JSON_SCHEMA } from "js-yaml";
import { dataDefinition } from "../../../api/data/request";
import { MCP_SERVERS, type McpServerId } from "./servers";

export type ToolDefinition = { name: string; dataset: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> };
export class ToolDefinitionError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** 配布フォルダのYAMLを起動時に読む。取得処理の許可範囲はコード側で維持する。 */
export function readToolDefinitions(id: McpServerId, file: string | URL): ToolDefinition[] {
  try {
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error();
    const parsed: unknown = load(text, { schema: JSON_SCHEMA });
    if (!record(parsed) || Object.keys(parsed).some(key => key !== "tools") || !record(parsed.tools)) throw new Error();
    const entries = Object.entries(parsed.tools);
    if (!entries.length || entries.length > 100) throw new Error();
    const allowed = new Set<string>([...Object.values(MCP_SERVERS[id].tools), "status"]);
    return entries.map(([name, tool]) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !record(tool)
        || Object.keys(tool).some(key => !["dataset", "description", "inputSchema", "outputSchema"].includes(key))
        || typeof tool.dataset !== "string" || !allowed.has(tool.dataset)
        || typeof tool.description !== "string" || !tool.description.trim()
        || !record(tool.inputSchema) || tool.inputSchema.type !== "object"
        || tool.inputSchema.additionalProperties !== false || !record(tool.inputSchema.properties)
        || !record(tool.outputSchema) || tool.outputSchema.type !== "object" || !record(tool.outputSchema.properties)) throw new Error();
      const rules = tool.dataset === "status" ? {} : dataDefinition(tool.dataset).parameters;
      const properties = tool.inputSchema.properties;
      const required = tool.inputSchema.required ?? [];
      if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key))) throw new Error();
      for (const [key, rule] of Object.entries(rules)) if (rule.required && !required.includes(key)) throw new Error();
      for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
        const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
        if (!rule || !record(schema) || schema.type !== (rule.type === "flag" ? "boolean" : rule.type === "integer" ? "integer" : "string")) throw new Error();
      }
      return { name, dataset: tool.dataset, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema };
    });
  } catch {
    // YAMLの例外には入力全文や秘密情報が含まれ得るため、そのまま出力しない。
    throw new ToolDefinitionError("tools.yamlを読み込めません。YAML構文・入出力スキーマ・対応するdatasetと必須引数を確認してください。");
  }
}
