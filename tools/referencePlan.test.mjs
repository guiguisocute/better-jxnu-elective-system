import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
let server, buildCreditPlan, CreditRing;
before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  ({ buildCreditPlan } = await server.ssrLoadModule("/src/lib/creditPlan.ts"));
  ({ CreditRing } = await server.ssrLoadModule("/src/components/sim/CreditRing.tsx"));
});
after(async () => { await server?.close(); });
const inputs = {
  totalEarned: 0, electiveThisSem: 0, term: 1, readingSettled: false,
  takenMajorElectives: new Set(), excludedRequired: new Set(), transferMode: false,
  transferEarlyCids: new Set(), transferOffsetCids: new Set(), showFutureRequired: false,
  moocOffset: false, competitionOffset: 0,
};
const partial = {year:"2026",major:"测试专业",directions:[],minTotal:null,minMajorElective:null,byNature:{},isPartial:true};
test("reference plan never becomes 0-credit graduation completion", () => {
  const view = buildCreditPlan(partial, [], [], "2026级-测试专业", inputs);
  assert.equal(view.found, true);
  assert.equal(view.minTotal, null);
  assert.equal(view.totalRemaining, null);
  assert.equal(view.totalOverflow, null);
  assert.ok(view.blocks.every(b => b.required === null && b.remaining === null));
  assert.equal(view.blocks[1].subTarget, null);
  const markup = renderToStaticMarkup(React.createElement(CreditRing, {view}));
  assert.match(markup, /毕业学分未知/);
  assert.match(markup, /暂不计算进度/);
});
test("existing complete plan credit requirements are unchanged", () => {
  const req = {...partial,year:"2025",isPartial:undefined,minTotal:160,minMajorElective:20,byNature:{公共必修:{count:1,sumXf:50}}};
  const view = buildCreditPlan(req, [], [], "2025级-测试专业", inputs);
  assert.equal(view.minTotal,160);
  assert.equal(view.blocks[0].required,50);
  assert.equal(view.blocks[1].required,110);
  assert.equal(view.blocks[1].subTarget.required,20);
});
