/**
 * Bounded reads of a fetch response body: at most `maxBytes` is read, the
 * rest is cancelled, so a huge (or decompressed gzip-bomb) body is never
 * buffered whole. Web streams only, so it runs on every host.
 */

/** A fetch Response from undici, Node's global fetch or a Worker; only the body is used. */
export interface ResponseWithBody {
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

/**
 * Read at most `maxBytes` of a response body, then cancel the rest.
 * Reading with arrayBuffer() first would buffer a huge (or decompressed
 * gzip-bomb) body in memory before any truncation.
 */
export async function readBodyBytes(
  response: ResponseWithBody,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) return { bytes: concat(chunks, total), truncated: false };
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        await reader.cancel().catch(() => {});
        return { bytes: concat(chunks, maxBytes), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read at most `maxBytes` of a response body as UTF-8 text (see readBodyBytes). */
export async function readBodyText(
  response: ResponseWithBody,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBodyBytes(response, maxBytes);
  return { text: new TextDecoder("utf-8").decode(bytes), truncated }; // not fatal: the default
}
