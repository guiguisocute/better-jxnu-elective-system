import assert from "node:assert/strict";
import test from "node:test";

import { abuseActor, deriveAbuseActor } from "./abuseIdentity.ts";

const SECRET = "unit-test-secret-with-at-least-32-chars";

test("deriveAbuseActor is stable without exposing the source address", async () => {
  const first = await deriveAbuseActor(SECRET, "helpful", "203.0.113.7");
  const second = await deriveAbuseActor(SECRET, "helpful", "203.0.113.7");
  assert.equal(first, second);
  assert.match(first ?? "", /^a1:[A-Za-z0-9_-]{43}$/);
  assert.equal(first?.includes("203.0.113.7"), false);
});

test("deriveAbuseActor separates features, addresses, and secrets", async () => {
  const base = await deriveAbuseActor(SECRET, "helpful", "203.0.113.7");
  assert.notEqual(base, await deriveAbuseActor(SECRET, "reports", "203.0.113.7"));
  assert.notEqual(base, await deriveAbuseActor(SECRET, "helpful", "203.0.113.8"));
  assert.notEqual(base, await deriveAbuseActor(`${SECRET}-other`, "helpful", "203.0.113.7"));
});

test("abuseActor fails closed without a strong secret or Cloudflare source address", async () => {
  const request = new Request("https://example.test/api", {
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  });
  assert.equal(await abuseActor(request, {}, "ai"), null);
  assert.equal(await abuseActor(request, { ABUSE_ID_SECRET: "too-short" }, "ai"), null);
  assert.equal(
    await abuseActor(new Request("https://example.test/api"), { ABUSE_ID_SECRET: SECRET }, "ai"),
    null,
  );
});
