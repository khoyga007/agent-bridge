#!/usr/bin/env node
// agent-bridge: minimal MCP stdio relay so multiple agents can message each
// other directly via a shared append-only JSONL log.
// No external deps. Newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport).
//
// Usage: node server.js --self <name>
//   --self   this agent's address (any stable identifier). Required.
//   --store  override store dir (default: this file's directory).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { reduce: reduceTasks } = require("./task-reducer");
const { validateAction } = require("./policy");

// ---- args ----
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const SELF = (arg("--self", process.env.BRIDGE_SELF) || "").trim().toLowerCase();
if (!SELF) {
  process.stderr.write("agent-bridge: --self <name> required\n");
  process.exit(1);
}
const STORE_DIR = arg("--store", __dirname);
const LOG = path.join(STORE_DIR, "messages.jsonl");
const RECEIPTS = path.join(STORE_DIR, "receipts.jsonl");
const STATE = path.join(STORE_DIR, "state.json");
const ROLES = path.join(STORE_DIR, "roles.json");
const CURSOR = path.join(STORE_DIR, `cursor.${SELF}.json`);
const LEGACY_CURSOR = path.join(STORE_DIR, `cursor.${SELF}.txt`);
const GLOBAL_LOCK = path.join(STORE_DIR, "bridge");
const LOCKS_DIR = path.join(STORE_DIR, "locks");
const DEFAULT_STATE = { current_gen: 0, rotated_at: null, max_lines: 5000, max_bytes: 5242880, max_backlog: 0 };

fs.mkdirSync(STORE_DIR, { recursive: true });
fs.mkdirSync(LOCKS_DIR, { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "");
if (!fs.existsSync(RECEIPTS)) fs.writeFileSync(RECEIPTS, "");
if (!fs.existsSync(STATE)) fs.writeFileSync(STATE, JSON.stringify(DEFAULT_STATE, null, 2) + "\n");

// ---- store helpers ----
function atomicWrite(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readState() {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  for (const [k, t] of [["current_gen", "number"], ["max_lines", "number"], ["max_bytes", "number"]]) {
    if (typeof state[k] !== t || !Number.isFinite(state[k])) throw new Error(`invalid state.json: ${k}`);
  }
  if (state.current_gen < 0 || state.max_lines <= 0 || state.max_bytes <= 0) throw new Error("invalid state.json values");
  const maxBacklog = state.max_backlog ?? 0;
  if (typeof maxBacklog !== "number" || !Number.isFinite(maxBacklog) || maxBacklog < 0) throw new Error("invalid state.json: max_backlog");
  return {
    current_gen: Math.trunc(state.current_gen),
    rotated_at: state.rotated_at ?? null,
    max_lines: Math.trunc(state.max_lines),
    max_bytes: Math.trunc(state.max_bytes),
    max_backlog: Math.trunc(maxBacklog),
  };
}

function writeState(state) {
  atomicWrite(STATE, JSON.stringify(state, null, 2) + "\n");
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip corrupt line */ }
  }
  return out;
}
function genPath(active, gen, currentGen) {
  if (gen === currentGen) return active;
  const ext = active.endsWith(".jsonl") ? ".jsonl" : "";
  const base = ext ? active.slice(0, -ext.length) : active;
  return `${base}.${gen}${ext}`;
}
function readGenerations(active) {
  const state = readState();
  const out = [];
  for (let gen = 0; gen <= state.current_gen; gen++) {
    const file = genPath(active, gen, state.current_gen);
    if (!fs.existsSync(file)) {
      if (gen === state.current_gen) fs.writeFileSync(file, "");
      else continue;
    }
    out.push(...readJsonl(file));
  }
  return out;
}
function readAll() { return readGenerations(LOG); }
function readReceipts() { return readGenerations(RECEIPTS); }
function readRoles() {
  if (!fs.existsSync(ROLES)) return null;
  try {
    const roles = JSON.parse(fs.readFileSync(ROLES, "utf8"));
    const preset = String(roles.active_preset || roles.preset || "").trim();
    if (preset) {
      const presetFile = path.join(STORE_DIR, "presets", `${preset}.json`);
      if (fs.existsSync(presetFile)) {
        const presetData = JSON.parse(fs.readFileSync(presetFile, "utf8"));
        roles.presets = roles.presets && typeof roles.presets === "object" ? roles.presets : {};
        roles.presets[preset] = presetData.roles || presetData;
      }
    }
    return roles;
  } catch { return null; }
}
function policyMode(roles) {
  const mode = String(roles?.policy_mode || "off").trim().toLowerCase();
  return mode === "advisory" || mode === "enforce" ? mode : "off";
}
function checkPolicy(action, actor = SELF) {
  const roles = readRoles();
  const mode = policyMode(roles);
  if (mode === "off") return { ok: true, warning: "" };
  const verdict = validateAction({ actor, action }, roles);
  if (verdict.ok) return { ok: true, warning: "" };
  if (mode === "enforce") throw new Error(`policy denied: ${verdict.reason}`);
  return { ok: true, warning: `warning: policy denied: ${verdict.reason}` };
}
function withWarning(text, policy) {
  return policy?.warning ? `${policy.warning}\n${text}` : text;
}
// P2: cross-process advisory lock so two agents never interleave a write.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(file, fn, strict = false) {
  const lock = file + ".lock";
  for (let i = 0; i < 50; i++) {
    let fd;
    try { fd = fs.openSync(lock, "wx"); }            // 'wx' = fail if exists
    catch (e) {
      if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch { /* race */ }
      sleepSync(20); continue;                       // spin ~1s then fall through
    }
    try { return fn(); } finally { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch {} } }
  }
  if (strict) throw new Error(`could not acquire lock: ${lock}`);
  return fn();                                       // fallback: O_APPEND is atomic for small records
}
function waitNoGlobalLock() {
  const lock = GLOBAL_LOCK + ".lock";
  for (let i = 0; i < 250; i++) {
    if (!fs.existsSync(lock)) return;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch { /* race */ }
    sleepSync(20);
  }
}
function lineCount(file) {
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, "utf8");
  return raw ? (raw.match(/\n/g) || []).length : 0;
}

