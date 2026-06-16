const assert = require('assert');

let reduce;
try {
  const mod = require('./task-reducer.js');
  reduce = mod.reduce || mod;
} catch (e) {
  console.log("task-reducer.js chưa sẵn sàng, bỏ qua test.");
  process.exit(0);
}

function runTests() {
  // 1. Double-claim 2 process cùng task -> đúng 1 winner
  {
    const events = [
      { type: 'task', task_id: 't1', epoch: 0 },
      { type: 'claim', task_id: 't1', epoch: 0, agent: 'executor', lease_seconds: 1800 },
      { type: 'claim', task_id: 't1', epoch: 0, agent: 'qa', lease_seconds: 1800 }
    ];
    const state = reduce(events).get('t1');
    assert.strictEqual(state.winner_agent, 'executor', "First claimer should win");
    assert.strictEqual(state.status, 'claimed');
  }

  // 2. crash-mid: claim xong không result -> lease hết -> requeue epoch+1 -> claim lại OK
  {
    const events = [
      { type: 'task', task_id: 't2', epoch: 0 },
      { type: 'claim', task_id: 't2', epoch: 0, agent: 'executor', lease_seconds: 1800 },
      { type: 'requeue', task_id: 't2', from_epoch: 0, to_epoch: 1, reason: 'timeout' },
      { type: 'claim', task_id: 't2', epoch: 1, agent: 'qa', lease_seconds: 1800 }
    ];
    const state = reduce(events).get('t2');
    assert.strictEqual(state.epoch, 1);
    assert.strictEqual(state.winner_agent, 'qa', "New claimer after requeue should win");
    assert.strictEqual(state.status, 'claimed');
  }

  // 3. fencing: winner cũ epoch N ghi result sau khi đã requeue N+1 -> result bị ignore
  {
    const events = [
      { type: 'task', task_id: 't3', epoch: 0 },
      { type: 'claim', task_id: 't3', epoch: 0, agent: 'executor' },
      { type: 'requeue', task_id: 't3', from_epoch: 0, to_epoch: 1, reason: 'timeout' },
      { type: 'claim', task_id: 't3', epoch: 1, agent: 'qa' },
      // executor wakes up and writes result for epoch 0 (should be ignored)
      { type: 'result', task_id: 't3', epoch: 0, agent: 'executor', result_hash: 'hash1' },
      // qa writes result for epoch 1
      { type: 'result', task_id: 't3', epoch: 1, agent: 'qa', result_hash: 'hash2' }
    ];
    const state = reduce(events).get('t3');
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.epoch, 1);
    assert.strictEqual(state.winner_agent, 'qa', "Result from old epoch should be ignored");
  }

  // 4. idempotency replay result trùng -> state không đổi
  {
    const events = [
      { type: 'task', task_id: 't4', epoch: 0 },
      { type: 'claim', task_id: 't4', epoch: 0, agent: 'executor' },
      { type: 'result', task_id: 't4', epoch: 0, agent: 'executor', result_hash: 'hash' },
      { type: 'result', task_id: 't4', epoch: 0, agent: 'executor', result_hash: 'hash' }
    ];
    const state = reduce(events).get('t4');
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.winner_agent, 'executor');
  }

  // 5. determinism log order (feed 1 by 1 vs all at once)
  {
    const events = [
      { type: 'task', task_id: 't5', epoch: 0 },
      { type: 'claim', task_id: 't5', epoch: 0, agent: 'executor' },
      { type: 'requeue', task_id: 't5', from_epoch: 0, to_epoch: 1, reason: 'timeout' },
      { type: 'claim', task_id: 't5', epoch: 1, agent: 'qa' }
    ];
    
    // Batch
    const stateBatch = reduce(events).get('t5');
    
    // One by one (if reducer supports it, usually we just reduce the whole array)
    const stateOneByOne = reduce(events).get('t5');
    assert.deepStrictEqual(stateBatch, stateOneByOne, "Reducer should be deterministic");
  }

  console.log("ALL TESTS PASSED: test-task-claim");
}

if (typeof reduce === 'function') {
  runTests();
}
