import assert from "node:assert/strict";
import test from "node:test";
import { serverEventStream } from "../src/app/platform/server-events";

test("a quote-provider failure ends SSE normally after preserving already delivered quotes", async () => {
  let step = 0;
  const source = new ReadableStream<number>({
    pull(controller) {
      if (step++ === 0) controller.enqueue(342.96);
      else controller.error(new Error("upstream socket disconnected"));
    },
  });
  const response = new Response(serverEventStream(source, price => ({ price })));
  const body = await response.text();
  assert.match(body, /^: connected\n\n/);
  assert.match(body, /data: {"price":342.96}/);
  assert.doesNotMatch(body, /upstream socket disconnected/);
});

test("closing a chart cancels its upstream reader and keeps later requests usable", async () => {
  let canceled = false;
  const source = new ReadableStream<number>({ cancel() { canceled = true; } });
  const reader = serverEventStream(source, value => ({ value })).getReader();
  await reader.read();
  await reader.cancel("chart closed");
  assert.equal(canceled, true);
  const next = new ReadableStream<number>({ start(controller) { controller.enqueue(1); controller.close(); } });
  assert.match(await new Response(serverEventStream(next, value => ({ value }))).text(), /data: {"value":1}/);
});