function parseCursorFile(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (file.endsWith(".json")) return normalizeCursor(JSON.parse(raw));
  if (/^\d+$/.test(raw)) return { gen: 0, offset: parseInt(raw, 10), last_id: null };
  return { gen: 0, offset: raw ? offsetAfterIdInGen0(raw) : 0, last_id: raw || null };
}

function cursorAgentName(name) {
  const m = /^cursor\.([^.]+)\.(json|txt)$/.exec(name);
  return m ? m[1] : null;
}

function readAllCursors() {
  const byAgent = new Map();
  for (const ent of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const agent = cursorAgentName(ent.name);
    if (!agent) continue;
    const file = path.join(STORE_DIR, ent.name);
    const cur = parseCursorFile(file);
    const prev = byAgent.get(agent);
    if (!prev || ent.name.endsWith(".json")) byAgent.set(agent, cur);
  }
  const dir = path.join(STORE_DIR, "cursors");
  if (fs.existsSync(dir)) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      byAgent.set(path.basename(ent.name, ".json"), parseCursorFile(path.join(dir, ent.name)));
    }
  }
  return [...byAgent.entries()].map(([agent, cursor]) => ({ agent, cursor }));
}

function pruneLocked(state = readState()) {
  const cursors = readAllCursors();
  if (!cursors.length || state.current_gen <= 0) return { deleted: [], min_gen: 0, ignored: [] };
  const ignored = [];
  const active = [];
  for (const item of cursors) {
    const cur = item.cursor;
    if (cur.gen > state.current_gen) throw new Error(`cursor ${item.agent} beyond current_gen`);
    if (state.max_backlog > 0 && cur.gen <= state.current_gen - state.max_backlog) ignored.push(item.agent);
    else active.push(cur);
  }
  let minGen = active.length ? Math.min(...active.map((c) => c.gen)) : state.current_gen;

  const tasks = taskState();
  for (let gen = 0; gen < minGen; gen++) {
    const file = genPath(LOG, gen, state.current_gen);
    if (!fs.existsSync(file)) continue;
    const records = readJsonl(file);
    let hasOpenTask = false;
    for (const r of records) {
      if (r.type === "task") {
        const s = tasks.get(r.task_id);
        if (s && s.status !== "done") {
          hasOpenTask = true;
          break;
        }
      }
    }
    if (hasOpenTask) {
      minGen = gen;
      break;
    }
  }

  const deleted = [];
  for (let gen = 0; gen < minGen && gen < state.current_gen; gen++) {
    for (const file of [genPath(LOG, gen, state.current_gen), genPath(RECEIPTS, gen, state.current_gen)]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    deleted.push(gen);
  }
  return { deleted, min_gen: minGen, ignored };
}

function toolPrune() {
  const res = withLock(GLOBAL_LOCK, () => pruneLocked(readState()), true);
  const ignored = res.ignored.length ? ` ignored=${res.ignored.join(",")}` : "";
  return `prune deleted=${res.deleted.length ? res.deleted.join(",") : "none"} min_gen=${res.min_gen}${ignored}`;
}

function maybeRotate() {
  withLock(GLOBAL_LOCK, () => {
    const state = readState();
    if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "");
    if (!fs.existsSync(RECEIPTS)) fs.writeFileSync(RECEIPTS, "");
    const bytes = fs.statSync(LOG).size;
    const lines = lineCount(LOG);
    if (lines < state.max_lines && bytes < state.max_bytes) return;

    withLock(LOG, () => withLock(RECEIPTS, () => {
      const msgDest = genPath(LOG, state.current_gen, state.current_gen - 1);
      const rcptDest = genPath(RECEIPTS, state.current_gen, state.current_gen - 1);
      if (fs.existsSync(msgDest) || fs.existsSync(rcptDest)) throw new Error(`rotate target exists for gen ${state.current_gen}`);
      fs.renameSync(LOG, msgDest);
      fs.renameSync(RECEIPTS, rcptDest);
      fs.writeFileSync(LOG, "");
      fs.writeFileSync(RECEIPTS, "");
      writeState({
        current_gen: state.current_gen + 1,
        rotated_at: new Date().toISOString(),
        max_lines: state.max_lines,
        max_bytes: state.max_bytes,
        max_backlog: state.max_backlog,
      });
      try { pruneLocked(readState()); } catch { /* prune aborts without blocking rotate/append */ }
    }, true), true);
  }, true);
}
function appendTo(file, rec) {
  if (file === LOG) maybeRotate();
  waitNoGlobalLock();
  withLock(file, () => fs.appendFileSync(file, JSON.stringify(rec) + "\n"));
}
function append(rec) { appendTo(LOG, rec); }
function appendReceipt(msgId) {
  appendTo(RECEIPTS, {
    id: crypto.randomUUID(),
    msg_id: msgId,
    agent: SELF,
    read_at: new Date().toISOString(),
  });
}
function markRead(list) {
  const existing = new Set(readReceipts().map((r) => `${r.msg_id}:${r.agent}`));
  for (const m of list) {
    const key = `${m.id}:${SELF}`;
    if (!existing.has(key)) {
      appendReceipt(m.id);
      existing.add(key);
    }
  }
}
function markReadOnce(list) {
  for (const m of list) appendReceipt(m.id);
}

