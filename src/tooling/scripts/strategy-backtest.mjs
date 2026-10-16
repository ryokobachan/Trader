import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localPython = process.platform === "win32"
  ? path.join(repositoryRoot, "venv", "Scripts", "python.exe")
  : path.join(repositoryRoot, "venv", "bin", "python");
const python = process.env.TRADER_STRATEGY_PYTHON
  || (existsSync(localPython) ? localPython : (process.platform === "win32" ? "python" : "python3"));
const entrypoint = path.join(repositoryRoot, "src", "tooling", "strategy_runner", "cli.py");
const allowedEnvironmentKeys = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "XDG_CACHE_HOME",
  "NUMBA_CACHE_DIR",
  "NUMBA_NUM_THREADS",
  "SEC_USER_AGENT",
  "OMP_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "MKL_NUM_THREADS",
  "VECLIB_MAXIMUM_THREADS",
]);
const childEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && allowedEnvironmentKeys.has(key.toUpperCase())) {
    childEnvironment[key] = value;
  }
}
childEnvironment.PYTHONHASHSEED = "0";
childEnvironment.PYTHONNOUSERSITE = "1";
childEnvironment.PYTHONDONTWRITEBYTECODE = "1";
const result = spawnSync(python, [entrypoint, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  env: childEnvironment,
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write("The Trader strategy Python runtime could not be started.\n");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
