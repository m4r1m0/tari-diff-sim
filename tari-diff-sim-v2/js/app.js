'use strict';

/**
 * Application bootstrap and UI event handlers.
 * Orchestrates simulation runs, chart rendering, zoom controls,
 * trial sections, and scenario settings.
 */

const { ANALYSIS_START_HEIGHT, ANALYSIS_END_HEIGHT, ZOOM_STEP, MIN_ZOOM_DELTA,
        DEFAULT_MIN_WINDOW, DEFAULT_MAX_WINDOW, DEFAULT_STEP, MIN_STEP,
        INIT_DELAY_MS } = CONFIG;

const App = (function() {
    let blocks = null;
    let simulationData = null;
    let validationResults = null;
    let currentAlgo = 0;
    let selectedScenarios = [];
    let currentBaseSeed = 0;
    let currentScenarios = null;


    function init() {
        blocks = window.BLOCKS_DATA.blocks;
        const loading = document.getElementById('loading');

        setTimeout(async () => {
            try {
                validationResults = validateLWMA(blocks);
                currentScenarios = Simulation.generateScenarios(
                    DEFAULT_MIN_WINDOW, DEFAULT_MAX_WINDOW, DEFAULT_STEP
                );
                simulationData = await runSimulationsWithProgress(currentScenarios, currentBaseSeed);
            } catch (error) {
                loading.innerHTML = `<div class="error">Error: ${error.message}<br><pre>${error.stack}</pre></div>`;
                return;
            }

            initializeSelectedScenarios();
            initScenarioCheckboxes();
            initAlgoSelector();
            initTabs();
            initZoomBars();
            initSettingsBar();
            initTrialSections();

            Charts.renderSummaryTable(simulationData);
            Charts.renderValidation(validationResults);

            renderTabCharts('tab-baseline');
            loading.style.display = 'none';
        }, INIT_DELAY_MS);
    }


    // --- Simulation runner ---

    async function runSimulationsWithProgress(scenarios, baseSeed) {
        const loading = document.getElementById('loading');
        const loadingText = document.getElementById('loadingText');
        loading.style.display = 'flex';

        const result = await Simulation.runAllAsync(blocks, scenarios, (current, total) => {
            loadingText.textContent = `Running simulations... ${current}/${total} scenarios`;
        }, baseSeed);

        loadingText.textContent = 'Rendering...';
        return result;
    }


    // --- Scenario selection ---

    function initializeSelectedScenarios() {
        selectedScenarios = [simulationData.scenarios[0]];
        const simulatedScenarios = simulationData.scenarios.filter(scenario => !scenario.baseline);
        if (simulatedScenarios.length > 0) selectedScenarios.push(simulatedScenarios[0]);
        if (simulatedScenarios.length > 1) selectedScenarios.push(simulatedScenarios[Math.floor(simulatedScenarios.length / 2)]);
        if (simulatedScenarios.length > 2) selectedScenarios.push(simulatedScenarios[simulatedScenarios.length - 1]);
    }

    function initScenarioCheckboxes() {
        const containerIds = ['scenarioCheckboxes', 'scenarioCheckboxesDiff'];
        for (const containerId of containerIds) {
            const container = document.getElementById(containerId);
            if (!container) continue;
            container.innerHTML = '';
            for (const scenario of simulationData.scenarios) {
                const isChecked = selectedScenarios.find(existing => existing.id === scenario.id);
                const checkboxId = `${containerId}_chk_${scenario.id}`;
                container.innerHTML += `
                    <label class="scenario-toggle">
                        <input type="checkbox" id="${checkboxId}" data-scenario="${scenario.id}" ${isChecked ? 'checked' : ''}>
                        <span class="color-dot" style="background:${scenario.color}"></span>
                        ${scenario.label}
                    </label>`;
            }
            container.querySelectorAll('input[type=checkbox]').forEach(checkbox => {
                checkbox.addEventListener('change', () => handleScenarioToggle(checkbox, containerId, containerIds));
            });
        }
    }

    function handleScenarioToggle(checkbox, currentContainerId, allContainerIds) {
        const scenarioId = checkbox.dataset.scenario;
        const scenario = simulationData.scenarios.find(item => item.id === scenarioId);

        if (checkbox.checked && !selectedScenarios.find(item => item.id === scenarioId)) {
            selectedScenarios.push(scenario);
        } else if (!checkbox.checked) {
            selectedScenarios = selectedScenarios.filter(item => item.id !== scenarioId);
        }

        syncCheckboxAcrossContainers(scenarioId, checkbox.checked, currentContainerId, allContainerIds);
        rerenderComparisonIfVisible();
    }

    function syncCheckboxAcrossContainers(scenarioId, isChecked, excludeContainerId, allContainerIds) {
        for (const containerId of allContainerIds) {
            if (containerId === excludeContainerId) continue;
            const otherCheckbox = document.querySelector(`#${containerId} input[data-scenario="${scenarioId}"]`);
            if (otherCheckbox) otherCheckbox.checked = isChecked;
        }
    }


    // --- Algo selector ---

    function initAlgoSelector() {
        const selector = document.getElementById('algoSelector');
        if (!selector) return;
        selector.addEventListener('change', (event) => {
            currentAlgo = parseInt(event.target.value);
            rerenderComparisonIfVisible();
            rerenderDifficultyTrialsIfOpen();
        });
    }

    function rerenderDifficultyTrialsIfOpen() {
        const details = document.getElementById('trialDifficulty');
        if (!details || !details.open) return;
        renderTrialForSection('trialGridDifficulty', 'trialSelectDifficulty', 'difficulty');
    }


    // --- Tab switching ---

    function initTabs() {
        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', () => {
                document.querySelectorAll('.tab-button').forEach(tab => tab.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                button.classList.add('active');
                const tabId = button.dataset.tab;
                document.getElementById(tabId).classList.add('active');
                renderTabCharts(tabId);
            });
        });
    }


    // --- Zoom controls ---

    function initZoomBars() {
        document.querySelectorAll('.zoom-bar').forEach(zoomBar => {
            const minInput = zoomBar.querySelector('.zoom-min');
            const maxInput = zoomBar.querySelector('.zoom-max');
            const minValueDisplay = zoomBar.querySelector('.zoom-min-val');
            const maxValueDisplay = zoomBar.querySelector('.zoom-max-val');
            const resetButton = zoomBar.querySelector('.zoom-reset');

            minInput.addEventListener('input', () => {
                let minHeight = parseInt(minInput.value);
                const maxHeight = parseInt(maxInput.value);
                if (minHeight >= maxHeight) {
                    minHeight = maxHeight - MIN_ZOOM_DELTA;
                    minInput.value = minHeight;
                }
                minValueDisplay.textContent = minHeight;
                syncZoomBars(minHeight, maxHeight, zoomBar);
                Charts.applyZoom(minHeight, maxHeight);
            });

            maxInput.addEventListener('input', () => {
                const minHeight = parseInt(minInput.value);
                let maxHeight = parseInt(maxInput.value);
                if (maxHeight <= minHeight) {
                    maxHeight = minHeight + MIN_ZOOM_DELTA;
                    maxInput.value = maxHeight;
                }
                maxValueDisplay.textContent = maxHeight;
                syncZoomBars(minHeight, maxHeight, zoomBar);
                Charts.applyZoom(minHeight, maxHeight);
            });

            resetButton.addEventListener('click', () => {
                minInput.value = ANALYSIS_START_HEIGHT;
                maxInput.value = ANALYSIS_END_HEIGHT;
                minValueDisplay.textContent = ANALYSIS_START_HEIGHT;
                maxValueDisplay.textContent = ANALYSIS_END_HEIGHT;
                syncZoomBars(ANALYSIS_START_HEIGHT, ANALYSIS_END_HEIGHT, zoomBar);
                Charts.resetZoom();
            });
        });
    }

    function syncZoomBars(minHeight, maxHeight, excludeBar) {
        document.querySelectorAll('.zoom-bar').forEach(zoomBar => {
            if (zoomBar === excludeBar) return;
            zoomBar.querySelector('.zoom-min').value = minHeight;
            zoomBar.querySelector('.zoom-max').value = maxHeight;
            zoomBar.querySelector('.zoom-min-val').textContent = minHeight;
            zoomBar.querySelector('.zoom-max-val').textContent = maxHeight;
        });
    }


    // --- Settings bar (re-run simulations) ---

    function initSettingsBar() {
        const runButton = document.getElementById('runSimulations');
        const rerandomizeButton = document.getElementById('rerandomize');
        if (!runButton) return;

        runButton.addEventListener('click', async () => {
            const minWindow = parseInt(document.getElementById('minWindow').value) || DEFAULT_MIN_WINDOW;
            const maxWindow = parseInt(document.getElementById('maxWindow').value) || DEFAULT_MAX_WINDOW;
            const step = parseInt(document.getElementById('stepWindow').value) || DEFAULT_STEP;

            if (minWindow >= maxWindow || step < MIN_STEP) {
                alert('Invalid range: ensure Min < Max and Step >= 1');
                return;
            }

            currentScenarios = Simulation.generateScenarios(minWindow, maxWindow, step);
            simulationData = await runSimulationsWithProgress(currentScenarios, currentBaseSeed);
            await afterRerun();
        });

        if (rerandomizeButton) {
            rerandomizeButton.addEventListener('click', async () => {
                currentBaseSeed = Math.floor(Math.random() * 1000000);
                const currentScenariosToUse = currentScenarios || Simulation.generateScenarios(
                    DEFAULT_MIN_WINDOW, DEFAULT_MAX_WINDOW, DEFAULT_STEP
                );
                simulationData = await runSimulationsWithProgress(currentScenariosToUse, currentBaseSeed);
                await afterRerun();
            });
        }

        async function afterRerun() {
            Charts.destroyTrialCharts('trialGridBlockTime');
            Charts.destroyTrialCharts('trialGridDifficulty');
            document.getElementById('trialBlockTime').open = false;
            document.getElementById('trialDifficulty').open = false;

            initializeSelectedScenarios();
            initScenarioCheckboxes();
            populateTrialSelectors();
            Charts.renderSummaryTable(simulationData);

            const activeTab = document.querySelector('.tab-button.active');
            if (activeTab) renderTabCharts(activeTab.dataset.tab);

            document.getElementById('loading').style.display = 'none';
        }
    }


    // --- Trial sections ---

    function initTrialSections() {
        populateTrialSelectors();

        const sections = [
            { detailsId: 'trialBlockTime', gridId: 'trialGridBlockTime', selectId: 'trialSelectBlockTime', chartType: 'blocktime' },
            { detailsId: 'trialDifficulty', gridId: 'trialGridDifficulty', selectId: 'trialSelectDifficulty', chartType: 'difficulty' },
        ];

        for (const section of sections) {
            const details = document.getElementById(section.detailsId);
            const selector = document.getElementById(section.selectId);
            if (!details || !selector) continue;

            details.addEventListener('toggle', () => {
                if (details.open) {
                    renderTrialForSection(section.gridId, section.selectId, section.chartType);
                } else {
                    Charts.destroyTrialCharts(section.gridId);
                }
            });

            selector.addEventListener('change', () => {
                if (details.open) {
                    renderTrialForSection(section.gridId, section.selectId, section.chartType);
                }
            });
        }
    }

    function populateTrialSelectors() {
        const selectorIds = ['trialSelectBlockTime', 'trialSelectDifficulty'];
        for (const selectorId of selectorIds) {
            const selector = document.getElementById(selectorId);
            if (!selector) continue;
            const previousValue = selector.value;
            selector.innerHTML = '';
            for (const scenario of simulationData.scenarios) {
                if (!scenario.baseline) {
                    selector.innerHTML += `<option value="${scenario.id}">${scenario.label}</option>`;
                }
            }
            if (previousValue && [...selector.options].some(option => option.value === previousValue)) {
                selector.value = previousValue;
            }
        }
    }

    function renderTrialForSection(gridId, selectId, chartType) {
        const selector = document.getElementById(selectId);
        if (!selector) return;
        const scenarioId = selector.value;
        Charts.renderTrialCharts(gridId, simulationData, scenarioId, chartType, currentAlgo);
    }


    // --- Tab chart rendering ---

    function renderTabCharts(tabId) {
        switch (tabId) {
            case 'tab-baseline':
                Charts.renderBaselineBlockTimesOverall(blocks, simulationData.warmup);
                Charts.renderBaselineBlockTimesByAlgo(blocks, simulationData.warmup);
                Charts.renderBaselineDifficulty(blocks, simulationData.warmup);
                break;
            case 'tab-blocktime':
                Charts.renderBlockTimeComparison(simulationData, selectedScenarios);
                break;
            case 'tab-difficulty':
                Charts.renderDifficultyComparison(simulationData, selectedScenarios, currentAlgo);
                break;
            case 'tab-lanesplit':
                Charts.renderAlgoSplit(blocks, simulationData.warmup, simulationData, simulationData.scenarios);
                break;
        }
    }

    function rerenderComparisonIfVisible() {
        if (document.getElementById('tab-blocktime').classList.contains('active')) {
            Charts.renderBlockTimeComparison(simulationData, selectedScenarios);
        }
        if (document.getElementById('tab-difficulty').classList.contains('active')) {
            Charts.renderDifficultyComparison(simulationData, selectedScenarios, currentAlgo);
        }
    }


    return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
