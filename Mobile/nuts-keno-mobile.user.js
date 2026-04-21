// ==UserScript==
// @name         Nuts.gg Keno Preset Manager (Mobile Userscripts)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Mobile Userscripts counterpart for Nuts.gg Keno presets. Save/load number + risk presets with touch-friendly controls. Shares preset storage with the Stake Keno script.
// @author       .
// @match        https://nuts.gg/keno*
// @match        https://*.nuts.gg/keno*
// @grant        none
// @inject-into  page
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PRESETS_KEY = 'keno-presets';
    const RISK_BY_INDEX = ['classic', 'low', 'medium', 'high'];
    const INDEX_BY_RISK = Object.fromEntries(RISK_BY_INDEX.map((r, i) => [r, i]));

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
        const all = document.querySelectorAll('button');
        const byNum = new Map();
        for (const b of all) {
            if (b.children.length !== 2) continue;
            const span = b.querySelector('span');
            if (!span) continue;
            const n = parseInt((span.textContent || '').trim(), 10);
            if (n >= 1 && n <= 40 && !byNum.has(n)) byNum.set(n, b);
        }
        if (byNum.size < 40) return [];
        const out = [];
        for (let i = 1; i <= 40; i++) out.push(byNum.get(i));
        return out;
    }

    // Picks are tracked from the user's own click events. Reading selection
    // state from the DOM is unreliable on Nuts: the inner cover <div> class
    // isn't the state marker (the outer button class is), and after a round
    // the board has 3+ visual states (unselected / picked / hit / revealed).
    const userPicks = new Set();

    // Best-effort DOM seed — works while the board is IDLE (only 2 classes).
    function readPicksFromDOM() {
        const tiles = getTiles();
        if (!tiles.length) return [];
        const freq = {};
        for (const t of tiles) {
            const cover = t.children[1];
            if (!cover) continue;
            const key = cover.className || '';
            freq[key] = (freq[key] || 0) + 1;
        }
        const entries = Object.entries(freq);
        if (entries.length < 2) return [];
        entries.sort((a, b) => a[1] - b[1]);
        const selectedClass = entries[0][0];
        return tiles
            .map((t, i) => ({ n: i + 1, selected: (t.children[1]?.className || '') === selectedClass }))
            .filter(x => x.selected)
            .map(x => x.n);
    }
    function syncPicksFromDOM() {
        userPicks.clear();
        for (const n of readPicksFromDOM()) userPicks.add(n);
    }
    function getSelectedNumbers() {
        return Array.from(userPicks).sort((a, b) => a - b);
    }

    function clickTile(number) {
        const tiles = getTiles();
        const t = tiles[number - 1];
        if (!t) return false;
        t.click();
        return true;
    }

    function getRiskSlider() {
        return document.querySelector('[role="slider"][aria-valuemax="3"][aria-valuemin="0"]')
            || document.querySelector('[role="slider"]');
    }
    function getRisk() {
        const s = getRiskSlider();
        if (s) {
            const idx = Number(s.getAttribute('aria-valuenow'));
            if (!isNaN(idx) && RISK_BY_INDEX[idx]) return RISK_BY_INDEX[idx];
        }
        const spans = document.querySelectorAll('span');
        for (const sp of spans) {
            const m = (sp.textContent || '').match(/\b(CLASSIC|LOW|MEDIUM|HIGH)\s*RISK\b/i);
            if (m) return m[1].toLowerCase();
        }
        return null;
    }
    async function setRisk(risk) {
        const targetIdx = INDEX_BY_RISK[risk];
        if (targetIdx === undefined) return false;
        const slider = getRiskSlider();
        if (!slider) return false;
        let currentIdx = Number(slider.getAttribute('aria-valuenow'));
        if (isNaN(currentIdx)) return false;
        if (currentIdx === targetIdx) return true;
        slider.focus();
        const diff = targetIdx - currentIdx;
        const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft';
        const steps = Math.abs(diff);
        for (let i = 0; i < steps; i++) {
            slider.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
            slider.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
            await sleep(100);
        }
        return Number(slider.getAttribute('aria-valuenow')) === targetIdx;
    }

    async function applyPreset(preset) {
        if (!preset || !Array.isArray(preset.numbers)) return;
        if (preset.risk) {
            await setRisk(preset.risk);
            await sleep(80);
        }
        const current = new Set(getSelectedNumbers());
        const target = new Set(preset.numbers);
        for (const n of current) {
            if (!target.has(n)) { clickTile(n); await sleep(50); }
        }
        for (const n of target) {
            if (!current.has(n)) { clickTile(n); await sleep(50); }
        }
    }

    // --- Mobile UI ---
    const style = document.createElement('style');
    style.textContent = `
    #keno-preset-gui {
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
        right: 10px;
        z-index: 999999;
        background: #1a1a2a; color: #d0d0e0; border: 1px solid #3a3a4a;
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
        background: linear-gradient(135deg, #2a2a3a, #1e1e2e);
        padding: 10px 12px; border-radius: 10px 10px 0 0;
        border-bottom: 1px solid #3a3a4a; touch-action: none;
    }
    #keno-preset-gui .kp-title {
        font-weight: 700; font-size: 13px; color: #bb86fc; letter-spacing: 0.3px;
    }
    #keno-preset-gui .kp-header-btns { display: flex; gap: 4px; }
    #keno-preset-gui .kp-header-btn {
        background: none; border: none; color: #94a3b8; cursor: pointer;
        padding: 6px 8px; min-width: 32px; min-height: 32px;
        border-radius: 6px; font-size: 16px; line-height: 1;
        -webkit-tap-highlight-color: rgba(255,255,255,0.1);
    }
    #keno-preset-gui .kp-header-btn:active { color: #fff; background: #3a3a4a; }
    #keno-preset-gui .kp-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #keno-preset-gui select {
        width: 100%; background: #0f0f1a; color: #e0e0f0; border: 1px solid #4a4a5a;
        border-radius: 6px; padding: 10px 10px; font-size: 14px; min-height: 40px;
        -webkit-appearance: none; appearance: none;
    }
    #keno-preset-gui select:focus { outline: none; border-color: #bb86fc; }
    #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
    #keno-preset-gui .kp-btn {
        flex: 1 1 0; min-width: 70px;
        background: #2a2a3a; color: #d0d0e0; border: 1px solid #3a3a4a;
        border-radius: 6px; padding: 10px 8px; font-size: 11px; font-weight: 700;
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
        min-height: 40px; -webkit-tap-highlight-color: transparent;
    }
    #keno-preset-gui .kp-btn:active:not(:disabled) { transform: scale(0.97); }
    #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #keno-preset-gui .kp-btn.primary {
        background: linear-gradient(135deg, #bb86fc, #8e63c4); border-color: #bb86fc; color: #fff;
    }
    #keno-preset-gui .kp-btn.danger { color: #ff0266; }
    #keno-preset-gui .kp-btn.danger:active:not(:disabled) { background: #2a1a1f; color: #ff6b9e; }
    #keno-preset-gui .kp-current {
        padding: 8px 10px; background: #0f0f1a; border-radius: 6px;
        font-size: 12px; color: #a0a0b0; line-height: 1.4; word-break: break-word;
    }
    #keno-preset-gui .kp-current b { color: #e0e0f0; }
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

    closeBtn.onclick = () => gui.remove();

    // Track user taps/clicks on tiles — our pick set is the source of truth.
    // Tiles are identified by content (number in a span), so we map the
    // clicked button back to its index via getTiles().
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const tiles = getTiles();
        if (!tiles.length) return;
        const idx = tiles.indexOf(btn);
        if (idx === -1) return;
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

    // Drag (touch + mouse)
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

    // Re-render on grid / slider changes
    let tilesObserver = null;
    function attachWatchers() {
        const tiles = getTiles();
        if (!tiles.length) return false;
        syncPicksFromDOM();
        const gridParent = tiles[0].parentElement;
        if (gridParent) {
            if (tilesObserver) tilesObserver.disconnect();
            tilesObserver = new MutationObserver(() => renderCurrent());
            tilesObserver.observe(gridParent, { attributes: true, subtree: true, attributeFilter: ['class'] });
        }
        const slider = getRiskSlider();
        if (slider) {
            const riskObserver = new MutationObserver(() => renderCurrent());
            riskObserver.observe(slider, { attributes: true, attributeFilter: ['aria-valuenow'] });
        }
        renderCurrent();
        return true;
    }

    let attachTries = 0;
    const attachTimer = setInterval(() => {
        if (attachWatchers()) clearInterval(attachTimer);
        else if (++attachTries > 60) clearInterval(attachTimer);
    }, 500);

    renderPresets();
    renderCurrent();
})();
