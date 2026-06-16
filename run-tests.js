const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'test-reducer.js',
  'test-p5-rotate.js',
  'test-p5-prune.js',
  'test-task-claim.js',
  'test-sync.js',
  'test-review.js',
  'test-flock.js',
  'test-policy.js'
];

let allPassed = true;

console.log("=== RUNNING AGENT-BRIDGE TEST SUITE ===");

for (const test of tests) {
  const file = path.join(__dirname, test);
  console.log(`\n--- Running ${test} ---`);
  
  const result = spawnSync('node', [file], { stdio: 'inherit' });
  
  if (result.status === 0) {
    console.log(`[PASS] ${test}`);
  } else {
    console.error(`[FAIL] ${test} (exit code: ${result.status})`);
    allPassed = false;
  }
}

console.log("\n=== TEST SUITE COMPLETE ===");
if (allPassed) {
  console.log("ALL TESTS PASSED.");
  process.exit(0);
} else {
  console.error("SOME TESTS FAILED.");
  process.exit(1);
}
