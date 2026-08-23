'use strict';

/**
 * Mining competition simulation engine.
 *
 * At each block slot, all 4 PoW algorithms compete in parallel. Each algo has:
 *   - target difficulty (from LWMA, with TIP-004 penalty if it mined the last block(s))
 *   - estimated hash rate (from actual network data)
 *
 * Mining rate for algo i = hashRate_i / targetDifficulty_i (blocks per second)
 * Total rate = sum of all rates
 * Winning algo sampled from categorical: P(i) = rate_i / total_rate
 * Block time sampled from exponential(total_rate)
 */

const { NUMBER_OF_RUNS, RATE_PRECISION, PENALTY_BASE, LOG_EPSILON, FALLBACK_BLOCK_TIME,
        BASELINE_WINDOW, SCENARIO_PALETTE, BASELINE_COLOR, ALGO_IDS,
        PENALTY_CAP, BURN_IN_BLOCKS } = CONFIG;

const { aggregateStatsWithCI, computeStats, findMedianRun } = Statistics;


// --- Scenario generation ---

function generateScenarios(minWindow, maxWindow, step) {
    const scenarios = [
        { id: 'actual', label: 'Actual (LWMA-90)', window: BASELINE_WINDOW, penalty: false, baseline: true, color: BASELINE_COLOR }
    ];
    let colorIndex = 0;
    for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += step) {
        // Original proposal: per-algo consecutive count, uncapped 2^n, sticky
        // (penalty baked into target_time, so inflated difficulty lingers in the window).
        scenarios.push({
            id: `lwma${windowSize}p`,
            label: `LWMA-${windowSize} + Penalty (Original)`,
            window: windowSize,
            penalty: true,
            penaltyMode: 'original',
            baseline: false,
            color: SCENARIO_PALETTE[colorIndex % SCENARIO_PALETTE.length],
        });
        // New proposal (TIP-RFC-MT-0004, 2026-08-19): per-algorithm penalty scope,
        // capped at 32x, transient (window stores unadjusted difficulty + normalized
        // solve times, so the penalty resets the instant a different algorithm mines).
        scenarios.push({
            id: `lwma${windowSize}pnew`,
            label: `LWMA-${windowSize} + Penalty (New)`,
            window: windowSize,
            penalty: true,
            penaltyMode: 'new',
            baseline: false,
            color: SCENARIO_PALETTE[(colorIndex + 8) % SCENARIO_PALETTE.length],
        });
        // WTEMA (Zawy's exponential moving average, #76): the research-recommended
        // alternative. No penalty — response is embedded in the algorithm itself.
        // The "window" slider sweeps the EMA smoothing constant N.
        scenarios.push({
            id: `wtema${windowSize}`,
            label: `WTEMA-${windowSize} (EMA)`,
            window: windowSize,
            penalty: false,
            penaltyMode: 'wtema',
            baseline: false,
            color: SCENARIO_PALETTE[(colorIndex + 12) % SCENARIO_PALETTE.length],
        });
        colorIndex++;
    }
    return scenarios;
}


// --- Block precomputation ---

function precomputeBlockData(blocks) {
    const algoLastSeenTimestamp = {};

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const algo = block.pow_algo;

        block._consecutive = countConsecutiveSameAlgo(blocks, index, algo);

        if (index > 0) {
            const rawBlockTime = block.timestamp - blocks[index - 1].timestamp;
            block._mainChainBlockTime = rawBlockTime > 0 ? rawBlockTime : 1;
        } else {
            block._mainChainBlockTime = 0;
        }

        const previousTimestamp = algoLastSeenTimestamp[algo];
        if (previousTimestamp !== undefined) {
            const rawSolveTime = block.timestamp - previousTimestamp;
            block._algoSolveTime = rawSolveTime > 0 ? rawSolveTime : 1;
        } else {
            block._algoSolveTime = null;
        }
        algoLastSeenTimestamp[algo] = block.timestamp;
    }
}

function countConsecutiveSameAlgo(blocks, currentIndex, algo) {
    // Run length INCLUDING the current block: a lone block is a run of 1, the
    // second of a streak is 2, etc. (consistent with the simulated scenario
    // counters, so "Consecutive max" means the same thing on every tab).
    let count = 0;
    for (let lookback = currentIndex; lookback >= 0; lookback--) {
        if (blocks[lookback].pow_algo !== algo) break;
        count++;
    }
    return count;
}


