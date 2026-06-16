#!/usr/bin/env node
// agent-bridge viewer — local read dashboard + coordinator buttons.
// Zero dependencies. Reads the JSONL log directly for display, and forwards
// coordinator actions (task / requeue / review / send) to a real server.js
// subprocess over MCP JSON-RPC so all locking and log formatting is reused.
//
// Usage: node viewer.js [--store <dir>] [--self <name>] [--port <n>]
//   --store  bridge store dir (default: this directory)
//   --self   identity used for coordinator actions (default: planner)
//   --port   HTTP port (default: 8787)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const STORE_DIR = arg("--store", __dirname);
const SELF = (arg("--self", process.env.BRIDGE_DASHBOARD_SELF) || "planner").trim().toLowerCase();
const PORT = parseInt(arg("--port", process.env.PORT || "8787"), 10);
const SERVER_JS = path.join(__dirname, "server.js");
const LOG = path.join(STORE_DIR, "messages.jsonl");
const RECEIPTS = path.join(STORE_DIR, "receipts.jsonl");
const STATE = path.join(STORE_DIR, "state.json");
const ROLES = path.join(STORE_DIR, "roles.json");
const LOCKS_DIR = path.join(STORE_DIR, "locks");

const reducer = require("./task-reducer");
const reduceTasks = reducer.reduce || reducer;

// ---- read side (no locks; append-only log, tolerate a torn last line) ----
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { current_gen: 0 }; }
}
function ensureServerState() {
  const state = readState();
  const next = {
    current_gen: Number.isFinite(Number(state.current_gen)) ? Math.trunc(Number(state.current_gen)) : 0,
    rotated_at: state.rotated_at ?? null,
    max_lines: Number.isFinite(Number(state.max_lines)) && Number(state.max_lines) > 0 ? Math.trunc(Number(state.max_lines)) : 5000,
    max_bytes: Number.isFinite(Number(state.max_bytes)) && Number(state.max_bytes) > 0 ? Math.trunc(Number(state.max_bytes)) : 5242880,
    max_backlog: Number.isFinite(Number(state.max_backlog)) && Number(state.max_backlog) >= 0 ? Math.trunc(Number(state.max_backlog)) : 0,
  };
  try { fs.writeFileSync(STATE, JSON.stringify(next, null, 2) + "\n"); } catch {}
}
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip torn/partial line */ }
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
  const currentGen = Math.max(0, Math.trunc(readState().current_gen || 0));
  const out = [];
  for (let gen = 0; gen <= currentGen; gen++) {
    const file = genPath(active, gen, currentGen);
    if (gen !== currentGen && !fs.existsSync(file)) continue; // pruned archive
    out.push(...readJsonl(file));
  }
  return out;
}
function readAll() { return readGenerations(LOG); }
function readReceipts() { return readGenerations(RECEIPTS); }
function readRoles() {
  try { return JSON.parse(fs.readFileSync(ROLES, "utf8")); } catch { return null; }
}
function peers(records) {
  const set = new Set();
  for (const r of records) if (r.from) set.add(r.from);
  return [...set].sort();
}
function taskState(records) {
  const map = reduceTasks(records, readRoles());
  return [...map.entries()].map(([id, s]) => ({ task_id: id, ...s }));
}
function reviews(records) {
  return records
    .filter((r) => r.type === "review" || r.thread === "reviews")
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      reviewer: r.reviewer || r.from,
      target: r.target || null,
      verdict: r.verdict || null,
      issues: Array.isArray(r.issues) ? r.issues : [],
      msg: r.msg || "",
    }));
}
function readLocks() {
  const out = [];
  const now = Date.now();
  let ents = [];
  try { ents = fs.readdirSync(LOCKS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    let lock;
    try { lock = JSON.parse(fs.readFileSync(path.join(LOCKS_DIR, ent.name), "utf8")); } catch { continue; }
    if (Date.parse(lock.expires_at || "") > now) out.push(lock);
  }
  return out.sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")));
}

// ---- coordinator subprocess (one persistent server.js over JSON-RPC) ----
class BridgeChildError extends Error {}

let child = null;
let childReady = null;
let rpcId = 0;
const pending = new Map();
let rpcBuf = "";
let shuttingDown = false;
let lastChildError = "";

function startChild() {
  if (child) return childReady || Promise.resolve();
  ensureServerState();
  rpcBuf = "";
  child = spawn(process.execPath, [SERVER_JS, "--self", SELF, "--store", STORE_DIR], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rpcBuf += chunk;
    let nl;
    while ((nl = rpcBuf.indexOf("\n")) >= 0) {
      const line = rpcBuf.slice(0, nl).trim();
      rpcBuf = rpcBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.on("error", (e) => {
    lastChildError = e.message || String(e);
  });
  child.on("exit", (code, signal) => {
    const reason = `server exited (${code ?? signal ?? "unknown"})`;
    lastChildError = reason;
    for (const { reject } of pending.values()) reject(new BridgeChildError(reason));
    pending.clear();
    child = null;
    childReady = null;
    if (!shuttingDown) setTimeout(() => { try { startChild(); } catch {} }, 250);
  });
  childReady = rpcRaw("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "viewer", version: "1" } })
    .then((res) => {
      if (res.error) throw new BridgeChildError(res.error.message || "initialize failed");
      if (!child || !child.stdin.writable) throw new BridgeChildError(lastChildError || "server unavailable");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return true;
    })
    .catch((e) => {
      lastChildError = e.message || String(e);
      throw e instanceof BridgeChildError ? e : new BridgeChildError(lastChildError);
    });
  return childReady;
}

function rpcRaw(method, params) {
  if (!child || !child.stdin.writable) throw new BridgeChildError(lastChildError || "server unavailable");
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("rpc timeout")); }
    }, 10000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
      if (err && pending.has(id)) {
        pending.delete(id);
        reject(new BridgeChildError(err.message || "server write failed"));
      }
    });
  });
}

