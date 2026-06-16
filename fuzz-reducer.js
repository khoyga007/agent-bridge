const { reduce, compareHlc, canonicalString } = require("./reducer.js");
const assert = require("assert");

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomHlc() {
  return {
    ts: randomInt(1, 100),
    count: randomInt(0, 10),
    node: `node-${randomInt(1, 3)}`
  };
}

function generateRandomEvent(idCounter) {
  return {
    key: `key-${randomInt(1, 5)}`,
    value: `val-${randomInt(1, 100)}`,
    hlc: randomHlc(),
    rid: `rid-${idCounter}`,
  };
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateFuzzCase() {
  const events = [];
  const numEvents = randomInt(0, 50);
  let idCounter = 1;
  
  for (let i = 0; i < numEvents; i++) {
    const e = generateRandomEvent(idCounter++);
    events.push(e);
    
    // (b) Idempotent rid: Inject duplicate rid sometimes
    if (Math.random() < 0.2) {
      events.push(JSON.parse(JSON.stringify(e))); // Exact duplicate
    }
    
    // (c) edge canonicalString: Same rid, different content
    if (Math.random() < 0.1) {
      const edgeE = JSON.parse(JSON.stringify(e));
      edgeE.value = `val-diff-${randomInt(100, 200)}`;
      events.push(edgeE);
    }
  }
  
  const watermark = randomHlc();
  return { events: shuffle(events), watermark };
}

function stringifyMap(m) {
  const entries = [...m.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

function stringifyArr(arr) {
  return JSON.stringify(arr); // dedupeByRid output is already sorted
}

function runFuzz(iterations) {
  for (let i = 0; i < iterations; i++) {
    const { events, watermark } = generateFuzzCase();
    
    // Base run
    const result1 = reduce(events, watermark);
    const c1 = stringifyMap(result1.committed);
    const d1 = stringifyArr(result1.deferred);
    
    // (a) Determinism - shuffle input 3 times
    for (let j = 0; j < 3; j++) {
      const shuffled = shuffle(events);
      const result2 = reduce(shuffled, watermark);
      const c2 = stringifyMap(result2.committed);
      const d2 = stringifyArr(result2.deferred);
      
      if (c1 !== c2 || d1 !== d2) {
        console.error("Determinism failure!");
        console.error("Watermark:", watermark);
        console.error("Input:", events);
        console.error("Shuffled:", shuffled);
        console.error("C1:", c1);
        console.error("C2:", c2);
        console.error("D1:", d1);
        console.error("D2:", d2);
        process.exit(1);
      }
    }
    
    // (d) wm boundary check
    for (const [key, event] of result1.committed.entries()) {
      assert(compareHlc(event.hlc, watermark) <= 0, `Committed event > watermark: ${JSON.stringify(event.hlc)} > ${JSON.stringify(watermark)}`);
    }
    
    for (const event of result1.deferred) {
      assert(compareHlc(event.hlc, watermark) > 0, `Deferred event <= watermark: ${JSON.stringify(event.hlc)} <= ${JSON.stringify(watermark)}`);
    }
  }
  console.log(`Fuzz test passed: ${iterations} iterations.`);
}

runFuzz(10000);
