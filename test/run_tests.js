'use strict';

/**
 * Node test harness: ports the Rust unit tests of tari PR #7960
 * (branch sw_tip-004) to the JS port in js/lwma_sw.js, plus regression checks
 * against the pre-TIP-0004 engine (js/lwma.js) and real chain data (js/data.js).
 *
 * Run:  node test/run_tests.js
 */

global.window = global.window || {};

const path = require('path');
const js = p => require(path.join(__dirname, '..', 'js', p));

const { LwmaWindow, ALGO_CONFIG, MAX_DIFFICULTY } = js('lwma.js');
const {
    LwmaWindowSW,
    PowBackoffTracker,
    SW_M_MAX,
    SW_MAX_U64,
} = js('lwma_sw.js');

// ---------------------------------------------------------------------------
// Tiny harness

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.log(`FAIL  ${name}`);
        console.log(`      ${e.message.split('\n')[0]}`);
    }
}

function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'assertEq'}: expected ${expected}, got ${actual}`);
    }
}

function assertThrows(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(`${msg || 'assertThrows'}: expected an exception`);
}

const SHA3X = 1, RXM = 0, RXT = 2, C29 = 3; // PowAlgorithm ids as used by the sim
const CAP = SW_M_MAX;

// Convenience wrappers so the ported tests read like the Rust ones.
LwmaWindowSW.prototype.add_back = function (ts, target, adjusted) {
    this.add(ts, target, adjusted);
};
LwmaWindowSW.prototype.raw_difficulty = function () {
    // With min=1 and max=u64::MAX the calculate() clamps are no-ops relative to
    // Rust's raw_difficulty(), which clamps nothing and floors at Difficulty::min().
    return this.calculate();
};

// ===========================================================================
// pow_backoff.rs tests -> PowBackoffTracker

test('tracker: empty tracker has no penalty', () => {
    const tracker = new PowBackoffTracker();
    for (const algo of [SHA3X, RXM, RXT, C29]) {
        assertEq(tracker.modifierFor(algo, CAP), 1n, `empty ${algo}`);
    }
});

test('tracker: run doubles the modifier up to the cap', () => {
    const t = new PowBackoffTracker();
    assertEq(t.modifierFor(SHA3X, CAP), 1n); // first Sha3x block pays nothing
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 2n, 'r=2');
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 4n, 'r=3');
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 8n, 'r=4');
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 16n, 'r=5');
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 32n, 'r=6 (capped)');
    for (let i = 0; i < 1000; i++) {
        t.push(SHA3X);
        assertEq(t.modifierFor(SHA3X, CAP), 32n, `saturated at push ${i}`);
    }
});

test('tracker: a different algo resets the run', () => {
    const t = new PowBackoffTracker();
    for (let i = 0; i < 10; i++) t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 32n);
    assertEq(t.modifierFor(RXM, CAP), 1n, 'different algo pays nothing');
    t.push(RXM);
    assertEq(t.modifierFor(SHA3X, CAP), 1n, 'Sha3x run reset');
    assertEq(t.modifierFor(RXM, CAP), 2n, 'RxM run starts');
});

test('tracker: randomx variants are independent scopes', () => {
    const t = new PowBackoffTracker();
    t.push(RXM);
    t.push(RXM);
    assertEq(t.modifierFor(RXM, CAP), 4n);
    assertEq(t.modifierFor(RXT, CAP), 1n, 'RxT separate scope');
    t.push(RXT);
    assertEq(t.modifierFor(RXM, CAP), 1n);
    assertEq(t.modifierFor(RXT, CAP), 2n);
});

test('tracker: cap of one disables the backoff', () => {
    const t = new PowBackoffTracker();
    for (let i = 0; i < 10; i++) {
        t.push(SHA3X);
        assertEq(t.modifierFor(SHA3X, 1n), 1n);
        assertEq(t.modifierFor(SHA3X, 0n), 1n);
    }
});

test('tracker: a lower cap clamps the modifier', () => {
    const t = new PowBackoffTracker();
    for (let i = 0; i < 10; i++) t.push(C29);
    assertEq(t.modifierFor(C29, 4n), 4n);
    assertEq(t.modifierFor(C29, 8n), 8n);
});

test('tracker: a short run is not capped by a large cap', () => {
    const t = new PowBackoffTracker();
    t.push(C29);
    assertEq(t.modifierFor(C29, 32n), 2n);
    assertEq(t.modifierFor(C29, 2n), 2n);
});

test('tracker: run length saturates at the lookback', () => {
    const t = new PowBackoffTracker();
    for (let i = 0; i < 100; i++) t.push(SHA3X);
    assertEq(t.runLength(), 5);
    assertEq(t.lastAlgo(), SHA3X);
});

test('tracker: a run longer than the lookback is capped exactly', () => {
    // Port of target_difficulties.rs::a_run_longer_than_the_lookback_is_capped
    const t = new PowBackoffTracker();
    t.push(RXM);
    for (let i = 0; i < 5 - 1; i++) t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 16n, 'run of lookback => one short of cap');
    t.push(SHA3X);
    assertEq(t.modifierFor(SHA3X, CAP), 32n);
    for (let i = 0; i < 50; i++) {
        t.push(SHA3X);
        assertEq(t.modifierFor(SHA3X, CAP), 32n);
    }
});

// ===========================================================================
// lwma_diff.rs tests -> LwmaWindowSW

test('lwma: calculate vector from Rust lwma_calculate test', () => {
    // (timestamp, target difficulty, expected next target difficulty)
    const EXPECTED = [
        [60, 100, null],
        [120, 100, 100n],
        [180, 100, 100n],
        [240, 100, 100n],
        [300, 100, 100n],
        [350, 105, 106n],
        [380, 128, 134n],
        [445, 123, 128n],
        [515, 116, 119n],
        [615, 94, 93n],
        [975, 39, 35n],
        [976, 46, 38n],
        [977, 55, 46n],
        [978, 75, 65n],
        [979, 148, 173n],
    ];
    const dif = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
    for (const [timestamp, target, expected] of EXPECTED) {
        dif.add(timestamp, target, target); // pre-fork: adjusted == target
        const got = dif.calculate();
        assertEq(got === null ? null : got, expected, `at timestamp ${timestamp}`);
    }
});

// Verbatim copy of the pre-TIP-0004 LWMA calculation, used to prove that the
// scaled implementation is bit-identical when every modifier is 1.
function legacyCalculate(data, targetTime, maxBlockTime) {
    if (data.length <= 1) return null;
    const n = BigInt(data.length - 1);
    let weightedTimes = 0n;
    let difficultySum = 0n;
    for (let i = 1; i < data.length; i++) difficultySum += data[i][1];
    const aveDifficulty = difficultySum / n;
    let prevTimestamp = data[0][0];
    for (let i = 1; i < data.length; i++) {
        let thisTimestamp = data[i][0];
        if (thisTimestamp <= prevTimestamp) thisTimestamp = prevTimestamp + 1n;
        let solveTime = thisTimestamp - prevTimestamp;
        if (solveTime > maxBlockTime) solveTime = maxBlockTime;
        prevTimestamp = thisTimestamp;
        weightedTimes += solveTime * BigInt(i);
    }
    const k = n * (n + 1n) * BigInt(targetTime) / 2n;
    let target = aveDifficulty * k / weightedTimes;
    if (target > SW_MAX_U64) target = SW_MAX_U64;
    if (target < 1n) return null;
    return target;
}

const M64 = (1n << 64n) - 1n;
function nextRand(state) {
    state ^= (state << 13n) & M64;
    state ^= state >> 7n;
    state ^= (state << 17n) & M64;
    return state;
}

test('lwma: pre-fork result is bit-identical to the legacy formula (PRNG sweep)', () => {
    let state = 0x2545F4914F6CDD1Dn;
    for (const targetTime of [60n, 120n, 240n, 360n, 480n]) {
        for (const blockWindow of [2, 5, 45, 90]) {
            for (let round = 0; round < 20; round++) {
                const dif = new LwmaWindowSW(blockWindow, targetTime, 1n, SW_MAX_U64);
                const legacy = [];
                let timestamp = 1000000n;
                for (let i = 0; i <= blockWindow; i++) {
                    // Solve times spanning below, around, and far above the max
                    // block time, including zero/negative steps.
                    state = nextRand(state);
                    const step = state % (targetTime * 10n);
                    timestamp += step;
                    timestamp -= targetTime / 2n;
                    if (timestamp < 0n) timestamp = 0n;
                    state = nextRand(state);
                    const difficulty = 1n + state % 100000000000n;
                    dif.add_back(timestamp, difficulty, difficulty);
                    legacy.push([timestamp, difficulty]);
                }
                const expected = legacyCalculate(legacy, targetTime, targetTime * 6n);
                assertEq(dif.raw_difficulty(), expected,
                    `tt=${targetTime} bw=${blockWindow} round=${round}`);
            }
        }
    }
});

// Convenience wrappers mirroring the Rust test helpers are defined near the top.

test('lwma: a uniform modifier scales the target by that modifier', () => {
    // Rust's `scaled(target, modifier)` stores (target, target*modifier).
    for (const modifier of [1n, 2n, 4n, 8n, 16n, 32n]) {
        const dif = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
        let timestamp = 60n;
        for (let i = 0; i < 6; i++) {
            dif.add_back(timestamp, 100n, 100n * modifier);
            timestamp += 60n;
        }
        assertEq(dif.raw_difficulty(), 100n * modifier, `modifier=${modifier}`);
    }
});

test('lwma: only the entry that closes the gap is used', () => {
    const a = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
    const b = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
    let timestamp = 60n;
    for (let i = 0; i < 6; i++) {
        a.add(timestamp, 100n, i === 0 ? 100n * 32n : 100n);
        b.add(timestamp, 100n, 100n);
        timestamp += 60n;
    }
    assertEq(a.raw_difficulty(), b.raw_difficulty());
});

test('lwma: the effective modifier is used when a clamp binds', () => {
    // target 10M, nominal modifier 32 would be 320M but max_pow_difficulty caps
    // it at 60M, so the effective modifier is 6. Steady-state blocks arrive
    // every 6*target_time because they must clear 6x the target.
    const targetTime = 240;
    const dif = new LwmaWindowSW(5, targetTime, 1n, SW_MAX_U64);
    let timestamp = 1000n;
    for (let i = 0; i < 6; i++) {
        dif.add(timestamp, 10000000n, 60000000n);
        timestamp += BigInt(6 * targetTime);
    }
    assertEq(dif.raw_difficulty(), 10000000n);

    // De-normalising by the nominal 32 would produce a target ~5.3x too high.
    const nominal = new LwmaWindowSW(5, targetTime, 1n, SW_MAX_U64);
    let ts2 = 1000n;
    for (let i = 0; i < 6; i++) {
        nominal.add(ts2, 10000000n, 320000000n);
        ts2 += BigInt(6 * targetTime);
    }
    assertEq(nominal.raw_difficulty(), 10000000n * 32n / 6n);
});

test('lwma: an adjusted target below the target is treated as no penalty', () => {
    const dif = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
    const reference = new LwmaWindowSW(5, 60, 1n, SW_MAX_U64);
    let timestamp = 60n;
    for (let i = 0; i < 6; i++) {
        dif.add(timestamp, 100n, 1n);
        reference.add(timestamp, 100n, 100n);
        timestamp += 60n;
    }
    assertEq(dif.raw_difficulty(), reference.raw_difficulty());
});

test('lwma: clamping happens after normalisation', () => {
    const targetTime = 60n;
    const maxBlockTime = targetTime * 6n;
    const dif = new LwmaWindowSW(2, 60, 1n, SW_MAX_U64);
    dif.add(0n, 100n, 3200n);
    dif.add(maxBlockTime * 3200n, 100n, 3200n);
    dif.add(maxBlockTime * 6400n, 100n, 3200n);

    const reference = new LwmaWindowSW(2, 60, 1n, SW_MAX_U64);
    reference.add(0n, 100n, 100n);
    reference.add(maxBlockTime, 100n, 100n);
    reference.add(maxBlockTime * 2n, 100n, 100n);

    assertEq(dif.raw_difficulty(), reference.raw_difficulty());
});

test('lwma: an enormous solve time does not overflow', () => {
    const dif = new LwmaWindowSW(2, 480, 1n, SW_MAX_U64);
    dif.add(0n, SW_MAX_U64 / 32n, SW_MAX_U64);
    dif.add(SW_MAX_U64 / 2n, SW_MAX_U64 / 32n, SW_MAX_U64);
    dif.add(SW_MAX_U64, SW_MAX_U64 / 32n, SW_MAX_U64);
    assertEq(typeof dif.raw_difficulty(), 'bigint');
});

test('lwma: updateBlockWindow shrinks from the front', () => {
    const dif = new LwmaWindowSW(90, 60, 1n, SW_MAX_U64);
    let timestamp = 60n;
    for (let i = 0; i < 91; i++) {
        const d = BigInt(100 + i);
        dif.add(timestamp, d, d);
        timestamp += 60n;
    }
    assertEq(dif.isFull, true);
    assertEq(dif.numSamples, 91);
    dif.updateBlockWindow(45);
    assertEq(dif.numSamples, 46);
    assertEq(dif.isFull, true);
    assertEq(dif.samples[dif.samples.length - 1].target, 190n, 'newest survived');
    assertEq(dif.samples[0].target, 145n, 'oldest dropped');
    assertThrows(() => dif.updateBlockWindow(0));
});

// ===========================================================================
// Real-data regressions (Esmeralda blocks 294400..296521)

test('data: LwmaWindowSW (m=1) is byte-identical to LwmaWindow on real data', () => {
    const blocksData = js('data.js');
    const blocks = (global.window.BLOCKS_DATA || {}).blocks;
    if (!blocks) throw new Error('BLOCKS_DATA not loaded');
    if (blocks.length !== 2122) throw new Error(`unexpected block count ${blocks.length}`);

    const baseWindows = {};
    const swWindows = {};
    for (const algoId of [0, 1, 2, 3]) {
        const cfg = ALGO_CONFIG[algoId];
        baseWindows[algoId] = new LwmaWindow(90, cfg.targetTime, cfg.minDifficulty, MAX_DIFFICULTY);
        baseWindows[algoId].setBaseTargetTime(cfg.targetTime);
        swWindows[algoId] = new LwmaWindowSW(90, cfg.targetTime, cfg.minDifficulty, MAX_DIFFICULTY);
        swWindows[algoId].setBaseTargetTime(cfg.targetTime);
    }

    let compared = 0;
    for (const b of blocks) {
        const algo = b.pow_algo;
        const d = BigInt(b.difficulty);
        const baseOut = baseWindows[algo].calculate();
        const swOut = swWindows[algo].calculate();
        assertEq(swOut === null ? 'null' : swOut.toString(),
                 baseOut === null ? 'null' : baseOut.toString(),
                 `height ${b.height}`);
        if (baseOut !== null && baseWindows[algo].isFull) compared++;
        baseWindows[algo].add(b.timestamp, d);
        swWindows[algo].add(b.timestamp, d, d);
    }
    if (compared < 1500) throw new Error(`too few comparisons: ${compared}`);
});

test('data: LWMA-90 replay still matches actual network difficulties', () => {
    const blocks = (global.window.BLOCKS_DATA || {}).blocks;
    const windows = {};
    for (const algoId of [0, 1, 2, 3]) {
        const cfg = ALGO_CONFIG[algoId];
        windows[algoId] = new LwmaWindow(90, cfg.targetTime, cfg.minDifficulty, MAX_DIFFICULTY);
        windows[algoId].setBaseTargetTime(cfg.targetTime);
    }
    let exactMatch = 0, total = 0;
    for (const b of blocks) {
        const w = windows[b.pow_algo];
        const computed = w.calculate();
        if (computed !== null && w.isFull) {
            total++;
            if (computed === BigInt(b.difficulty)) exactMatch++;
        }
        w.add(b.timestamp, b.difficulty);
    }
    const rate = total > 0 ? (exactMatch / total) * 100 : 0;
    console.log(`      (info) LWMA-90 replay match rate: ${exactMatch}/${total} = ${rate.toFixed(2)}%`);
    if (rate < 99) throw new Error(`replay match rate dropped to ${rate.toFixed(2)}%`);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