// --- Baseline (actual) results ---

function getActualResults(blocks) {
    const results = [];
    for (let index = WARMUP_BLOCKS; index < blocks.length; index++) {
        const block = blocks[index];
        results.push(buildResultObject(
            block, block.pow_algo, BigInt(block.difficulty),
            block._mainChainBlockTime, block.timestamp, block._consecutive,
            BASELINE_WINDOW, false
        ));
    }
    return results;
}


// --- Mining competition (single run) ---

function runCompetition(blocks, scenario, seed) {
    const rng = createRng(seed);
    const windows = initializeLwmaWindows(scenario);
    const hashRateHistory = createEmptyHashRateHistory();

    let lastWinner = -1;
    let consecutiveCount = 0;
    let simulatedTimestamp = 0;
    const results = [];

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const actualAlgo = block.pow_algo;

        updateHashRateHistory(hashRateHistory, block, actualAlgo);

        if (index < WARMUP_BLOCKS) {
            windows[actualAlgo].add(block.timestamp, block.difficulty);
            if (index === WARMUP_BLOCKS - 1) simulatedTimestamp = block.timestamp;
            continue;
        }

        const algoRates = computeAlgoRates(windows, hashRateHistory, scenario, lastWinner, consecutiveCount);
        const totalRate = algoRates.reduce((sum, entry) => sum + entry.rate, 0);

        let winningAlgo, simulatedDifficulty, simulatedSolveTime;

        if (totalRate <= 0) {
            winningAlgo = actualAlgo;
            simulatedDifficulty = BigInt(block.difficulty);
            simulatedSolveTime = block._mainChainBlockTime || FALLBACK_BLOCK_TIME;
        } else {
            winningAlgo = sampleWinningAlgo(algoRates, totalRate, rng);
            simulatedSolveTime = sampleBlockTime(totalRate, rng);
            simulatedDifficulty = algoRates.find(entry => entry.algo === winningAlgo).targetDifficulty;
        }

        // consecutiveCount = run length of the last mined block (>= 1). A block
        // extending the run is at position r = consecutiveCount + 1 and pays
        // 2^(r-1) = 2^consecutiveCount: the second consecutive block doubles,
        // the third quadruples, etc. (TIP: m = 2^(r-1)). Any other algorithm
        // resets the run to length 1.
        if (winningAlgo === lastWinner) consecutiveCount++;
        else consecutiveCount = 1; // a fresh winner starts a run of length 1
        lastWinner = winningAlgo;

        simulatedTimestamp += simulatedSolveTime;
        windows[winningAlgo].add(Math.floor(simulatedTimestamp), simulatedDifficulty);

        results.push(buildResultObject(
            block, winningAlgo, simulatedDifficulty, simulatedSolveTime,
            Math.floor(simulatedTimestamp), consecutiveCount, scenario.window, scenario.penalty
        ));
    }

    return results;
}


// --- Competition helpers ---

function initializeLwmaWindows(scenario) {
    const windows = {};
    for (const algoId of ALGO_IDS) {
        const algoConfig = ALGO_CONFIG[algoId];
        const window = new LwmaWindow(scenario.window, algoConfig.targetTime, algoConfig.minDifficulty, MAX_DIFFICULTY);
        window.setBaseTargetTime(algoConfig.targetTime);
        windows[algoId] = window;
    }
    return windows;
}

function createEmptyHashRateHistory() {
    const history = {};
    for (const algoId of ALGO_IDS) history[algoId] = [];
    return history;
}

function updateHashRateHistory(hashRateHistory, block, actualAlgo) {
    if (block._algoSolveTime === null) return;
    hashRateHistory[actualAlgo].push({
        difficulty: BigInt(block.difficulty),
        time: BigInt(block._algoSolveTime),
    });
    if (hashRateHistory[actualAlgo].length > CONFIG.HASH_RATE_WINDOW) {
        hashRateHistory[actualAlgo].shift();
    }
}

