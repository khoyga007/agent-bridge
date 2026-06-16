const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-flock');
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
  console.log("Setting up store for flock tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);

  const a = createClient('agent_a');
  const b = createClient('agent_b');

  try {
    await a.call('tools/call', { name: 'flock', arguments: { path: '/some/file.txt', ttl_seconds: 2 }});
  } catch(e) {
    if (e.message.includes("unknown tool")) {
      console.log("flock tool not implemented yet. Skipping test.");
      a.kill();
      b.kill();
      return;
    }
    throw e;
  }

  // Contention
  const res2 = await b.call('tools/call', { name: 'flock', arguments: { path: '/some/file.txt' }});
  assert(res2.content[0].text.includes('held by'), "B should be blocked by A's lock");

  // Expiration
  console.log("Waiting for lock to expire...");
  await new Promise(r => setTimeout(r, 2100)); 
  const res3 = await b.call('tools/call', { name: 'flock', arguments: { path: '/some/file.txt' }});
  assert(!res3.content[0].text.includes('held by'), "B should acquire lock after expiration");

  // Unlock
  await b.call('tools/call', { name: 'funlock', arguments: { path: '/some/file.txt' }});
  
  const res5 = await a.call('tools/call', { name: 'flock', arguments: { path: '/some/file.txt' }});
  assert(!res5.content[0].text.includes('held by'), "A should acquire lock after B unlocks");

  a.kill();
  b.kill();
  console.log("ALL TESTS PASSED: test-flock");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
