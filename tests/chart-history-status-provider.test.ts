import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("chart history feedback depends on the bars request, not the workspace quote request", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /\{barsStatus === "loading" && <div className="chart-data-state" role="status">\{t\("chart\.historyLoading"\)\}<\/div>\}/,
  );
  assert.match(
    source,
    /\{barsStatus === "error" && <div className="chart-data-state is-error" role="alert">\{t\("chart\.historyError"\)\}<\/div>\}/,
  );
  assert.doesNotMatch(
    source,
    /\{dataStatus === "error" && <div className="chart-data-state is-error"/,
  );
});