// P5: cursor stores {gen, offset, last_id}; legacy .txt cursors migrate as gen0.
function normalizeCursor(c) {
  if (!c || typeof c !== "object") throw new Error("invalid cursor");
  const gen = Number(c.gen ?? 0);
  const offset = Number(c.offset ?? 0);
  if (!Number.isFinite(gen) || !Number.isFinite(offset) || gen < 0 || offset < 0) throw new Error("invalid cursor values");
  return { gen: Math.trunc(gen), offset: Math.trunc(offset), last_id: c.last_id || null };
}
function offsetAfterIdInGen0(id) {
  const state = readState();
  const file = genPath(LOG, 0, state.current_gen);
  if (!fs.existsSync(file)) return fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  const text = fs.readFileSync(file, "utf8");
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const s = line.trim();
    if (s) {
      let m; try { m = JSON.parse(s); } catch { m = null; }
      if (m && m.id === id) return pos + lineBytes + 1; // +1 = the \n
    }
    pos += lineBytes + 1;
  }
  return fs.statSync(file).size;
}
function getCursor() {
  try {
    if (fs.existsSync(CURSOR)) return normalizeCursor(JSON.parse(fs.readFileSync(CURSOR, "utf8")));
  } catch (e) {
    throw new Error(`invalid cursor file ${CURSOR}: ${e.message}`);
  }
  let raw;
  try { raw = fs.readFileSync(LEGACY_CURSOR, "utf8").trim(); } catch { return { gen: 0, offset: 0, last_id: null }; }
  if (/^\d+$/.test(raw)) return { gen: 0, offset: parseInt(raw, 10), last_id: null };
  return { gen: 0, offset: offsetAfterIdInGen0(raw), last_id: raw || null };
}
function setCursor(cursor) {
  atomicWrite(CURSOR, JSON.stringify(normalizeCursor(cursor), null, 2) + "\n");
}

