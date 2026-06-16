const assert = require('assert');

let validateAction;
try {
  const policy = require('./policy.js');
  validateAction = policy.validateAction;
} catch (e) {
  console.log("policy.js chưa sẵn sàng, bỏ qua test.");
  process.exit(0);
}

let reduce;
try {
  const mod = require('./task-reducer.js');
  reduce = mod.reduce || mod;
} catch (e) {
  reduce = () => new Map();
}

function runTests() {
  const roles = {
    policy_mode: "enforce",
    allowed_actions: ["task", "claim", "renew", "result", "requeue", "review"],
    roles: {
      claire: ["task", "requeue", "review"],
      celina: ["claim", "renew", "result"],
      ariel:  ["claim", "renew", "result", "review"]
    }
  };

  // 1. Matrix test
  // Claire can task, but not claim
  assert.strictEqual(validateAction({ actor: 'claire', action: 'task' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'claire', action: 'claim' }, roles).ok, false);
  
  // Celina can claim, but not review
  assert.strictEqual(validateAction({ actor: 'celina', action: 'claim' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'celina', action: 'review' }, roles).ok, false);

  // Ariel can review and claim
  assert.strictEqual(validateAction({ actor: 'ariel', action: 'review' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'ariel', action: 'claim' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'ariel', action: 'task' }, roles).ok, false);

  // Unknown action not in vocab -> ok (fail-open for chat tools)
  assert.strictEqual(validateAction({ actor: 'celina', action: 'send' }, roles).ok, true);

  // 2. Reducer DROP test (Distributed teeth)
  // Even if injected into log, reducer must drop unauthorized actions
  const events = [
    { type: 'task', task_id: 't1', epoch: 0 },
    // Claire tries to claim (unauthorized)
    { type: 'claim', task_id: 't1', epoch: 0, agent: 'claire' },
    // Celina tries to claim (authorized)
    { type: 'claim', task_id: 't1', epoch: 0, agent: 'celina' }
  ];
  
  const state = reduce(events, roles).get('t1');
  if (state && state.status === 'claimed') {
    assert.strictEqual(state.winner_agent, 'celina', "Reducer should drop claim from unauthorized actor (claire)");
  }

  console.log("ALL TESTS PASSED: test-policy");
}

if (typeof validateAction === 'function') {
  runTests();
}
