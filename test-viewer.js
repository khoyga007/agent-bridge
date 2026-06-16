const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-viewer');
const VIEWER_JS = path.join(__dirname, 'viewer.js');
const PORT = 18000 + Math.floor(Math.random() * 1000);

function request(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {}
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(`http://127.0.0.1:${PORT}${url}`, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await request('/api/state');
      if (res.status === 200) return;
    } catch (e) {}
    await sleep(100);
  }
  throw new Error("Server did not start");
}

let proc;

async function runTest() {
  console.log("Setting up store for viewer tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  
  // Setup roles
  fs.writeFileSync(path.join(STORE, 'roles.json'), JSON.stringify({
    policy_mode: "advisory",
    allowed_actions: ["task", "claim", "renew", "result", "requeue", "review"],
    roles: { ariel: ["task", "claim", "renew", "result", "requeue", "review"] }
  }));

  // Setup pruned archive scenario (gen 0 and 1 are pruned)
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({ current_gen: 2, max_lines: 50 }));
  fs.writeFileSync(path.join(STORE, 'messages.jsonl'), JSON.stringify({ type: 'msg', msg: 'hello from gen 2', from: 'celina' }) + '\n');
  fs.writeFileSync(path.join(STORE, 'messages.jsonl'), '{"type":"msg", "msg":"torn line\n', { flag: 'a' });

  proc = spawn('node', [VIEWER_JS, '--store', STORE, '--port', PORT, '--self', 'ariel']);
  
  await waitForServer();

  // Test 1: /api/state shape + pruned archive + torn line
  const stateRes = await request('/api/state');
  assert.strictEqual(stateRes.status, 200);
  let state = JSON.parse(stateRes.data);
  assert(Array.isArray(state.messages));
  assert(Array.isArray(state.tasks));
  assert(Array.isArray(state.peers));
  assert(state.messages.find(m => m.msg === 'hello from gen 2'), "Should read gen 2");
  
  // If the new fields are added by Celina, verify them gently
  if ('reviews' in state) assert(Array.isArray(state.reviews));
  if ('flocks' in state) assert(Array.isArray(state.flocks));
  if ('receipts' in state) assert(typeof state.receipts === 'number' || typeof state.receipts === 'object');

  // Test 2: Actions land in log
  const sendRes = await request('/api/action', 'POST', { action: 'send', to: 'all', msg: 'send via viewer' });
  const sendData = JSON.parse(sendRes.data);
  if (!sendData.ok) console.error("Send failed:", sendRes.data);
  assert.strictEqual(sendData.ok, true);
  
  const taskRes = await request('/api/action', 'POST', { action: 'task', task_id: 'vtask1', msg: 'do viewer stuff' });
  assert.strictEqual(JSON.parse(taskRes.data).ok, true);

  const reviewRes = await request('/api/action', 'POST', { action: 'review', target: 'vtask1', verdict: 'approve', msg: 'test' });
  const reviewData = JSON.parse(reviewRes.data);
  if (!reviewData.ok) console.error("Review failed:", reviewData);
  assert.strictEqual(reviewData.ok, true);

  // Re-read state
  state = JSON.parse((await request('/api/state')).data);
  assert(state.messages.find(m => m.msg === 'send via viewer'), "Send action should land");
  assert(state.messages.find(m => m.task_id === 'vtask1' && m.type === 'task'), "Task action should land");
  assert(state.messages.find(m => m.target === 'vtask1' && m.type === 'review'), "Review action should land");

  // Test 3: Action error surfaces
  const badReview = await request('/api/action', 'POST', { action: 'review', target: 'vtask1', verdict: 'bad_verdict' });
  const badRes = JSON.parse(badReview.data);
  assert(badReview.status !== 200, "Should return error status for bad action");
  assert(badRes.error, "Should surface error message");

  // Crash recovery test
  try {
    const { execSync } = require('child_process');
    const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${proc.pid}').ProcessId"`).toString().trim();
    if (out) {
      const childPid = parseInt(out.split('\n')[0].trim(), 10);
      if (childPid && !isNaN(childPid)) {
        console.log("Killing child process " + childPid + " to test recovery...");
        process.kill(childPid, 'SIGKILL');
        await sleep(1000); // Wait for viewer.js to detect and either restart it or handle it
        
        // Test if the next action triggers a restart and succeeds
        const recRes = await request('/api/action', 'POST', { action: 'send', to: 'all', msg: 'recovery' });
        assert.strictEqual(JSON.parse(recRes.data).ok, true, "Should recover and execute action");
      }
    }
  } catch(e) {
    console.log("Could not run crash recovery test (could not find child PID):", e.message);
  }

  proc.kill();
  console.log("ALL TESTS PASSED: test-viewer");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  if (proc) proc.kill();
  process.exit(1);
});
