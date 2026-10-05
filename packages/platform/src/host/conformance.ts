/**
 * The Host port's conformance suite: what any host serving the gateway's
 * route table must do the same way (Azure Functions, a Cloudflare Worker,
 * a future Lambda or Cloud Run host).
 *
 * A host under test serves `hostConformanceTable()` and gives the suite a
 * way to send it requests (in process, or over HTTP). The suite checks:
 * - routing: `{name}` and `{*rest}` params (decoded), case-insensitive paths,
 *   and 404 for an unknown path or a method no route accepts;
 * - requests: the method, query values (repeated too), the raw body exactly,
 *   and JSON bodies;
 * - responses: the handler's status and headers as given, an empty 204, a
 *   redirect left to the client, and 500 for a handler that throws;
 * - CORS: a route that handles OPTIONS answers its own preflight; for one
 *   that doesn't, the host answers it (where it does: Azure's host config,
 *   the Worker host);
 * - the invocation scope: handlers run in one, and background work finishes:
 *   after the response on a host that keeps running then
 *   (`backgroundAfterResponse`), before it on one that freezes (Lambda);
 * - `deadlineAt`: in the future when set, and always set on a host that
 *   freezes, which waits for background work only until then.
 *
 *   import { hostConformanceTable, runHostConformance } from "@agentforeach/platform/host/conformance";
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostConformanceTable } from "./conformance-table.js";

export { hostConformanceTable };

export interface HostConformanceOptions {
  /** Shown in the suite name. */
  name: string;
  /** Send a request to the host serving `hostConformanceTable()`. Its URL's origin is `baseUrl`. */
  fetch: (request: Request) => Promise<Response>;
  /** The origin requests are addressed to. Default "https://host.test". */
  baseUrl?: string;
  /** The host answers preflights for routes without OPTIONS (Azure does it through its host config). Default true. */
  answersPreflights?: boolean;
  /** The host turns a handler that throws into a 500. Default true. */
  handlesErrors?: boolean;
  /** As `HostInfo.backgroundAfterResponse`: false for a host that awaits background work before it answers. Default true. */
  backgroundAfterResponse?: boolean;
}

export function runHostConformance(options: HostConformanceOptions): void {
  const base = (options.baseUrl ?? "https://host.test").replace(/\/$/, "");
  const send = (path: string, init?: RequestInit) => options.fetch(new Request(`${base}${path}`, init));
  const body = async (response: Response) => JSON.parse(await response.text()) as Record<string, unknown>;
  const afterResponse = options.backgroundAfterResponse !== false;
  const backgroundKey = () => `bg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  describe(`host conformance: ${options.name}`, () => {
    it("passes {name} and {*rest} params decoded, query values (repeated too), headers and the raw body", async () => {
      const raw = 'Grüße, 👋 {"not": "parsed"}\n';
      const res = await send("/conformance/echo/a%20b/x/y%2Fz?q=1&q=two&other=3", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Conformance": "sent" },
        body: raw,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await body(res), {
        method: "POST",
        id: "a b",
        rest: "x/y/z",
        q: ["1", "two"],
        missing: null,
        header: "sent",
        text: raw,
      });
    });

    it("parses JSON bodies", async () => {
      const res = await send("/conformance/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":[1,"b"]}' });
      assert.deepEqual(await body(res), { received: { a: [1, "b"] } });
    });

    it("matches paths case-insensitively, with or without a trailing slash", async () => {
      assert.equal((await send("/Conformance/STATUS/200")).status, 200);
      assert.equal((await send("/conformance/status/200/")).status, 200);
    });

    it("answers 404 for an unknown path, and for a method no route accepts", async () => {
      assert.equal((await send("/conformance/nowhere")).status, 404);
      assert.equal((await send("/conformance/json")).status, 404, "GET on a POST-only route");
    });

    it("sends the handler's status and headers as given, with no body for a 204", async () => {
      let res = await send("/conformance/status/201");
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("x-conformance"), "custom");
      assert.equal(await res.text(), "status 201");
      res = await send("/conformance/status/418");
      assert.equal(res.status, 418);
      res = await send("/conformance/status/204");
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("x-conformance"), "empty");
      assert.equal(await res.text(), "");
    });

    it("leaves a redirect to the client", async () => {
      const res = await send("/conformance/status/302", { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "https://example.com/next");
    });

    it("turns a handler that throws into a 500", { skip: options.handlesErrors === false }, async () => {
      assert.equal((await send("/conformance/throws")).status, 500);
    });

    it("lets a route that handles OPTIONS answer its own preflight", async () => {
      const res = await send("/conformance/own-cors", { method: "OPTIONS", headers: { Origin: "https://app.example" } });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://own.example");
    });

    it("answers the preflight for a route without OPTIONS", { skip: options.answersPreflights === false }, async () => {
      const res = await send("/conformance/no-options", {
        method: "OPTIONS",
        headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
      });
      assert.ok(res.status === 200 || res.status === 204, `status ${res.status}`);
      assert.ok(res.headers.get("access-control-allow-origin"), "an allowed origin");
      assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    });

    it("runs each request in an invocation scope named by its invocation id", async () => {
      assert.deepEqual(await body(await send("/conformance/scope")), { inScope: true, kind: "http", sameId: true });
    });

    it("gives handlers a deadlineAt in the future, or none where background work may outlive the response", async () => {
      const sent = Date.now();
      const { deadlineAt } = await body(await send("/conformance/deadline"));
      if (!afterResponse) assert.equal(typeof deadlineAt, "number", "it bounds the wait for background work");
      assert.ok(deadlineAt === null || (typeof deadlineAt === "number" && deadlineAt > sent), `deadlineAt ${deadlineAt}`);
    });

    it("finishes background work before it answers, on a host that runs nothing after", { skip: afterResponse }, async () => {
      const key = backgroundKey();
      const res = await send(`/conformance/background/${key}`, { method: "POST" });
      assert.equal(res.status, 202);
      assert.deepEqual(await body(res), { state: "started" }, "the handler answered before its work was done");
      assert.equal((await body(await send(`/conformance/background/${key}`))).state, "done", "done by the time the response came");
    });

    it("keeps background work going after the response, to completion", { skip: !afterResponse }, async () => {
      const key = backgroundKey();
      const res = await send(`/conformance/background/${key}`, { method: "POST" });
      assert.equal(res.status, 202);
      assert.deepEqual(await body(res), { state: "started" }, "the response didn't wait for it");
      let state: unknown;
      for (let i = 0; i < 30 && state !== "done"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = (await body(await send(`/conformance/background/${key}`))).state;
      }
      assert.equal(state, "done");
    });
  });
}
