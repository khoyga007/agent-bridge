const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-task-verify');
const SERVER_JS = path.join(__dirname, 'server.js');

function createClient(name) {
  const p = spawn('node', [SERVER_JS, '--self', name, '--store', STORE]);
  let reqId = 1;
  const cbs = new Map();
  let buffer = '';
  p.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && cbs.has(msg.id)) {
          const cb = cbs.get(msg.id);
          cbs.delete(msg.id);
          cb(msg);
        }
      } catch (e) {}
    }
  });
  return {
    proc: p,
    call: (method, params) => new Promise((resolve, reject) => {
      const id = reqId++;
      cbs.set(id, res => {
        if (res.error) reject(new Error(res.error.message));
        else if (res.result && res.result.isError) reject(new Error(res.result.content[0].text));
        else resolve(res.result);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    kill: () => p.kill()
  };
}

async function runTest() {
  console.log("Setting up store for task-verify tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);

  const a = createClient('a');

  // Test toolTask returns the state string verifying it landed
  const res1 = await a.call('tools/call', { name: 'task', arguments: { task_id: 't1', spec_hash: 'abc' } });
  const text1 = res1.content[0].text;
  assert(text1.includes('task created'), "Should say task created");
  assert(text1.includes('status=open'), "Should include re-read state string with status=open");

  const res2 = await a.call('tools/call', { name: 'task', arguments: { task_id: 't2', spec_hash: 'def', requires_human: true } });
  const text2 = res2.content[0].text;
  assert(text2.includes('status=human'), "Should include re-read state string with status=human");

  a.kill();
  console.log("ALL TESTS PASSED: test-task-verify");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
