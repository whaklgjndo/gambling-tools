// ==UserScript==
// @name         Stake Keno Preset Manager (Mobile Userscripts)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Mobile Userscripts counterpart for Stake Keno presets. Save/load number + difficulty presets on stake.com and stake.us with touch-friendly controls.
// @author       .
// @match        https://stake.com/casino/games/keno*
// @match        https://stake.us/casino/games/keno*
// @grant        none
// @inject-into  page
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PRESETS_KEY = 'keno-presets';
    const TILE_SELECTOR = 'button[data-testid^="game-tile-"]';
    const RISK_SELECTOR = 'select[data-testid="game-difficulty"]';
    const RISK_VALUES = ['classic', 'low', 'medium', 'high'];

    function loadPresets() {
        try {
            const raw = localStorage.getItem(PRESETS_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    function savePresets(list) {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function getTiles() {
        return Array.from(document.querySelectorAll(TILE_SELECTOR));
    }

    // Picks are tracked from the user's own click events — Stake also sets
    // data-selected="true" on game-drawn HIT tiles during a round, so reading
    // that attribute reports hits as picks. Source of truth lives here.
    const userPicks = new Set();

    function readPicksFromDOM() {
        return getTiles()
            .filter(t => t.dataset.selected === 'true')
            .map(t => Number(t.dataset.index) + 1)
            .filter(n => !isNaN(n));
    }
    function syncPicksFromDOM() {
        userPicks.clear();
        for (const n of readPicksFromDOM()) userPicks.add(n);
    }
    function getSelectedNumbers() {
        return Array.from(userPicks).sort((a, b) => a - b);
    }
    function getRisk() {
        const el = document.querySelector(RISK_SELECTOR);
        return el ? el.value : null;
    }
    function setRisk(risk) {
        const el = document.querySelector(RISK_SELECTOR);
        if (!el || el.value === risk) return !!el;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, risk);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }
    function clickTile(number) {
        const tile = document.querySelector(`button[data-testid="game-tile-${number}"]`);
        if (!tile) return false;
        tile.click();
        return true;
    }

    async function applyPreset(preset) {
        if (!preset || !Array.isArray(preset.numbers)) return;
        if (preset.risk && RISK_VALUES.includes(preset.risk)) {
            setRisk(preset.risk);
            await sleep(80);
        }
        const current = new Set(getSelectedNumbers());
        const target = new Set(preset.numbers);
        for (const n of current) {
            if (!target.has(n)) { clickTile(n); await sleep(40); }
        }
        for (const n of target) {
            if (!current.has(n)) { clickTile(n); await sleep(40); }
        }
    }

    // --- UI ---
    const style = document.createElement('style');
    style.textContent = `
    #keno-preset-gui {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
        right: 10px;
        z-index: 999999;
        background: #0f212e; color: #b1bad3; border: 1px solid #2f4553;
        border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        width: min(300px, calc(100vw - 20px));
        max-width: calc(100vw - 20px);
        user-select: none; -webkit-user-select: none;
    }
    #keno-preset-gui.hidden { display: none; }
    #keno-preset-gui .kp-header {
        display: flex; align-items: center; justify-content: space-between;
        background: #1a2c38; padding: 10px 12px; border-radius: 10px 10px 0 0;
        border-bottom: 1px solid #2f4553; touch-action: none;
    }
    #keno-preset-gui .kp-title {
        font-weight: 600; font-size: 13px; color: #fff; letter-spacing: 0.3px;
    }
    #keno-preset-gui .kp-header-btns { display: flex; gap: 4px; }
    #keno-preset-gui .kp-header-btn {
        background: none; border: none; color: #94a3b8; cursor: pointer;
        padding: 6px 8px; min-width: 32px; min-height: 32px;
        border-radius: 6px; font-size: 16px; line-height: 1;
        -webkit-tap-highlight-color: rgba(255,255,255,0.1);
    }
    #keno-preset-gui .kp-header-btn:active { color: #fff; background: #2f4553; }
    #keno-preset-gui .kp-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #keno-preset-gui select {
        width: 100%; background: #1a2c38; color: #e2e8f0; border: 1px solid #2f4553;
        border-radius: 6px; padding: 10px 10px; font-size: 14px; min-height: 40px;
        -webkit-appearance: none; appearance: none;
    }
    #keno-preset-gui select:focus { outline: none; border-color: #10b981; }
    #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
    #keno-preset-gui .kp-btn {
        flex: 1 1 0; min-width: 70px;
        background: #1a2c38; color: #b1bad3; border: 1px solid #2f4553;
        border-radius: 6px; padding: 10px 8px; font-size: 11px; font-weight: 700;
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
        min-height: 40px; -webkit-tap-highlight-color: transparent;
    }
    #keno-preset-gui .kp-btn:active:not(:disabled) { transform: scale(0.97); }
    #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #keno-preset-gui .kp-btn.primary {
        background: #10b981; border-color: #10b981; color: #fff;
    }
    #keno-preset-gui .kp-btn.danger { color: #ef4444; }
    #keno-preset-gui .kp-btn.danger:active:not(:disabled) { background: #2a1a1f; color: #fca5a5; }
    #keno-preset-gui .kp-current {
        padding: 8px 10px; background: #1a2c38; border-radius: 6px;
        font-size: 12px; color: #94a3b8; line-height: 1.4; word-break: break-word;
    }
    #keno-preset-gui .kp-current b { color: #e2e8f0; }
    #keno-preset-gui.mini { width: auto; border-radius: 22px; }
    #keno-preset-gui.mini .kp-header { border-radius: 22px; padding: 8px 14px; border-bottom: none; }
    #keno-preset-gui.mini .kp-content { display: none; }
    `;
    document.head.appendChild(style);

    const gui = document.createElement('div');
    gui.id = 'keno-preset-gui';
    gui.innerHTML = `
        <div class="kp-header" data-drag-handle="true">
            <span class="kp-title">Keno Presets</span>
            <div class="kp-header-btns">
                <button class="kp-header-btn" id="kp-min" title="Minimize">−</button>
                <button class="kp-header-btn" id="kp-close" title="Close">×</button>
            </div>
        </div>
        <div class="kp-content">
            <div class="kp-current" id="kp-current">Loading…</div>
            <select id="kp-select"></select>
            <div class="kp-btn-row">
                <button class="kp-btn primary" id="kp-load">Load</button>
                <button class="kp-btn" id="kp-save">Save As…</button>
                <button class="kp-btn" id="kp-sync" title="Re-read current picks from the board">↻</button>
                <button class="kp-btn danger" id="kp-delete">Delete</button>
            </div>
        </div>
    `;
    document.body.appendChild(gui);

    const selectEl = gui.querySelector('#kp-select');
    const currentEl = gui.querySelector('#kp-current');
    const loadBtn = gui.querySelector('#kp-load');
    const saveBtn = gui.querySelector('#kp-save');
    const syncBtn = gui.querySelector('#kp-sync');
    const deleteBtn = gui.querySelector('#kp-delete');
    const closeBtn = gui.querySelector('#kp-close');
    const minBtn = gui.querySelector('#kp-min');
    const header = gui.querySelector('.kp-header');

    function renderPresets() {
        const list = loadPresets();
        selectEl.innerHTML = '';
        if (!list.length) {
            const opt = document.createElement('option');
            opt.textContent = '— no presets saved —';
            opt.disabled = true;
            selectEl.appendChild(opt);
            loadBtn.disabled = true;
            deleteBtn.disabled = true;
            return;
        }
        for (const p of list) {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} (${p.numbers.length}#, ${p.risk || '—'})`;
            selectEl.appendChild(opt);
        }
        loadBtn.disabled = false;
        deleteBtn.disabled = false;
    }

    function renderCurrent() {
        const nums = getSelectedNumbers();
        const risk = getRisk() || '—';
        currentEl.innerHTML = nums.length
            ? `Current: <b>${nums.length}</b> picks · risk <b>${risk}</b><br>${nums.join(', ')}`
            : `No picks selected · risk <b>${risk}</b>`;
    }

    saveBtn.onclick = () => {
        const nums = getSelectedNumbers();
        if (!nums.length) {
            alert('Select some numbers first, then save as a preset.');
            return;
        }
        const risk = getRisk();
        const name = (prompt('Preset name:') || '').trim();
        if (!name) return;
        const list = loadPresets();
        const existing = list.findIndex(p => p.name === name);
        const preset = { name, numbers: nums, risk };
        if (existing >= 0) {
            if (!confirm(`"${name}" already exists. Overwrite?`)) return;
            list[existing] = preset;
        } else {
            list.push(preset);
        }
        savePresets(list);
        renderPresets();
        selectEl.value = name;
    };

    loadBtn.onclick = async () => {
        const list = loadPresets();
        const p = list.find(x => x.name === selectEl.value);
        if (!p) return;
        loadBtn.disabled = true;
        await applyPreset(p);
        setTimeout(() => {
            loadBtn.disabled = false;
            renderCurrent();
        }, 200);
    };

    deleteBtn.onclick = () => {
        const name = selectEl.value;
        if (!name) return;
        if (!confirm(`Delete preset "${name}"?`)) return;
        const list = loadPresets().filter(p => p.name !== name);
        savePresets(list);
        renderPresets();
    };

    syncBtn.onclick = () => { syncPicksFromDOM(); renderCurrent(); };

    closeBtn.onclick = () => gui.remove();

    // Track user taps/clicks on tiles — our pick set is the source of truth.
    document.addEventListener('click', (e) => {
        const tile = e.target.closest(TILE_SELECTOR);
        if (!tile) return;
        const idx = Number(tile.dataset.index);
        if (isNaN(idx)) return;
        const n = idx + 1;
        if (userPicks.has(n)) userPicks.delete(n);
        else userPicks.add(n);
        setTimeout(renderCurrent, 0);
    }, true);

    minBtn.onclick = (e) => {
        e.stopPropagation();
        gui.classList.toggle('mini');
        minBtn.textContent = gui.classList.contains('mini') ? '+' : '−';
    };

    // --- Drag (touch + mouse) ---
    let isDragging = false, cx = 0, cy = 0, ix = 0, iy = 0;
    const isHandle = t => {
        if (t.closest('.kp-header-btns')) return false;
        return Boolean(t.closest('[data-drag-handle="true"]'));
    };
    const startDrag = (x, y) => {
        const rect = gui.getBoundingClientRect();
        if (!gui.style.left) { cx = rect.left; cy = rect.top; }
        ix = x - cx; iy = y - cy;
        isDragging = true;
    };
    const dragMove = (x, y) => {
        let nx = x - ix, ny = y - iy;
        nx = Math.max(0, Math.min(window.innerWidth - gui.offsetWidth, nx));
        ny = Math.max(0, Math.min(window.innerHeight - gui.offsetHeight, ny));
        cx = nx; cy = ny;
        gui.style.left = nx + 'px'; gui.style.top = ny + 'px';
        gui.style.right = 'auto'; gui.style.bottom = 'auto';
    };
    header.addEventListener('mousedown', (e) => {
        if (!isHandle(e.target)) return;
        startDrag(e.clientX, e.clientY);
        e.preventDefault();
    });
    header.addEventListener('touchstart', (e) => {
        if (!isHandle(e.target)) return;
        const t = e.touches[0]; if (!t) return;
        startDrag(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    document.addEventListener('mousemove', (e) => {
        if (isDragging) dragMove(e.clientX, e.clientY);
    });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0]; if (!t) return;
        dragMove(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    const endDrag = () => { isDragging = false; };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag, { passive: true });

    // Watch for selection / risk changes
    const observer = new MutationObserver(() => renderCurrent());
    let attachTries = 0;
    const attachTimer = setInterval(() => {
        const grid = document.querySelector('[data-testid="game-keno"]');
        if (grid && getTiles().length) {
            clearInterval(attachTimer);
            syncPicksFromDOM();
            observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ['data-selected', 'class'] });
            const risk = document.querySelector(RISK_SELECTOR);
            if (risk) risk.addEventListener('change', renderCurrent);
            renderCurrent();
        } else if (++attachTries > 40) {
            clearInterval(attachTimer);
        }
    }, 250);

    renderPresets();
    renderCurrent();
})();
