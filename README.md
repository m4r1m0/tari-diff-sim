# Tari Difficulty Algorithm Simulation

A client-side web application that simulates how Tari's difficulty adjustment algorithm would have performed under real network conditions. It compares **three designs side by side**:

1. **LWMA + Penalty (Original)** — Tari's per-algorithm LWMA with the initial TIP-004 consecutive-block penalty (per-algo, uncapped, "sticky").
2. **LWMA + Penalty (New)** — the accepted [TIP-RFC-MT-0004](https://github.com/tari-project/rfcs/pull/174) (per-algorithm penalty scope, capped at 32×, transient).
3. **WTEMA** — the research-recommended alternative: Zawy's exponential moving average difficulty ([#76](https://github.com/zawy12/difficulty-algorithms/issues/76)), run independently per algorithm **with no penalty**. This is the primary topic of the [Design Rationale](#wtema-scenario--design-rationale) section below.

Uses actual historical block data extracted from a Tari mainnet node via gRPC.

**No server required.** Download the folder and open `index.html` in any browser. All computation runs client-side in JavaScript.

---

## Table of Contents

1. [Data Source](#data-source)
2. [LWMA Algorithm](#lwma-algorithm)
3. [Penalty Proposals (Original vs New)](#penalty-proposals)
4. [WTEMA Scenario — Design Rationale](#wtema-scenario--design-rationale)
5. [Mining Competition Model](#mining-competition-model)
6. [Simulation Parameters](#simulation-parameters)
7. [Validation](#validation)
8. [Scenarios](#scenarios)
9. [Statistics & Confidence Intervals](#statistics--confidence-intervals)
10. [Assumptions & Limitations](#assumptions--limitations)
11. [Further reading: the chain-work "credit cap"](#further-reading-the-chain-work-credit-cap)

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

## Penalty Proposals

Both proposals make consecutive same-algo blocks exponentially more expensive to mine. They differ in **how the consecutive run is defined**, **whether the penalty is capped**, and **how the penalty interacts with the LWMA**.

### Original Proposal (sticky)

**Source:** initial TIP-004 formulation.

When a PoW algorithm mines a block, and the previous block(s) in the main chain were also mined by the **same algorithm**, the **target time for that algorithm is doubled** for each consecutive block:

```
effective_target_time = base_target_time × 2^consecutive_count
```

Where `consecutive_count` = number of immediately preceding blocks mined by the same algorithm. **No cap.** When a different algorithm mines, the penalty resets.

| Consecutive blocks | Target time | Effect                          |
|--------------------|-------------|---------------------------------|
| 0 (different algo) | 8 min       | Normal                          |
| 1                  | 16 min      | 2× harder to mine next Sha3x    |
| 2                  | 32 min      | 4× harder                       |
| 3                  | 64 min      | 8× harder                       |

**Sticky interaction with the LWMA:** the penalty is applied by inflating `target_time`, so `LwmaWindow.calculate()` returns an *adjusted* difficulty. That adjusted difficulty is then stored back into the LWMA window. The inflated difficulty therefore lingers in `avg_difficulty` until it ages out — the penalty is "sticky" and decays slowly after a run breaks.

### New Proposal — TIP-RFC-MT-0004 (accepted, transient)

**Source:** [RFC PR #174](https://github.com/tari-project/rfcs/pull/174) — `TIP-RFC-MT-0004_MinoTari_PoW_Difficulty_changes.md` (Last Modified 2026-08-19, Status: Accepted). Implemented in `js/lwma_sw.js` (`LwmaWindowSW`) and the `runCompetitionSW` path in `js/simulation.js`.

Three changes versus the Original:

1. **Per-algorithm penalty scope.** Each of the four algorithms (RxM, RxT, Sha3x, C29) is its own penalty scope. An RxM block followed by an RxT block **resets** the run and pays no penalty. An earlier draft grouped RxM and RxT into a single RandomX penalty class — both run on the same hardware, so a RandomX farm could otherwise alternate them for free — but the accepted TIP rejects that grouping: it is not neutral between algorithms (a combined class would hold roughly half of all blocks and pay ~1.47x expected penalty against ~1.15x for the others), and it dominates the block-time inflation (~8.4% vs ~1.7% with the algorithms separate). The cost of keeping them apart — RandomX capacity can alternate the two variants with no penalty at all, including on a private chain — is explicitly accepted under the TIP's single-algorithm threat model: the mechanism binds Sha3x and C29 in practice.

2. **Capped at 32×.** `m = min(2^(r-1), 32)` where `r` is the run length within the algorithm (including the block being mined). The cap is a liveness guarantee: if a single algorithm is ever the only active miner, an uncapped modifier would stall the chain indefinitely. The cap bounds that failure to a 32× slowdown (≈4.3 h/block at an 8 min base) and the chain resumes as soon as any other algorithm mines.

   | Run length `r` | Modifier `m` |
   |----------------|--------------|
   | 1              | 1            |
   | 2              | 2            |
   | 3              | 4            |
   | 4              | 8            |
   | 5              | 16           |
   | 6+             | 32 (capped)  |

3. **Transient, not sticky.** The LWMA always uses the **base** `target_time` and returns the **unadjusted** target difficulty. Each sample in the window carries the per-block modifier `m[i]`, and solve times are **normalized by `m[i]`** before entering the weighted sum (`solve_time[i] / m[i]`, normalize-then-clamp to the base bounds, integer-exact via `M_MAX = 32`). The mining target is `unadjusted × m`; the window stores the **unadjusted** difficulty + `m`. Because the inflated difficulty never enters `avg_difficulty`, the penalty affects only the block it applies to and **resets the instant a different algorithm mines** — no lingering inflation.

   **Implementation invariant:** with every modifier set to 1, `LwmaWindowSW.calculate()` is numerically identical to `LwmaWindow.calculate()`, so the warm-up phase (actual blocks, no penalty) behaves exactly like the Original. This is verified against actual mainnet difficulties (100% exact match).

### Difficulty display parity

For both proposals the recorded/displayed `simDifficulty` is the **adjusted** mining target (the difficulty the block was actually mined against), so the difficulty charts compare like-for-like. The behavioural difference is visible in the *shape*: the Original's difficulty stays elevated after a run and decays slowly (sticky), while the New proposal's difficulty spikes per-block and snaps back to baseline immediately (transient).

### Effect on mining competition

In the mining competition model, an algo's effective mining target is raised by `m`, which **lowers its mining rate** (`rate = hashRate / targetDiff`) and thus its probability of winning the next block — making it likely that another algorithm mines instead, which is what breaks the consecutive run.

---

## WTEMA Scenario — Design Rationale

This section explains **why WTEMA replaces the whole "change the LWMA parameters + add a penalty" approach** as the recommended design, and why it is the right instrument for Tari's structure: 4 independent PoW lanes, an 8-minute per-lane target (120 s combined), large hashrate swings, and the geometric-mean (product, no root) chain-work comparison between forks.

### What is implemented

The WTEMA scenario runs Zawy's **WTEMA** per algorithm, exactly as recommended in [zawy12/difficulty-algorithms #76](https://github.com/zawy12/difficulty-algorithms/issues/76). Zawy's update is on the *target* axis (`target = prior × (1 + t/T/N − 1/N)`, higher = easier, so slow blocks relax the target). The simulator works on the *difficulty* axis (higher = harder, the quantity that gates block rate), so the form implemented here is its inverted, integer-exact equivalent:

```
t = ts[n] - ts[n-1]                        // lane's own previous solve time
t = clamp(t, 1, 6*T)                       // same 6T bound as Tari's LWMA
D_next = D_last * (N*T + T - t) / (N*T)    // fast block (t<T) -> harder, slow -> easier
D_next = clamp(D_next, minDifficulty, maxDifficulty)
```

`T` = 480 s (per lane), `N` = the EMA smoothing constant (swept by the **Min/Max Window** slider: `WTEMA-30` … `WTEMA-60`). WTEMA is the linearization (`e^x ≈ 1 + x`) of relative ASERT, and every lane has its own independent WTEMA — per Zawy, keeping the per-algorithm difficulty calculation separate is "the best if not only correct way" for multi-PoW coins ([#69](https://github.com/zawy12/difficulty-algorithms/issues/69)).

Unlike Tari's LWMA, WTEMA keeps no window: only the lane's last two samples `(timestamp, difficulty)` are needed. It uses the lane's **previous** solve time (a 1-block delay, exactly like today's Tari DAA, matching blackwolfsa's note that "we only feed in the actual mined blocks") — there is no real-time timestamp feeding, so it avoids the "live timestamp" complications and self-referential difficulty drift discussed in the forum.

### The problem, decomposed: what a DAA actually can and cannot fix

Before comparing algorithms it is worth being explicit about the floor that **no** difficulty algorithm can move. With a healthy 2-minute combined target, interleaved lane arrivals are a Poisson process with rate 1/(120 s). Even with a *perfect* DAA:

- ~22% of blocks take > 3 min  (`e^(-3/2)`), median ≈ 83 s, mean 120 s, CV = 1
- long gaps grow slower than linearly in block time: a 6-minute gap is a ~5% event even when the network is perfectly healthy

This is why "block times are all over the place" is *mostly* a misread of exponential mining, not a difficulty bug — it is visible even on Bitcoin ([post 25](https://community.tari.com/t/update-taris-difficulty-algorithm/160/25)). The **fixable** component is DAA-induced: after a lane's hashrate surges or collapses, a slow DAA keeps the target wrong for hours, stretching the tail *beyond* the Poisson floor and letting burst miners reorg. The correct DAA metric is therefore the **excess tail** — P90/P99/max block time and difficulty overshoot — not the mean, which all sane algorithms keep near target (see [How to read the results](#how-to-read-the-results)).

### Why EMA-family, not LWMA / DGW / MultiShield

LWMA, DigiShield, DGW and MultiShield are all members of the moving-average family. Their shared defect is a **dead band**: when hashrate changes, the first several fast or slow blocks barely move the target, because the estimate is dominated by old samples that have already aged-in. Response time is the flip side of a smoothing window, and the LWMA/Digibyte-style "tempers" (weighting, clamping, median filters) only trade one lag profile for another. blackwolfsa's [post 15](https://community.tari.com/t/update-taris-difficulty-algorithm/160/15) is correct that swapping to DGW/MultiShield "won't change anything" — they are the same family with the same lag-vs-noise tradeoff, applied per-algo with a geometric-mean combination (which Tari already does).

An exponential filter has a fundamentally different response profile: because the estimate is *multiplicative* and uses only the most recent samples, the difficulty reacts to the next fast or slow block instead of waiting for a window to refill. Its per-block movement is also *bounded* by the update factor itself, which moving averages do not have. Zawy's current and unambiguous verdict for per-chain difficulty is WTEMA, because "every good algorithm gives almost identical results" ([#76](https://github.com/zawy12/difficulty-algorithms/issues/76)) — so the question is not "which of dozens of DAAs is best" but "use the simplest correct one with the right N."

### Why WTEMA and not full relative/absolute ASERT

ASERT (the `e^x` form) is mathematically slightly cleaner but requires a b-spline approximation of `e^x` **in integer math** so that every architecture computes the identical value — otherwise validators can disagree and fork. WTEMA's `1 + x` linearization keeps essentially the same stability with far less consensus-sensitive code (a single `mul`/`div`), which is a real engineering advantage for a chain that must run on GPUs, ASICs and heterogeneous validators. Zawy's EMA-Z analysis ([#17](https://github.com/zawy12/difficulty-algorithms/issues/17)) documents this tradeoff in detail.

### The two "optional" fixes that are actually unnecessary in WTEMA

1. **Shrinking the LWMA window** (90 → 45). This only works *because* the penalty was bolted on top; the window and the penalty are coupled. WTEMA replaces the whole question with a single N parameter whose meaning is the same as an EMA mean-life, so there is no separate window to tune.
2. **The consecutive-block penalty itself.** See [Why no penalty](#why-no-penalty).

### Selecting N

Under constant hashrate the difficulty std-dev of an EMA is approximately `1/√(2N)` ([#76](https://github.com/zawy12/difficulty-algorithms/issues/76)). Zawy's mapping for equal *response* to a moving average of window W is `N ≈ W / 2.3` ([#17](https://github.com/zawy12/difficulty-algorithms/issues/17)), but for *equal stability* an EMA with `N = 80` behaves like an SMA with `W = 144`. Because Tari's lanes have an 8-minute target, wall-clock response scales as `N × 8 min`, so a slightly larger N is affordable without the LWMA's sluggishness:

| N (WTEMA) | Difficulty noise (const. hashrate) | Approx. lane response (× 8 min) |
|-----------|------------------------------------|-------------------------------|
| 30        | ~12.9%                             | ~4 h                           |
| 45        | ~10.5%                             | ~6 h                           |
| 60        | ~9.1%                              | ~8 h                           |

**N = 45 is the default recommendation**: it matches the smoothness of today's LWMA-90 (`1/√90 ≈ 10.5%`) at roughly **half the wall-clock response**, while reacting on the very first changed block instead of waiting 12 hours of lane history. Sweep `30–60` (the slider's default) to see the noise/response tradeoff directly, and, per Zawy's guidance, err on the side of a larger N for a small coin: the reduction in tail variance from a larger N is usually worth the slower reaction to price/hashrate swings.

### Security properties

- **Bounded per-block movement.** The update factor ranges from `(1 + 1/N)` (at t = 1 s, a hashrate flood — difficulty can rise at most ~2.2% per block at `N = 45`) to `(1 − 5/N)` (at t = 6T, a hashrate collapse — difficulty falls at most ~11.1% per block). Because the correction is proportional and opposing, the estimate is mean-reverting rather than divergent: a block at half the target time raises difficulty by `+1/(2N)`, a block at double target time lowers it by `−1/N`, and so on. A hash flood therefore faces a target that climbs on the *next* block (limited to `+1/N` each), whereas an LWMA faces several blocks of a fresh flood at the *old* target before its window refills. This bounded, self-correcting response is the anti-burst property the penalty was trying to bolt on separately — and, critically, a wrong sign here diverges (the simulator reproduces the divergence for an inverted implementation), so the direction of correction is itself consensus-critical.
- **Chain work is untouched.** The accumulated-per-lane difficulty product (geomean without the root) that selects forks is still fed by the difficulty the blocks were actually mined at; WTEMA changes only *how* that difficulty is chosen. A single-lane attacker must still outgrow the sum of the other three lanes' relative work to reorg, per the RFC's own algebra.
- **No new header fields** — same as today; the next target is recomputed deterministically from the previous two blocks of the lane.

These properties are quantified in [How to read the results](#how-to-read-the-results).

### Why no penalty

The penalty scenarios are kept purely as a comparison baseline. The research — including the [PR #174 review thread](https://github.com/tari-project/rfcs/pull/174), stringhandler's review, and the sequence of m4r1m0's simulations this sim is based on — documents four independent reasons the backoff is the wrong instrument:

1. **It is evadable for fractionally diversified miners.** Penalty scope is per algorithm, so a miner holding capacity in any *two* algorithms alternates them and pays nothing; because RxM and RxT run on the same hardware, RandomX capacity is exempt in full — a RandomX farm can alternate the two variants indefinitely with no penalty at all, including while building a private chain. The accepted TIP concedes this explicitly: its threat model names single-algorithm Sha3x/C29 concentration as the target, so the mechanism binds only miners stuck in one lane.
2. **It still slows emission.** `E[solve_time] = E[m]·T`; the TIP's own corrected simulation puts the steady-state penalty at `E[m]≈1.16` with four algorithms live, inflating the mean block interval by ~1.7% (3.5% with three live). ~25% of main-chain blocks follow a same-algo block **by chance** — honest miners absorb the tax, which is not a security property, and the inflation lands on top of an already slow 3-min-realized block time.
3. **The accounting cancels the scheduling.** "Accumulated difficulty per unit time equals hashrate, regardless of the target" — over any window beyond a few blocks, doubling the target makes each block worth twice as much *and* take twice as long, so the work-gain ratio the attacker needs is unchanged. This is the core reason a target-time penalty cannot raise the real cost of selfish mining.
4. **It skews the estimator it depends on.** LWMA regresses solve times against target times over its window; a target jumping by powers of two injects noise the LWMA then reads back. The careful normalization/order-of-operations rules in the RFC are a patch for this interaction.

WTEMA needs no such mechanism because its bounded, immediate response already raises the cost of a burst at the *target* level — the layer where the attack actually operates. The whole "penalty vs no penalty" question is therefore moot once the DAA itself responds in one block.

### How to read the results

- **Mean block time**: all scenarios should sit near ~120–124 s. The mean is *not* the differentiator — it is pinned by the Poisson floor.
- **The DAA metric**: look at **P90 / P99 / Max** block time, **CV**, and the difficulty trail in the *Difficulty Comparison* tab around the known hashrate swings in blocks 295000–296521. WTEMA should cut the *tail* — fewer 6–20+ minute gaps — because its target tracks a vanished or arrived miner within a few blocks instead of a 6–12 hour lane window.
- **N sweep**: smaller N clips the tail harder but oscillates the difficulty more (`1/√(2N)`); larger N smooths but hugs the target more slowly. N = 45 is the default balance.
- The **Algo / Lane Split** tab now compares three families; WTEMA scenarios simply have no penalty-multiplier scatter (they have no penalty to scatter).

### Sources

- [zawy12/difficulty-algorithms #76 — "Best Difficulty Algorithm, Timestamp Rules, Selfish Mining, Selecting N"](https://github.com/zawy12/difficulty-algorithms/issues/76)
- [#69 — "Multishield's geometric mean to get chain work in Multi-POW coins"](https://github.com/zawy12/difficulty-algorithms/issues/69)
- [#17 — EMA-Z / ASERT family, N mapping, integer-math notes](https://github.com/zawy12/difficulty-algorithms/issues/17)
- [#14 — Selecting N based on coin experience and target solvetime](https://github.com/zawy12/difficulty-algorithms/issues/14)
- [RFC PR #174 (TIP-RFC-MT-0004) and its review thread](https://github.com/tari-project/rfcs/pull/174)
- [tari#7631 — the geometric-mean chain-work framing](https://github.com/tari-project/tari/issues/7631)
- [Tari community thread — "Update Tari's Difficulty Algorithm"](https://community.tari.com/t/update-taris-difficulty-algorithm/160)

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
| `PENALTY_BASE`       | 2n     | Exponential backoff base for both penalties (2^n)              |
| `PENALTY_CAP`        | 32n    | Cap on the New proposal modifier (`min(2^n, 32)`); Original is uncapped |
| Penalty scope        | per algorithm | New proposal run tracking: RxM, RxT, Sha3x, C29 each independent; an RxM→RxT sequence resets |
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
2. **LWMA-{w} + Penalty (Original)** — for each window size `w`, with the Original penalty (per-algo, uncapped, sticky)
3. **LWMA-{w} + Penalty (New)** — for each window size `w`, with the accepted TIP-004 penalty (per-algorithm scope, capped 32×, transient)
4. **WTEMA-{w} (EMA)** — for each `w`, Zawy's WTEMA run per algorithm with **no penalty**; the swept value is the EMA smoothing constant `N` (see [WTEMA Scenario — Design Rationale](#wtema-scenario--design-rationale))

Default range: 30–60, step 5 → 7 Original + 7 New + 7 WTEMA scenarios + 1 baseline = 22 total.

The range is adjustable via the **Settings bar** at the top of the page. Click "Run Simulations" to regenerate with a new range. Click "Re-randomize Seeds" to re-run with fresh random seeds while keeping the same window range.

### What each scenario isolates

- **Window size effect**: Compare Actual (90 blocks) vs LWMA-30/45/60+Penalty — smaller windows respond faster to hash rate changes
- **Penalty effect**: Both penalties prevent consecutive same-algo blocks, reducing variance and balancing algo distribution
- **Original vs New**: On the **Algo / Lane Split** tab, the *Penalty Multiplier* chart overlays the Original (uncapped `2^n`) against the New (capped at 32×) multipliers, making the cap visible. The difficulty charts show the Original's slow post-run decay versus the New's immediate reset.
- **WTEMA vs the penalties**: the same-sweep comparison isolates the DAA *family* from the scheduling penalty. WTEMA has no multiplier scatter (nothing to scatter) and instead shows the bounded per-block difficulty movement and faster tail response during the period's hashrate swings.

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

3. **Algo sequence is simulated** — the winning algo at each step is determined by the mining competition, not replayed from actual data. For the penalty scenarios, the penalty actually prevents consecutive same-algo blocks; the WTEMA scenarios rely on the algorithm's fast per-block response instead.

4. **No miner behavior model** — the simulation does not model miners joining/leaving based on profitability. Hash rates are fixed inputs from actual data.

5. **Warm-up dependency** — the first 600 blocks use actual data to seed the per-algo difficulty state (an LWMA window for the LWMA scenarios, or WTEMA's last-two-sample state). Results are only meaningful for the analysis range (blocks 295,000+).

6. **Per-algo hash rate units** — hash rates for different algorithms are in different units (e.g., Sha3x hashes vs Cuckaroo cycles). The rate computation (`hashRate / targetDiff`) normalizes these to "blocks per second," which is consistent across algos.

7. **Stochastic results** — each run produces different results due to random sampling. The 30-run aggregation with CIs provides statistical confidence, but individual runs may vary. Default seeds (1–30) ensure reproducibility; use the Re-randomize button for fresh runs.

---

## Further reading: the chain-work "credit cap"

A separate, complementary idea surfaced during the research that is **documented here for completeness but not implemented in this simulator**, because a no-fork competition model cannot observe it.

Tari selects the best tip between two competing forks by comparing the product of the four lanes' accumulated difficulties (the geometric mean without the n-th root). The comparison is effectively by *relative growth* — a tip wins when `x/Sha3 > y/C29 + z/RxT + w/RxM` for the latest blocks. [Issue #7631](https://github.com/tari-project/tari/issues/7631) identifies the residual risk this creates: if a single lane's difficulty is depressed (miners left), a big one-lane miner can burst several blocks each with a large *relative* difficulty, and the relative-growth comparison lets a short run outvote 20–100+ blocks mined by the other lanes.

The TIP-004 backoff attacks that vector by inflating the lane's **target** (the scheduling layer) — with the efficiency flaws described elsewhere in this README. The alternative is to cap the block's contribution to its lane's **accumulated** difficulty used in the fork comparison, e.g. credit `min(achieved, k × current_target)` or normalize by the lane's recent average difficulty. This is stringhandler's "fix belongs in the accounting, not the scheduling" and aligns with Zawy's probability-corrected update forms in [#17](https://github.com/zawy12/difficulty-algorithms/issues/17). Mining requirements are unchanged; only the fork-picking bookkeeping is capped, so a lone lane can never pump its relative work faster than the DAA can react.

It is **not implemented here** because the simulator models a single chain with a mining competition — there are no competing tips, so a credit cap has no observable effect in these numbers. It is also largely redundant once WTEMA is in place: WTEMA's bounded per-block movement (a burst of fast blocks raises the difficulty by at most `×(1 + 1/N)` per block, and the second block of the burst already mines at the raised target) stops a burst from getting its huge-relative-difficulty blocks cheaply in the first place. The credit cap is best understood as the defensive complement to keep in mind for the consensus layer (fork selection), not the difficulty adjustment layer that this simulator validates.
