import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet } from "./all.ts";

test("public review aggregates reuse the edge cache and report D1 timing", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const stored = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => stored.get(request.url),
        put: async (request: Request, response: Response) => { stored.set(request.url, response); },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else Reflect.deleteProperty(globalThis, "caches");
  });

  let queries = 0;
  const env = {
    DB: {
      prepare: () => ({
        all: async () => {
          queries += 1;
          return { results: [{ course_id: "C1", teacher_id: "T1", overall_avg: 4.5, overall_count: 2 }] };
        },
      }),
    },
  };
  const pending: Promise<unknown>[] = [];
  const context = {
    request: new Request("https://example.test/api/reviews/all"),
    env,
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as never;

  const miss = await onRequestGet(context);
  await Promise.all(pending);
  assert.equal(miss.headers.get("X-Reviews-Cache"), "MISS");
  assert.match(miss.headers.get("Server-Timing") ?? "", /d1;dur=/);
  assert.equal(miss.headers.get("Cache-Control"), "public, max-age=30, s-maxage=60, stale-while-revalidate=30");

  const hit = await onRequestGet(context);
  assert.equal(hit.headers.get("X-Reviews-Cache"), "HIT");
  assert.equal(queries, 1);
  assert.deepEqual(await hit.json(), { C1: { T1: { overall: { avg: 4.5, count: 2 } } } });
});