function computeAlgoRates(windows, hashRateHistory, scenario, lastWinner, consecutiveCount) {
    const algoRates = [];
    for (const algoId of ALGO_IDS) {
        const algoConfig = ALGO_CONFIG[algoId];
        const window = windows[algoId];

        applyPenaltyIfActive(window, algoConfig, scenario, algoId, lastWinner, consecutiveCount);

        let targetDifficulty = window.calculate();
        if (targetDifficulty === null) targetDifficulty = algoConfig.minDifficulty;

        const rate = estimateMiningRate(hashRateHistory[algoId], targetDifficulty);

        algoRates.push({ algo: algoId, targetDifficulty, rate });
    }
    return algoRates;
}

function applyPenaltyIfActive(window, algoConfig, scenario, algoId, lastWinner, consecutiveCount) {
    // consecutiveCount is the run length ending at the previous block, so the
    // block being mined is at position r = consecutiveCount + 1 and pays
    // 2^(r-1) = 2^consecutiveCount. Fresh winners (consecutive = 0) pay base.
    const isConsecutiveWinner = (lastWinner === algoId);
    const consecutive = isConsecutiveWinner ? consecutiveCount : 0;

    if (scenario.penalty && consecutive > 0) {
        const penaltyMultiplier = PENALTY_BASE ** BigInt(consecutive);
        window.updateTargetTime(algoConfig.targetTime * penaltyMultiplier);
    } else {
        window.updateTargetTime(algoConfig.targetTime);
    }
}

function estimateMiningRate(hashRateEntries, targetDifficulty) {
    if (hashRateEntries.length === 0) return 0;

    let totalDifficulty = 0n;
    let totalTime = 0n;
    for (const entry of hashRateEntries) {
        totalDifficulty += entry.difficulty;
        totalTime += entry.time;
    }

    if (totalDifficulty === 0n || totalTime === 0n || targetDifficulty === 0n) return 0;

    const scaledRate = (totalDifficulty * RATE_PRECISION) / (totalTime * targetDifficulty);
    return Number(scaledRate) / Number(RATE_PRECISION);
}

function sampleWinningAlgo(algoRates, totalRate, rng) {
    const randomValue = rng.next();
    let cumulativeProbability = 0;
    let winner = algoRates[algoRates.length - 1].algo;
    for (const entry of algoRates) {
        cumulativeProbability += entry.rate / totalRate;
        if (randomValue <= cumulativeProbability) {
            winner = entry.algo;
            break;
        }
    }
    return winner;
}

function sampleBlockTime(totalRate, rng) {
    const uniformSample = rng.next();
    const rawBlockTime = -Math.log(Math.max(uniformSample, LOG_EPSILON)) / totalRate;
    return Math.max(1, Math.round(rawBlockTime));
}

function buildResultObject(block, winningAlgo, simulatedDifficulty, simulatedSolveTime,
                           simulatedTimestamp, consecutiveCount, windowSize, penaltyEnabled) {
    return {
        height: block.height,
        algo: winningAlgo,
        algoName: ALGO_NAMES[winningAlgo],
        simDifficulty: simulatedDifficulty.toString(),
        simSolveTime: simulatedSolveTime,
        simTimestamp: simulatedTimestamp,
        simMainChainBT: simulatedSolveTime,
        actualDifficulty: block.difficulty,
        actualSolveTime: block._algoSolveTime || 0,
        actualMainChainBT: block._mainChainBlockTime,
        actualTimestamp: block.timestamp,
        consecutive: consecutiveCount,
        penaltyMultiplier: (penaltyEnabled && consecutiveCount > 0) ? Math.pow(Number(PENALTY_BASE), Math.max(consecutiveCount - 1, 0)) : 1,
        window: windowSize,
        penalty: penaltyEnabled,
    };
}


