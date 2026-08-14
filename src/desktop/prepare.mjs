import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(desktopRoot, "../..");
const targetTriple = "aarch64-apple-darwin";
const binariesDirectory = path.join(desktopRoot, "tauri", "binaries");
const runtimeBinary = path.join(binariesDirectory, `unicorn-runtime-${targetTriple}`);
const marketBinary = path.join(binariesDirectory, `unicorn-market-sidecar-${targetTriple}`);
const marketBuildDirectory = path.join(desktopRoot, "runtime", "tradingview-sidecar");
const iconSource = path.join(repositoryRoot, "public", "unicorn-logo-v3.png");
const iconsDirectory = path.join(desktopRoot, "tauri", "icons");

// The source artwork's alpha bounds are x=150..638 and y=32..683 on a 768 px
// canvas. This crop keeps the original artwork unchanged, centers those bounds,
// and leaves a 4% vertical safe zone so it reads larger in Finder and the Dock.
const iconCrop = Object.freeze({ size: 708, offsetY: 4, offsetX: 41 });
const iconsetSizes = Object.freeze([
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]);

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}

async function generateDesktopIcons() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "unicorn-icons-"));
  const croppedSource = path.join(temporaryDirectory, "unicorn-cropped.png");
  const iconsetDirectory = path.join(temporaryDirectory, "Unicorn.iconset");

  try {
    await mkdir(iconsDirectory, { recursive: true });
    await mkdir(iconsetDirectory, { recursive: true });
    await run("/usr/bin/sips", [
      "--cropToHeightWidth",
      String(iconCrop.size),
      String(iconCrop.size),
      "--cropOffset",
      String(iconCrop.offsetY),
      String(iconCrop.offsetX),
      iconSource,
      "--out",
      croppedSource,
    ]);

    await Promise.all(iconsetSizes.map(([filename, size]) => run("/usr/bin/sips", [
      "--resampleHeightWidth",
      String(size),
      String(size),
      croppedSource,
      "--out",
      path.join(iconsetDirectory, filename),
    ])));

    await run("/usr/bin/sips", [
      "--resampleHeightWidth",
      "512",
      "512",
      croppedSource,
      "--out",
      path.join(iconsDirectory, "icon.png"),
    ]);
    await rm(path.join(iconsDirectory, "icon.icns"), { force: true });
    await run("/usr/bin/iconutil", [
      "--convert",
      "icns",
      iconsetDirectory,
      "--output",
      path.join(iconsDirectory, "icon.icns"),
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The current desktop package target is Apple Silicon macOS only.");
}

await generateDesktopIcons();
await run("npm", ["run", "build"]);
await run("npx", ["vite", "build", "--config", path.join(desktopRoot, "vite.config.ts")]);

await rm(binariesDirectory, { recursive: true, force: true });
await mkdir(binariesDirectory, { recursive: true });
await run("bun", [
  "build",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-package-json",
  path.join(desktopRoot, "runtime", "server.mjs"),
  "--outfile",
  runtimeBinary,
]);

const marketArguments = process.env.UNICORN_DESKTOP_LIVE_SMOKE === "1"
  ? ["--live-smoke", "--tauri-output"]
  : ["--tauri-output"];
await run(path.join(marketBuildDirectory, "build.sh"), marketArguments);
await Promise.all([chmod(runtimeBinary, 0o755), chmod(marketBinary, 0o755)]);

process.stdout.write(`Desktop helpers prepared in ${path.relative(repositoryRoot, binariesDirectory)}.\n`);