function parseLimit(limit, defaultLimit = 20) {
  if (limit === undefined || limit === null) return defaultLimit;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 0) throw new Error("`limit` must be a non-negative integer");
  return n === 0 ? Infinity : n;
}
function shortTs(ts) {
  return String(ts || "").replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d{3,}Z$/, "Z");
}
function fmt(list, meta) {
  const body = list.length
    ? list
    .map((m) => `[${shortTs(m.ts)}] ${m.from}${m.thread ? ` #${m.thread}` : ""}${m.reply_to ? ` > re ${m.reply_to}` : ""}: ${m.msg}`)
    .join("\n")
    : "inbox empty (no new messages)";
  if (!meta) return body;
  return `${body}\nhas_more: ${meta.has_more ? "true" : "false"}\nunread_remaining: ${meta.unread_remaining}`;
}

// ---- routing (supports direct, group array, and "all" broadcast) ----
function normTo(to) {
  if (to === "all") return "all";
  if (Array.isArray(to)) {
    const a = [...new Set(to.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    if (!a.length) throw new Error("`to` array is empty");
    return a.length === 1 ? a[0] : a;            // collapse single-element array
  }
  if (typeof to === "string" && to.trim()) return to.trim().toLowerCase();
  throw new Error("`to` must be an address string, an array of addresses, or 'all'");
}
function toMe(m) {
  if (m.from === SELF) return false;             // never deliver own messages back
  if (m.to === "all") return true;               // broadcast
  if (Array.isArray(m.to)) return m.to.includes(SELF);
  return m.to === SELF;
}
function involvesSelf(m) {
  if (m.from === SELF) return true;
  if (m.to === "all") return true;
  if (Array.isArray(m.to)) return m.to.includes(SELF);
  return m.to === SELF;
}
function toStr(to) { return Array.isArray(to) ? to.join(",") : to; }

// ---- tools ----
function makeMessage({ to, msg, thread, reply_to }) {
  if (to === undefined || to === null) throw new Error("`to` required");
  if (!msg || typeof msg !== "string") throw new Error("`msg` (string) required");
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: SELF,
    to: normTo(to),
    thread: thread || null,
    reply_to: reply_to || null,
    msg,
  };
}

function toolSend({ to, msg, thread, reply_to }) {
  const rec = makeMessage({ to, msg, thread, reply_to });
  append(rec);
  return `sent -> ${toStr(rec.to)} (id ${rec.id}${rec.thread ? `, thread ${rec.thread}` : ""}${rec.reply_to ? `, reply_to ${rec.reply_to}` : ""})`;
}

function taskMsg(rec) {
  if (rec.msg) return rec.msg;
  if (rec.type === "task") return `task ${rec.task_id} epoch ${rec.epoch}`;
  if (rec.type === "claim") return `claim ${rec.task_id} epoch ${rec.epoch} by ${rec.agent}`;
  if (rec.type === "renew") return `renew ${rec.task_id} epoch ${rec.epoch} by ${rec.agent}`;
  if (rec.type === "result") return `result ${rec.task_id} epoch ${rec.epoch} by ${rec.agent}`;
  if (rec.type === "requeue") return `requeue ${rec.task_id} ${rec.from_epoch}->${rec.to_epoch}`;
  return "";
}

function taskRecord(type, fields) {
  const rec = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: SELF,
    to: "all",
    thread: "task-claim",
    reply_to: null,
    type,
    ...fields,
  };
  rec.msg = taskMsg(rec);
  return rec;
}

function taskState() {
  return reduceTasks(readAll(), readRoles());
}

function appendAfterCheck(rec, check) {
  maybeRotate();
  waitNoGlobalLock();
  withLock(GLOBAL_LOCK, () => {
    check();
    withLock(LOG, () => fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"), true);
  }, true);
}

function requireTaskId(task_id) {
  const id = String(task_id || "").trim();
  if (!id) throw new Error("`task_id` required");
  return id;
}

function requireHash(name, value) {
  const v = String(value || "").trim();
  if (!v) throw new Error(`\`${name}\` required`);
  return v;
}

function parseEpoch(value, fallback = 0) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("epoch must be a non-negative integer");
  return n;
}

function parseLease(value) {
  const n = value === undefined || value === null ? 1800 : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error("lease_seconds must be a positive integer");
  return n;
}

function stateLine(taskId, s) {
  if (!s) return `task ${taskId}: missing`;
  return `task ${taskId}: epoch=${s.epoch} status=${s.status}${s.winner_agent ? ` winner=${s.winner_agent}` : ""}${s.lease_until ? ` lease_until=${s.lease_until}` : ""}${s.result_hash ? ` result=${s.result_hash}` : ""}`;
}

function assertWinner(taskId, epoch) {
  const s = taskState().get(taskId);
  if (!s) throw new Error(`task ${taskId} missing`);
  if (s.epoch !== epoch) throw new Error(`task ${taskId} epoch moved to ${s.epoch}`);
  if (s.status !== "claimed") throw new Error(`task ${taskId} is ${s.status}, not claimed`);
  if (s.winner_agent !== SELF) throw new Error(`task ${taskId} winner is ${s.winner_agent || "none"}, not ${SELF}`);
  return s;
}

function toolTask({ task_id, spec_hash, requires_human, msg }) {
  const policy = checkPolicy("task");
  const taskId = requireTaskId(task_id || crypto.randomUUID());
  const hash = requireHash("spec_hash", spec_hash);
  if (taskState().has(taskId)) throw new Error(`task ${taskId} already exists`);
  const rec = taskRecord("task", {
    task_id: taskId,
    epoch: 0,
    spec_hash: hash,
    requires_human: !!requires_human,
    msg: msg || `task ${taskId} spec=${hash}${requires_human ? " requires_human" : ""}`,
  });
  append(rec);
  const s = taskState().get(taskId);
  const landed = !!s;
  return withWarning(`${landed ? "task created" : "task creation failed"} (id ${taskId}, record ${rec.id})\n${stateLine(taskId, s)}`, policy);
}

function toolClaim({ task_id, epoch, nonce, lease_seconds }) {
  const policy = checkPolicy("claim");
  const taskId = requireTaskId(task_id);
  const cur = taskState().get(taskId);
  const wantEpoch = parseEpoch(epoch, cur ? cur.epoch : 0);
  const lease = parseLease(lease_seconds);
  const rec = taskRecord("claim", {
    task_id: taskId,
    epoch: wantEpoch,
    agent: SELF,
    nonce: nonce || crypto.randomUUID(),
    lease_seconds: lease,
  });
  append(rec);
  const s = taskState().get(taskId);
  const won = !!s && s.epoch === wantEpoch && s.status === "claimed" && s.winner_agent === SELF;
  return withWarning(`${won ? "claim won" : "claim lost"} (record ${rec.id})\n${stateLine(taskId, s)}`, policy);
}

function toolRenew({ task_id, epoch, lease_seconds }) {
  const policy = checkPolicy("renew");
  const taskId = requireTaskId(task_id);
  const wantEpoch = parseEpoch(epoch, 0);
  const rec = taskRecord("renew", {
    task_id: taskId,
    epoch: wantEpoch,
    agent: SELF,
    lease_seconds: parseLease(lease_seconds),
  });
  appendAfterCheck(rec, () => assertWinner(taskId, wantEpoch));
  return withWarning(`renewed (record ${rec.id})\n${stateLine(taskId, taskState().get(taskId))}`, policy);
}

function toolResult({ task_id, epoch, result_hash, side_effect_keys }) {
  const policy = checkPolicy("result");
  const taskId = requireTaskId(task_id);
  const wantEpoch = parseEpoch(epoch, 0);
  const hash = requireHash("result_hash", result_hash);
  const before = taskState().get(taskId);
  if (before && before.epoch === wantEpoch && before.status === "done" && before.winner_agent === SELF && before.result_hash === hash) {
    return withWarning(`result already recorded\n${stateLine(taskId, before)}`, policy);
  }
  const rec = taskRecord("result", {
    task_id: taskId,
    epoch: wantEpoch,
    agent: SELF,
    result_hash: hash,
    side_effect_keys: Array.isArray(side_effect_keys) ? side_effect_keys.map(String) : [],
  });
  appendAfterCheck(rec, () => assertWinner(taskId, wantEpoch));
  return withWarning(`result recorded (record ${rec.id})\n${stateLine(taskId, taskState().get(taskId))}`, policy);
}

function toolRequeue({ task_id, from_epoch, to_epoch, reason }) {
  const policy = checkPolicy("requeue");
  const taskId = requireTaskId(task_id);
  const s = taskState().get(taskId);
  if (!s) throw new Error(`task ${taskId} missing`);
  const fromEpoch = parseEpoch(from_epoch, s.epoch);
  if (fromEpoch !== s.epoch) throw new Error(`task ${taskId} epoch is ${s.epoch}, not ${fromEpoch}`);
  if (s.status === "done" || s.status === "human") throw new Error(`task ${taskId} is ${s.status}`);
  if (s.lease_until && Date.parse(s.lease_until) > Date.now()) throw new Error(`lease still active until ${s.lease_until}`);
  const rec = taskRecord("requeue", {
    task_id: taskId,
    from_epoch: fromEpoch,
    to_epoch: parseEpoch(to_epoch, fromEpoch + 1),
    reason: reason || "requeue",
  });
  appendAfterCheck(rec, () => {
    const latest = taskState().get(taskId);
    if (!latest) throw new Error(`task ${taskId} missing`);
    if (latest.epoch !== fromEpoch) throw new Error(`task ${taskId} epoch moved to ${latest.epoch}`);
    if (latest.status === "done" || latest.status === "human") throw new Error(`task ${taskId} is ${latest.status}`);
    if (latest.lease_until && Date.parse(latest.lease_until) > Date.now()) throw new Error(`lease still active until ${latest.lease_until}`);
  });
  return withWarning(`requeued (record ${rec.id})\n${stateLine(taskId, taskState().get(taskId))}`, policy);
}

function toolInbox({ since, all, peek, limit }) {
  // all / since (id): full scan, never touch the byte offset (rare / manual)
  if (since !== undefined || all) {
    const max = parseLimit(limit, Infinity);
    const msgs = readAll().filter(toMe);
    if (since !== undefined) {
      const i = msgs.findIndex((m) => m.id === since);
      const list = i >= 0 ? msgs.slice(i + 1) : msgs;
      const shown = list.slice(0, max);
      if (!peek) markRead(shown);
      return fmt(shown, { has_more: list.length > shown.length, unread_remaining: Math.max(0, list.length - shown.length) });
    }
    const shown = msgs.slice(0, max);
    if (!peek) markRead(shown);
    return fmt(shown, { has_more: msgs.length > shown.length, unread_remaining: Math.max(0, msgs.length - shown.length) });
  }
  // default: incremental read from {gen, offset}, crossing immutable generations.
  const max = parseLimit(limit, 20);
  const scan = withLock(GLOBAL_LOCK, () => {
    const state = readState();
    let cursor = getCursor();
    if (cursor.gen > state.current_gen) cursor = { gen: state.current_gen, offset: 0, last_id: null };
    const out = [];
    let remaining = 0;
    let scanEnd = { ...cursor };
    let limitEnd = null;
    let lastId = cursor.last_id;
    for (let gen = cursor.gen; gen <= state.current_gen; gen++) {
      const file = genPath(LOG, gen, state.current_gen);
      if (!fs.existsSync(file)) {
        if (gen < state.current_gen) {
          scanEnd = { gen: gen + 1, offset: 0, last_id: lastId };
          continue;
        }
        fs.writeFileSync(file, "");
      }
      const size = fs.statSync(file).size;
      let off = gen === cursor.gen ? cursor.offset : 0;
      if (off > size) off = 0;
      let consumedTo = off;
      if (size > off) {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(size - off);
        fs.readSync(fd, buf, 0, size - off, off);
        fs.closeSync(fd);
        const text = buf.toString("utf8");
        const lastNl = text.lastIndexOf("\n");        // consume only up to last COMPLETE line
        if (lastNl < 0) {
          scanEnd = { gen, offset: off, last_id: lastId };
          break;
        }
        const complete = text.slice(0, lastNl + 1);
        let rel = 0;
        for (const rawLine of complete.split("\n")) {
          if (rawLine === "") continue;
          const lineEnd = off + rel + Buffer.byteLength(rawLine, "utf8") + 1;
          rel += Buffer.byteLength(rawLine, "utf8") + 1;
          let m; try { m = JSON.parse(rawLine.trim()); } catch { consumedTo = lineEnd; continue; }
          if (m.id) lastId = m.id;
          if (toMe(m)) {
            if (out.length < max) {
              out.push(m);
              limitEnd = { gen, offset: lineEnd, last_id: lastId };
            } else {
              remaining++;
            }
          }
          consumedTo = lineEnd;
        }
      }
      scanEnd = { gen, offset: consumedTo, last_id: lastId };
      if (gen < state.current_gen && consumedTo >= size) scanEnd = { gen: gen + 1, offset: 0, last_id: lastId };
      else break;
    }
    const hasMore = remaining > 0;
    return { out, next: hasMore && limitEnd ? limitEnd : scanEnd, has_more: hasMore, unread_remaining: remaining };
  }, true);
  if (!peek) setCursor(scan.next);
  if (!peek) markReadOnce(scan.out);
  return fmt(scan.out, { has_more: scan.has_more, unread_remaining: scan.unread_remaining });
}

function toolSync({ outbox, limit, peek } = {}) {
  const items = outbox === undefined || outbox === null ? [] : outbox;
  if (!Array.isArray(items)) throw new Error("`outbox` must be an array");
  const records = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each outbox item must be an object");
    return makeMessage(item);
  });
  for (const rec of records) append(rec);
  return toolInbox({ limit, peek });
}