// --- "New" proposal (TIP-RFC-MT-0004, 2026-08-19) competition path ---
//
// Exact port of tari PR #7960 (branch sw_tip-004). Reuses the shared helpers
// (estimateMiningRate, sampleWinningAlgo, sampleBlockTime, updateHashRateHistory,
// buildResultObject).
//
// Fidelity to the Rust implementation:
//   * PowBackoffTracker (js/lwma_sw.js) replaces the lastWinner/consecutiveCount
//     counters: m = min(2^run_len, cap, 32), per-algorithm scope, run state is
//     seeded by replaying the ACTUAL block algorithms during warm-up so the first
//     simulated block pays the modifier the real chain would have charged it.
//   * The mining target is adjusted Rust-style (TargetDifficultyWindow::calculate_pair):
//     adjusted = clamp(saturating(base * m), min, max), with u64 saturation.
//   * The window stores (target, adjustedTarget) pairs and the LWMA normalises
//     solve times by the *effective* modifier adjustedTarget/target (LwmaWindowSW),
//     which matches lwma_diff.rs::raw_difficulty exactly, including when a
//     difficulty clamp binds.
//   * The first BURN_IN_BLOCKS simulated blocks after warm-up are still simulated
//     (windows/tracker update normally) but excluded from results/statistics, so
//     charts only show the fully-accurate region past the warm-up boundary.

function runSingleScenarioSW(blocks, scenario, baseSeed = 0) {
    const runs = [];
    const allStats = [];
    for (let runIndex = 0; runIndex < NUMBER_OF_RUNS; runIndex++) {
        const run = runCompetitionSW(blocks, scenario, runIndex + 1 + baseSeed);
        runs.push(run);
        allStats.push(computeStats(run));
    }
    return {
        runs,
        stats: aggregateStatsWithCI(allStats),
        medianRunIndex: findMedianRun(allStats),
        numRuns: NUMBER_OF_RUNS,
    };
}

function runCompetitionSW(blocks, scenario, seed) {
    const rng = createRng(seed);
    const windows = initializeLwmaWindowsSW(scenario);
    const hashRateHistory = createEmptyHashRateHistory();
    const tracker = new PowBackoffTracker();
    // Blocks to simulate before results are recorded (warm-up + burn-in).
    const analysisStart = WARMUP_BLOCKS + BURN_IN_BLOCKS;

    // Display-only counters (run length ending at the current block); consensus
    // semantics live in `tracker`.
    let lastWinner = -1;
    let consecutiveCount = 0;
    let simulatedTimestamp = 0;
    const results = [];

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const actualAlgo = block.pow_algo;

        updateHashRateHistory(hashRateHistory, block, actualAlgo);

        if (index < WARMUP_BLOCKS) {
            // Pre-fork replay: no penalty, adjusted == target. The tracker is
            // advanced so its state at the warm-up boundary matches the actual
            // chain (Rust derives it from the preceding headers).
            windows[actualAlgo].add(block.timestamp, block.difficulty, block.difficulty);
            tracker.push(actualAlgo);
            if (index === WARMUP_BLOCKS - 1) simulatedTimestamp = block.timestamp;
            continue;
        }

        const algoRates = computeAlgoRatesSW(windows, hashRateHistory, tracker);
        const totalRate = algoRates.reduce((sum, entry) => sum + entry.rate, 0);

        let winningAlgo, simulatedSolveTime, winnerEntry;

        if (totalRate <= 0) {
            winningAlgo = actualAlgo;
            simulatedSolveTime = block._mainChainBlockTime || FALLBACK_BLOCK_TIME;
            // Degenerate path (no hash-rate data): no penalty applied, matching
            // the pre-fork-style fallback of the other engines.
            winnerEntry = { algo: actualAlgo, unadjusted: BigInt(block.difficulty), miningTarget: BigInt(block.difficulty), modifier: 1n };
        } else {
            winningAlgo = sampleWinningAlgo(algoRates, totalRate, rng);
            simulatedSolveTime = sampleBlockTime(totalRate, rng);
            winnerEntry = algoRates.find(entry => entry.algo === winningAlgo);
        }

        // Advance the tracker AFTER rates were computed (modifier_for is "what
        // would this next block pay"), mirroring TargetDifficulties::add_back.
        tracker.push(winningAlgo);

        if (winningAlgo === lastWinner) consecutiveCount++;
        else consecutiveCount = 1; // display-only run length including this block
        lastWinner = winningAlgo;

        simulatedTimestamp += simulatedSolveTime;
        windows[winningAlgo].add(
            Math.floor(simulatedTimestamp),
            winnerEntry.unadjusted,
            winnerEntry.miningTarget,
        );

        if (index >= analysisStart) {
            const result = buildResultObject(
                block, winningAlgo, winnerEntry.miningTarget, simulatedSolveTime,
                Math.floor(simulatedTimestamp), consecutiveCount, scenario.window, scenario.penalty
            );
            // Override with the capped modifier actually in force
            // (buildResultObject's default assumes the uncapped Original formula).
            result.penaltyMultiplier = Number(winnerEntry.modifier);
            results.push(result);
        }
    }

    return results;
}

