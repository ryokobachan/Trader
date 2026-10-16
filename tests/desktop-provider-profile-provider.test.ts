import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROVIDER_IDS_BY_ROLE, PROVIDER_ROLES } from "../api/provider-roles";
import { standaloneDevelopmentEnvironment } from "../src/tooling/scripts/dev-with-tradingview.mjs";

test("local startup profile covers every supported data role with a real provider", async () => {
  const profile = JSON.parse(await readFile(new URL("../api/local-provider-profile.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(profile).sort(), [...PROVIDER_ROLES].sort());
  for (const role of PROVIDER_ROLES) {
    assert.notEqual(profile[role], "mock", `${role} must not silently use fixture data`);
    assert.ok((PROVIDER_IDS_BY_ROLE[role] as readonly string[]).includes(profile[role]), `${role} must select a supported provider`);
  }
});

test("desktop embeds the same complete profile used by standalone development", async () => {
  const profile = JSON.parse(await readFile(new URL("../api/local-provider-profile.json", import.meta.url), "utf8"));
  const environment = standaloneDevelopmentEnvironment({}) as Record<string, unknown>;
  for (const role of PROVIDER_ROLES) {
    assert.equal(environment[`TRADER_${role.toUpperCase()}_PROVIDER`], profile[role]);
  }
  const source = await readFile(new URL("../src/desktop/tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /include_str!\(\s*"\.\.\/\.\.\/\.\.\/\.\.\/api\/local-provider-profile\.json"/);
  assert.match(source, /command\.env\(format!\("TRADER_\{\}_PROVIDER", role\.to_uppercase\(\)\), provider\)/);
  const fallback = source.split('if let Some((port, token)) = market {')[1]?.split("} else {")[1]?.split("let mut child")[0];
  assert.ok(fallback);
  for (const role of ["MARKET", "BARS", "FUNDAMENTALS", "EARNINGS"]) {
    assert.ok(fallback.includes(`.env("TRADER_${role}_PROVIDER", "yahoo")`), `${role} must not require an unavailable helper`);
  }
});
