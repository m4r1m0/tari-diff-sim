'use strict';

/**
 * TIP-RFC-MT-0004 engine — exact port of tari PR #7960 (branch sw_tip-004):
 *
 *   base_layer/core/src/proof_of_work/pow_backoff.rs  -> PowBackoffTracker
 *   base_layer/core/src/proof_of_work/lwma_diff.rs    -> LwmaWindowSW
 *
 * Design notes carried over from the Rust implementation:
 *
 *  - The backoff modifier m = min(2^(r-1), 32) for a run of r consecutive
 *    same-algorithm blocks. Every algorithm (RxM, Sha3x, RxT, C29) is an
 *    independent penalty scope; RandomXM and RandomXT are NOT grouped.
 *  - The LWMA window stores (timestamp, target, adjustedTarget) triples. The
 *    adjusted target is the bar the block's PoW actually cleared:
 *    adjusted = clamp(base * m, min, max) computed with the modifier in force
 *    when that block was mined. The ratio adjusted/target is the *effective*
 *    modifier, which is what the solve time is normalised by. Recording the
 *    pair (rather than the nominal modifier) matters whenever a clamp binds.
 *  - Solve times are normalised as
 *        scaled = min(raw_solve_time * M_MAX * target / adjusted_target,
 *                     max_block_time * M_MAX)
 *    with the raw solve time pre-capped at max_block_time * M_MAX^2. The k
 *    constant is scaled by the same M_MAX, leaving the result unchanged.
 *  - weighted_times == 0 yields null (the caller falls back to min difficulty),
 *    mirroring `raw_difficulty()` returning None.
 *
 * INVARIANT (pinned by the Rust test `pre_fork_result_is_bit_identical_to_the_legacy_formula`,
 * ported in test/run_tests.js): with every modifier equal to 1, calculate() is
 * bit-identical to the pre-TIP-0004 LwmaWindow.calculate().
 */

const SW_M_MAX = 32n;                    // MAX_POW_BACKOFF_MODIFIER
const SW_LWMA_MAX_BLOCK_TIME_RATIO = 6n; // LWMA_MAX_BLOCK_TIME_RATIO
const SW_MAX_BACKOFF_RUN_LOOKBACK = 5;   // log2(MAX_POW_BACKOFF_MODIFIER)
const SW_MAX_U64 = 18446744073709551615n; // 2^64 - 1

/**
 * Tracks the trailing run of same-algorithm blocks so that the backoff modifier
 * can be derived from headers alone (port of `PowBackoffTracker`).
 */
class PowBackoffTracker {
    constructor() {
        this.last = null;    // Option<PowAlgorithm>
        this.runLen = 0;     // saturated at SW_MAX_BACKOFF_RUN_LOOKBACK
    }

    /**
     * The modifier a block of `algo` would pay when appended to the tracked
     * chain. A `cap` of 1 (or 0) disables the backoff entirely, which is how
     * pre-fork behaviour is preserved. The result is always capped at
     * SW_M_MAX regardless of `cap`.
     */
    modifierFor(algo, cap) {
        cap = BigInt(cap);
        if (cap <= 1n) return 1n;
        if (this.last !== null && this.last === algo) {
            let m = 2n ** BigInt(this.runLen);
            if (m > cap) m = cap;
            if (m > SW_M_MAX) m = SW_M_MAX;
            return m;
        }
        return 1n;
    }

    /** Appends a block of `algo` to the tracked chain. */
    push(algo) {
        if (this.last === algo) {
            // Saturate so that 2^runLen can never overflow; any run longer than
            // the lookback is capped anyway.
            this.runLen = Math.min(this.runLen + 1, SW_MAX_BACKOFF_RUN_LOOKBACK);
        } else {
            this.last = algo;
            this.runLen = 1;
        }
    }

    lastAlgo() {
        return this.last;
    }

    runLength() {
        return this.runLen;
    }
}

/**
 * LWMA variant for TIP-RFC-MT-0004 (port of `LinearWeightedMovingAverage` as
 * modified by tari PR #7960). Returns the UNADJUSTED target; the caller applies
 * the backoff multiplier to obtain the mining target and stores both values via
 * add(timestamp, target, adjustedTarget).
 */
