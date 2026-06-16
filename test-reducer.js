"use strict";

const assert = require("assert");
const { reduce } = require("./reducer");

const wm = { ts: 10, count: 0, node: "z" };

function event(rid, key, value, ts, count = 0, node = "a") {
  return { key, value, hlc: { ts, count, node }, rid };
}

function committedObject(result) {
  return Object.fromEntries(
    [...result.committed.entries()].map(([key, value]) => [key, value.value])
  );
}

// T1 empty -> empty committed/deferred.
{
  const out = reduce([], wm);
  assert.deepStrictEqual(committedObject(out), {});
  assert.deepStrictEqual(out.deferred, []);
}

// T2 one event <= watermark -> committed.
{
  const a = event("r1", "alpha", "A", 1);
  const out = reduce([a], wm);
  assert.deepStrictEqual(committedObject(out), { alpha: "A" });
  assert.deepStrictEqual(out.deferred, []);
}

// T3 same key, different HLC -> higher HLC wins.
{
  const low = event("r1", "alpha", "low", 1);
  const high = event("r2", "alpha", "high", 2);
  const out = reduce([low, high], wm);
  assert.deepStrictEqual(committedObject(out), { alpha: "high" });
}

// T4 same HLC ts/count, different node -> node id tie-break is deterministic.
{
  const a = event("r1", "alpha", "from-a", 1, 0, "a");
  const b = event("r2", "alpha", "from-b", 1, 0, "b");
  const left = reduce([a, b], wm);
  const right = reduce([b, a], wm);
  assert.deepStrictEqual(committedObject(left), { alpha: "from-b" });
  assert.deepStrictEqual(committedObject(right), { alpha: "from-b" });
}

// T5 duplicate rid -> idempotent.
{
  const a = event("r1", "alpha", "A", 1);
  const out = reduce([a, a, { ...a }], wm);
  assert.strictEqual(out.committed.size, 1);
  assert.deepStrictEqual(committedObject(out), { alpha: "A" });
}

// T6 HLC > watermark -> deferred, not committed.
{
  const early = event("r1", "alpha", "early", 1);
  const late = event("r2", "beta", "late", 11);
  const out = reduce([late, early], wm);
  assert.deepStrictEqual(committedObject(out), { alpha: "early" });
  assert.deepStrictEqual(out.deferred.map((item) => item.rid), ["r2"]);
}

console.log("reducer tests passed");
