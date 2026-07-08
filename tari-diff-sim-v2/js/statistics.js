'use strict';

/**
 * Statistics computation for simulation results.
 * Computes per-run stats, aggregates across runs with confidence intervals,
 * and computes mean-across-runs for chart visualization.
 * Wrapped in IIFE to avoid polluting the global scope.
 */

(function() {

const { Z_SCORE_95_PERCENT, MEDIAN_PERCENTILE, P90_PERCENTILE, P99_PERCENTILE } = CONFIG;

const STAT_KEYS = ['mean', 'median', 'std', 'cv', 'p90', 'p99', 'min', 'max', 'consecMax'];


// --- Per-run statistics ---

function computeStats(results) {
    const blockTimes = results.map(result => result.simMainChainBT).filter(time => time > 0);
    const sortedTimes = [...blockTimes].sort((a, b) => a - b);
    const count = sortedTimes.length;

    if (count === 0) return createEmptyStats();

    const sum = sortedTimes.reduce((total, value) => total + value, 0);
    const mean = sum / count;
    const variance = sortedTimes.reduce((total, value) => total + (value - mean) ** 2, 0) / count;
    const standardDeviation = Math.sqrt(variance);

    const algoCounts = countAlgoBlocks(results);
    const consecutiveMax = findConsecutiveMax(results);

    return {
        count,
        mean,
        median: percentile(sortedTimes, MEDIAN_PERCENTILE),
        std: standardDeviation,
        cv: mean > 0 ? standardDeviation / mean : 0,
        p90: percentile(sortedTimes, P90_PERCENTILE),
        p99: percentile(sortedTimes, P99_PERCENTILE),
        min: sortedTimes[0],
        max: sortedTimes[count - 1],
        algoCounts,
        consecMax: consecutiveMax,
    };
}

function createEmptyStats() {
    return { count: 0, mean: 0, median: 0, std: 0, cv: 0, p90: 0, p99: 0,
             min: 0, max: 0,
             algoCounts: { 0: 0, 1: 0, 2: 0, 3: 0 }, consecMax: 0 };
}

function percentile(sortedValues, proportion) {
    const count = sortedValues.length;
    const index = Math.min(count - 1, Math.floor(count * proportion));
    return sortedValues[index];
}

function countAlgoBlocks(results) {
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const result of results) counts[result.algo]++;
    return counts;
}

function findConsecutiveMax(results) {
    let consecutiveMax = 0;
    for (const result of results) {
        if (result.consecutive > consecutiveMax) consecutiveMax = result.consecutive;
    }
    return consecutiveMax;
}


// --- Aggregation across runs with confidence intervals ---

function aggregateStatsWithCI(allStats) {
    const runCount = allStats.length;
    if (runCount === 0) return null;

    const aggregated = {};
    for (const key of STAT_KEYS) {
        aggregated[key] = aggregateSingleStat(allStats, key, runCount);
    }

    aggregated.algoCounts = aggregateAlgoCounts(allStats, runCount);
    aggregated.count = allStats[0].count;
    return aggregated;
}

function aggregateSingleStat(allStats, key, runCount) {
    const values = allStats.map(stat => stat[key]);
    const mean = values.reduce((total, value) => total + value, 0) / runCount;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / runCount;
    const standardDeviation = Math.sqrt(variance);
    const confidenceInterval = runCount > 1 ? Z_SCORE_95_PERCENT * standardDeviation / Math.sqrt(runCount) : 0;
    return { mean, ci: confidenceInterval, std: standardDeviation };
}

function aggregateAlgoCounts(allStats, runCount) {
    const aggregated = {};
    for (const algoId of CONFIG.ALGO_IDS) {
        const values = allStats.map(stat => stat.algoCounts[algoId]);
        const mean = values.reduce((total, value) => total + value, 0) / runCount;
        const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / runCount;
        const standardDeviation = Math.sqrt(variance);
        const confidenceInterval = runCount > 1 ? Z_SCORE_95_PERCENT * standardDeviation / Math.sqrt(runCount) : 0;
        aggregated[algoId] = { mean, ci: confidenceInterval };
    }
    return aggregated;
}


// --- Find median run (for difficulty chart) ---

function findMedianRun(allStats) {
    const means = allStats.map(stat => stat.mean);
    const sortedMeans = [...means].sort((a, b) => a - b);
    const medianValue = sortedMeans[Math.floor(sortedMeans.length / 2)];

    let bestIndex = 0;
    let smallestDifference = Infinity;
    for (let index = 0; index < means.length; index++) {
        const difference = Math.abs(means[index] - medianValue);
        if (difference < smallestDifference) {
            smallestDifference = difference;
            bestIndex = index;
        }
    }
    return bestIndex;
}


// --- Compute mean across runs at each height (for block time chart) ---

function computeMeanAcrossRuns(runs) {
    if (runs.length === 0) return [];
    if (runs.length === 1) return runs[0];

    const blockCount = runs[0].length;
    const meanResults = [];

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
        let sumBlockTime = 0;
        let minBlockTime = Infinity;
        let maxBlockTime = 0;

        for (const run of runs) {
            const blockTime = run[blockIndex].simMainChainBT;
            sumBlockTime += blockTime;
            if (blockTime < minBlockTime) minBlockTime = blockTime;
            if (blockTime > maxBlockTime) maxBlockTime = blockTime;
        }

        meanResults.push({
            height: runs[0][blockIndex].height,
            simMainChainBT: sumBlockTime / runs.length,
            minAcrossRuns: minBlockTime,
            maxAcrossRuns: maxBlockTime,
        });
    }

    return meanResults;
}


if (typeof window !== 'undefined') {
    window.Statistics = {
        computeStats, aggregateStatsWithCI, findMedianRun, computeMeanAcrossRuns,
    };
}

})();
