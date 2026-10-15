import rawConfig from "../../api/config.json";
import { defineTraderConfig, type TraderConfig } from "./platform/trader-config";

/**
 * Validated, non-secret build-time configuration.
 * Developers normally edit only `api/config.json`.
 */
export const traderConfig: TraderConfig = defineTraderConfig(rawConfig);

export type { TraderConfig } from "./platform/trader-config";
