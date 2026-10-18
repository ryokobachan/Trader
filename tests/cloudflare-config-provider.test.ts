import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedConfig } from "vite";
import { sites } from "../src/tooling/sites-vite-plugin";

test("packages deployment metadata from ordinary config without a root .openai folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "trader-cloudflare-config-"));
  try {
    await mkdir(join(root, "src/worker"), { recursive: true });
    await mkdir(join(root, "src/db/migrations"), { recursive: true });
    const config = await readFile(new URL("../src/worker/cloudflare.config.json", import.meta.url), "utf8");
    await writeFile(join(root, "src/worker/cloudflare.config.json"), config);
    await writeFile(join(root, "src/db/migrations/0000.sql"), "SELECT 1;");
    await mkdir(join(root, "dist/.openai"), { recursive: true });
    await writeFile(join(root, "dist/.openai/stale.json"), "{}");
    const plugin = sites();
    assert.equal(typeof plugin.configResolved, "function");
    assert.equal(typeof plugin.closeBundle, "function");
    const configure = plugin.configResolved as (config: ResolvedConfig) => void;
    const build = plugin.closeBundle as () => Promise<void>;
    configure({ root } as ResolvedConfig);
    await build();
    assert.equal(await readFile(join(root, "dist/.openai/hosting.json"), "utf8"), config);
    assert.equal(await readFile(join(root, "dist/.openai/drizzle/0000.sql"), "utf8"), "SELECT 1;");
    await assert.rejects(readFile(join(root, "dist/.openai/stale.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, ".openai/hosting.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
