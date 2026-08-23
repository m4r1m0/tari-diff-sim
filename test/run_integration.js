'use strict';

/**
 * Integration smoke test: runs the full TIP-RFC-MT-0004 competition path
 * (runCompetitionSW) end-to-end over the real chain data, exactly as the
 * browser app would, and sanity-checks the output.
 *
 * Run:  node test/run_integration.js
 */

global.window = global.window || {};
if (global.window !== global) {
    global.window = global; // let window.X exports become bare globals
}

const path = require('path');
const js = p => require(path.join(__dirname, '..', 'js', p));

js('config.js');     // sets CONFIG
js('lwma.js');       // sets LwmaWindow, ALGO_CONFIG, WARMUP_BLOCKS, MAX_DIFFICULTY, ...
js('lwma_sw.js');    // sets LwmaWindowSW, PowBackoffTracker
js('prng.js');       // sets createRng
js('statistics.js'); // sets Statistics
js('data.js');       // sets BLOCKS_DATA
js('simulation.js'); // sets Simulation (via window)
const simulation = global.Simulation;

const blocks = global.BLOCKS_DATA.blocks;
const { ALGO_CONFIG, MAX_DIFFICULTY, WARMUP_BLOCKS } = global;
const { PENALTY_CAP, BURN_IN_BLOCKS } = global.CONFIG;

let failures = 0;
function check(cond, msg) {
    if (!cond) {
        failures++;
        console.log(`FAIL  ${msg}`);
    }
}

simulation.precomputeBlockData(blocks);
const scenario = { id: 'lwma45pnew', label: 'LWMA-45 + Penalty (New)', window: 45, penalty: true, penaltyMode: 'new', baseline: false };
const run = simulation.runCompetitionSW(blocks, scenario, 1);

// Length: every block after warm-up + burn-in produces one result.
check(run.length === blocks.length - WARMUP_BLOCKS - BURN_IN_BLOCKS,
    `results length ${run.length} != ${blocks.length - WARMUP_BLOCKS - BURN_IN_BLOCKS}`);

// First result starts right after the burn-in boundary.
check(run[0].height === blocks[WARMUP_BLOCKS + BURN_IN_BLOCKS].height,
    `first result height ${run[0].height} misaligned`);

const VALID_MULTIPLIERS = new Set([1, 2, 4, 8, 16, 32]);
let penalized = 0;
let maxConsecutive = 0;
for (let i = 0; i < run.length; i++) {
    const r = run[i];
    check(VALID_MULTIPLIERS.has(r.penaltyMultiplier),
        `height ${r.height}: invalid multiplier ${r.penaltyMultiplier}`);
    check(Number(r.simDifficulty) > 0 && BigInt(r.simDifficulty) <= MAX_DIFFICULTY,
        `height ${r.height}: difficulty out of range`);
    check(r.penaltyMultiplier > 1 ? r.consecutive >= 2 : true,
        `height ${r.height}: penalized at consecutive=${r.consecutive}`);
    if (i > 0) {
        check(Number(r.simTimestamp) > Number(run[i - 1].simTimestamp),
            `height ${r.height}: timestamps not increasing`);
    }
    if (r.penaltyMultiplier > 1) penalized++;
    if (r.consecutive > maxConsecutive) maxConsecutive = r.consecutive;
}

// The penalty must actually fire in a 1500-block simulated stretch.
check(penalized > 20, `penalty fired only ${penalized} times`);
console.log(`(info) penalized blocks: ${penalized}/${run.length}, max consecutive run: ${maxConsecutive}`);

// A second run with a different seed must differ (stochasticity intact).
const run2 = simulation.runCompetitionSW(blocks, scenario, 2);
check(JSON.stringify(run.map(r => r.algo)) !== JSON.stringify(run2.map(r => r.algo)),
    'runs with different seeds are identical');

// Baseline engine regression on the same data (unchanged Original path).
const actual = simulation.getActualResults(blocks);
check(actual.length === blocks.length - WARMUP_BLOCKS,
    `baseline results length ${actual.length}`);

console.log(failures === 0 ? '\nintegration OK' : `\n${failures} integration checks failed`);
process.exit(failures > 0 ? 1 : 0);
