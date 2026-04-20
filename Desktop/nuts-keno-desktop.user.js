// ==UserScript==
// @name         Nuts.gg Keno Preset Manager
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Save and load Keno number + risk presets on nuts.gg. Shares preset storage with the Stake Keno script.
// @author       .
// @match        https://nuts.gg/keno*
// @match        https://*.nuts.gg/keno*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PRESETS_KEY = 'keno-presets';
    // Slider index → risk name. nuts.gg's slider ranges aria-valuemin=0 to aria-valuemax=3.
    const RISK_BY_INDEX = ['classic', 'low', 'medium', 'high'];
    const INDEX_BY_RISK = Object.fromEntries(RISK_BY_INDEX.map((r, i) => [r, i]));

    // --- Presets store (shared with Stake keno via same localStorage key) ---
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

    // --- Tile detection: content-based (styled-components class names change on deploy) ---
    function getTiles() {
        // Tile = <button> with exactly 2 children, where first span contains a number 1-40
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

    // Detect selected by class-frequency: the inner cover <div> has a different class when selected
    function getSelectedNumbers() {
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
        if (entries.length < 2) return []; // all same class → nothing selected
        // Selected = less-frequent class
        entries.sort((a, b) => a[1] - b[1]);
        const selectedClass = entries[0][0];
        return tiles
            .map((t, i) => ({ n: i + 1, selected: (t.children[1]?.className || '') === selectedClass }))
            .filter(x => x.selected)
            .map(x => x.n);
    }

    function clickTile(number) {
        const tiles = getTiles();
        const t = tiles[number - 1];
        if (!t) return false;
        t.click();
        return true;
    }

    // --- Risk slider ---
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
        // Fallback: parse the "MEDIUM RISK" label
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

    // --- UI ---
    const style = document.createElement('style');
    style.textContent = `
    #keno-preset-gui {
        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        background: #1a1a2a; color: #d0d0e0; border: 1px solid #3a3a4a;
        border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; width: 260px; user-select: none;
    }
    #keno-preset-gui .kp-header {
        display: flex; align-items: center; justify-content: space-between;
        background: linear-gradient(135deg, #2a2a3a, #1e1e2e);
        padding: 8px 12px; border-radius: 10px 10px 0 0;
        border-bottom: 1px solid #3a3a4a; cursor: grab;
    }
    #keno-preset-gui .kp-header:active { cursor: grabbing; }
    #keno-preset-gui .kp-title {
        font-weight: 700; font-size: 12px; color: #bb86fc; letter-spacing: 0.3px;
    }
    #keno-preset-gui .kp-close {
        background: none; border: none; color: #7a7a8a; cursor: pointer;
        padding: 2px 6px; font-size: 16px; line-height: 1; border-radius: 4px;
    }
    #keno-preset-gui .kp-close:hover { color: #fff; background: #3a3a4a; }
    #keno-preset-gui .kp-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #keno-preset-gui select {
        width: 100%; background: #0f0f1a; color: #e0e0f0; border: 1px solid #4a4a5a;
        border-radius: 4px; padding: 6px 8px; font-size: 12px;
    }
    #keno-preset-gui select:focus { outline: none; border-color: #bb86fc; }
    #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; }
    #keno-preset-gui .kp-btn {
        flex: 1; background: #2a2a3a; color: #d0d0e0; border: 1px solid #3a3a4a;
        border-radius: 4px; padding: 6px 8px; font-size: 11px; font-weight: 700;
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
    }
    #keno-preset-gui .kp-btn:hover:not(:disabled) { background: #3a3a4a; color: #fff; }
    #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #keno-preset-gui .kp-btn.primary {
        background: linear-gradient(135deg, #bb86fc, #8e63c4); border-color: #bb86fc; color: #fff;
    }
    #keno-preset-gui .kp-btn.danger { color: #ff0266; }
    #keno-preset-gui .kp-btn.danger:hover:not(:disabled) { background: #2a1a1f; color: #ff6b9e; }
    #keno-preset-gui .kp-current {
        padding: 6px 8px; background: #0f0f1a; border-radius: 4px;
        font-size: 11px; color: #a0a0b0; line-height: 1.4; word-break: break-word;
    }
    #keno-preset-gui .kp-current b { color: #e0e0f0; }
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

    // Re-render on grid / slider changes
    let tilesObserver = null;
    function attachWatchers() {
        const tiles = getTiles();
        if (!tiles.length) return false;
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
