import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute } from "./routing.js";

const routes = [
  { name: "list", route: "cron/jobs", methods: ["GET"] },
  { name: "create", route: "cron/jobs", methods: ["POST"] },
  { name: "get", route: "cron/jobs/{id}", methods: ["GET"] },
  { name: "run", route: "cron/jobs/{id}/run", methods: ["POST"] },
  { name: "connect", route: "ws/connect", methods: ["GET", "OPTIONS", "POST"] },
  { name: "catchAll", route: "ws/{*catchAllEvent}", methods: ["OPTIONS"] },
  { name: "negotiate", route: "negotiate", methods: ["GET", "OPTIONS"] },
] as const;

const name = (method: string, path: string) => matchRoute(routes, method, path)?.route.name ?? null;

test("matches by method among routes with the same path", () => {
  assert.equal(name("GET", "/cron/jobs"), "list");
  assert.equal(name("POST", "/cron/jobs"), "create");
  assert.equal(name("DELETE", "/cron/jobs"), null);
});

test("extracts and decodes parameters", () => {
  assert.deepEqual(matchRoute(routes, "GET", "/cron/jobs/a%20b")?.params, { id: "a b" });
  assert.deepEqual(matchRoute(routes, "POST", "cron/jobs/j1/run")?.params, { id: "j1" });
});

test("a parameter matches exactly one segment", () => {
  assert.equal(name("GET", "/cron/jobs/j1/extra"), null);
  assert.equal(name("POST", "/cron/jobs/run"), null);
});

test("is case-insensitive and ignores a trailing slash", () => {
  assert.equal(name("get", "/Cron/JOBS/"), "list");
  assert.equal(name("GET", "/negotiate/"), "negotiate");
});

test("a literal route beats a catch-all for the same method", () => {
  assert.equal(name("OPTIONS", "/ws/connect"), "connect");
  assert.equal(name("OPTIONS", "/ws/message"), "catchAll");
  assert.deepEqual(matchRoute(routes, "OPTIONS", "/ws/a/b")?.params, { catchAllEvent: "a/b" });
  assert.equal(name("POST", "/ws/message"), null);
});

test("a catch-all may match an empty remainder", () => {
  assert.deepEqual(matchRoute(routes, "OPTIONS", "/ws")?.params, { catchAllEvent: "" });
});

test("rejects a catch-all that is not last", () => {
  assert.throws(() => matchRoute([{ route: "a/{*rest}/b", methods: ["GET"] }], "GET", "/a/x/b"), /must be last/);
});
