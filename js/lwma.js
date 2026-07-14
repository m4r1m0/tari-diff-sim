'use strict';

/**
 * LWMA (Linearly Weighted Moving Average) difficulty adjustment.
 * Exact port of Tari's Rust implementation (base_layer/core/src/proof_of_work/lwma_diff.rs).
 *
 * Formula:
 *   n = num_samples - 1
 *   avg_diff = sum(diff[1..n]) / n
 *   weighted_times = sum( min(solveTime_i, 6*targetTime) * i )  for i=1..n
 *   k = n * (n+1) * targetTime / 2
 *   target = avg_diff * k / weighted_times
 *   result clamped to [minDifficulty, maxDifficulty]
 */

const LWMA_MAX_BLOCK_TIME_RATIO = 6n;
const MAX_U64 = 18446744073709551615n; // 2^64 - 1

class LwmaWindow {
    constructor(blockWindow, targetTime, minDifficulty, maxDifficulty) {
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        if (blockWindow <= 0) throw new Error('blockWindow must be > 0');
        this.blockWindow = blockWindow;
        this.targetTime = BigInt(targetTime);
        this.maxBlockTime = this.targetTime * LWMA_MAX_BLOCK_TIME_RATIO;
        this.minDifficulty = BigInt(minDifficulty);
        this.maxDifficulty = BigInt(maxDifficulty);
        this.samples = []; // [{timestamp: BigInt, difficulty: BigInt}], FIFO (index 0 = oldest)
    }

    get numSamples() {
        return this.samples.length;
    }

    get isFull() {
        return this.samples.length === this.blockWindow + 1;
    }

    updateTargetTime(targetTime) {
        targetTime = BigInt(targetTime);
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        this.targetTime = targetTime;
        this.maxBlockTime = targetTime * LWMA_MAX_BLOCK_TIME_RATIO;
    }

    resetTargetTime() {
        this.targetTime = this.baseTargetTime;
        this.maxBlockTime = this.baseTargetTime * LWMA_MAX_BLOCK_TIME_RATIO;
    }

    setBaseTargetTime(targetTime) {
        targetTime = BigInt(targetTime);
        this.baseTargetTime = targetTime;
        this.targetTime = targetTime;
        this.maxBlockTime = targetTime * LWMA_MAX_BLOCK_TIME_RATIO;
    }

    add(timestamp, difficulty) {
        timestamp = BigInt(timestamp);
        difficulty = BigInt(difficulty);
        this.samples.push({ timestamp, difficulty });
        if (this.samples.length > this.blockWindow + 1) {
            this.samples.shift();
        }
    }

    calculate() {
        if (this.samples.length <= 1) return null;

        const n = BigInt(this.samples.length - 1);

        // Average difficulty (skip first/oldest sample)
        let difficultySum = 0n;
        for (let i = 1; i < this.samples.length; i++) {
            difficultySum += this.samples[i].difficulty;
        }
        const avgDifficulty = difficultySum / n;

        // Weighted solve times
        let weightedTimes = 0n;
        let prevTimestamp = this.samples[0].timestamp;

        for (let i = 1; i < this.samples.length; i++) {
            let thisTimestamp = this.samples[i].timestamp;
            // Enforce strictly increasing timestamps
            if (thisTimestamp <= prevTimestamp) {
                thisTimestamp = prevTimestamp + 1n;
            }
            let solveTime = thisTimestamp - prevTimestamp;
            // Cap at max_block_time
            if (solveTime > this.maxBlockTime) {
                solveTime = this.maxBlockTime;
            }
            prevTimestamp = thisTimestamp;

            // Weight = i (1-indexed), matching Rust's (enumerate_index + 1)
            weightedTimes += solveTime * BigInt(i);
        }

        if (weightedTimes === 0n) weightedTimes = 1n;

        // k = n * (n+1) * targetTime / 2
        const k = (n * (n + 1n) * this.targetTime) / 2n;

        // target = avgDifficulty * k / weightedTimes
        let target = (avgDifficulty * k) / weightedTimes;

        // Clamp
        if (target < this.minDifficulty) target = this.minDifficulty;
        if (target > this.maxDifficulty) target = this.maxDifficulty;

        return target;
    }
}

// Per-algorithm consensus constants (mainnet)
const ALGO_CONFIG = {
    0: { name: 'RandomXM', minDifficulty: 1200000n,     targetTime: 480n },
    1: { name: 'Sha3x',    minDifficulty: 150000000000n, targetTime: 480n },
    2: { name: 'RandomXT', minDifficulty: 1200000n,     targetTime: 480n },
    3: { name: 'Cuckaroo', minDifficulty: 1n,            targetTime: 480n },
};

const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
const ALGO_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#e67e22'];
const MAX_DIFFICULTY = MAX_U64;
const DEFAULT_BLOCK_WINDOW = 90;
const WARMUP_BLOCKS = 600;
const TARGET_BLOCK_TIME = 120; // seconds (overall: 480/4 = 120)

if (typeof window !== 'undefined') {
    window.LwmaWindow = LwmaWindow;
    window.ALGO_CONFIG = ALGO_CONFIG;
    window.ALGO_NAMES = ALGO_NAMES;
    window.ALGO_COLORS = ALGO_COLORS;
    window.MAX_DIFFICULTY = MAX_DIFFICULTY;
    window.DEFAULT_BLOCK_WINDOW = DEFAULT_BLOCK_WINDOW;
    window.WARMUP_BLOCKS = WARMUP_BLOCKS;
    window.TARGET_BLOCK_TIME = TARGET_BLOCK_TIME;
    window.MAX_U64 = MAX_U64;
}
