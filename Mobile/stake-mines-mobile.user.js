// ==UserScript==
// @name Stake.us Mines Auto + Helper (Mobile Userscripts)
// @namespace https://github.com/userscripts
// @version 1.1
// @description Mobile Userscripts counterpart for Stake Mines with compact overlay controls, touch-safe placement, and live stats.
// @author .
// @match https://stake.us/casino/games/mines*
// @match https://stake.com/casino/games/mines*
// @grant none
// @inject-into page
// @run-at document-end
// ==/UserScript==

(function () {
    'use strict';
    let isRunning = false;

    const gui = document.createElement('div');
    gui.id = 'mines-auto-gui';
    gui.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        background: linear-gradient(135deg, #2a2a3a, #1e1e2e); color: #e0e0e0; padding: 12px;
        border-radius: 8px; border: 1px solid #3a3a4a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        width: min(320px, calc(100vw - 20px)); max-width: calc(100vw - 20px);
        min-width: 220px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        cursor: move; user-select: none; transition: box-shadow 0.3s ease;
    `;
    gui.innerHTML = `
        <div data-drag-handle="true" style="font-weight: 600; margin-bottom: 8px; text-align: center; color: #bb86fc; font-size: 1em; touch-action: none;">
            Mines Auto + Helper
        </div>
        <div style="display: flex; align-items: center; margin: 6px 0;">
            <label style="flex: 1; color: #b0b0b0; font-size: 0.9em;">Min:</label>
            <input id="minPicks" type="number" value="3" min="1" max="24" style="width: 60px; padding: 4px; border: 1px solid #4a4a5a; border-radius: 4px; background: #1a1a2a; color: #e0e0e0;">
        </div>
        <div style="display: flex; align-items: center; margin: 6px 0;">
            <label style="flex: 1; color: #b0b0b0; font-size: 0.9em;">Max:</label>
            <input id="maxPicks" type="number" value="8" min="1" max="24" style="width: 60px; padding: 4px; border: 1px solid #4a4a5a; border-radius: 4px; background: #1a1a2a; color: #e0e0e0;">
        </div>
        <div style="display: flex; align-items: center; margin: 6px 0;">
            <label style="flex: 1; color: #b0b0b0; font-size: 0.9em;">Speed:</label>
            <input id="speedSlider" type="range" min="1" max="100" value="85" style="width: 100px; accent-color: #bb86fc;">
            <span id="speedValue" style="margin-left: 8px; font-weight: 600; color: #bb86fc; font-size: 0.9em;">85</span>
        </div>
        <div style="margin: 10px 0; text-align: center;">
            <button id="btnStart" style="background: linear-gradient(135deg, #03dac6, #018786); color: #fff; border: none; padding: 6px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; font-size: 0.9em;">
                START
            </button>
            <button id="btnStop" style="background: linear-gradient(135deg, #ff0266, #c2185b); color: #fff; border: none; padding: 6px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; display: none; transition: transform 0.2s, box-shadow 0.2s; font-size: 0.9em;">
                STOP
            </button>
        </div>
        <div id="status" style="font-size: 0.8em; color: #a0a0a0; text-align: center; min-height: 1.2em;"></div>
        <div style="margin-top: 12px; border-top: 1px solid #3a3a4a; padding-top: 8px;">
            <div style="font-weight: 600; margin-bottom: 6px; text-align: center; color: #4CAF50; font-size: 0.95em;">
                Live Stats
            </div>
            <p style="margin: 4px 0; font-size: 0.9em;">Multiplier: <span id="mult" style="font-weight: bold; color: #2196F3;">N/A</span>×</p>
            <p style="margin: 4px 0; font-size: 0.9em;">Payout: <span id="pout" style="font-weight: bold; color: #2196F3;">N/A</span></p>
            <p style="margin: 4px 0; font-size: 0.9em;">Next Gem Chance: <span id="chance" style="font-weight: bold; color: #2196F3;">N/A</span>%</p>
        </div>
    `;
    document.body.appendChild(gui);

    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    [btnStart, btnStop].forEach(btn => {
        btn.addEventListener('mouseover', () => {
            btn.style.transform = 'scale(1.05)';
            btn.style.boxShadow = '0 3px 8px rgba(0,0,0,0.3)';
        });
        btn.addEventListener('mouseout', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = 'none';
        });
    });

    const isMobileViewport = () => window.innerWidth <= 768 || window.matchMedia('(pointer: coarse)').matches;

    function positionGui() {
        if (isMobileViewport()) {
            gui.style.left = '10px';
            gui.style.right = '10px';
            gui.style.top = 'auto';
            gui.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 10px)';
            gui.style.maxHeight = '50vh';
            gui.style.overflowY = 'auto';
            gui.style.cursor = 'default';
            return;
        }
        gui.style.left = (window.innerWidth - gui.offsetWidth - 30) + 'px';
        gui.style.top = '40px';
        gui.style.right = 'auto';
        gui.style.bottom = 'auto';
        gui.style.maxHeight = '';
        gui.style.overflowY = '';
        gui.style.cursor = 'move';
    }

    let isDragging = false, currentX = 0, currentY = 0, initialX = 0, initialY = 0;
    const isHandle = (target) => Boolean(target.closest('[data-drag-handle="true"]'));
    const startDrag = (clientX, clientY) => {
        initialX = clientX - currentX;
        initialY = clientY - currentY;
        isDragging = true;
        gui.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
    };
    const dragMove = (clientX, clientY) => {
        currentX = clientX - initialX;
        currentY = clientY - initialY;
        gui.style.left = currentX + 'px';
        gui.style.top = currentY + 'px';
        gui.style.right = 'auto';
        gui.style.bottom = 'auto';
    };
    gui.addEventListener('mousedown', (e) => {
        if (!isHandle(e.target) || isMobileViewport()) return;
        startDrag(e.clientX, e.clientY);
    });
    gui.addEventListener('touchstart', (e) => {
        if (!isHandle(e.target)) return;
        const touch = e.touches[0];
        if (!touch) return;
        e.preventDefault();
        startDrag(touch.clientX, touch.clientY);
    }, { passive: false });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        dragMove(e.clientX, e.clientY);
    });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        if (!touch) return;
        e.preventDefault();
        dragMove(touch.clientX, touch.clientY);
    }, { passive: false });
    const endDrag = () => {
        isDragging = false;
        gui.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
    };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag, { passive: true });

    positionGui();
    window.addEventListener('resize', positionGui);

    const status = document.getElementById('status');
    const speedSlider = document.getElementById('speedSlider');
    const speedValue = document.getElementById('speedValue');

    speedSlider.addEventListener('input', () => {
        speedValue.textContent = speedSlider.value;
        speedValue.style.color = speedSlider.value > 90 ? '#ff0266' :
                                 speedSlider.value > 70 ? '#ff5722' :
                                 speedSlider.value > 40 ? '#ff9800' : '#03dac6';
    });

    function setStatus(txt, color = '#a0a0a0') {
        status.textContent = txt;
        status.style.color = color;
    }

    function getDelayFactor() {
        const val = parseInt(speedSlider.value);
        return Math.max(0.18, 3.8 - (val / 100) * 3.62);
    }

    function randomDelay(baseMin, baseMax) {
        const factor = getDelayFactor();
        const min = Math.round(baseMin * factor);
        const max = Math.round(baseMax * factor);
        return Math.max(30, Math.floor(Math.random() * (max - min + 1)) + min);
    }

    function clickPlay() {
        const el = document.querySelector('[data-testid="bet-button"]');
        return el ? (el.click(), true) : false;
    }

    function clickCashout() {
        const el = document.querySelector('[data-testid="cashout-button"]');
        return el ? (el.click(), true) : false;
    }

    function clickRandomTile() {
        const idleButtons = document.querySelectorAll('button[data-game-tile-status="idle"]');
        if (idleButtons.length === 0) return false;
        const randomIdx = Math.floor(Math.random() * idleButtons.length);
        idleButtons[randomIdx].click();
        return true;
    }

    async function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function weightedRandom(min, max) {
        const base = 1.5;
        let weights = [];
        let total = 0;
        for (let i = min; i <= max; i++) {
            let w = Math.pow(base, max - i);
            weights.push(w);
            total += w;
        }
        let r = Math.random() * total;
        let sum = 0;
        for (let idx = 0; idx < weights.length; idx++) {
            sum += weights[idx];
            if (r < sum) {
                return min + idx;
            }
        }
        return max;
    }

    async function doOneRound() {
        if (!isRunning) return;
        setStatus('Waiting for PLAY...');
        while (isRunning && !clickPlay()) {
            await delay(10);
        }
        if (!isRunning) return;
        setStatus('Starting round...');
        await delay(randomDelay(380, 820));

        const min = parseInt(document.getElementById('minPicks').value) || 3;
        const max = parseInt(document.getElementById('maxPicks').value) || 12;
        const picks = weightedRandom(min, max);
        setStatus(`Doing ${picks} random tile clicks...`);
        for (let i = 0; i < picks; i++) {
            if (!isRunning) return;
            if (!clickRandomTile()) {
                setStatus('No more idle tiles, proceeding...', '#ff9800');
                break;
            }
        }
        // Wait for Stake to return all tile statuses
        if (isRunning) {
            await delay(randomDelay(220, 620));
        }

        if (isRunning) {
            await delay(randomDelay(80, 220));
            if (!clickCashout()) {
                setStatus('CASHOUT failed, continuing...', '#ff9800');
            }
        }
    }

    async function runLoop() {
        while (isRunning) {
            await doOneRound();
        }
    }

    function startBot() {
        if (isRunning) return;
        isRunning = true;
        btnStart.style.display = 'none';
        btnStop.style.display = 'inline-block';
        setStatus(`Running – speed ${speedSlider.value}${speedSlider.value >= 95 ? ' (MAX)' : ''}`, '#03dac6');
        runLoop();
    }

    function stopBot() {
        isRunning = false;
        btnStart.style.display = 'inline-block';
        btnStop.style.display = 'none';
        setStatus('Stopped', '#ff0266');
    }

    btnStart.onclick = startBot;
    btnStop.onclick = stopBot;
    window.addEventListener('beforeunload', stopBot);

    function updateInfo() {
        let mines = NaN;
        const minesSelect = document.querySelector('select[data-testid="mines-count"]');
        if (minesSelect) mines = parseInt(minesSelect.value);

        let gems = NaN;
        const gemsInput = document.querySelector('input[type="text"][readonly]:not([data-testid="profit-input"])');
        if (gemsInput) gems = parseInt(gemsInput.value);

        let multiplier = NaN;
        const labels = document.querySelectorAll('span[slot="label"]');
        for (const label of labels) {
            const text = label.textContent || '';
            if (text.includes('×')) {
                const multMatch = text.match(/([\d.,]+)×/);
                if (multMatch) {
                    multiplier = parseFloat(multMatch[1].replace(/,/g, ''));
                    break;
                }
            }
        }

        let payout = NaN;
        const payoutInput = document.querySelector('input[data-testid="profit-input"]');
        if (payoutInput) payout = parseFloat(payoutInput.value);

        let chance = 'N/A';
        if (!isNaN(gems) && !isNaN(mines) && (gems + mines) > 0) {
            chance = ((gems / (gems + mines)) * 100).toFixed(2);
        }

        document.getElementById('mult').textContent = isNaN(multiplier) ? 'N/A' : multiplier.toFixed(2);
        document.getElementById('pout').textContent = isNaN(payout) ? 'N/A' : payout.toFixed(2);
        document.getElementById('chance').textContent = chance;
    }

    setInterval(updateInfo, 1000);
    updateInfo();
})();
