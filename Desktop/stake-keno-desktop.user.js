// ==UserScript==
// @name         Stake Keno Preset Manager
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Save and load Keno number + difficulty presets on stake.com and stake.us.
// @author       .
// @match        https://stake.com/casino/games/keno*
// @match        https://stake.us/casino/games/keno*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PRESETS_KEY = 'keno-presets';
    const TILE_SELECTOR = 'button[data-testid^="game-tile-"]';
    const RISK_SELECTOR = 'select[data-testid="game-difficulty"]';
    const RISK_VALUES = ['classic', 'low', 'medium', 'high'];

    // --- Presets store (shared across sites via localStorage) ---
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

    // --- DOM helpers ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function getTiles() {
        return Array.from(document.querySelectorAll(TILE_SELECTOR));
    }
    function getSelectedNumbers() {
        return getTiles()
            .filter(t => t.dataset.selected === 'true')
            .map(t => Number(t.dataset.index) + 1)
            .filter(n => !isNaN(n))
            .sort((a, b) => a - b);
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
        // Toggle off tiles that shouldn't be on
        for (const n of current) {
            if (!target.has(n)) { clickTile(n); await sleep(40); }
        }
        // Toggle on tiles that should be on
        for (const n of target) {
            if (!current.has(n)) { clickTile(n); await sleep(40); }
        }
    }

    // --- UI ---
    const style = document.createElement('style');
    style.textContent = `
    #keno-preset-gui {
        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        background: #0f212e; color: #b1bad3; border: 1px solid #2f4553;
        border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; width: 260px; user-select: none;
    }
    #keno-preset-gui .kp-header {
        display: flex; align-items: center; justify-content: space-between;
        background: #1a2c38; padding: 8px 12px; border-radius: 8px 8px 0 0;
        border-bottom: 1px solid #2f4553; cursor: grab;
    }
    #keno-preset-gui .kp-header:active { cursor: grabbing; }
    #keno-preset-gui .kp-title {
        font-weight: 600; font-size: 12px; color: #fff; letter-spacing: 0.3px;
    }
    #keno-preset-gui .kp-close {
        background: none; border: none; color: #64748b; cursor: pointer;
        padding: 2px 6px; font-size: 16px; line-height: 1; border-radius: 4px;
    }
    #keno-preset-gui .kp-close:hover { color: #fff; background: #2f4553; }
    #keno-preset-gui .kp-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #keno-preset-gui select {
        width: 100%; background: #1a2c38; color: #e2e8f0; border: 1px solid #2f4553;
        border-radius: 4px; padding: 6px 8px; font-size: 12px;
    }
    #keno-preset-gui select:focus { outline: none; border-color: #10b981; }
    #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; }
    #keno-preset-gui .kp-btn {
        flex: 1; background: #1a2c38; color: #b1bad3; border: 1px solid #2f4553;
        border-radius: 4px; padding: 6px 8px; font-size: 11px; font-weight: 600;
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
    }
    #keno-preset-gui .kp-btn:hover:not(:disabled) { background: #2f4553; color: #fff; }
    #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #keno-preset-gui .kp-btn.primary {
        background: #10b981; border-color: #10b981; color: #fff;
    }
    #keno-preset-gui .kp-btn.primary:hover:not(:disabled) { background: #059669; }
    #keno-preset-gui .kp-btn.danger { color: #ef4444; }
    #keno-preset-gui .kp-btn.danger:hover:not(:disabled) { background: #2a1a1f; color: #fca5a5; }
    #keno-preset-gui .kp-current {
        padding: 6px 8px; background: #1a2c38; border-radius: 4px;
        font-size: 11px; color: #94a3b8; line-height: 1.4;
    }
    #keno-preset-gui .kp-current b { color: #e2e8f0; }
    `;
    document.head.appendChild(style);

    const gui = document.createElement('div');
    gui.id = 'keno-preset-gui';
    gui.innerHTML = `
        <div class="kp-header">
            <span class="kp-title">Keno Presets</span>
            <button class="kp-close" id="kp-close" title="Close">×</button>
        </div>
        <div class="kp-content">
            <div class="kp-current" id="kp-current">Loading…</div>
            <select id="kp-select"></select>
            <div class="kp-btn-row">
                <button class="kp-btn primary" id="kp-load">Load</button>
                <button class="kp-btn" id="kp-save">Save As…</button>
                <button class="kp-btn danger" id="kp-delete">Delete</button>
            </div>
        </div>
    `;
    document.body.appendChild(gui);

    const selectEl = gui.querySelector('#kp-select');
    const currentEl = gui.querySelector('#kp-current');
    const loadBtn = gui.querySelector('#kp-load');
    const saveBtn = gui.querySelector('#kp-save');
    const deleteBtn = gui.querySelector('#kp-delete');
    const closeBtn = gui.querySelector('#kp-close');
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

    closeBtn.onclick = () => gui.remove();

    // Drag
    let isDragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.kp-close')) return;
        isDragging = true;
        const rect = gui.getBoundingClientRect();
        dx = e.clientX - rect.left; dy = e.clientY - rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let nl = e.clientX - dx, nt = e.clientY - dy;
        nl = Math.max(0, Math.min(window.innerWidth - gui.offsetWidth, nl));
        nt = Math.max(0, Math.min(window.innerHeight - gui.offsetHeight, nt));
        gui.style.left = nl + 'px'; gui.style.top = nt + 'px';
        gui.style.right = 'auto'; gui.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    // Watch for selection / risk changes on the page
    const observer = new MutationObserver(() => renderCurrent());
    const attachObserver = () => {
        const grid = document.querySelector('[data-testid="game-keno"]');
        if (grid) observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ['data-selected', 'class'] });
        const risk = document.querySelector(RISK_SELECTOR);
        if (risk) risk.addEventListener('change', renderCurrent);
    };
    // Retry if the grid hasn't mounted yet
    let attachTries = 0;
    const attachTimer = setInterval(() => {
        if (document.querySelector('[data-testid="game-keno"]')) {
            clearInterval(attachTimer);
            attachObserver();
            renderCurrent();
        } else if (++attachTries > 40) {
            clearInterval(attachTimer);
        }
    }, 250);

    renderPresets();
    renderCurrent();
})();
