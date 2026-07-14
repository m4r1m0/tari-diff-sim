'use strict';

// LWMA-90 replay validation — verifies the JS LWMA engine matches actual
// network difficulties. Do not modify; this is a verified validation tool.

function validateLWMA(blocks) {
    const windows = {};
    for (const algoId of [0, 1, 2, 3]) {
        const cfg = ALGO_CONFIG[algoId];
        const w = new LwmaWindow(90, cfg.targetTime, cfg.minDifficulty, MAX_DIFFICULTY);
        w.setBaseTargetTime(cfg.targetTime);
        windows[algoId] = w;
    }

    const comparisons = [];
    let exactMatch = 0;
    let total = 0;
    let maxRelErr = 0;

    for (const b of blocks) {
        const algo = b.pow_algo;
        const w = windows[algo];
        const actualDiff = BigInt(b.difficulty);

        const computed = w.calculate();
        if (computed !== null && w.isFull) {
            const diff = computed - actualDiff;
            const absErr = diff < 0n ? -diff : diff;
            let relPct = 0;
            if (actualDiff > 0n) {
                relPct = Number((absErr * 10000n) / actualDiff) / 100;
            }
            const same = absErr === 0n;
            if (same) exactMatch++;
            if (relPct > maxRelErr) maxRelErr = relPct;
            total++;

            comparisons.push({
                algo, algoName: ALGO_NAMES[algo], height: b.height,
                actual: actualDiff.toString(), computed: computed.toString(),
                absErr: absErr.toString(), relErrPct: relPct, same,
            });
        }

        w.add(b.timestamp, actualDiff);
    }

    const perAlgo = {};
    for (const algoId of [0, 1, 2, 3]) {
        const ac = comparisons.filter(c => c.algo === algoId);
        let matched = 0, maxR = 0, sumR = 0;
        for (const c of ac) {
            if (c.same) matched++;
            if (c.relErrPct > maxR) maxR = c.relErrPct;
            sumR += c.relErrPct;
        }
        perAlgo[algoId] = {
            name: ALGO_NAMES[algoId], count: ac.length, matched,
            matchRate: ac.length > 0 ? (matched / ac.length) * 100 : 0,
            avgErr: ac.length > 0 ? sumR / ac.length : 0, maxErr: maxR,
        };
    }

    return {
        total, exactMatch,
        matchRate: total > 0 ? (exactMatch / total) * 100 : 0,
        maxRelErr, perAlgo, comparisons,
    };
}

if (typeof window !== 'undefined') {
    window.validateLWMA = validateLWMA;
}
