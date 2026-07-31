import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "./ratings.ts";

for (const method of ["POST", "DELETE"]) {
  test(`legacy ratings ${method} is gone without touching D1`, async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/ratings", { method }),
      env: {},
    } as never);
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
}