function initializeLwmaWindowsSW(scenario) {
    const windows = {};
    for (const algoId of ALGO_IDS) {
        const algoConfig = ALGO_CONFIG[algoId];
        const window = new LwmaWindowSW(scenario.window, algoConfig.targetTime, algoConfig.minDifficulty, MAX_DIFFICULTY);
        window.setBaseTargetTime(algoConfig.targetTime);
        windows[algoId] = window;
    }
    return windows;
}

function computeAlgoRatesSW(windows, hashRateHistory, tracker) {
    const algoRates = [];
    for (const algoId of ALGO_IDS) {
        const window = windows[algoId];

        // m = min(2^run_len, cap, M_MAX): what a block of this algorithm would
        // pay if it were appended now. A fresh winner pays nothing.
        const modifier = tracker.modifierFor(algoId, PENALTY_CAP);

        let unadjusted = window.calculate();
        if (unadjusted === null) unadjusted = ALGO_CONFIG[algoId].minDifficulty;

        // adjusted = clamp(saturating(base * m), min, max) — Rust `adjust()`.
        // base is already within [min, max]; u64 saturation at MAX_U64.
        let miningTarget = unadjusted * modifier;
        if (miningTarget > MAX_U64) miningTarget = MAX_U64;

        const rate = estimateMiningRate(hashRateHistory[algoId], miningTarget);

        algoRates.push({ algo: algoId, unadjusted, miningTarget, modifier, rate });
    }
    return algoRates;
}


// --- WTEMA (Zawy EMA, research-recommended) competition path ---
//
// Per-lane difficulty follows WtemaWindow.calculate(): a bounded, correcting
// exponential update using the lane's own previous solve time (difficulty rises at
// most ~1/N per fast block and falls at most ~5/N per slow block). There is no
// penalty: the fast, mean-reverting response and the per-block movement bound are
// built into the algorithm, so an extra scheduling penalty would double-count the
// same mechanism (and would reintroduce the emission/efficiency flaws documented
// in the README). Reuses the shared helpers (estimateMiningRate, sampleWinningAlgo,
// sampleBlockTime, updateHashRateHistory, buildResultObject).

function runSingleScenarioWtema(blocks, scenario, baseSeed = 0) {
    const runs = [];
    const allStats = [];
    for (let runIndex = 0; runIndex < NUMBER_OF_RUNS; runIndex++) {
        const run = runCompetitionWtema(blocks, scenario, runIndex + 1 + baseSeed);
        runs.push(run);
        allStats.push(computeStats(run));
    }
    return {
        runs,
        stats: aggregateStatsWithCI(allStats),
        medianRunIndex: findMedianRun(allStats),
        numRuns: NUMBER_OF_RUNS,
    };
}

function runCompetitionWtema(blocks, scenario, seed) {
    const rng = createRng(seed);
    const windows = initializeWtemaWindows(scenario);
    const hashRateHistory = createEmptyHashRateHistory();

    let lastWinner = -1;
    let consecutiveCount = 0;
    let simulatedTimestamp = 0;
    const results = [];

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const actualAlgo = block.pow_algo;

        updateHashRateHistory(hashRateHistory, block, actualAlgo);

        if (index < WARMUP_BLOCKS) {
            windows[actualAlgo].add(block.timestamp, block.difficulty);
            if (index === WARMUP_BLOCKS - 1) simulatedTimestamp = block.timestamp;
            continue;
        }

        const algoRates = computeAlgoRatesWtema(windows, hashRateHistory);
        const totalRate = algoRates.reduce((sum, entry) => sum + entry.rate, 0);

        let winningAlgo, simulatedDifficulty, simulatedSolveTime;

        if (totalRate <= 0) {
            winningAlgo = actualAlgo;
            simulatedDifficulty = BigInt(block.difficulty);
            simulatedSolveTime = block._mainChainBlockTime || FALLBACK_BLOCK_TIME;
        } else {
            winningAlgo = sampleWinningAlgo(algoRates, totalRate, rng);
            simulatedSolveTime = sampleBlockTime(totalRate, rng);
            simulatedDifficulty = algoRates.find(entry => entry.algo === winningAlgo).targetDifficulty;
        }

        // No penalty here; consecutiveCount is still run length (>= 1, including
        // the current block) so the "Consecutive max" stat matches the other
        // scenarios and the actual-data tab.
        if (winningAlgo === lastWinner) consecutiveCount++;
        else consecutiveCount = 1;
        lastWinner = winningAlgo;

        simulatedTimestamp += simulatedSolveTime;
        windows[winningAlgo].add(Math.floor(simulatedTimestamp), simulatedDifficulty);

        results.push(buildResultObject(
            block, winningAlgo, simulatedDifficulty, simulatedSolveTime,
            Math.floor(simulatedTimestamp), consecutiveCount, scenario.window, scenario.penalty
        ));
    }

    return results;
}

