import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadStrategyPackages,
  renderGeneratedStrategyPackages,
} from "../strategy-package-loader";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outputPath = path.join(
  repositoryRoot,
  "src/app/generated/strategy-packages.generated.ts",
);
const rendered = renderGeneratedStrategyPackages(
  await loadStrategyPackages(path.join(repositoryRoot, "strategies")),
);

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== rendered) {
    throw new Error("Generated strategy catalog is stale. Run npm run strategies:generate.");
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, rendered, "utf8");
  await rename(temporaryPath, outputPath);
  process.stdout.write(`Generated ${path.relative(repositoryRoot, outputPath)}.\n`);
}
