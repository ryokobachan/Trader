import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(desktopRoot, "../..");
const tauriRoot = path.join(desktopRoot, "tauri");
const tauriExecutable = path.join(repositoryRoot, "node_modules", ".bin", "tauri");
const bundledApp = path.join(
  tauriRoot,
  "target",
  "release",
  "bundle",
  "macos",
  "Trader.app",
);
const outputDirectory = path.join(repositoryRoot, "build");
const outputApp = path.join(outputDirectory, "Trader.app");
const desktopBuildIntermediates = Object.freeze([
  path.join(desktopRoot, "frontend-dist"),
  path.join(tauriRoot, "binaries"),
  path.join(tauriRoot, "gen"),
  path.join(tauriRoot, "target"),
  path.join(desktopRoot, "runtime", "tradingview-sidecar", ".venv"),
  path.join(desktopRoot, "runtime", "tradingview-sidecar", "build"),
  path.join(desktopRoot, "runtime", "tradingview-sidecar", "dist"),
]);
const DESKTOP_BUILD_SENSITIVE_ENVIRONMENT_KEYS = Object.freeze([
  "FMP_API_KEY",
  "FMP_BASE_URL",
  "BENZINGA_API_TOKEN",
  "BENZINGA_API_KEY",
  "BENZINGA_ANALYST_RATINGS_ENDPOINT",
  "TRADER_TRADINGVIEW_SIDECAR_TOKEN",
  "TRADER_TRADINGVIEW_SIDECAR_URL",
]);
const DESKTOP_BUILD_SECRET_VALUE_KEYS = Object.freeze([
  "FMP_API_KEY",
  "BENZINGA_API_TOKEN",
  "BENZINGA_API_KEY",
  "TRADER_TRADINGVIEW_SIDECAR_TOKEN",
]);

function run(executable, args, cwd = repositoryRoot, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}

function privateDesktopBuildEnvironment() {
  const environment = { ...process.env };
  for (const key of DESKTOP_BUILD_SENSITIVE_ENVIRONMENT_KEYS) environment[key] = "";
  return environment;
}

function privateRustBuildEnvironment(baseEnvironment) {
  const remapFlag = `--remap-path-prefix=${homedir()}=/trader-build`;
  const encodedFlags = baseEnvironment.CARGO_ENCODED_RUSTFLAGS;

  if (encodedFlags) {
    return {
      ...baseEnvironment,
      CARGO_ENCODED_RUSTFLAGS: `${encodedFlags}\x1f${remapFlag}`,
    };
  }

  return {
    ...baseEnvironment,
    RUSTFLAGS: [baseEnvironment.RUSTFLAGS, remapFlag].filter(Boolean).join(" "),
  };
}

async function assertNoPrivateBuildData(directory, needles) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoPrivateBuildData(entryPath, needles);
    } else if (entry.isFile()) {
      const contents = await readFile(entryPath);
      for (const needle of needles) {
        if (contents.includes(needle.value)) {
          throw new Error(
            `${path.relative(repositoryRoot, entryPath)} contains ${needle.description}`,
          );
        }
      }
    }
  }
}

async function cleanupDesktopBuildIntermediates() {
  await Promise.all(desktopBuildIntermediates.map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
}

const privateBuildEnvironment = privateDesktopBuildEnvironment();
const privateBuildNeedles = [
  { description: "a local home-directory path", value: Buffer.from(homedir()) },
  ...DESKTOP_BUILD_SECRET_VALUE_KEYS.flatMap((key) => {
    const value = process.env[key];
    return value && value.length >= 8
      ? [{ description: `the value of sensitive environment variable ${key}`, value: Buffer.from(value) }]
      : [];
  }),
];

try {
  await run("npm", ["run", "desktop:prepare"], repositoryRoot, privateBuildEnvironment);
  await run(
    tauriExecutable,
    ["build", "--bundles", "app", "--config", "tauri.local.conf.json"],
    tauriRoot,
    privateRustBuildEnvironment(privateBuildEnvironment),
  );

  await mkdir(outputDirectory, { recursive: true });
  await rm(outputApp, { recursive: true, force: true });
  await cp(bundledApp, outputApp, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    outputApp,
  ]);
  await assertNoPrivateBuildData(outputApp, privateBuildNeedles);

  process.stdout.write(`Desktop application written to ${path.relative(repositoryRoot, outputApp)}.\n`);
} finally {
  await cleanupDesktopBuildIntermediates();
}
