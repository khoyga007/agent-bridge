"use strict";

function compareHlc(a, b) {
  const ats = Number(a && a.ts);
  const bts = Number(b && b.ts);
  if (ats !== bts) return ats < bts ? -1 : 1;

  const ac = Number(a && a.count);
  const bc = Number(b && b.count);
  if (ac !== bc) return ac < bc ? -1 : 1;

  const an = String((a && a.node) || "");
  const bn = String((b && b.node) || "");
  if (an === bn) return 0;
  return an < bn ? -1 : 1;
}

function canonicalString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`)
    .join(",")}}`;
}

function dedupeByRid(events) {
  const byRid = new Map();
  for (const event of events || []) {
    if (!event || typeof event.rid !== "string" || !event.rid) continue;
    const existing = byRid.get(event.rid);
    if (!existing || canonicalString(event) < canonicalString(existing)) {
      byRid.set(event.rid, event);
    }
  }
  return [...byRid.values()].sort((a, b) => {
    const ah = a.hlc || {};
    const bh = b.hlc || {};
    const byHlc = compareHlc(ah, bh);
    if (byHlc !== 0) return byHlc;
    return a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0;
  });
}

function isEligible(event, watermark) {
  return compareHlc(event.hlc || {}, watermark || {}) <= 0;
}

function reduce(events, watermark) {
  const unique = dedupeByRid(events);
  const committed = new Map();
  const deferred = [];

  for (const event of unique) {
    if (!isEligible(event, watermark)) {
      deferred.push(event);
      continue;
    }

    const current = committed.get(event.key);
    if (!current || compareHlc(current.hlc, event.hlc) < 0) {
      committed.set(event.key, event);
    } else if (compareHlc(current.hlc, event.hlc) === 0 && event.rid > current.rid) {
      committed.set(event.key, event);
    }
  }

  return { committed, deferred };
}

module.exports = {
  canonicalString,
  compareHlc,
  dedupeByRid,
  reduce,
};
