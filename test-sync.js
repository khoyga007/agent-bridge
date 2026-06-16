const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-sync');
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
  console.log("Setting up store for sync tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);

  const a = createClient('agent_a');
  const b = createClient('agent_b');

  // Test 1: Bad outbox should reject without appending valid ones
  let rejected = false;
  try {
    await a.call('tools/call', {
      name: 'sync',
      arguments: {
        outbox: [
          { to: 'agent_b', msg: 'valid message 1' },
          { to: null, msg: 'invalid message' }, // bad to
          { to: 'agent_b', msg: 'valid message 2' }
        ]
      }
    });
  } catch (e) {
    rejected = true;
  }
  assert(rejected, "Sync should reject bad outbox");

  // Verify nothing was appended
  const resB = await b.call('tools/call', { name: 'sync', arguments: {} });
  assert(resB.content[0].text.includes('empty'), "Nothing should be appended if outbox validation fails");

  // Test 2: Valid outbox append + read
  const resA = await a.call('tools/call', {
    name: 'sync',
    arguments: {
      outbox: [
        { to: 'agent_b', msg: 'Hello from A' },
        { to: 'agent_b', msg: 'Hello again' }
      ]
    }
  });
  // a's inbox should be empty
  assert(resA.content[0].text.includes('empty'), "Agent A inbox should be empty");

  // Test 3: b reading via sync
  const resB2 = await b.call('tools/call', { name: 'sync', arguments: {} });
  assert(resB2.content[0].text.includes('Hello from A'));
  assert(resB2.content[0].text.includes('Hello again'));

  a.kill();
  b.kill();
  console.log("ALL TESTS PASSED: test-sync");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