function requireReviewTarget(target) {
  const t = String(target || "").trim();
  if (!t) throw new Error("`target` required");
  return t;
}

function requireVerdict(verdict) {
  const v = String(verdict || "").trim();
  if (v !== "approve" && v !== "request_changes") throw new Error("`verdict` must be approve or request_changes");
  return v;
}

function normalizeIssues(issues) {
  if (issues === undefined || issues === null) return [];
  if (!Array.isArray(issues)) throw new Error("`issues` must be an array");
  return issues.map((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) throw new Error("each issue must be an object");
    const severity = String(issue.severity || "").trim();
    if (!["low", "med", "high"].includes(severity)) throw new Error("issue severity must be low, med, or high");
    const note = String(issue.note || "").trim();
    if (!note) throw new Error("issue note required");
    const out = { severity, note };
    if (issue.file !== undefined && issue.file !== null && String(issue.file).trim()) out.file = String(issue.file).trim();
    return out;
  });
}

function reviewMsg(rec) {
  const issueText = rec.issues.length ? ` issues=${rec.issues.length}` : "";
  return rec.msg || `review ${rec.verdict} target=${rec.target}${issueText}`;
}

function toolReview({ target, verdict, issues, msg }) {
  const policy = checkPolicy("review");
  const rec = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: SELF,
    to: "all",
    thread: "reviews",
    reply_to: null,
    type: "review",
    reviewer: SELF,
    target: requireReviewTarget(target),
    verdict: requireVerdict(verdict),
    issues: normalizeIssues(issues),
    msg: msg || null,
  };
  rec.msg = reviewMsg(rec);
  append(rec);
  return withWarning(`review recorded (id ${rec.id}, target ${rec.target}, verdict ${rec.verdict})`, policy);
}

