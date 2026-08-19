'use strict';

/**
 * LWMA variant for the "New" penalty proposal (TIP-RFC-MT-0004, 2026-08-19).
 *
 * The validated LwmaWindow (Original proposal) bakes the penalty into target_time,
 * so calculate() returns an ADJUSTED difficulty that is then stored back into the
 * window. That makes the Original penalty "sticky": the inflated difficulty lingers
 * in avg_difficulty until it ages out.
 *
 * This variant keeps the penalty TRANSIENT:
 *   - The LWMA always uses the base target_time and returns the UNADJUSTED target.
 *   - Each sample carries the per-block modifier m[i] in force when it was mined.
 *     Solve times are normalized by m[i] before entering the weighted sum, so a
 *     block mined against an inflated target is not read as a hash-rate drop.
 *   - The caller applies m as a one-shot multiplier on the mining target only
 *     (miningTarget = unadjusted * m) and stores the UNADJUSTED difficulty in the
 *     window. The penalty therefore resets the instant a different algorithm
 *     mines.
 *
 * Integer-exact normalization (RFC "Integer arithmetic"): every modifier is a
 * power of two dividing M_MAX (32), so M_MAX/m[i] is an exact integer and both k
 * and weighted_times are scaled by M_MAX, leaving the target unchanged.
 *
 * INVARIANT: with every modifier == 1, calculate() is numerically identical to
 * LwmaWindow.calculate() (the Original/baseline engine). This is what makes the
 * warm-up phase (actual blocks, m=1) behave exactly like the Original.
 */

const SW_M_MAX = 32n;
const SW_LWMA_MAX_BLOCK_TIME_RATIO = 6n;

class LwmaWindowSW {
    constructor(blockWindow, targetTime, minDifficulty, maxDifficulty) {
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        if (blockWindow <= 0) throw new Error('blockWindow must be > 0');
        this.blockWindow = blockWindow;
        this.targetTime = BigInt(targetTime);
        this.maxBlockTime = this.targetTime * SW_LWMA_MAX_BLOCK_TIME_RATIO;
        this.minDifficulty = BigInt(minDifficulty);
        this.maxDifficulty = BigInt(maxDifficulty);
        // FIFO (index 0 = oldest). difficulty is the UNADJUSTED target.
        this.samples = [];
    }

    get numSamples() {
        return this.samples.length;
    }

    get isFull() {
        return this.samples.length === this.blockWindow + 1;
    }

    setBaseTargetTime(targetTime) {
        targetTime = BigInt(targetTime);
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        this.targetTime = targetTime;
        this.maxBlockTime = targetTime * SW_LWMA_MAX_BLOCK_TIME_RATIO;
    }

    add(timestamp, difficulty, modifier = 1n) {
        const m = BigInt(modifier);
        this.samples.push({
            timestamp: BigInt(timestamp),
            difficulty: BigInt(difficulty),
            modifier: m > 0n ? m : 1n,
        });
        if (this.samples.length > this.blockWindow + 1) {
            this.samples.shift();
        }
    }

    calculate() {
        if (this.samples.length <= 1) return null;

        const n = BigInt(this.samples.length - 1);

        // Average difficulty (skip oldest); these are UNADJUSTED values.
        let difficultySum = 0n;
        for (let i = 1; i < this.samples.length; i++) {
            difficultySum += this.samples[i].difficulty;
        }
        const avgDifficulty = difficultySum / n;

        // Weighted, NORMALIZED solve times.
        // For interval i: normalized = raw_solve_time / m[i]; scale every term by
        // M_MAX so the division stays integer-exact (M_MAX / m[i] is exact for every
        // permitted modifier). Clamp the normalized value to the base bounds
        // [1, maxBlockTime] (scaled: [M_MAX, maxBlockTime*M_MAX]) AFTER normalization,
        // per the RFC's consensus-critical ordering.
        const maxScaled = this.maxBlockTime * SW_M_MAX; // base upper bound, scaled
        const minScaled = SW_M_MAX;                     // base lower bound (1), scaled

        let weightedTimes = 0n;
        let prevTimestamp = this.samples[0].timestamp;

        for (let i = 1; i < this.samples.length; i++) {
            let thisTimestamp = this.samples[i].timestamp;
            if (thisTimestamp <= prevTimestamp) {
                thisTimestamp = prevTimestamp + 1n;
            }
            const rawSolveTime = thisTimestamp - prevTimestamp;
            prevTimestamp = thisTimestamp;

            const m = this.samples[i].modifier;
            let normalized = rawSolveTime * (SW_M_MAX / m);
            if (normalized < minScaled) normalized = minScaled;
            if (normalized > maxScaled) normalized = maxScaled;

            weightedTimes += normalized * BigInt(i);
        }

        if (weightedTimes === 0n) weightedTimes = 1n;

        // k = n*(n+1)*targetTime*M_MAX/2  (scaled by M_MAX to match weightedTimes)
        const k = (n * (n + 1n) * this.targetTime * SW_M_MAX) / 2n;

        let target = (avgDifficulty * k) / weightedTimes;

        if (target < this.minDifficulty) target = this.minDifficulty;
        if (target > this.maxDifficulty) target = this.maxDifficulty;

        return target; // UNADJUSTED
    }
}

if (typeof window !== 'undefined') {
    window.LwmaWindowSW = LwmaWindowSW;
    window.SW_M_MAX = SW_M_MAX;
}
