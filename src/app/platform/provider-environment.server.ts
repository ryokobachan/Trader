import type { ProviderEnvironment } from "./provider-contracts";
import { PROVIDER_ENVIRONMENT_KEYS } from "@api/environment";

let runtimeBindings: Readonly<Record<string, unknown>> = Object.freeze({});

/** Called by the worker entry for each request before route dispatch. */
export function installProviderEnvironmentBindings(bindings: Readonly<Record<string, unknown>>) {
  runtimeBindings = bindings;
}

function binding(name: string, nodeValue: string | undefined) {
  const value = runtimeBindings[name];
  return typeof value === "string" ? value : nodeValue;
}

/**
 * Vinext can keep statically addressed environment variables server-only.
 * Keep this allow-list explicit: dynamic `process.env` access is not portable
 * to the Cloudflare worker runtime and makes secret review impossible.
 */
export function providerEnvironment(): ProviderEnvironment {
  return Object.freeze(Object.fromEntries(
    PROVIDER_ENVIRONMENT_KEYS.map((name) => [name, binding(name, process.env[name])]),
  ));
}