function fmtReview(r) {
  const issues = (Array.isArray(r.issues) ? r.issues : [])
    .map((i) => `${i.severity}${i.file ? ` ${i.file}` : ""}: ${i.note}`)
    .join("; ");
  return `[${shortTs(r.ts)}] ${r.reviewer || r.from} ${r.verdict} ${r.target}${issues ? ` | ${issues}` : ""}${r.msg ? ` | ${r.msg}` : ""}`;
}

function toolReviews({ target } = {}) {
  const want = target === undefined || target === null ? null : String(target).trim();
  const roles = readRoles();
  const list = readAll().filter((m) => (
    m.type === "review"
    && validateAction({ actor: m.reviewer || m.from, action: "review" }, roles).ok
    && (!want || m.target === want)
  ));
  return list.length ? list.map(fmtReview).join("\n") : "no reviews";
}

function requirePath(p) {
  const s = String(p || "").trim();
  if (!s) throw new Error("`path` required");
  return s;
}

function parseTtl(ttl) {
  const n = ttl === undefined || ttl === null ? 600 : Number(ttl);
  if (!Number.isInteger(n) || n <= 0) throw new Error("ttl_seconds must be a positive integer");
  return n;
}

function lockFileFor(p) {
  return path.join(LOCKS_DIR, `${crypto.createHash("sha1").update(p).digest("hex")}.json`);
}

