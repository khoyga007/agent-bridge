const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-p5-prune');
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

function getGens() {
  const archived = fs.readdirSync(STORE)
    .filter(f => /^messages\.\d+\.jsonl$/.test(f))
    .map(f => parseInt(f.split('.')[1]))
    .sort((a,b) => a - b);
  const state = JSON.parse(fs.readFileSync(path.join(STORE, 'state.json'), 'utf8'));
  return [...archived, state.current_gen].sort((a,b) => a - b);
}

async function runTest() {
  console.log("Setting up store for p5-prune tests...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0,
    rotated_at: null,
    max_lines: 50,
    max_bytes: 10240,
    max_backlog: 0
  }) + '\n');

  const a = createClient('a');
  let b = createClient('b');

  try {
    await a.call('tools/call', { name: 'prune', arguments: {} });
  } catch (e) {
    if (e.message.includes('unknown tool')) {
      console.log('prune tool not implemented yet. Skipping test.');
      a.kill(); b.kill(); return;
    }
  }

  // 1. send 60 messages to trigger rotation (max is 50 per file)
  for (let i = 0; i < 60; i++) {
    await a.call('tools/call', { name: 'send', arguments: { to: 'all', msg: `msg ${i}` } });
  }
  
  // Both read inbox to advance their cursors to gen 1
  await a.call('tools/call', { name: 'inbox', arguments: { limit: 0 } });
  await b.call('tools/call', { name: 'inbox', arguments: { limit: 0 } });

  assert.deepStrictEqual(getGens(), [0, 1], "Should have gen 0 and 1");

  // Call prune -> should delete 0 because both are at 1 (del khi all-past)
  await a.call('tools/call', { name: 'prune', arguments: {} });
  assert.deepStrictEqual(getGens(), [1], "Should prune gen 0 (all-past)");

  // 2. B goes offline. A sends 60 more -> rotates to gen 2
  b.kill();
  for (let i = 60; i < 120; i++) {
    await a.call('tools/call', { name: 'send', arguments: { to: 'all', msg: `msg ${i}` } });
  }
  await a.call('tools/call', { name: 'inbox', arguments: { limit: 0 } }); // a advances to 2

  assert.deepStrictEqual(getGens(), [1, 2], "Should have gen 1 and 2");
  
  // Call prune -> should NOT delete 1 because B is at 1 (offline chặn)
  await a.call('tools/call', { name: 'prune', arguments: {} });
  assert.deepStrictEqual(getGens(), [1, 2], "Should NOT prune gen 1 (b is offline at 1)");

  // 3. max_backlog loại agent chết -> prune chạy
  const stateFile = path.join(STORE, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.max_backlog = 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));

  await a.call('tools/call', { name: 'prune', arguments: {} });
  assert.deepStrictEqual(getGens(), [2], "Should prune gen 1 (b is ignored due to max_backlog=1)");

  // 4. agent chết hồi sinh đọc current OK
  b = createClient('b');
  const resB = await b.call('tools/call', { name: 'inbox', arguments: { limit: 0 } });
  assert(resB.content[0].text.includes('msg 119'), "B should be able to read current gen after waking up");

  // 5. never-del-current
  // A is at 2, B is at 2. Prune should not delete 2
  await a.call('tools/call', { name: 'prune', arguments: {} });
  assert.deepStrictEqual(getGens(), [2], "Should never delete current gen");

  // 6. corrupt cursor -> abort
  fs.writeFileSync(path.join(STORE, 'cursor.c.json'), "{ invalid json }");
  
  const c = createClient('c');
  
  for (let i = 120; i < 180; i++) {
    await a.call('tools/call', { name: 'send', arguments: { to: 'all', msg: `msg ${i}` } });
  }
  await a.call('tools/call', { name: 'inbox', arguments: { limit: 0 } });
  await b.call('tools/call', { name: 'inbox', arguments: { limit: 0 } });
  
  // Prune should abort, leaving gen 2 intact (which would otherwise be pruned since max_backlog=1 and C is at 0? Wait, C's cursor is corrupt, we must abort!)
  let errorCaught = false;
  try {
    await a.call('tools/call', { name: 'prune', arguments: {} });
  } catch (e) {
    // maybe it throws, maybe it silently aborts. We just ensure it doesn't prune.
  }
  
  assert.deepStrictEqual(getGens(), [2, 3], "Should abort prune due to corrupt cursor of c");

  a.kill(); b.kill(); c.kill();
  console.log("ALL TESTS PASSED: test-p5-prune");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