function initializeWtemaWindows(scenario) {
    const windows = {};
    for (const algoId of ALGO_IDS) {
        const algoConfig = ALGO_CONFIG[algoId];
        const window = new WtemaWindow(scenario.window, algoConfig.targetTime, algoConfig.minDifficulty, MAX_DIFFICULTY);
        window.setBaseTargetTime(algoConfig.targetTime);
        windows[algoId] = window;
    }
    return windows;
}

function computeAlgoRatesWtema(windows, hashRateHistory) {
    const algoRates = [];
    for (const algoId of ALGO_IDS) {
        const algoConfig = ALGO_CONFIG[algoId];
        const window = windows[algoId];

        let targetDifficulty = window.calculate();
        if (targetDifficulty === null) targetDifficulty = algoConfig.minDifficulty;

        const rate = estimateMiningRate(hashRateHistory[algoId], targetDifficulty);

        algoRates.push({ algo: algoId, targetDifficulty, rate });
    }
    return algoRates;
}


// --- Run all scenarios ---

function runAll(blocks, scenarios) {
    precomputeBlockData(blocks);
    const results = {};
    for (const scenario of scenarios) {
        results[scenario.id] = runSingleScenario(blocks, scenario);
    }
    return { scenarios, results, warmup: WARMUP_BLOCKS, numRuns: NUMBER_OF_RUNS };
}

async function runAllAsync(blocks, scenarios, onProgress, baseSeed = 0) {
    precomputeBlockData(blocks);
    const results = {};
    for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index];
        results[scenario.id] = runSingleScenario(blocks, scenario, baseSeed);
        if (onProgress) onProgress(index + 1, scenarios.length);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { scenarios, results, warmup: WARMUP_BLOCKS, numRuns: NUMBER_OF_RUNS };
}

function runSingleScenario(blocks, scenario, baseSeed = 0) {
    if (scenario.baseline) {
        const run = getActualResults(blocks);
        return {
            runs: [run],
            stats: aggregateStatsWithCI([computeStats(run)]),
            medianRunIndex: 0,
            numRuns: 1,
        };
    }

    // "New" proposal uses a separate competition path; the Original path below is
    // left untouched.
    if (scenario.penaltyMode === 'new') {
        return runSingleScenarioSW(blocks, scenario, baseSeed);
    }

    // WTEMA (Zawy EMA) uses its own competition path.
    if (scenario.penaltyMode === 'wtema') {
        return runSingleScenarioWtema(blocks, scenario, baseSeed);
    }

    const runs = [];
    const allStats = [];
    for (let runIndex = 0; runIndex < NUMBER_OF_RUNS; runIndex++) {
        const run = runCompetition(blocks, scenario, runIndex + 1 + baseSeed);
        runs.push(run);
        allStats.push(computeStats(run));
    }
    return {
        runs,
        stats: aggregateStatsWithCI(allStats),
        medianRunIndex: findMedianRun(allStats),
        numRuns: NUMBER_OF_RUNS,
    };
}


if (typeof window !== 'undefined') {
    window.Simulation = {
        generateScenarios, runAll, runAllAsync,
        precomputeBlockData, getActualResults, runCompetition,
        runCompetitionSW, runCompetitionWtema,
    };
}
