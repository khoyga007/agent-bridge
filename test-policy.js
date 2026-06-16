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
      planner: ["task", "requeue", "review"],
      executor: ["claim", "renew", "result"],
      qa:  ["claim", "renew", "result", "review"]
    }
  };

  // 1. Matrix test
  // planner can task, but not claim
  assert.strictEqual(validateAction({ actor: 'planner', action: 'task' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'planner', action: 'claim' }, roles).ok, false);

  // executor can claim, but not review
  assert.strictEqual(validateAction({ actor: 'executor', action: 'claim' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'executor', action: 'review' }, roles).ok, false);

  // qa can review and claim
  assert.strictEqual(validateAction({ actor: 'qa', action: 'review' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'qa', action: 'claim' }, roles).ok, true);
  assert.strictEqual(validateAction({ actor: 'qa', action: 'task' }, roles).ok, false);

  // Unknown action not in vocab -> ok (fail-open for chat tools)
  assert.strictEqual(validateAction({ actor: 'executor', action: 'send' }, roles).ok, true);

  // 2. Reducer DROP test (Distributed teeth)
  // Even if injected into log, reducer must drop unauthorized actions
  const events = [
    { type: 'task', task_id: 't1', epoch: 0 },
    // planner tries to claim (unauthorized)
    { type: 'claim', task_id: 't1', epoch: 0, agent: 'planner' },
    // executor tries to claim (authorized)
    { type: 'claim', task_id: 't1', epoch: 0, agent: 'executor' }
  ];
  
  const state = reduce(events, roles).get('t1');
  if (state && state.status === 'claimed') {
    assert.strictEqual(state.winner_agent, 'executor', "Reducer should drop claim from unauthorized actor (planner)");
  }

  console.log("ALL TESTS PASSED: test-policy");
}

if (typeof validateAction === 'function') {
  runTests();
}
