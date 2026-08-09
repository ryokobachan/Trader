import rawConfig from "../../api/config.json";
import { defineUnicornConfig, type UnicornConfig } from "./platform/unicorn-config";

/**
 * Validated, non-secret build-time configuration.
 * Developers normally edit only `api/config.json`.
 */
export const unicornConfig: UnicornConfig = defineUnicornConfig(rawConfig);

export type { UnicornConfig } from "./platform/unicorn-config";
