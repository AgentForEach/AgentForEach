/**
 * Runtime polyfills for deprecated/removed Node.js APIs.
 *
 * Must be the first import in the entry point (index.ts) so patches
 * take effect before any dependency accesses the polyfilled APIs.
 *
 * Current patches:
 *   - util.isDate — removed in Node.js v24, still used by
 *     durable-functions v3.x (CreateTimerAction.js).
 *   - Math.sumPrecise — a TC39 proposal not yet shipped in Node, used by
 *     PDF.js (via unpdf) when rebuilding embedded font tables. Without it
 *     every PDF with embedded fonts logs a TypeError during extraction.
 *   - globalThis.crypto — present in every Node we support, but absent in
 *     the Azure Functions worker on Flex Consumption. @azure/cosmos reaches
 *     it through @azure/core-util → @typespec/ts-http-runtime, which as of
 *     0.3.x calls globalThis.crypto.randomUUID() with no Node fallback, so
 *     without this every Cosmos request dies in DiagnosticNodeInternal.
 */

import util from "node:util";
import { webcrypto } from "node:crypto";

const u = util as Record<string, unknown>;
if (typeof u.isDate !== "function") {
  u.isDate = (d: unknown): boolean => d instanceof Date;
}

const m = Math as unknown as Record<string, unknown>;
if (typeof m.sumPrecise !== "function") {
  // Neumaier compensated summation — tracks the low-order bits that plain
  // accumulation drops, so the result matches the exact sum for the integer
  // byte counts PDF.js feeds it, and stays accurate for floats too.
  m.sumPrecise = (values: Iterable<number>): number => {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + value;
      compensation +=
        Math.abs(sum) >= Math.abs(value)
          ? sum - next + value
          : value - next + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

// Node normally exposes this as a getter-only accessor, so defineProperty
// rather than assignment — a bare `globalThis.crypto = …` throws in ESM.
if (typeof (globalThis as { crypto?: unknown }).crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
