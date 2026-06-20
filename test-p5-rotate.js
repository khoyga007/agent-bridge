const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STORE = path.join(__dirname, 'test-store-p5');
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
          cbs.get(msg.id)(msg);
          cbs.delete(msg.id);
        }
      } catch (e) {}
    }
  });
  
  return {
    proc: p,
    call: (method, params) => new Promise((resolve, reject) => {
      const id = reqId++;
      cbs.set(id, res => {
        if (res.error) {
          reject(new Error(res.error.message));
        } else if (res.result && res.result.isError) {
          reject(new Error(res.result.content[0].text));
        } else {
          resolve(res.result);
        }
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
    kill: () => p.kill()
  };
}

async function runTest() {
  console.log("Setting up store...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  
  // Create an initial state.json to force small rotation sizes
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0,
    rotated_at: null,
    max_lines: 50,
    max_bytes: 10240
  }) + '\n');
  
  // --- (5) Legacy Cursor Migration ---
  console.log("Testing (5) Legacy Cursor Migration...");
  // Create some dummy log so offset makes sense
  const dummyLog = [...Array(10)].map((_, i) => JSON.stringify({id: `msg-${i}`, ts: new Date().toISOString(), from: 'agent_a', to: 'agent_c', msg: 'test'})).join('\n') + '\n';
  fs.writeFileSync(path.join(STORE, 'messages.jsonl'), dummyLog);
  const offset = Math.floor(dummyLog.length / 2); // middle
  fs.writeFileSync(path.join(STORE, 'cursor.agent_c.txt'), `${offset}\n`);
  
  const cTest = createClient('agent_c');
  await cTest.call('tools/call', { name: 'inbox', arguments: {} }); // Trigger read & migrate
  cTest.kill();
  
  const cCursor = JSON.parse(fs.readFileSync(path.join(STORE, 'cursor.agent_c.json'), 'utf8'));
  assert.strictEqual(cCursor.gen, 0, "Migrated cursor gen should be 0");
  assert(cCursor.offset > offset, "Migrated cursor offset should have advanced");
  console.log(" Legacy migration pass.");

  // --- Flush policy: byte OR line count rotate triggers ---
  console.log("Testing flush policy OR triggers...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0, rotated_at: null, max_lines: 2, max_bytes: 1024 * 1024
  }) + '\n');
  const lineClient = createClient('agent_a');
  for (let i = 0; i < 3; i++) {
    await lineClient.call('tools/call', { name: 'send', arguments: { to: 'agent_b', msg: `line trigger ${i}` }});
  }
  lineClient.kill();
  let flushState = JSON.parse(fs.readFileSync(path.join(STORE, 'state.json'), 'utf8'));
  assert(flushState.current_gen >= 1, "max_lines should rotate even when max_bytes is not reached");

  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0, rotated_at: null, max_lines: 1000, max_bytes: 200
  }) + '\n');
  const byteClient = createClient('agent_a');
  await byteClient.call('tools/call', { name: 'send', arguments: { to: 'agent_b', msg: 'x'.repeat(500) }});
  await byteClient.call('tools/call', { name: 'send', arguments: { to: 'agent_b', msg: 'byte trigger' }});
  byteClient.kill();
  flushState = JSON.parse(fs.readFileSync(path.join(STORE, 'state.json'), 'utf8'));
  assert(flushState.current_gen >= 1, "max_bytes should rotate even when max_lines is not reached");
  console.log(" Flush policy OR trigger pass.");

  // --- Crash recovery: orphaned rotated gen before state bump ---
  console.log("Testing orphaned rotate recovery...");
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'messages.0.jsonl'), JSON.stringify({
    id: 'old-msg', ts: new Date().toISOString(), from: 'agent_a', to: 'agent_c', msg: 'old gen'
  }) + '\n');
  fs.writeFileSync(path.join(STORE, 'messages.jsonl'), JSON.stringify({
    id: 'active-msg', ts: new Date().toISOString(), from: 'agent_a', to: 'agent_c', msg: 'active gen'
  }) + '\n');
  fs.writeFileSync(path.join(STORE, 'receipts.jsonl'), JSON.stringify({
    id: 'old-receipt', msg_id: 'old-msg', agent: 'agent_c', read_at: new Date().toISOString()
  }) + '\n');
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0, rotated_at: null, max_lines: 1, max_bytes: 1024 * 1024, max_backlog: 0
  }) + '\n');
  const recoveryClient = createClient('agent_a');
  await recoveryClient.call('tools/call', { name: 'send', arguments: { to: 'agent_c', msg: 'after recovery' }});
  recoveryClient.kill();
  const recoveredState = JSON.parse(fs.readFileSync(path.join(STORE, 'state.json'), 'utf8'));
  assert(recoveredState.current_gen >= 1, "orphan recovery should bump current_gen before next rotate");
  assert(fs.existsSync(path.join(STORE, 'messages.0.jsonl')), "orphaned messages gen should remain readable");
  assert(fs.existsSync(path.join(STORE, 'receipts.0.jsonl')), "active receipts from half-rotate should be reconciled to gen 0");
  console.log(" Orphaned rotate recovery pass.");

  // Clean store for main test
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'state.json'), JSON.stringify({
    current_gen: 0, rotated_at: null, max_lines: 50, max_bytes: 10240
  }) + '\n');

  const a = createClient('agent_a');
  const b = createClient('agent_b');
  
  // --- (1) & (4) Concurrent Append & Volume for multiple rotations ---
  console.log("Testing (1) Concurrent append and (4) Multiple rotations...");
  const pA = (async () => {
    for (let i = 0; i < 200; i++) {
      await a.call('tools/call', { name: 'send', arguments: { to: 'agent_c', msg: `msg A ${i} - ${'x'.repeat(100)}` }});
    }
  })();
  const pB = (async () => {
    for (let i = 0; i < 200; i++) {
      await b.call('tools/call', { name: 'send', arguments: { to: 'agent_c', msg: `msg B ${i} - ${'y'.repeat(100)}` }});
    }
  })();
  
  // --- (3) Read during append/rotate ---
  console.log("Testing (3) Read during append/rotate (agent_c online)...");
  const cOnline = createClient('agent_c');
  let readCount = 0;
  const pC = (async () => {
    for (let i = 0; i < 50; i++) {
      const res = await cOnline.call('tools/call', { name: 'inbox', arguments: { limit: 10 } });
      const text = res.content[0].text;
      if (text && text.includes('msg')) {
        const lines = text.split('\n');
        readCount += lines.filter(l => l.includes('] agent_')).length;
      }
      await new Promise(r => setTimeout(r, 10)); // small sleep
    }
  })();
  const pMeta = (async () => {
    for (let i = 0; i < 50; i++) {
      await cOnline.call('tools/call', { name: 'peers', arguments: {} });
      await cOnline.call('tools/call', { name: 'threads', arguments: {} });
      await cOnline.call('tools/call', { name: 'receipts', arguments: {} });
      await cOnline.call('tools/call', { name: 'context', arguments: {} });
    }
  })();
  
  await Promise.all([pA, pB, pC, pMeta]);
  cOnline.kill();
  
  const state = JSON.parse(fs.readFileSync(path.join(STORE, 'state.json'), 'utf8'));
  assert(state.current_gen >= 3, `Expected >= 3 rotations, got ${state.current_gen}`);
  console.log(` Concurrent append, read, and multi-rotate pass. (gens=${state.current_gen})`);

  // --- (2) Offline agent reads unread without loss ---
  console.log("Testing (2) Offline agent reads unread after rotations...");
  const cOffline = createClient('agent_c');
  let offlineReadCount = 0;
  while (true) {
    const res = await cOffline.call('tools/call', { name: 'inbox', arguments: {} });
    const text = res.content[0].text;
    if (!text || text.includes('empty')) break;
    const msgLines = text.split('\n').filter(l => l.includes('] agent_'));
    offlineReadCount += msgLines.length;
    
    // Check default limit enforcement (max 20)
    assert(msgLines.length <= 20, `Default limit > 20 violated: got ${msgLines.length}`);
    if (!text.includes('has_more: true')) break;
  }
  cOffline.kill();
  
  const totalCRead = readCount + offlineReadCount;
  assert.strictEqual(totalCRead, 400, `Expected 400 total messages read, got ${totalCRead}`);
  console.log(" Offline read pass. No loss of unread.");

  // --- (6) Backlog 500 unread, inbox limit:20 ---
  console.log("Testing (6) Backlog 500 limit:20...");
  const d = createClient('agent_d');
  for (let i = 0; i < 500; i++) {
    await a.call('tools/call', { name: 'send', arguments: { to: 'agent_d', msg: `backlog ${i}` }});
  }
  
  let dReadCount = 0;
  let hasMore = true;
  let loops = 0;
  while (hasMore && loops < 50) {
    loops++;
    const res = await d.call('tools/call', { name: 'inbox', arguments: { limit: 20 } });
    const text = res.content[0].text;
    if (text.includes('empty')) { hasMore = false; break; }
    
    const msgLines = text.split('\n').filter(l => l.includes('] agent_'));
    dReadCount += msgLines.length;
    
    assert(msgLines.length <= 20, `Returned ${msgLines.length} msgs, expected <= 20`);
    if (text.includes('has_more: true')) {
      assert.strictEqual(msgLines.length, 20, "Should return exactly 20 when has_more is true");
    } else {
      hasMore = false;
    }
  }
  assert.strictEqual(dReadCount, 500, `Expected exactly 500 read in backlog test, got ${dReadCount}`);
  assert.strictEqual(loops, 25, `Expected exactly 25 loops for 500 msgs with limit 20, got ${loops}`);
  console.log(" Backlog limit 20 pass.");
  
  a.kill();
  b.kill();
  d.kill();
  
  console.log("ALL TESTS PASSED.");
}

runTest().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
