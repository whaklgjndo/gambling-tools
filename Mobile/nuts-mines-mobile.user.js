// ==UserScript==
// @name         Nuts.gg Mines Auto (Mobile Userscripts)
// @namespace    https://github.com/userscripts
// @version      1.1
// @description  Mobile Userscripts counterpart for Nuts Mines with compact controls, touch-safe placement, and burst automation.
// @author       .
// @match        https://nuts.gg/mines*
// @match        https://*.nuts.gg/mines*
// @grant        none
// @inject-into  page
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';
    let isRunning = false;

    // ==================== HOLOGLASS GUI ====================
    const gui = document.createElement('div');
    gui.id = 'mines-auto-gui';
    gui.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        background: rgba(16, 20, 30, 0.45);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(0, 255, 255, 0.15);
        border-top: 1px solid rgba(0, 255, 255, 0.3);
        border-left: 1px solid rgba(0, 255, 255, 0.3);
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.05);
        color: #e0ffff; padding: 16px; border-radius: 16px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        width: min(340px, calc(100vw - 20px)); max-width: calc(100vw - 20px);
        min-width: 240px; cursor: move; user-select: none;
        transition: box-shadow 0.3s ease, transform 0.3s ease;
    `;

    const inputStyle = `
        width: 60px; padding: 6px; border: 1px solid rgba(0, 255, 255, 0.2);
        border-radius: 6px; background: rgba(0, 0, 0, 0.2); color: #00ffff;
        outline: none; text-shadow: 0 0 5px rgba(0, 255, 255, 0.4);
        font-weight: bold; text-align: center;
    `;

    gui.innerHTML = `
        <div data-drag-handle="true" style="font-weight: 700; margin-bottom: 12px; text-align: center; color: #00ffff; font-size: 1.1em; text-shadow: 0 0 10px rgba(0, 255, 255, 0.6), 0 0 20px rgba(0, 255, 255, 0.2); letter-spacing: 1px; touch-action: none;">
            ⬡ MINES BURST ⬡
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin: 8px 0;">
            <label style="color: rgba(224, 255, 255, 0.8); font-size: 0.9em; font-weight: 500;">Min Tiles:</label>
            <input id="minPicks" type="number" value="3" min="1" max="24" style="${inputStyle}">
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin: 8px 0;">
            <label style="color: rgba(224, 255, 255, 0.8); font-size: 0.9em; font-weight: 500;">Max Tiles:</label>
            <input id="maxPicks" type="number" value="8" min="1" max="24" style="${inputStyle}">
        </div>
        <div style="display: flex; align-items: center; margin: 12px 0;">
            <label style="flex: 1; color: rgba(224, 255, 255, 0.8); font-size: 0.9em; font-weight: 500;">Speed:</label>
            <input id="speedSlider" type="range" min="1" max="100" value="85" style="width: 100px; accent-color: #00ffff; cursor: pointer;">
            <span id="speedValue" style="margin-left: 10px; font-weight: 700; color: #00ffff; font-size: 0.9em; text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);">85</span>
        </div>
        <div style="margin: 16px 0 8px 0; text-align: center; display: flex; gap: 10px; justify-content: center;">
            <button id="btnStart" style="flex: 1; background: rgba(0, 255, 255, 0.1); border: 1px solid rgba(0, 255, 255, 0.4); color: #00ffff; padding: 8px; border-radius: 8px; font-weight: 700; cursor: pointer; transition: all 0.2s; text-shadow: 0 0 5px rgba(0, 255, 255, 0.5); box-shadow: 0 0 10px rgba(0, 255, 255, 0.1);">
                ENGAGE
            </button>
            <button id="btnStop" style="flex: 1; background: rgba(255, 0, 85, 0.1); border: 1px solid rgba(255, 0, 85, 0.4); color: #ff0055; padding: 8px; border-radius: 8px; font-weight: 700; cursor: pointer; display: none; transition: all 0.2s; text-shadow: 0 0 5px rgba(255, 0, 85, 0.5); box-shadow: 0 0 10px rgba(255, 0, 85, 0.1);">
                ABORT
            </button>
        </div>
        <div id="status" style="font-size: 0.8em; color: rgba(224, 255, 255, 0.6); text-align: center; min-height: 1.2em; font-weight: 500; letter-spacing: 0.5px;"></div>
    `;

    document.body.appendChild(gui);

    // ==================== INTERACTIVITY & FX ====================
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');

    btnStart.addEventListener('mouseover', () => {
        btnStart.style.background = 'rgba(0, 255, 255, 0.2)';
        btnStart.style.boxShadow = '0 0 15px rgba(0, 255, 255, 0.3)';
    });
    btnStart.addEventListener('mouseout', () => {
        btnStart.style.background = 'rgba(0, 255, 255, 0.1)';
        btnStart.style.boxShadow = '0 0 10px rgba(0, 255, 255, 0.1)';
    });

    btnStop.addEventListener('mouseover', () => {
        btnStop.style.background = 'rgba(255, 0, 85, 0.2)';
        btnStop.style.boxShadow = '0 0 15px rgba(255, 0, 85, 0.3)';
    });
    btnStop.addEventListener('mouseout', () => {
        btnStop.style.background = 'rgba(255, 0, 85, 0.1)';
        btnStop.style.boxShadow = '0 0 10px rgba(255, 0, 85, 0.1)';
    });

    const isMobileViewport = () => window.innerWidth <= 768 || window.matchMedia('(pointer: coarse)').matches;

    function positionGui() {
        if (isMobileViewport()) {
            gui.style.left = '10px';
            gui.style.right = '10px';
            gui.style.top = 'auto';
            gui.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 10px)';
            gui.style.maxHeight = '55vh';
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

    let isDragging = false, currentX = 0, currentY = 0;
    const isHandle = (target) => Boolean(target.closest('[data-drag-handle="true"]'));
    const startDrag = (clientX, clientY) => {
        isDragging = true;
        currentX = clientX - gui.offsetLeft;
        currentY = clientY - gui.offsetTop;
        gui.style.boxShadow = '0 12px 40px 0 rgba(0, 0, 0, 0.5), inset 0 0 20px rgba(0, 255, 255, 0.1)';
        gui.style.transform = 'scale(1.02)';
    };
    const moveDrag = (clientX, clientY) => {
        gui.style.left = (clientX - currentX) + 'px';
        gui.style.top = (clientY - currentY) + 'px';
        gui.style.right = 'auto';
        gui.style.bottom = 'auto';
    };
    gui.addEventListener('mousedown', e => {
        if (!isHandle(e.target) || isMobileViewport()) return;
        startDrag(e.clientX, e.clientY);
    });
    gui.addEventListener('touchstart', e => {
        if (!isHandle(e.target)) return;
        const touch = e.touches[0];
        if (!touch) return;
        e.preventDefault();
        startDrag(touch.clientX, touch.clientY);
    }, { passive: false });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        moveDrag(e.clientX, e.clientY);
    });
    document.addEventListener('touchmove', e => {
        if (!isDragging) return;
        const touch = e.touches[0];
        if (!touch) return;
        e.preventDefault();
        moveDrag(touch.clientX, touch.clientY);
    }, { passive: false });
    const endDrag = () => {
        isDragging = false;
        gui.style.boxShadow = '0 8px 32px 0 rgba(0, 0, 0, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.05)';
        gui.style.transform = 'scale(1)';
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
        const color = speedSlider.value > 90 ? '#ff0055' : speedSlider.value > 70 ? '#ffaa00' : '#00ffff';
        speedValue.style.color = color;
        speedValue.style.textShadow = `0 0 5px ${color}`;
    });

    function setStatus(txt, color = 'rgba(224, 255, 255, 0.6)') {
        status.textContent = txt;
        status.style.color = color;
    }

    // ==================== CORE LOGIC ====================
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

    function findButton(textContent, partial = false) {
        const texts = [textContent.toLowerCase()];
        if (partial) texts.push(textContent.toLowerCase().replace(/\s+/g,''));
        const candidates = document.querySelectorAll('button, div[role="button"], [class*="button" i], [class*="btn" i], [class*="play" i], [class*="cash" i]');
        for (const el of candidates) {
            let txt = (el.textContent || '').toLowerCase().trim();
            if (texts.some(t => partial ? txt.includes(t) : txt === t)) return el;
        }
        return null;
    }

    function clickPlay() { const el = findButton('PLAY') || findButton('play', true); return el ? (el.click(), true) : false; }
    function clickCashout() { const el = findButton('CASHOUT') || findButton('cashout', true); return el ? (el.click(), true) : false; }

    function getClickableTiles() {
        // Broadened selector slightly to ensure it catches standard Nut.gg tile classes
        return Array.from(document.querySelectorAll('div[class*="gtVEXU"]'))
            .filter(el => window.getComputedStyle(el).cursor === 'pointer' || (el.getAttribute('style') || '').includes('cursor: pointer'));
    }

    async function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function weightedRandom(min, max) {
        const base = 1.5;
        let weights = [], total = 0;
        for (let i = min; i <= max; i++) {
            let w = Math.pow(base, max - i);
            weights.push(w); total += w;
        }
        let r = Math.random() * total, sum = 0;
        for (let idx = 0; idx < weights.length; idx++) {
            sum += weights[idx];
            if (r < sum) return min + idx;
        }
        return max;
    }

    async function doOneRound() {
        if (!isRunning) return;

        setStatus('Initializing sequence...', 'rgba(224, 255, 255, 0.6)');
        while (isRunning && !clickPlay()) await delay(15);
        if (!isRunning) return;

        setStatus('Grid locked. Calculating coordinates...', '#00ffff');
        await delay(randomDelay(300, 700));

        const min = parseInt(document.getElementById('minPicks').value) || 3;
        const max = parseInt(document.getElementById('maxPicks').value) || 12;
        const targetAmount = weightedRandom(min, max);

        let availableTiles = getClickableTiles();

        if (availableTiles.length === 0) {
            setStatus('Grid sync error. Retrying...', '#ffaa00');
            return;
        }

        // Shuffle array to pick random distinct tiles
        const shuffled = availableTiles.sort(() => 0.5 - Math.random());
        const tilesToClick = shuffled.slice(0, Math.min(targetAmount, availableTiles.length));

        setStatus(`Executing burst on ${tilesToClick.length} sectors...`, '#00ffff');

        // Rapid fire loop
        for (let i = 0; i < tilesToClick.length; i++) {
            if (!isRunning) return;
            tilesToClick[i].click();
            // Tiny delay to ensure browser dispatches the click events properly
            await delay(randomDelay(15, 45));
        }

        setStatus('Awaiting payload resolution...', '#ffaa00');

        // Polling loop: Wait for the front-end to render the server's response
        let resolved = false;
        let timeoutCounter = 0;

        while (!resolved && timeoutCounter < 60 && isRunning) { // Max wait ~3 seconds
            await delay(50);
            timeoutCounter++;

            // Check 1: Did we hit a mine? Game over, PLAY button reappears.
            if (findButton('PLAY') || findButton('play', true)) {
                setStatus('Mine encountered. Resetting...', '#ff0055');
                resolved = true;
                break;
            }

            // Check 2: Have all clicked tiles updated their state? (No longer pointer)
            let stillPending = tilesToClick.filter(t => window.getComputedStyle(t).cursor === 'pointer').length;
            if (stillPending === 0) {
                resolved = true;
                break;
            }
        }

        if (isRunning && !findButton('PLAY') && !findButton('play', true)) {
            // Survived the burst and DOM updated
            setStatus('Sector clear. Extracting...', '#00ffff');
            await delay(randomDelay(120, 280));

            const cashed = clickCashout();
            setStatus(cashed ? 'Extraction successful' : 'Extraction error (skip)', cashed ? '#00ffff' : '#ffaa00');
        }
    }

    async function runLoop() {
        while (isRunning) await doOneRound();
    }

    function startBot() {
        if (isRunning) return;
        isRunning = true;
        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
        setStatus(`Sequence engaged. Max velocity.`, '#00ffff');
        runLoop();
    }

    function stopBot() {
        isRunning = false;
        btnStart.style.display = 'block';
        btnStop.style.display = 'none';
        setStatus('Sequence aborted.', '#ff0055');
    }

    btnStart.onclick = startBot;
    btnStop.onclick = stopBot;
    window.addEventListener('beforeunload', stopBot);
    setStatus('System standby. Awaiting engage.', 'rgba(224, 255, 255, 0.6)');
})();
