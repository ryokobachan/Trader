import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import rawConfig from "../api/config.json" with { type: "json" };
import { listInstalledProviderSources } from "../api/index.server";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("keeps developer-owned APIs and strategies at the root and Core under src", async () => {
  for (const path of [
    "api/config.json",
    "api/README.md",
    "api/yahoo/chart.ts",
    "api/yahoo/fundamentals/bs.ts",
    "api/provider-roles.ts",
    "api/environment.ts",
    "api/stock-detail/ids.ts",
    "api/stock-detail/metrics.ts",
    "strategies/catalog.ts",
    "strategies/metrics.ts",
    "strategies/metric-ids.ts",
    "strategies/i18n.ts",
    "strategies/sample-transactions.ts",
    "extensions/index.ts",
    "extensions/README.md",
    "src/app/page.tsx",
    "src/app/api/v1/symbols/[symbol]/workspace/route.ts",
    "src/db/schema.ts",
    "src/db/drizzle.config.ts",
    "src/db/migrations/0000_lumpy_silver_samurai.sql",
    "src/worker/index.ts",
  ]) {
    assert.equal(await exists(path), true, `${path} must exist`);
  }

  for (const obsoleteRoot of ["app", "config", "db", "drizzle", "drizzle.config.ts", "worker", "services", "scripts", ".github", "public/company-logos"]) {
    assert.equal(await exists(obsoleteRoot), false, `${obsoleteRoot}/ must stay consolidated`);
  }
  assert.equal(await exists("src/app/plugins"), false, "developer UI registrations belong in extensions/");
});

test("every configured provider ID maps to a reviewed file under its matching api folder", async () => {
  const sources = new Map(listInstalledProviderSources().map(({ id, source }) => [id, source]));
  const selectedIds = new Set(
    Object.values(rawConfig.providers).filter((id): id is string => typeof id === "string"),
  );

  for (const [id, source] of sources) {
    assert.ok(source.startsWith(`api/${id}/`), `${id} must map to its matching folder`);
    await readFile(new URL(`../${source}`, import.meta.url), "utf8");
  }

  for (const id of selectedIds) assert.ok(sources.has(id), `${id} must be registered`);
});

test("sample strategy history is source-controlled while mutable history stays in D1", async () => {
  const [sampleSource, storeSource, guide] = await Promise.all([
    readFile(new URL("../strategies/sample-transactions.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/platform/strategy-portfolio-transactions.server.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../strategies/README.md", import.meta.url), "utf8"),
  ]);

  assert.match(sampleSource, /SAMPLE_STRATEGY_TRANSACTIONS/);
  assert.match(storeSource, /getD1\(\)/);
  assert.match(guide, /stored in D1/);
  assert.doesNotMatch(guide, /write.+this directory/i);
});