class LwmaWindowSW {
    constructor(blockWindow, targetTime, minDifficulty, maxDifficulty) {
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        if (blockWindow <= 0) throw new Error('blockWindow must be > 0');
        this.blockWindow = blockWindow;
        this.targetTime = BigInt(targetTime);
        this.maxBlockTime = this.targetTime * SW_LWMA_MAX_BLOCK_TIME_RATIO;
        this.minDifficulty = BigInt(minDifficulty);
        this.maxDifficulty = BigInt(maxDifficulty);
        // FIFO (index 0 = oldest). Entries: {timestamp, target, adjustedTarget}.
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

    add(timestamp, target, adjustedTarget) {
        this.samples.push({
            timestamp: BigInt(timestamp),
            target: BigInt(target),
            adjustedTarget: BigInt(adjustedTarget),
        });
        if (this.samples.length > this.blockWindow + 1) {
            this.samples.shift();
        }
    }

    /// Resizes the block window, dropping the oldest entries if the window
    /// shrank (port of `update_block_window`; needed at the 90 -> 45 fork).
    updateBlockWindow(blockWindow) {
        if (blockWindow <= 0) {
            throw new Error('blockWindow must be > 0');
        }
        this.blockWindow = blockWindow;
        while (this.samples.length > blockWindow + 1) {
            this.samples.shift();
        }
    }

    /**
     * Exact port of `raw_difficulty()` + `TargetDifficultyWindow::calculate_pair`'s
     * base clamping: computes the unadjusted target and clamps it into
     * [minDifficulty, maxDifficulty], or returns null where Rust returns None
     * (insufficient data, zero weighted times, or a target below Difficulty::min()).
     */
    calculate() {
        if (this.samples.length <= 1) return null;

        const n = BigInt(this.samples.length - 1);

        // Average difficulty: skip the oldest entry (its modifier is never read;
        // it only opens the first gap).
        let difficultySum = 0n;
        for (let i = 1; i < this.samples.length; i++) {
            difficultySum += this.samples[i].target;
        }
        const avgDifficulty = difficultySum / n;

        const maxScaledBlockTime = this.maxBlockTime * SW_M_MAX;
        const maxRawSolveTime = maxScaledBlockTime * SW_M_MAX;

        let weightedTimes = 0n;
        let prevTimestamp = this.samples[0].timestamp;

        for (let i = 1; i < this.samples.length; i++) {
            const sample = this.samples[i];

            // Enforce strictly increasing timestamps (monotonicity fix).
            let thisTimestamp = sample.timestamp;
            if (thisTimestamp <= prevTimestamp) {
                thisTimestamp = prevTimestamp + 1n;
            }

            // Cap the raw solve time BEFORE scaling (lossless: anything above
            // this bound normalises/clamps down regardless).
            let rawSolveTime = thisTimestamp - prevTimestamp;
            if (rawSolveTime > maxRawSolveTime) {
                rawSolveTime = maxRawSolveTime;
            }
            prevTimestamp = thisTimestamp;

            // Normalise by the *effective* modifier adjustedTarget/target.
            const target = sample.target;
            const adjustedTarget = sample.adjustedTarget > target
                ? sample.adjustedTarget
                : target;
            const scaledSolveTime = (rawSolveTime * SW_M_MAX * target) / adjustedTarget;
            const clampedScaled = scaledSolveTime > maxScaledBlockTime
                ? maxScaledBlockTime
                : scaledSolveTime;

            weightedTimes += clampedScaled * BigInt(i);
        }

        if (weightedTimes === 0n) return null;

        // k = n*(n+1)*targetTime*M_MAX/2, scaled by M_MAX to match weightedTimes.
        const k = (n * (n + 1n) * this.targetTime * SW_M_MAX) / 2n;

        let target = (avgDifficulty * k) / weightedTimes;

        // u64::try_from(...).unwrap_or(u64::MAX)
        if (target > SW_MAX_U64) target = SW_MAX_U64;

        // Below Difficulty::min(), Rust returns None (caller falls back to min).
        if (target < 1n) return null;

        // TargetDifficultyWindow::calculate_pair base clamping.
        if (target < this.minDifficulty) target = this.minDifficulty;
        if (target > this.maxDifficulty) target = this.maxDifficulty;

        return target;
    }
}

if (typeof window !== 'undefined') {
    window.LwmaWindowSW = LwmaWindowSW;
    window.PowBackoffTracker = PowBackoffTracker;
    window.SW_M_MAX = SW_M_MAX;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LwmaWindowSW,
        PowBackoffTracker,
        SW_M_MAX,
        SW_LWMA_MAX_BLOCK_TIME_RATIO,
        SW_MAX_BACKOFF_RUN_LOOKBACK,
        SW_MAX_U64,
    };
}
