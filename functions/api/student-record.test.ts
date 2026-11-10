import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "./student-record.ts";

test("NDJSON import returns the dated snapshot before the live record", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    source: "live",
    row: { className: "实时班", planKey: "2023级-计算机科学与技术", totalEarned: 90, takenCount: 30 },
    record: { studentId: "202400000001", className: "实时班", scheduleItems: [], detailCourses: [] },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const statement = {
    bind: () => statement,
    all: async () => ({ results: [] }),
    first: async () => ({
      student_id: "202400000001",
      class_name: "快照班",
      plan_key: "2023级-计算机科学与技术",
      total_earned: 88,
      taken_count: 29,
      record_json: JSON.stringify({ studentId: "202400000001", className: "快照班", scheduleItems: [], detailCourses: [] }),
      updated_at: "2026-11-01 08:00:00",
    }),
    run: async () => ({}),
  };
  const env = {
    DB: { prepare: () => statement },
    DB_STUDENTS: { prepare: () => statement },
    LIVE_URL: "https://backend.example.test/student-record",
    LIVE_SECRET: "test-secret",
  };
  const pending: Promise<unknown>[] = [];
  const response = await onRequestPost({
    request: new Request("https://example.test/api/student-record", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ sid: "202400000001" }),
    }),
    env,
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as never);

  assert.match(response.headers.get("Content-Type") ?? "", /application\/x-ndjson/);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].source, "snapshot");
  assert.equal(lines[0].className, "快照班");
  assert.equal(lines[0].snapshotUpdatedAt, "2026-11-01 08:00:00");
  assert.equal(lines[1].source, "live");
  assert.equal(lines[1].className, "实时班");
  await Promise.all(pending);
});
