"use strict";

const DEFAULT_ALLOWED_ACTIONS = ["task", "claim", "renew", "result", "requeue", "review"];

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function allowedActions(roles) {
  const list = roles && Array.isArray(roles.allowed_actions) ? roles.allowed_actions : DEFAULT_ALLOWED_ACTIONS;
  return new Set(list.map(norm).filter(Boolean));
}

function grantsFor(actor, roles) {
  const presets = roles && roles.presets && typeof roles.presets === "object" ? roles.presets : {};
  const presetName = norm(roles && roles.active_preset) || norm(roles && roles.preset) || "planner-executor-qa";
  const rawPreset = presets[presetName] && typeof presets[presetName] === "object" ? presets[presetName] : {};
  const preset = rawPreset.roles && typeof rawPreset.roles === "object" ? rawPreset.roles : rawPreset;
  const direct = roles && roles.roles && typeof roles.roles === "object" ? roles.roles : {};
  const grants = direct[actor] || preset[actor] || [];
  return Array.isArray(grants) ? grants.map(norm).filter(Boolean) : [];
}

function validateAction({ actor, action }, roles) {
  const who = norm(actor);
  const what = norm(action);
  if (!what) return { ok: false, reason: "missing action" };
  if (!roles || typeof roles !== "object") return { ok: true, reason: "policy off" };
  if (!allowedActions(roles).has(what)) return { ok: true, reason: "action not gated" };
  if (!who) return { ok: false, reason: `${what} requires actor` };
  const grants = new Set(grantsFor(who, roles));
  if (grants.has(what)) return { ok: true, reason: "allowed" };
  return { ok: false, reason: `${who} cannot ${what}` };
}

module.exports = { validateAction, DEFAULT_ALLOWED_ACTIONS };
