'use strict';

const Charts = (function() {
    const chartInstances = {};

    function destroy(id) {
        if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
    }

    function get(id, config) {
        destroy(id);
        const ctx = document.getElementById(id);
        if (!ctx) return null;
        chartInstances[id] = new Chart(ctx, config);
        return chartInstances[id];
    }

    function downsample(data, maxPoints) {
        if (data.length <= maxPoints) return data;
        const step = Math.ceil(data.length / maxPoints);
        const result = [];
        for (let i = 0; i < data.length; i += step) result.push(data[i]);
        return result;
    }

    function fmtDifficulty(s) {
        const n = Number(s);
        if (!isFinite(n)) return s;
        if (n >= 1e15) return (n / 1e15).toFixed(2) + 'P';
        if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toFixed(0);
    }

    function fmtDuration(s) {
        if (s < 60) return s.toFixed(0) + 's';
        if (s < 3600) return (s / 60).toFixed(1) + 'm';
        return (s / 3600).toFixed(1) + 'h';
    }

    function fmtStat(val, ci) {
        if (ci && ci > 0) return `${fmtDuration(val)} \u00b1${fmtDuration(ci)}`;
        return fmtDuration(val);
    }

    const ALGO_LABELS = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
    const ALGO_SHORT = ['RXM', 'Sha', 'RXT', 'Cuc'];
    const ALGO_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#e67e22'];

    function getMedianRun(simData, scenarioId) {
        const sr = simData.results[scenarioId];
        if (!sr || !sr.runs || sr.runs.length === 0) return [];
        return sr.runs[sr.medianRunIndex] || sr.runs[0];
    }

    let zoomState = { min: null, max: null };

    function makeXScale() {
        const config = { type: 'linear', title: { display: true, text: 'Block Height', color: '#ccc' }, ticks: { color: '#999', maxTicksLimit: 12 }, grid: { color: '#333' } };
        if (zoomState.min !== null) { config.min = zoomState.min; config.max = zoomState.max; }
        return config;
    }

    function makeScales(yLabel) {
        return {
            x: makeXScale(),
            y: { title: { display: true, text: yLabel, color: '#ccc' }, ticks: { color: '#999', callback: (v) => fmtDuration(v) }, grid: { color: '#333' } },
        };
    }

    function makeLogScales(yLabel) {
        return {
            x: makeXScale(),
            y: { type: 'logarithmic', title: { display: true, text: yLabel, color: '#ccc' }, ticks: { color: '#999', callback: (v) => fmtDifficulty(v) }, grid: { color: '#333' } },
        };
    }

    // --- Baseline ---

    function renderBaselineBlockTimesOverall(blocks, warmup) {
        const data = blocks.slice(warmup);
        const points = downsample(data.map(b => ({ x: b.height, y: b._mainChainBlockTime })), 800);
        get('chartBaselineBTOverall', {
            type: 'line',
            data: { datasets: [{ label: 'Block Time', data: points, borderColor: '#95a5a6', backgroundColor: '#95a5a620', borderWidth: 1.2, pointRadius: 0, tension: 0.2 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Actual Historical Block Times (All Blocks)', color: '#eee', font: { size: 14 } }, legend: { display: false }, tooltip: { callbacks: { label: (ctx) => fmtDuration(ctx.parsed.y) } } },
                scales: makeScales('Block Time (s)'),
            },
        });
    }

    function renderBaselineBlockTimesByAlgo(blocks, warmup) {
        const data = blocks.slice(warmup);
        const datasets = [];
        for (let algo = 0; algo < 4; algo++) {
            const ad = data.filter(b => b.pow_algo === algo);
            datasets.push({
                label: ALGO_LABELS[algo],
                data: downsample(ad.map(b => ({ x: b.height, y: b._mainChainBlockTime })), 300),
                borderColor: ALGO_COLORS[algo], backgroundColor: ALGO_COLORS[algo] + '20',
                borderWidth: 1.2, pointRadius: 0, tension: 0.2, spanGaps: false,
            });
        }
        get('chartBaselineBTByAlgo', {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Actual Block Times by Algorithm', color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtDuration(ctx.parsed.y)}` } } },
                scales: makeScales('Block Time (s)'),
            },
        });
    }

    function renderBaselineDifficulty(blocks, warmup) {
        const data = blocks.slice(warmup);
        const datasets = [];
        for (let algo = 0; algo < 4; algo++) {
            const ad = data.filter(b => b.pow_algo === algo);
            datasets.push({
                label: ALGO_LABELS[algo],
                data: downsample(ad.map(b => ({ x: b.height, y: Number(b.difficulty) })), 300),
                borderColor: ALGO_COLORS[algo], backgroundColor: ALGO_COLORS[algo] + '20',
                borderWidth: 1.2, pointRadius: 0, tension: 0.1, spanGaps: false,
            });
        }
        get('chartBaselineDifficulty', {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Actual Historical Difficulty (per algo)', color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtDifficulty(ctx.parsed.y)}` } } },
                scales: makeLogScales('Difficulty'),
            },
        });
    }

    // --- Comparison ---

    function renderBlockTimeComparison(simData, selectedScenarios) {
        const datasets = [];
        for (const s of selectedScenarios) {
            const run = getMedianRun(simData, s.id);
            const points = run.map(r => ({ x: r.height, y: r.simMainChainBT }));
            datasets.push({
                label: s.label + (simData.results[s.id].numRuns > 1 ? ` (median)` : ''),
                data: downsample(points, 600),
                borderColor: s.color, backgroundColor: s.color + '20',
                borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.15,
            });
        }
        if (selectedScenarios.length > 0) {
            const firstRun = getMedianRun(simData, selectedScenarios[0].id);
            if (firstRun.length > 0) {
                datasets.push({
                    label: 'Target (2 min)',
                    data: [
                        { x: firstRun[0].height, y: TARGET_BLOCK_TIME },
                        { x: firstRun[firstRun.length - 1].height, y: TARGET_BLOCK_TIME },
                    ],
                    borderColor: '#ffffff',
                    borderWidth: 1,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                });
            }
        }
        get('chartBlockTimeCompare', {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Block Time Comparison (Median Run)', color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtDuration(ctx.parsed.y)}` } } },
                scales: makeScales('Block Time (s)'),
            },
        });
    }

    function renderDifficultyComparison(simData, selectedScenarios, algoId) {
        const datasets = [];
        for (const s of selectedScenarios) {
            const run = getMedianRun(simData, s.id);
            const ad = run.filter(r => r.algo === algoId);
            const points = ad.map(r => ({ x: r.height, y: Number(r.simDifficulty) }));
            datasets.push({
                label: s.label + (simData.results[s.id].numRuns > 1 ? ` (median)` : ''),
                data: downsample(points, 400),
                borderColor: s.color, backgroundColor: s.color + '20',
                borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.1, spanGaps: false,
            });
        }
        get('chartDifficultyCompare', {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: `Difficulty Comparison \u2014 ${ALGO_LABELS[algoId]}`, color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtDifficulty(ctx.parsed.y)}` } } },
                scales: makeLogScales('Difficulty'),
            },
        });
    }

    // --- Algo / Lane Split ---

    function renderAlgoSplit(blocks, warmup, simData, selectedScenarios) {
        const data = blocks.slice(warmup);

        // Algo distribution comparison
        const scenarioLabels = selectedScenarios.map(s => s.label.length > 20 ? s.label.substring(0, 18) + '..' : s.label);
        const datasets = [];
        for (let algo = 0; algo < 4; algo++) {
            const counts = selectedScenarios.map(s => {
                const stats = simData.results[s.id].stats;
                return Math.round(stats.algoCounts[algo].mean);
            });
            datasets.push({
                label: ALGO_SHORT[algo],
                data: counts,
                backgroundColor: ALGO_COLORS[algo] + 'cc',
                borderColor: ALGO_COLORS[algo],
                borderWidth: 1,
            });
        }
        get('chartAlgoDistribution', {
            type: 'bar',
            data: { labels: scenarioLabels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Block Distribution by Algorithm (mean across runs)', color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } } },
                scales: {
                    x: { ticks: { color: '#ccc', maxRotation: 30, minRotation: 0 }, grid: { color: '#333' } },
                    y: { title: { display: true, text: 'Blocks', color: '#ccc' }, ticks: { color: '#999' }, grid: { color: '#333' } },
                },
            },
        });

        // Consecutive runs (from actual baseline)
        const runCounts = {};
        for (const b of data) {
            if (b._consecutive > 0) runCounts[b._consecutive] = (runCounts[b._consecutive] || 0) + 1;
        }
        const maxRun = Math.max(...Object.keys(runCounts).map(Number), 0);
        const labels = [], values = [];
        for (let i = 1; i <= Math.min(maxRun, 10); i++) { labels.push(`${i} consecutive`); values.push(runCounts[i] || 0); }
        if (maxRun > 10) { labels.push('10+'); values.push(Object.entries(runCounts).filter(([k]) => Number(k) > 10).reduce((s, [, v]) => s + v, 0)); }

        get('chartConsecutiveRuns', {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Count', data: values, backgroundColor: '#3498dbcc', borderColor: '#3498db', borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { title: { display: true, text: 'Consecutive Same-Algo Block Runs (Actual)', color: '#eee', font: { size: 14 } }, legend: { display: false } },
                scales: { x: { ticks: { color: '#ccc' }, grid: { color: '#333' } }, y: { title: { display: true, text: 'Occurrences', color: '#ccc' }, ticks: { color: '#999' }, grid: { color: '#333' } } },
            },
        });

        // Penalty multiplier (from LWMA-90+Penalty median run)
        const lwma90pRun = getMedianRun(simData, 'lwma90p');
        if (lwma90pRun && lwma90pRun.length > 0) {
            const penaltyPoints = lwma90pRun.filter(r => r.penaltyMultiplier > 1).map(r => ({ x: r.height, y: r.penaltyMultiplier }));
            get('chartPenaltyMultiplier', {
                type: 'scatter',
                data: { datasets: [{ label: 'Penalty Multiplier', data: penaltyPoints, backgroundColor: '#e74c3c80', borderColor: '#e74c3c', pointRadius: 3, pointHoverRadius: 6, showLine: false }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { title: { display: true, text: 'TIP-004 Penalty Multiplier (LWMA-90+Penalty, median run)', color: '#eee', font: { size: 14 } }, legend: { labels: { color: '#ccc' } }, tooltip: { callbacks: { label: (ctx) => `Block ${ctx.parsed.x}: ${ctx.parsed.y}x target time` } } },
                    scales: { x: { title: { display: true, text: 'Block Height', color: '#ccc' }, ticks: { color: '#999' }, grid: { color: '#333' } }, y: { title: { display: true, text: 'Target Time Multiplier', color: '#ccc' }, ticks: { color: '#999' }, grid: { color: '#333' } } },
                },
            });
        }
    }

    // --- Summary table ---

    function renderSummaryTable(simData) {
        const tbody = document.getElementById('summaryTableBody');
        if (!tbody) return;
        let html = '';
        for (const s of simData.scenarios) {
            const sr = simData.results[s.id];
            if (!sr || !sr.stats) continue;
            const st = sr.stats;
            const isActual = sr.numRuns === 1;
            const algoStr = [0,1,2,3].map(a => {
                const ac = st.algoCounts[a];
                const m = Math.round(ac.mean);
                return isActual ? `${ALGO_SHORT[a]}:${m}` : `${ALGO_SHORT[a]}:${m}\u00b1${Math.round(ac.ci)}`;
            }).join(' ');
            html += `<tr class="${s.baseline ? 'baseline-row' : ''}">
                <td>${s.label}${sr.numRuns > 1 ? ` <span class="runs-badge">${sr.numRuns} runs</span>` : ''}</td>
                <td>${st.count}</td>
                <td>${fmtStat(st.mean.mean, st.mean.ci)}</td>
                <td>${fmtStat(st.median.mean, st.median.ci)}</td>
                <td>${fmtStat(st.std.mean, st.std.ci)}</td>
                <td>${(st.cv.mean * 100).toFixed(1)}${st.cv.ci > 0 ? '\u00b1' + (st.cv.ci * 100).toFixed(1) : ''}%</td>
                <td>${fmtStat(st.p90.mean, st.p90.ci)}</td>
                <td>${fmtStat(st.p99.mean, st.p99.ci)}</td>
                <td>${fmtStat(st.max.mean, st.max.ci)}</td>
                <td class="algo-cell">${algoStr}</td>
            </tr>`;
        }
        tbody.innerHTML = html;
    }

    // --- Validation ---

    function renderValidation(validation) {
        const panel = document.getElementById('validationPanel');
        if (!panel) return;
        const passed = validation.matchRate >= 99.9 && validation.maxRelErr < 0.01;
        panel.innerHTML = `
            <div class="validation-badge ${passed ? 'good' : 'bad'}">${passed ? 'ENGINE VALIDATED' : 'VALIDATION FAILED'}</div>
            <div class="validation-stats">
                <div><span class="stat-label">Total blocks:</span> ${validation.total}</div>
                <div><span class="stat-label">Exact matches:</span> ${validation.exactMatch}</div>
                <div><span class="stat-label">Match rate:</span> ${validation.matchRate.toFixed(2)}%</div>
                <div><span class="stat-label">Max rel error:</span> ${validation.maxRelErr.toFixed(4)}%</div>
            </div>
            <table class="validation-table">
                <thead><tr><th>Algorithm</th><th>Count</th><th>Matched</th><th>Match Rate</th><th>Avg Error</th><th>Max Error</th></tr></thead>
                <tbody>
                    ${Object.values(validation.perAlgo).map(a => `<tr><td>${a.name}</td><td>${a.count}</td><td>${a.matched}</td><td>${a.matchRate.toFixed(2)}%</td><td>${a.avgErr.toFixed(4)}%</td><td>${a.maxErr.toFixed(4)}%</td></tr>`).join('')}
                </tbody>
            </table>
        `;
    }

    // --- Zoom ---

    function applyZoom(minH, maxH) {
        zoomState = { min: minH, max: maxH };
        for (const [id, chart] of Object.entries(chartInstances)) {
            if (chart.options.scales && chart.options.scales.x && chart.options.scales.x.type === 'linear') {
                chart.options.scales.x.min = minH;
                chart.options.scales.x.max = maxH;
                chart.update('none');
            }
        }
    }

    function resetZoom() {
        zoomState = { min: null, max: null };
        for (const [id, chart] of Object.entries(chartInstances)) {
            if (chart.options.scales && chart.options.scales.x && chart.options.scales.x.type === 'linear') {
                chart.options.scales.x.min = undefined;
                chart.options.scales.x.max = undefined;
                chart.update('none');
            }
        }
    }

    // --- Individual trial charts ---

    function destroyTrialCharts(containerId) {
        const prefix = containerId + '_run';
        for (const [id, chart] of Object.entries(chartInstances)) {
            if (id.startsWith(prefix)) {
                chart.destroy();
                delete chartInstances[id];
            }
        }
        const container = document.getElementById(containerId);
        if (container) container.innerHTML = '';
    }

    function renderTrialCharts(containerId, simData, scenarioId, chartType, algoId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        destroyTrialCharts(containerId);

        const sr = simData.results[scenarioId];
        if (!sr || !sr.runs || sr.numRuns <= 1) {
            container.innerHTML = '<p class="no-trials">No individual trials available (actual data is a single run).</p>';
            return;
        }

        for (let i = 0; i < sr.runs.length; i++) {
            const canvasId = `${containerId}_run${i}`;
            const wrapper = document.createElement('div');
            wrapper.className = 'trial-chart-wrapper';

            const run = sr.runs[i];
            const isMedianRun = (i === sr.medianRunIndex);
            const statsLabel = `<span class="trial-label">Run ${i + 1}${isMedianRun ? ' (median)' : ''}</span>`;

            wrapper.innerHTML = `<div class="trial-chart-canvas"><canvas id="${canvasId}"></canvas></div>${statsLabel}`;
            container.appendChild(wrapper);

            const points = chartType === 'blocktime'
                ? downsample(run.map(r => ({ x: r.height, y: r.simMainChainBT })), 400)
                : downsample(run.filter(r => r.algo === algoId).map(r => ({ x: r.height, y: Number(r.simDifficulty) })), 400);

            destroy(canvasId);
            const ctx = document.getElementById(canvasId);
            if (ctx) {
                chartInstances[canvasId] = new Chart(ctx, {
                    type: 'line',
                    data: { datasets: [{ label: `Run ${i + 1}`, data: points, borderColor: isMedianRun ? '#1abc9c' : '#7f8c8d', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, tension: 0.15 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => chartType === 'blocktime' ? fmtDuration(c.parsed.y) : fmtDifficulty(c.parsed.y) } } },
                        scales: chartType === 'blocktime' ? makeScales('BT') : makeLogScales('Diff'),
                        animation: false,
                    },
                });
            }
        }
    }

    return {
        renderBaselineBlockTimesOverall, renderBaselineBlockTimesByAlgo, renderBaselineDifficulty,
        renderBlockTimeComparison, renderDifficultyComparison,
        renderAlgoSplit, renderSummaryTable, renderValidation,
        applyZoom, resetZoom, renderTrialCharts, destroyTrialCharts,
    };
})();
