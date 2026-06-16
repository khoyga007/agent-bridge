"use strict";

const { validateAction } = require("./policy");

function asInt(value, fallback) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function addSeconds(ts, seconds) {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return new Date(t + Math.max(0, asInt(seconds, 1800)) * 1000).toISOString();
}

function cloneState(s) {
  return {
    epoch: s.epoch,
    winner_agent: s.winner_agent || null,
    lease_until: s.lease_until || null,
    status: s.status,
    result_hash: s.result_hash || null,
    side_effect_keys: Array.isArray(s.side_effect_keys) ? [...s.side_effect_keys] : [],
  };
}

function actorFor(rec) {
  return String(rec.agent || rec.reviewer || rec.from || "").trim().toLowerCase();
}

function enforcePolicy(roles) {
  return String(roles?.policy_mode || "").trim().toLowerCase() === "enforce";
}

function reduce(records, roles) {
  const state = new Map();

  for (const rec of records || []) {
    if (!rec || typeof rec !== "object" || typeof rec.type !== "string") continue;
    if (enforcePolicy(roles) && !validateAction({ actor: actorFor(rec), action: rec.type }, roles).ok) continue;
    const taskId = String(rec.task_id || "").trim();
    if (!taskId) continue;

    const cur = state.get(taskId);
    if (rec.type === "task") {
      if (cur) continue;
      const epoch = asInt(rec.epoch, 0);
      state.set(taskId, {
        epoch,
        winner_agent: null,
        lease_until: null,
        status: rec.requires_human ? "human" : "open",
        result_hash: null,
        side_effect_keys: [],
      });
      continue;
    }

    if (!cur) continue;

    if (rec.type === "claim") {
      const epoch = asInt(rec.epoch, cur.epoch);
      if (epoch !== cur.epoch) continue;
      if (cur.status !== "open" && cur.status !== "requeued") continue;
      cur.winner_agent = String(rec.agent || "").trim().toLowerCase() || null;
      if (!cur.winner_agent) continue;
      cur.lease_until = addSeconds(rec.ts, rec.lease_seconds);
      cur.status = "claimed";
      continue;
    }

    if (rec.type === "renew") {
      const epoch = asInt(rec.epoch, cur.epoch);
      const agent = String(rec.agent || "").trim().toLowerCase();
      if (epoch !== cur.epoch || agent !== cur.winner_agent) continue;
      if (cur.status !== "claimed") continue;
      cur.lease_until = addSeconds(rec.ts, rec.lease_seconds);
      continue;
    }

    if (rec.type === "result") {
      const epoch = asInt(rec.epoch, cur.epoch);
      const agent = String(rec.agent || "").trim().toLowerCase();
      if (epoch !== cur.epoch || agent !== cur.winner_agent) continue;
      if (cur.status === "done") continue;
      if (cur.status !== "claimed") continue;
      cur.status = "done";
      cur.result_hash = rec.result_hash || null;
      cur.side_effect_keys = Array.isArray(rec.side_effect_keys) ? [...rec.side_effect_keys] : [];
      continue;
    }

    if (rec.type === "requeue") {
      const fromEpoch = asInt(rec.from_epoch, cur.epoch);
      if (fromEpoch !== cur.epoch) continue;
      if (cur.status === "done" || cur.status === "human") continue;
      const nextEpoch = asInt(rec.to_epoch, cur.epoch + 1);
      if (nextEpoch <= cur.epoch) continue;
      cur.epoch = nextEpoch;
      cur.winner_agent = null;
      cur.lease_until = null;
      cur.status = "requeued";
      cur.result_hash = null;
      cur.side_effect_keys = [];
    }
  }

  return new Map([...state.entries()].map(([taskId, s]) => [taskId, cloneState(s)]));
}

module.exports = { reduce };