function readFileLock(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function lockActive(lock, now = Date.now()) {
  return !!lock && Date.parse(lock.expires_at || "") > now;
}

function writeFileLock(file, lock) {
  atomicWrite(file, JSON.stringify(lock, null, 2) + "\n");
}

function toolFlock({ path: lockPath, ttl_seconds } = {}) {
  const p = requirePath(lockPath);
  const ttl = parseTtl(ttl_seconds);
  const file = lockFileFor(p);
  let lock;
  withLock(file, () => {
    const now = Date.now();
    const cur = readFileLock(file);
    if (lockActive(cur, now) && cur.agent !== SELF) {
      lock = cur;
      return;
    }
    lock = {
      path: p,
      agent: SELF,
      expires_at: new Date(now + ttl * 1000).toISOString(),
    };
    writeFileLock(file, lock);
  }, true);
  if (lock.agent !== SELF) return `held by ${lock.agent} until ${lock.expires_at}`;
  return `locked ${lock.path} by ${SELF} until ${lock.expires_at}`;
}

function toolFunlock({ path: lockPath } = {}) {
  const p = requirePath(lockPath);
  const file = lockFileFor(p);
  let msg = `no active lock for ${p}`;
  withLock(file, () => {
    const cur = readFileLock(file);
    if (!lockActive(cur)) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      msg = `no active lock for ${p}`;
      return;
    }
    if (cur.agent !== SELF) {
      msg = `held by ${cur.agent} until ${cur.expires_at}`;
      return;
    }
    try { fs.unlinkSync(file); } catch {}
    msg = `unlocked ${p}`;
  }, true);
  return msg;
}

function toolFlocks() {
  const locks = [];
  const now = Date.now();
  for (const ent of fs.readdirSync(LOCKS_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const file = path.join(LOCKS_DIR, ent.name);
    const lock = readFileLock(file);
    if (!lockActive(lock, now)) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    locks.push(lock);
  }
  locks.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return locks.length
    ? locks.map((l) => `${l.path} | ${l.agent} | expires ${l.expires_at}`).join("\n")
    : "no active file locks";
}

function toolPeers() {
  const seen = new Set();
  for (const m of readAll()) {
    seen.add(m.from);
    if (m.to === "all") continue;
    if (Array.isArray(m.to)) m.to.forEach((x) => seen.add(x));
    else seen.add(m.to);
  }
  seen.delete(SELF);
  const peers = [...seen].filter(Boolean);
  return peers.length ? `self=${SELF}; peers: ${peers.join(", ")}` : `self=${SELF}; no peers yet`;
}

function toolThreads() {
  const byThread = new Map();
  for (const m of readAll()) {
    if (!involvesSelf(m)) continue;
    const id = m.thread || "(no-thread)";
    const cur = byThread.get(id);
    if (!cur || (m.ts || "") > (cur.ts || "")) byThread.set(id, m);
  }
  const latest = [...byThread.entries()].sort((a, b) => (b[1].ts || "").localeCompare(a[1].ts || ""));
  if (!latest.length) return "no threads";
  return latest
    .map(([thread, m]) => `${thread}: [${m.ts}] ${m.from}->${toStr(m.to)}${m.reply_to ? ` > re ${m.reply_to}` : ""}: ${m.msg}`)
    .join("\n");
}

function toolReceipts({ thread, msg_id } = {}) {
  let messages = readAll().filter(involvesSelf);
  if (thread) messages = messages.filter((m) => m.thread === thread);
  if (msg_id) messages = messages.filter((m) => m.id === msg_id);
  const ids = new Set(messages.map((m) => m.id));
  const receipts = readReceipts().filter((r) => ids.has(r.msg_id));
  if (!receipts.length) return "no receipts";
  return receipts
    .map((r) => `[${r.read_at}] ${r.agent} read ${r.msg_id}`)
    .join("\n");
}

const TOOLS = [
  {
    name: "send",
    description: "Send a message to another agent. `to` may be one address ('executor'), an array (['executor','qa']) for a group, or 'all' to broadcast to everyone. Appends to the shared bridge log.",
    inputSchema: {
      type: "object",
      properties: {
        to: { description: "Recipient(s): an address string ('planner'), an array of addresses, or 'all' for broadcast.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        msg: { type: "string", description: "Message text." },
        thread: { type: "string", description: "Optional thread id to group a conversation." },
        reply_to: { type: "string", description: "Optional parent message id this message replies to." },
      },
      required: ["to", "msg"],
    },
  },
  {
    name: "inbox",
    description: "Read messages addressed to you. By default returns only unread (since last read) and advances your read cursor.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Return full history addressed to you, not just unread." },
        peek: { type: "boolean", description: "Do not advance the read cursor (preview only)." },
        since: { type: "string", description: "Message id to read after (overrides stored cursor)." },
        limit: { type: "integer", minimum: 0, description: "Max messages to return. Default unread limit is 20; 0 means unlimited. all/since are unlimited unless limit is provided." },
      },
    },
  },
  {
    name: "sync",
    description: "Append zero or more outbound messages, then read unread inbox in one round trip. Reuses inbox cursor/limit/peek behavior.",
    inputSchema: {
      type: "object",
      properties: {
        outbox: {
          type: "array",
          description: "Messages to append before reading. All items are validated before any append.",
          items: {
            type: "object",
            properties: {
              to: { description: "Recipient(s): address string, array, or 'all'.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              msg: { type: "string", description: "Message text." },
              thread: { type: "string", description: "Optional thread id." },
              reply_to: { type: "string", description: "Optional parent message id." },
            },
            required: ["to", "msg"],
          },
        },
        limit: { type: "integer", minimum: 0, description: "Forwarded to inbox. Default unread limit is 20; 0 means unlimited." },
        peek: { type: "boolean", description: "Forwarded to inbox; do not advance cursor." },
      },
    },
  },
  {
    name: "peers",
    description: "List the other agents seen on the bridge and your own address.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "threads",
    description: "List conversation threads involving this agent with the latest message in each thread.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "receipts",
    description: "List read receipts for messages visible to this agent, optionally filtered by thread or message id.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "Optional thread id to filter receipts." },
        msg_id: { type: "string", description: "Optional message id to filter receipts." },
      },
    },
  },
  {
    name: "review",
    description: "Append a structured review verdict record. This records review state only; it does not gate task state.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Record id, task_id, or thread string being reviewed." },
        verdict: { type: "string", enum: ["approve", "request_changes"], description: "Review verdict." },
        issues: {
          type: "array",
          description: "Optional issue list.",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["low", "med", "high"] },
              file: { type: "string" },
              note: { type: "string" },
            },
            required: ["severity", "note"],
          },
        },
        msg: { type: "string", description: "Optional readable summary." },
      },
      required: ["target", "verdict"],
    },
  },
  {
    name: "reviews",
    description: "List structured review verdict records, optionally filtered by target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional target filter." },
      },
    },
  },
  {
    name: "flock",
    description: "Acquire or renew an advisory repo file lock for a path. This is a workflow guard, not a security boundary.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo file path to lock." },
        ttl_seconds: { type: "integer", minimum: 1, description: "Lock TTL. Default 600 seconds." },
      },
      required: ["path"],
    },
  },
  {
    name: "funlock",
    description: "Release an advisory repo file lock if held by this agent.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo file path to unlock." },
      },
      required: ["path"],
    },
  },
  {
    name: "flocks",
    description: "List active advisory repo file locks and lazily discard expired locks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prune",
    description: "Delete rotated message/receipt generations that every live cursor has passed. Honors state.json max_backlog escape hatch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task",
    description: "Append a task record to the shared task-claim log.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id. Generated if omitted." },
        spec_hash: { type: "string", description: "Stable hash of the task specification." },
        requires_human: { type: "boolean", description: "If true, task is recorded as human-gated and cannot be claimed." },
        msg: { type: "string", description: "Optional human-readable task summary." },
      },
      required: ["spec_hash"],
    },
  },
  {
    name: "claim",
    description: "Claim a task epoch. First claim in log order wins.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        epoch: { type: "integer", minimum: 0 },
        nonce: { type: "string" },
        lease_seconds: { type: "integer", minimum: 1, description: "Lease duration, default 1800 seconds." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "renew",
    description: "Renew the lease for a task currently won by this agent.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        epoch: { type: "integer", minimum: 0 },
        lease_seconds: { type: "integer", minimum: 1, description: "Lease duration, default 1800 seconds." },
      },
      required: ["task_id", "epoch"],
    },
  },
  {
    name: "result",
    description: "Record a task result. Re-reads log first; only current winner for current epoch may write.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        epoch: { type: "integer", minimum: 0 },
        result_hash: { type: "string" },
        side_effect_keys: { type: "array", items: { type: "string" } },
      },
      required: ["task_id", "epoch", "result_hash"],
    },
  },
  {
    name: "requeue",
    description: "Requeue a non-done task after its lease expires.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        from_epoch: { type: "integer", minimum: 0 },
        to_epoch: { type: "integer", minimum: 0 },
        reason: { type: "string" },
      },
      required: ["task_id"],
    },
  },
];

