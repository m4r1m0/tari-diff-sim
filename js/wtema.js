'use strict';

/**
 * WTEMA (Weighted Target EMA) difficulty adjustment.
 *
 * Zawy's current recommendation for per-chain difficulty (zawy12/difficulty-algorithms#76):
 *   target = prior_target * (1 + (t/T - 1)/N)
 *
 * where t = the lane's previous solve time, T = target block time, N = smoothing
 * constant (the EMA "filter"). WTEMA is the linearization (e^x ≈ 1+x) of relative
 * ASERT, so it gives near-identical results while staying entirely in integer math
 * (no b-spline e^x approximation -> no cross-CPU fork risk).
 *
 * Formula (integer-exact). The sim works on a "difficulty" axis (higher = harder),
 * so Zawy's target-axis update target = prior*(1 + t/T/N - 1/N) (higher target =
 * EASIER on slow blocks) is inverted to its difficulty form:
 *   t = ts[n] - ts[n-1]                        // previous solve time of this lane
 *   t = clamp(t, 1, 6*T)                       // same 6T bound as Tari's LWMA
 *   D_next = D_last * (N*T + T - t) / (N*T)    // slow (t>T) -> easier, fast -> harder
 *   D_next = clamp(D_next, minDifficulty, maxDifficulty)
 *
 * The factor (N*T + T - t) / (N*T) is positive for N >= 6 (t <= 6T), and the
 * per-block movement is bounded: a fast block (t = 1) raises difficulty by about
 * 1/N, a slow block (t = 6T) lowers it by up to 5/N. This bounded, correcting
 * response is the algorithm's built-in protection against hashrate spikes and
 * timestamp manipulation.
 *
 * Like Tari's LWMA, this only feeds on actual mined blocks, so it has a 1-block
 * delay; but unlike a moving average it reacts on the very next block instead of
 * waiting for old window samples to age out.
 *
 * Only the previous two samples of the lane need to be kept (no window).
 */

const WTEMA_MAX_BLOCK_TIME_RATIO = 6n;

class WtemaWindow {
    constructor(N, targetTime, minDifficulty, maxDifficulty) {
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        if (N <= 0) throw new Error('N must be > 0');
        if (N < 6) throw new Error('N must be >= 6 so the 6*T clamp keeps the update factor positive');
        this.N = BigInt(N);
        this.targetTime = BigInt(targetTime);
        this.maxBlockTime = this.targetTime * WTEMA_MAX_BLOCK_TIME_RATIO;
        this.minDifficulty = BigInt(minDifficulty);
        this.maxDifficulty = BigInt(maxDifficulty);
        // Only the last two (timestamp, difficulty) samples of the lane are needed.
        this.samples = [];
    }

    get numSamples() {
        return this.samples.length;
    }

    get isFull() {
        return this.samples.length >= 2;
    }

    setBaseTargetTime(targetTime) {
        targetTime = BigInt(targetTime);
        if (targetTime <= 0n) throw new Error('targetTime must be > 0');
        this.targetTime = targetTime;
        this.maxBlockTime = targetTime * WTEMA_MAX_BLOCK_TIME_RATIO;
    }

    add(timestamp, difficulty) {
        timestamp = BigInt(timestamp);
        difficulty = BigInt(difficulty);
        this.samples.push({ timestamp, difficulty });
        if (this.samples.length > 2) {
            this.samples.shift();
        }
    }

    calculate() {
        if (this.samples.length <= 1) return null;

        const prev = this.samples[0];
        const last = this.samples[1];

        // Enforce strictly increasing timestamps (same +1s rule as Tari's LWMA).
        let thisTimestamp = last.timestamp;
        if (thisTimestamp <= prev.timestamp) {
            thisTimestamp = prev.timestamp + 1n;
        }

        // Previous solve time of this lane, clamped to [1, 6*T].
        let t = thisTimestamp - prev.timestamp;
        if (t < 1n) t = 1n;
        if (t > this.maxBlockTime) t = this.maxBlockTime;

        const N = this.N;
        const T = this.targetTime;

        // D_next = D_last * (N*T + T - t) / (N*T), in exact integer math.
        // Fast block (t < T): factor > 1 -> harder (chokes a hashrate burst).
        // Slow block (t > T): factor < 1 -> easier (tracks hashrate drops).
        let target = (last.difficulty * (N * T + T - t)) / (N * T);

        if (target < this.minDifficulty) target = this.minDifficulty;
        if (target > this.maxDifficulty) target = this.maxDifficulty;

        return target;
    }
}

if (typeof window !== 'undefined') {
    window.WtemaWindow = WtemaWindow;
    window.WTEMA_MAX_BLOCK_TIME_RATIO = WTEMA_MAX_BLOCK_TIME_RATIO;
}