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
        BASELINE_WINDOW, SCENARIO_PALETTE, BASELINE_COLOR, ALGO_IDS } = CONFIG;

const { aggregateStatsWithCI, computeStats, findMedianRun } = Statistics;


// --- Scenario generation ---

function generateScenarios(minWindow, maxWindow, step) {
    const scenarios = [
        { id: 'actual', label: 'Actual (LWMA-90)', window: BASELINE_WINDOW, penalty: false, baseline: true, color: BASELINE_COLOR }
    ];
    let colorIndex = 0;
    for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += step) {
        scenarios.push({
            id: `lwma${windowSize}p`,
            label: `LWMA-${windowSize} + Penalty`,
            window: windowSize,
            penalty: true,
            baseline: false,
            color: SCENARIO_PALETTE[colorIndex % SCENARIO_PALETTE.length],
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
    if (currentIndex === 0) return 0;
    let count = 0;
    for (let lookback = currentIndex - 1; lookback >= 0; lookback--) {
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

        if (winningAlgo === lastWinner) consecutiveCount++;
        else consecutiveCount = 0;
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
        penaltyMultiplier: (penaltyEnabled && consecutiveCount > 0) ? Math.pow(Number(PENALTY_BASE), consecutiveCount) : 1,
        window: windowSize,
        penalty: penaltyEnabled,
    };
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
    };
}
