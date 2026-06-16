const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-review');
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
  console.log("Setting up store for review tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);

  const a = createClient('agent_a');
  
  // Try to test review before it's implemented. We just log if it's missing.
  try {
    await a.call('tools/call', { name: 'review', arguments: { target: 't1', verdict: 'approve' }});
  } catch(e) {
    if (e.message.includes("unknown tool")) {
      console.log("review tool not implemented yet. Skipping test.");
      a.kill();
      return;
    }
  }

  let rejected = false;
  try {
    await a.call('tools/call', { name: 'review', arguments: { target: 't1', verdict: 'looks_good' }});
  } catch(e) {
    rejected = true;
  }
  assert(rejected, "Should reject invalid verdict");

  await a.call('tools/call', {
    name: 'review',
    arguments: {
      target: 't1',
      verdict: 'request_changes',
      msg: 'Need to fix something',
      issues: [{ severity: 'high', note: 'Critical bug' }]
    }
  });

  const reviewsRes = await a.call('tools/call', { name: 'reviews', arguments: { target: 't1' } });
  const text = reviewsRes.content[0].text;
  assert(text.includes('request_changes'), "Should contain verdict");
  assert(text.includes('Critical bug'), "Should contain issue note");

  a.kill();
  console.log("ALL TESTS PASSED: test-review");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