async function rpc(method, params) {
  await startChild();
  return rpcRaw(method, params);
}

async function callTool(name, toolArgs) {
  const res = await rpc("tools/call", { name, arguments: toolArgs || {} });
  if (res.error) throw new Error(res.error.message || "rpc error");
  const text = (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || "";
  if (res.result && res.result.isError) throw new Error(text || "tool error");
  return text;
}

// ---- HTTP ----
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(HTML);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const records = readAll();
      const receiptsCount = readReceipts().length;
      return json(res, 200, {
        self: SELF,
        messages: records,
        tasks: taskState(records),
        peers: peers(records),
        reviews: reviews(records),
        flocks: readLocks(),
        receipts_count: receiptsCount,
        receipts: receiptsCount,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readBody(req);
      const { action } = body;
      let text;
      try {
        if (action === "send") {
          text = await callTool("send", { to: body.to, msg: body.msg, thread: body.thread || undefined });
        } else if (action === "task") {
          text = await callTool("task", {
            task_id: body.task_id,
            msg: body.msg || undefined,
            spec_hash: body.spec_hash || sha256(`${body.task_id}\n${body.msg || ""}`),
          });
        } else if (action === "requeue") {
          text = await callTool("requeue", { task_id: body.task_id, reason: body.reason || undefined });
        } else if (action === "review") {
          text = await callTool("review", { target: body.target, verdict: body.verdict, msg: body.msg || undefined });
        } else if (action === "prune") {
          text = await callTool("prune", {});
        } else {
          return json(res, 400, { error: `unknown action: ${action}` });
        }
      } catch (e) {
        const msg = String(e.message || e);
        const code = e instanceof BridgeChildError || /server (exited|unavailable|write failed)|rpc timeout/i.test(msg) ? 503 : 500;
        return json(res, code, { error: msg, child: code === 503 ? "unavailable" : undefined });
      }
      return json(res, 200, { ok: true, text });
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

process.on("exit", () => {
  shuttingDown = true;
  try { if (child) child.kill(); } catch {}
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`agent-bridge viewer: http://127.0.0.1:${PORT}  (self=${SELF}, store=${STORE_DIR})\n`);
});

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--edge:#272b35;--fg:#e6e9ef;--mut:#8b93a7;--acc:#5b9dff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--edge);position:sticky;top:0;background:var(--bg);flex-wrap:wrap}
header b{color:var(--acc)}.sp{flex:1}
select,input,button,textarea{background:var(--panel);color:var(--fg);border:1px solid var(--edge);border-radius:6px;padding:6px 8px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--acc)}
main{display:grid;grid-template-columns:1fr 360px;gap:0}
@media(max-width:880px){main{grid-template-columns:1fr}}
#feed{padding:12px 16px;min-height:60vh}
aside{border-left:1px solid var(--edge);padding:12px 16px}
.m{padding:8px 10px;border:1px solid var(--edge);border-radius:8px;margin:8px 0;background:var(--panel)}
.m .h{color:var(--mut);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.m .from{color:var(--acc);font-weight:600}
.m .to{color:var(--mut)}.m .th{color:var(--warn)}
.m .b{margin-top:4px;white-space:pre-wrap;word-break:break-word}
.tag{font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--edge)}
.t-task{color:var(--acc)}.t-review{color:var(--warn)}.t-claim,.t-result,.t-renew,.t-requeue{color:var(--mut)}
h3{margin:18px 0 6px;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.task{padding:6px 8px;border:1px solid var(--edge);border-radius:6px;margin:6px 0;background:var(--panel);font-size:13px}
.st-open{color:var(--warn)}.st-claimed{color:var(--acc)}.st-done{color:var(--ok)}
.row{display:flex;gap:6px;margin:4px 0}.row>*{flex:1}
fieldset{border:1px solid var(--edge);border-radius:8px;margin:10px 0;padding:8px 10px}
legend{color:var(--mut);font-size:12px;padding:0 4px}
#toast{position:fixed;bottom:16px;right:16px;background:var(--panel);border:1px solid var(--acc);border-radius:8px;padding:10px 14px;max-width:50ch;display:none;white-space:pre-wrap}
small{color:var(--mut)}
</style></head><body>
<header>
  <b>agent-bridge</b> <span id="me" class="tag"></span>
  <span class="sp"></span>
  <label>thread <select id="fThread"><option value="">all</option></select></label>
  <label>from <select id="fFrom"><option value="">all</option></select></label>
  <label><input type="checkbox" id="auto" checked> auto</label>
  <button id="refresh">refresh</button>
</header>
<main>
  <section id="feed"></section>
  <aside>
    <h3>tasks</h3><div id="tasks"></div>
    <h3>coordinate</h3>
    <fieldset><legend>send task</legend>
      <div class="row"><input id="tkId" placeholder="task_id"></div>
      <div class="row"><input id="tkMsg" placeholder="spec / message"></div>
      <button onclick="act('task',{task_id:v('tkId'),msg:v('tkMsg')})">create task</button>
    </fieldset>
    <fieldset><legend>requeue task</legend>
      <div class="row"><input id="rqId" placeholder="task_id"><input id="rqReason" placeholder="reason"></div>
      <button onclick="act('requeue',{task_id:v('rqId'),reason:v('rqReason')})">requeue</button>
    </fieldset>
    <fieldset><legend>review</legend>
      <div class="row"><input id="rvTarget" placeholder="target (task_id / id)"></div>
      <div class="row"><input id="rvMsg" placeholder="note"></div>
      <div class="row">
        <button onclick="act('review',{target:v('rvTarget'),verdict:'approve',msg:v('rvMsg')})">approve</button>
        <button onclick="act('review',{target:v('rvTarget'),verdict:'request_changes',msg:v('rvMsg')})">request changes</button>
      </div>
    </fieldset>
    <fieldset><legend>maintenance</legend>
      <button onclick="act('prune',{})">prune</button>
    </fieldset>
    <fieldset><legend>send message</legend>
      <div class="row"><input id="snTo" placeholder="to (name / all)" value="all"><input id="snTh" placeholder="thread"></div>
      <div class="row"><textarea id="snMsg" placeholder="message" rows="2"></textarea></div>
      <button onclick="act('send',{to:v('snTo'),msg:v('snMsg'),thread:v('snTh')})">send</button>
    </fieldset>
    <small>actions act as <b id="selfName"></b></small>
  </aside>
</main>
<div id="toast"></div>
<script>
let DATA={messages:[],tasks:[],peers:[],self:""};
const $=s=>document.querySelector(s);
const v=id=>$('#'+id).value.trim();
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function toast(msg,bad){const t=$('#toast');t.textContent=msg;t.style.borderColor=bad?'var(--bad)':'var(--acc)';t.style.display='block';clearTimeout(t._t);t._t=setTimeout(()=>t.style.display='none',4000);}
function toStr(to){return Array.isArray(to)?to.join(','):to;}
function fillSelect(sel,vals){const cur=sel.value;sel.innerHTML='<option value="">all</option>'+vals.map(x=>'<option>'+esc(x)+'</option>').join('');sel.value=cur;}
function render(){
  $('#me').textContent='self: '+DATA.self;$('#selfName').textContent=DATA.self;
  const threads=[...new Set(DATA.messages.map(m=>m.thread).filter(Boolean))].sort();
  fillSelect($('#fThread'),threads);fillSelect($('#fFrom'),DATA.peers);
  const ft=$('#fThread').value,ff=$('#fFrom').value;
  const ms=DATA.messages.filter(m=>(!ft||m.thread===ft)&&(!ff||m.from===ff));
  $('#feed').innerHTML=ms.map(m=>{
    const type=m.type||'msg';
    return '<div class="m"><div class="h">'
      +'<span class="from">'+esc(m.from)+'</span>'
      +'<span class="to">→ '+esc(toStr(m.to))+'</span>'
      +(m.thread?'<span class="th">#'+esc(m.thread)+'</span>':'')
      +'<span class="tag t-'+esc(type)+'">'+esc(type)+'</span>'
      +'<span class="sp" style="flex:1"></span><span>'+esc((m.ts||'').replace('T',' ').replace(/\\..*/,''))+'</span>'
      +'</div><div class="b">'+esc(m.msg||'')+'</div></div>';
  }).reverse().join('')||'<small>no messages</small>';
  $('#tasks').innerHTML=DATA.tasks.map(t=>'<div class="task"><b>'+esc(t.task_id)+'</b> '
    +'<span class="st-'+esc(t.status)+'">'+esc(t.status)+'</span> '
    +'<small>epoch '+esc(t.epoch)+(t.winner_agent?' · '+esc(t.winner_agent):'')+'</small></div>').join('')||'<small>no tasks</small>';
}
async function load(){
  try{const r=await fetch('/api/state');DATA=await r.json();render();}catch(e){toast('load failed: '+e,true);}
}
async function act(action,args){
  try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...args})});
    const j=await r.json();
    if(j.error){toast(action+' error: '+j.error,true);}else{toast(action+': '+j.text);load();}
  }catch(e){toast(action+' failed: '+e,true);}
}
$('#refresh').onclick=load;$('#fThread').onchange=render;$('#fFrom').onchange=render;
setInterval(()=>{if($('#auto').checked)load();},3000);
load();
</script></body></html>`;
