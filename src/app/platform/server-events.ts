/** Keep provider disconnects inside their SSE response, including in Bun. */
export function serverEventStream<T>(
  source: ReadableStream<T>,
  messageFor: (value: T) => unknown | null,
  heartbeatMs = 15_000,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, heartbeatMs);
      void (async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            const message = messageFor(value);
            if (message !== null) controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
          }
        } catch {
          // EOF lets EventSource reconnect. An errored HTTP body can terminate Bun.
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          if (!closed) controller.close();
          closed = true;
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })();
    },
    async cancel(reason) {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