function callTool(name, a = {}) {
  let text;
  if (name === "send") text = toolSend(a);
  else if (name === "inbox") text = toolInbox(a);
  else if (name === "sync") text = toolSync(a);
  else if (name === "peers") text = toolPeers();
  else if (name === "threads") text = toolThreads();
  else if (name === "receipts") text = toolReceipts(a);
  else if (name === "review") text = toolReview(a);
  else if (name === "reviews") text = toolReviews(a);
  else if (name === "flock") text = toolFlock(a);
  else if (name === "funlock") text = toolFunlock(a);
  else if (name === "flocks") text = toolFlocks();
  else if (name === "prune") text = toolPrune();
  else if (name === "task") text = toolTask(a);
  else if (name === "claim") text = toolClaim(a);
  else if (name === "renew") text = toolRenew(a);
  else if (name === "result") text = toolResult(a);
  else if (name === "requeue") text = toolRequeue(a);
  else throw new Error(`unknown tool: ${name}`);
  return { content: [{ type: "text", text }] };
}

// ---- JSON-RPC / MCP stdio loop ----
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function errReply(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-bridge", version: "0.4.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      return reply(id, callTool(params?.name, params?.arguments || {}));
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) errReply(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (e) { process.stderr.write(`handler error: ${e.stack}\n`); }
  }
});
process.stderr.write(`agent-bridge up: self=${SELF} store=${LOG}\n`);
