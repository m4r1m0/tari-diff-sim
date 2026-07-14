# Tari Difficulty Algorithm Simulation

A client-side web application that simulates how Tari's difficulty adjustment algorithm (LWMA) with the proposed TIP-004 consecutive block penalty would have performed under real network conditions. Uses actual historical block data extracted from a Tari mainnet node via gRPC.

**No server required.** Download the folder and open `index.html` in any browser. All computation runs client-side in JavaScript.

---

## Table of Contents

1. [Data Source](#data-source)
2. [LWMA Algorithm](#lwma-algorithm)
3. [TIP-004 Consecutive Block Penalty](#tip-004-consecutive-block-penalty)
4. [Mining Competition Model](#mining-competition-model)
5. [Simulation Parameters](#simulation-parameters)
6. [Validation](#validation)
7. [Scenarios](#scenarios)
8. [Statistics & Confidence Intervals](#statistics--confidence-intervals)
9. [Assumptions & Limitations](#assumptions--limitations)

---

## Data Source

Block data was extracted from a local Tari mainnet node (Tari Universe) via gRPC.

- **Block range:** 294,400–296,521 (2,122 blocks total)
  - Blocks 294,400–294,999: **warm-up** (seeds LWMA windows and hash rate estimates)
  - Blocks 295,000–296,521: **analysis range** (1,522 blocks, ~3.5 days)
- **Fields kept per block:** `height`, `timestamp`, `pow_algo`, `difficulty`
- **Stripped fields:** `grpc_address`, `extraction_time`, `tip_height`, `algo_name`, and all per-algo hash rate estimates (`sha3x_hr`, `randomxm_hr`, `randomxt_hr`, `cuckaroo_hr`) — not used by the simulation (hash rates are estimated from actual solve times instead)
- **No identifying information** is included — only block heights, timestamps, PoW algorithm, and target difficulty

---

## LWMA Algorithm

The LWMA implementation is a direct port of Tari's Rust source (`base_layer/core/src/proof_of_work/lwma_diff.rs`, `development` branch). It was verified to produce **100% exact matches** against actual network difficulties (see [Validation](#validation)).

### Formula

For each PoW algorithm, the LWMA maintains a FIFO window of `(timestamp, difficulty)` pairs. The window holds `blockWindow + 1` samples (i.e., `blockWindow` intervals).

```
n = num_samples - 1                          (number of intervals)
avg_diff = sum(difficulty[1..n]) / n         (average difficulty, excluding oldest)

weighted_times = 0
prev_ts = samples[0].timestamp
for i in 1..n:
    this_ts = samples[i].timestamp
    if this_ts <= prev_ts: this_ts = prev_ts + 1    (enforce strictly increasing)
    solve_time = min(this_ts - prev_ts, max_block_time)
    prev_ts = this_ts
    weighted_times += solve_time * i          (linearly weighted: most recent = highest weight)

if weighted_times == 0: weighted_times = 1

k = n * (n + 1) * target_time / 2             (sum of weights × target_time)
target = avg_diff * k / weighted_times

target = clamp(target, min_difficulty, max_difficulty)
```

**Canonical form:**

```
target = (avg_difficulty × n×(n+1)/2 × target_time) / Σ(min(solveTime_i, 6×target_time) × i)
```

### Constants (mainnet)

| Constant              | Value                        | Source                          |
|-----------------------|------------------------------|---------------------------------|
| `target_time`         | 480 seconds (all algos)      | Consensus constants via gRPC   |
| `max_block_time`      | `target_time × 6` = 2,880s   | `LWMA_MAX_BLOCK_TIME_RATIO = 6` |
| `max_difficulty`      | 18,446,744,073,709,551,615   | `u64::MAX`                      |
| `difficulty_block_window` | 90 (current production)  | Consensus constants via gRPC   |

### Per-algorithm minimum difficulties

| Algo       | min_difficulty   |
|------------|------------------|
| RandomXM   | 1,200,000        |
| Sha3x      | 150,000,000,000  |
| RandomXT   | 1,200,000        |
| Cuckaroo   | 1                |

### Implementation notes

- All arithmetic uses JavaScript `BigInt` to handle u64-range difficulties without precision loss
- The window is a FIFO array: new samples pushed to the end, oldest shifted from the front when full
- `target_time` can be dynamically updated via `updateTargetTime()` — this is how the TIP-004 penalty is applied
- When `target_time` changes, `max_block_time` is also recalculated as `target_time × 6`

---

## TIP-004 Consecutive Block Penalty

**Source:** [RFC PR #174](https://github.com/tari-project/rfcs/pull/174) — `TIP-RFC-MT-0004_MinoTari_PoW_Difficulty_changes.md`

### Mechanism

When a PoW algorithm mines a block, and the previous block(s) in the main chain were also mined by the same algorithm, the **target time for that algorithm is doubled** for each consecutive block:

```
effective_target_time = base_target_time × 2^consecutive_count
```

Where `consecutive_count` = number of immediately preceding blocks in the main chain mined by the same algorithm.

### Example (Sha3x, base target = 8 min)

| Consecutive blocks | Target time | Effect                          |
|--------------------|-------------|---------------------------------|
| 0 (different algo) | 8 min       | Normal                          |
| 1                  | 16 min      | 2× harder to mine next Sha3x    |
| 2                  | 32 min      | 4× harder                       |
| 3                  | 64 min      | 8× harder                       |

When a different algorithm mines a block, the penalty **resets** to the base target time.

### Effect on difficulty

Since `target ∝ target_time` in the LWMA formula, doubling the target time doubles the computed target difficulty. This makes consecutive same-algo blocks exponentially more expensive to mine.

### Effect on mining competition

In the mining competition model, doubling an algo's target difficulty **halves its mining rate** (`rate = hashRate / targetDiff`). This reduces its probability of winning the next block, making it likely that another algorithm mines instead — naturally preventing consecutive blocks.

---

## Mining Competition Model

At each block slot, all 4 algos "race" in parallel. Each algo has:

- A **target difficulty** (from its LWMA, with penalty applied if it mined the last block(s))
- An **estimated hash rate** (from actual network data)

The **mining rate** for each algo is:

```
rate_i = hashRate_i / targetDiff_i    (blocks per second)
```

The **total rate** is the sum of all algos' rates. The time to the next block follows an **exponential distribution**:

```
expected_block_time = 1 / total_rate
```

The **winning algorithm** is sampled from a **categorical distribution**:

```
P(algo i wins) = rate_i / total_rate
```

The **block time** is sampled from an **exponential distribution** with rate `total_rate`:

```
block_time = -ln(U) / total_rate    where U ~ Uniform(0, 1)
```

### Hash rate estimation

Hash rates are estimated from actual network data using a **rolling window** of the last 20 blocks per algorithm:

```
hashRate_i = sum(recent_difficulties_i) / sum(recent_solve_times_i)
```

Where `solve_time` is the time between consecutive blocks of the **same** algorithm (not main chain block time). This is consistent with the Poisson process model: the expected time between consecutive algo-i blocks is `D_i / H_i`, so `H_i = D_i / T_i`.

Hash rates are updated at each step with **actual** block data (regardless of which algo wins the simulated competition). This reflects the assumption that hash rates are exogenous — they don't change based on the difficulty algorithm.

### Rate computation (BigInt precision)

Since difficulties can exceed `Number.MAX_SAFE_INTEGER`, rates are computed using BigInt division with a precision multiplier:

```
scaled_rate = (sumDiff × 10^9) / (sumTime × targetDiff)
rate = Number(scaled_rate) / 10^9
```

This preserves sufficient precision for the categorical and exponential sampling.

### PRNG

Random numbers are generated using **xoshiro128\*\*** (xoshiro128 star-star), a fast 32-bit PRNG with good statistical properties.

By default, each simulation run uses a fixed seed (1–30), ensuring **reproducible results** — anyone who downloads the files gets the exact same 30 runs, CIs, and charts. This is critical for auditing and sharing.

A **"Re-randomize Seeds"** button is provided in the settings bar. Clicking it generates a random `baseSeed` (0–999,999) and re-runs all simulations with seeds `baseSeed+1` through `baseSeed+30`, producing a fresh set of results while keeping the same window range.

---

## Simulation Parameters

| Parameter            | Value  | Description                                                      |
|----------------------|--------|------------------------------------------------------------------|
| `WARMUP_BLOCKS`      | 600    | Blocks used to seed LWMA windows and hash rate estimates         |
| `NUMBER_OF_RUNS`    | 30     | Independent simulation runs per scenario (for confidence intervals) |
| `HASH_RATE_WINDOW`  | 20     | Rolling window size for hash rate estimation (blocks per algo)   |
| `RATE_PRECISION`     | 10^9   | BigInt precision multiplier for rate computation                 |
| `PENALTY_BASE`       | 2n     | Exponential backoff base for TIP-004 penalty (2^n)              |
| Default window range | 30–60  | LWMA window sizes simulated (step 5)                             |
| Block height range   | 295000–296521 | Analysis range (after warm-up)                           |

### Warm-up phase

The first 600 blocks (heights 294,400–294,999) are used to:
1. Populate each algo's LWMA window with actual `(timestamp, difficulty)` pairs
2. Build the rolling hash rate history from actual solve times

During warm-up, all scenarios use actual data. The simulation phase starts at block 295,000.

---

## Validation

The LWMA engine is validated by **replaying actual block timestamps** through the JS implementation and comparing computed difficulties to actual network difficulties.

### Method

1. For each block, add `(timestamp, difficulty)` to the corresponding algo's LWMA window
2. Compute the LWMA target difficulty using the current window
3. Compare to the block's actual difficulty
4. Only compare when the window is **full** (91 samples = 90 intervals) — early blocks with partial windows won't match the actual node (which had full windows from earlier blocks)

### Results

| Metric          | Value     |
|-----------------|-----------|
| Total compared  | 1,758     |
| Exact matches   | 1,758     |
| Match rate      | 100.00%   |
| Max rel error   | 0.0000%   |

All 4 algorithms show 100% exact match rate, confirming the JS implementation is identical to Tari's Rust LWMA.

---

## Scenarios

Scenarios are generated dynamically by `generateScenarios(minWindow, maxWindow, step)`:

1. **Actual (LWMA-90)** — baseline, uses actual historical data (no simulation)
2. **LWMA-{w} + Penalty** — for each window size `w` in the range, with TIP-004 penalty

Default range: 30–60, step 5 → 7 penalty scenarios + 1 baseline = 8 total.

The range is adjustable via the **Settings bar** at the top of the page. Click "Run Simulations" to regenerate with a new range. Click "Re-randomize Seeds" to re-run with fresh random seeds while keeping the same window range.

### What each scenario isolates

- **Window size effect**: Compare Actual (90 blocks) vs LWMA-30/45/60+Penalty — smaller windows respond faster to hash rate changes
- **Penalty effect**: The penalty prevents consecutive same-algo blocks, reducing variance and balancing algo distribution

---

## Statistics & Confidence Intervals

### Per-run statistics

For each simulation run, the following statistics are computed:

- **Mean block time** — average main chain block time
- **Median** — 50th percentile
- **Std dev** — standard deviation
- **CV** — coefficient of variation (std/mean), measures relative dispersion
- **P90, P99** — 90th and 99th percentile block times
- **Min, Max** — extreme values
- **Algo counts** — blocks mined by each algorithm
- **Consecutive max** — longest run of same-algo blocks

### Aggregation across runs

Each statistic is aggregated across 30 runs:

- **Mean** — average across runs
- **CI** — 95% confidence interval: `mean ± 1.96 × std / √n`
- **Median run** — the run whose mean block time is closest to the median across all runs; used for difficulty chart visualization

### Charts

- **Block time comparison chart** shows the **median run** (the run closest to the median mean block time — averaging across runs collapses the exponential noise to a flat line around the target, hiding the actual block-time variation patterns)
- **Difficulty comparison chart** also shows the **median run** (different algos have different difficulty scales, so averaging across runs with different winners is meaningless)
- **Individual trial charts** (collapsible) show all 30 runs as separate small line charts, with the median run highlighted
- **Summary table** shows mean ± CI for each statistic

---

## Assumptions & Limitations

1. **Hash rates are exogenous** — hash rates are estimated from actual data and do not change based on the simulated difficulty algorithm. In reality, miners may switch algos based on profitability, creating a feedback loop. This is a standard simplification in difficulty algorithm simulations.

2. **Block time distribution** — block times are sampled from an exponential distribution (Poisson process), which is the correct model for PoW mining. The actual network also follows this distribution.

3. **Algo sequence is simulated** — the winning algo at each step is determined by the mining competition, not replayed from actual data. This is the key improvement over the replay approach: the penalty actually prevents consecutive same-algo blocks.

4. **No miner behavior model** — the simulation does not model miners joining/leaving based on profitability. Hash rates are fixed inputs from actual data.

5. **Warm-up dependency** — the first 600 blocks use actual data to seed the LWMA windows. Results are only meaningful for the analysis range (blocks 295,000+).

6. **Per-algo hash rate units** — hash rates for different algorithms are in different units (e.g., Sha3x hashes vs Cuckaroo cycles). The rate computation (`hashRate / targetDiff`) normalizes these to "blocks per second," which is consistent across algos.

7. **Stochastic results** — each run produces different results due to random sampling. The 30-run aggregation with CIs provides statistical confidence, but individual runs may vary. Default seeds (1–30) ensure reproducibility; use the Re-randomize button for fresh runs.
