import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("desktop bundle is self-contained and restricted to the local runtime", async () => {
  const [baseConfigText, localConfigText, rustSource] = await Promise.all([
    text("../src/desktop/tauri/tauri.conf.json"),
    text("../src/desktop/tauri/tauri.local.conf.json"),
    text("../src/desktop/tauri/src/lib.rs"),
  ]);
  const baseConfig = JSON.parse(baseConfigText);
  const localConfig = JSON.parse(localConfigText);

  assert.deepEqual(baseConfig.bundle.externalBin, [
    "binaries/unicorn-runtime",
    "binaries/unicorn-market-sidecar",
  ]);
  assert.deepEqual(baseConfig.bundle.targets, ["app"]);
  assert.equal(baseConfig.bundle.macOS.minimumSystemVersion, "14.0");
  assert.equal(baseConfig.app.windows.length, 0);
  assert.equal(baseConfig.app.security.freezePrototype, undefined);
  assert.equal(localConfig.bundle.macOS.signingIdentity, "-");
  assert.equal(localConfig.bundle.macOS.hardenedRuntime, false);

  assert.match(rustSource, /\.stdin\(Stdio::piped\(\)\)/);
  assert.match(rustSource, /\.process_group\(0\)/);
  assert.match(rustSource, /libc::kill\(-\(child\.id\(\) as i32\), libc::SIGTERM\)/);
  assert.match(rustSource, /libc::kill\(-\(child\.id\(\) as i32\), libc::SIGKILL\)/);
  assert.match(rustSource, /url\.host_str\(\) == Some\("127\.0\.0\.1"\)/);
  assert.doesNotMatch(rustSource, /open_devtools|initialization_script/);
});

test("desktop loopback runtime uses one-time session bootstrap and strict browser boundaries", async () => {
  const source = await text("../src/desktop/runtime/server.mjs");

  assert.match(source, /hostname: options\.host/);
  assert.match(source, /options\.host !== DEFAULT_HOST/);
  assert.match(source, /bootstrapAvailable = false/);
  assert.match(source, /HttpOnly; SameSite=Strict; Path=\//);
  assert.match(source, /fetchSite === "cross-site"/);
  assert.match(source, /process\.stdin\.once\("end", shutdown\)/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.doesNotMatch(source, /script-src[^;]*'unsafe-eval'/);
});

test("desktop market health check accepts a complete response without waiting for socket EOF", async () => {
  const source = await text("../src/desktop/tauri/src/lib.rs");

  assert.match(source, /stream\.read\(&mut buffer\)/);
  assert.match(source, /unicorn\.tradingview-sidecar\.v1/);
  assert.doesNotMatch(source, /read_to_string\(&mut response\)/);
});

test("desktop build publishes only the finished app at the repository build boundary", async () => {
  const [packageText, buildSource, ignoreText, marketRequirements] = await Promise.all([
    text("../package.json"),
    text("../src/desktop/build.mjs"),
    text("../.gitignore"),
    text("../src/desktop/runtime/tradingview-sidecar/requirements-build.txt"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts["desktop:build"], "node src/desktop/build.mjs");
  assert.match(buildSource, /path\.join\(repositoryRoot, "build"\)/);
  assert.match(buildSource, /const outputApp = path\.join\(outputDirectory, "Unicorn\.app"\)/);
  assert.match(buildSource, /codesign/);
  assert.match(buildSource, /--remap-path-prefix=/);
  assert.match(buildSource, /DESKTOP_BUILD_SENSITIVE_ENVIRONMENT_KEYS/);
  assert.match(buildSource, /environment\[key\] = ""/);
  assert.match(buildSource, /assertNoPrivateBuildData\(outputApp, privateBuildNeedles\)/);
  assert.match(buildSource, /cleanupDesktopBuildIntermediates/);
  assert.match(buildSource, /path\.join\(tauriRoot, "target"\)/);
  assert.match(buildSource, /path\.join\(desktopRoot, "frontend-dist"\)/);
  assert.match(buildSource, /finally\s*\{\s*await cleanupDesktopBuildIntermediates\(\)/);
  assert.match(ignoreText, /^\/build\/$/m);
  assert.match(
    marketRequirements,
    /^-r \.\.\/\.\.\/\.\.\/\.\.\/api\/tradingview-websocket\/requirements\.txt$/m,
  );
});
