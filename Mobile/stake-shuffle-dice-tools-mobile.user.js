// ==UserScript==
// @name         Dice Tools (All-in-One Mobile)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Full Dice Tools app (Calculator, Simulator, Optimizer, Results) + Win/Loss Streak Counter with autoplay stopper + strategy import/balance export, all in one userscript. Works on iOS Userscripts, Tampermonkey, Violentmonkey. No hosting, no PWA, no bookmarks needed.
// @author       .
// @match        https://stake.com/casino/games/primedice*
// @match        https://stake.us/casino/games/primedice*
// @match        https://shuffle.us/games/originals/dice*
// @match        https://stake.us/casino/games/dice*
// @match        https://stake.com/casino/games/dice*
// @grant        none
// @inject-into  page
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       STATE & CONSTANTS
       ========================================================= */
    const STORE_KEY = 'dice_tools_aio_state_v1';
    const RES_COLS = [
        'StartingBalance', 'Trials', 'BetDiv', 'ProfitMult', 'W%', 'L', 'Buffer%',
        'AvgHigh', 'StdDev', 'MaxHigh', 'AvgCycles', 'AvgRounds',
        'CycleSuccess%', 'Bust%', 'Score'
    ];

    const state = {
        balance: '20', win_inc: '78', loss_reset: '5',
        bet_div: '500', profit_mult: '100', buffer: '25', n_trials: '100',
        opt_balance: '20', opt_trials: '10',
        opt_betdiv: '256,500', opt_profit: '50,100',
        opt_w: '50-100;step=5', opt_l: '3-5;step=1', opt_buf: '25,30,40',
        theme: 'original', large_fonts: false, keep_prev: false,
        worker_count: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4))),
        panel_open: false,
        results: [],
        // Streak counter (win/loss tracking + autoplay stopper)
        show_counter: true,
        counter_target: 10,
        counter_volume: 100,
        counter_autostop: true,
        counter_x: null, counter_y: null
    };

    let simWorker = null, simRunning = false;
    let optWorkers = [], optRunning = false, optQueue = [], optResults = [];
    let optDone = 0, optTotal = 0;
    let selectedRowIdx = -1;
    let resultsSortCol = 'Score';
    let resultsSortAsc = false;

    /* =========================================================
       STATE PERSISTENCE
       ========================================================= */
    function saveState() {
        try {
            const snap = {};
            const ids = ['balance', 'win_inc', 'loss_reset', 'bet_div', 'profit_mult', 'buffer', 'n_trials',
                         'opt_balance', 'opt_trials', 'opt_betdiv', 'opt_profit', 'opt_w', 'opt_l', 'opt_buf'];
            for (const k of ids) {
                const el = $(k);
                if (el) snap[k] = el.value;
            }
            const theme = $('theme_select');
            if (theme) snap.theme = theme.value;
            const lf = $('large_fonts'); if (lf) snap.large_fonts = lf.checked;
            const kp = $('keep_prev'); if (kp) snap.keep_prev = kp.checked;
            const wc = $('worker_count'); if (wc) snap.worker_count = parseInt(wc.value) || 1;
            const sc = $('show_counter'); if (sc) snap.show_counter = sc.checked;
            const cas = $('counter_autostop'); if (cas) snap.counter_autostop = cas.checked;
            snap.counter_target = state.counter_target;
            snap.counter_volume = state.counter_volume;
            snap.counter_x = state.counter_x;
            snap.counter_y = state.counter_y;
            snap.panel_open = state.panel_open;
            snap.results = optResults.slice();
            Object.assign(state, snap);
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } catch (e) { /* best effort */ }
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return;
            Object.assign(state, JSON.parse(raw));
        } catch (e) { /* ignore */ }
    }

    /* =========================================================
       DOM HELPERS (scoped — only look inside our panel)
       ========================================================= */
    const PANEL_ID = 'dt-aio-panel';
    const BUTTON_ID = 'dt-aio-button';
    const COUNTER_ID = 'dt-aio-counter';
    const $ = (id) => document.getElementById('dt-' + id);
    const $$ = (sel) => document.querySelectorAll('#' + PANEL_ID + ' ' + sel);

    function toast(msg, duration = 2000) {
        const t = $('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), duration);
    }

    /* =========================================================
       SHARED GAME HELPERS (from existing userscript)
       ========================================================= */
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const waitFor = async (selector, timeout = 15000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            await sleep(200);
        }
        throw new Error(`Timeout waiting for selector: ${selector}`);
    };
    const waitForText = async (tag, text, timeout = 10000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const els = Array.from(document.querySelectorAll(tag));
            const found = els.find(el => el.textContent.trim().toLowerCase().includes(text.toLowerCase()));
            if (found) return found;
            await sleep(200);
        }
        return null;
    };
    const setNativeValue = (element, value) => {
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else {
            valueSetter.call(element, value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const setSelectValue = (sel, val) => {
        sel.value = val;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const trigger = el => {
        ['input', 'change', 'blur'].forEach(type => {
            el.dispatchEvent(new Event(type, { bubbles: true }));
        });
    };

    /* Read current calculated values for strategy import */
    function currentCalcValues() {
        return {
            bet_size: $('out_bet').value,
            profit_stop: $('out_profit').value,
            multiplier: ($('out_mult').value || '').replace(/x$/, ''),
            win_increase: $('win_inc').value,
            loss_reset: $('loss_reset').value
        };
    }

    /* =========================================================
       WEB WORKER SOURCE — Stake RNG + simulator + optimizer.
       Port of simulation_core.py. Verified bit-identical vs Python.
       ========================================================= */
    const WORKER_SOURCE = `
'use strict';
async function hmacSha256(keyStr, msgStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  return new Uint8Array(sig);
}
function randomHex(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}
class StakeRNG {
  constructor() {
    this.server_seed = randomHex(32);
    this.client_seed = randomHex(32);
    this.nonce = 0;
    this.round_idx = 0;
    this.cache = new Uint8Array(0);
    this.cacheOffset = 0;
  }
  async _ensureBytes(n) {
    while (this.cache.length - this.cacheOffset < n) {
      const msg = this.client_seed + ':' + this.nonce + ':' + this.round_idx;
      const chunk = await hmacSha256(this.server_seed, msg);
      const remaining = this.cache.length - this.cacheOffset;
      const merged = new Uint8Array(remaining + chunk.length);
      if (remaining > 0) merged.set(this.cache.subarray(this.cacheOffset), 0);
      merged.set(chunk, remaining);
      this.cache = merged;
      this.cacheOffset = 0;
      this.round_idx += 1;
    }
  }
  async nextRollBatch(count) {
    if (count <= 0) return [];
    const needed = count * 4;
    await this._ensureBytes(needed);
    const rolls = new Float64Array(count);
    let off = this.cacheOffset;
    for (let i = 0; i < count; i++) {
      const b0 = this.cache[off], b1 = this.cache[off+1], b2 = this.cache[off+2], b3 = this.cache[off+3];
      off += 4;
      const f = b0/256 + b1/65536 + b2/16777216 + b3/4294967296;
      rolls[i] = f * 10001 / 100;
    }
    this.cacheOffset = off;
    this.nonce += count;
    return rolls;
  }
}
async function runCompoundedTrial(params, batchSize = 1024) {
  const rng = new StakeRNG();
  let balance = params.starting_balance;
  let peak = balance;
  let cycles = 0;
  let rounds = 0;
  const MAX_ROUNDS_SAFETY = 10000000;
  while (balance > 0 && rounds < MAX_ROUNDS_SAFETY) {
    const bet = balance / params.bet_div;
    const profit_stop = bet * params.profit_mult;
    const target = balance + profit_stop;
    const m = ((1 + params.w) * params.l) * params.buffer;
    const win_chance = m === 0 ? 0 : Math.max(0, Math.min(1, (1 - 0.01) / m));
    let current_bet = bet;
    let loss_streak = 0;
    let batch = [];
    let idx = 0;
    while (balance > 0 && balance < target && rounds < MAX_ROUNDS_SAFETY) {
      if (idx >= batch.length) {
        batch = await rng.nextRollBatch(batchSize);
        idx = 0;
        if (!batch.length) break;
      }
      const roll = batch[idx++];
      rounds++;
      if (roll < win_chance * 100) {
        balance += current_bet * (m - 1);
        current_bet *= (1 + params.w);
        loss_streak = 0;
      } else {
        balance -= current_bet;
        loss_streak++;
        if (loss_streak >= params.l) {
          current_bet = bet;
          loss_streak = 0;
        }
      }
      if (balance > peak) peak = balance;
    }
    if (balance < target) break;
    cycles += 1;
  }
  return { highest_balance: peak, cycles, rounds };
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x,y)=>x-y);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}
function mean(a) { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const mu = mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-mu)*(x-mu),0)/(a.length-1));
}

async function runSimulatorTask(params) {
  const results = [];
  for (let i = 0; i < params.n_trials; i++) {
    if (self._stopFlag) break;
    const r = await runCompoundedTrial(params);
    results.push(r);
    self.postMessage({ kind: 'sim_progress', done: i + 1, total: params.n_trials });
  }
  const highs = results.map(r => r.highest_balance);
  const cyc = results.map(r => r.cycles);
  const rnd = results.map(r => r.rounds);
  const successes = cyc.reduce((a,b)=>a+b,0);
  const attempts = results.length + successes;
  const stats = {
    avg_high: highs.length ? median(highs) : 0,
    std_high: highs.length > 1 ? stdev(highs) : 0,
    max_high: highs.length ? Math.max(...highs) : 0,
    avg_cycles: mean(cyc),
    avg_rounds: mean(rnd),
    cycle_success: attempts ? (successes / attempts * 100) : 0,
    bust_rate: params.n_trials ? (cyc.filter(c => c === 0).length / params.n_trials * 100) : 0,
    n_completed: results.length
  };
  self.postMessage({ kind: 'sim_done', stats });
}

async function runOptimizerCombo(combo) {
  const params = {
    starting_balance: combo.starting_balance,
    bet_div: combo.bet_div, profit_mult: combo.profit_mult,
    w: combo.w, l: combo.l, buffer: combo.buffer, n_trials: combo.n_trials
  };
  const results = [];
  for (let i = 0; i < params.n_trials; i++) {
    if (self._stopFlag) break;
    const r = await runCompoundedTrial(params);
    results.push(r);
  }
  const highs = results.map(r => r.highest_balance);
  const cyc = results.map(r => r.cycles);
  const rnd = results.map(r => r.rounds);
  const successes = cyc.reduce((a,b)=>a+b,0);
  const attempts = results.length + successes;
  const avg_high = highs.length ? median(highs) : 0;
  const std_high = highs.length > 1 ? stdev(highs) : 0;
  const max_high = highs.length ? Math.max(...highs) : 0;
  const score = std_high !== 0 ? (avg_high - combo.starting_balance) / std_high : 0;
  const row = {
    StartingBalance: +combo.starting_balance.toFixed(2),
    Trials: combo.n_trials,
    BetDiv: +combo.bet_div.toFixed(2),
    ProfitMult: +combo.profit_mult.toFixed(2),
    'W%': +(combo.w * 100).toFixed(2),
    L: combo.l,
    'Buffer%': +((combo.buffer - 1) * 100).toFixed(2),
    AvgHigh: +avg_high.toFixed(2),
    StdDev: +std_high.toFixed(2),
    MaxHigh: +max_high.toFixed(2),
    AvgCycles: +mean(cyc).toFixed(2),
    AvgRounds: +mean(rnd).toFixed(2),
    'CycleSuccess%': +(attempts ? successes / attempts * 100 : 0).toFixed(2),
    'Bust%': +(params.n_trials ? cyc.filter(c=>c===0).length / params.n_trials * 100 : 0).toFixed(2),
    Score: +score.toFixed(2)
  };
  self.postMessage({ kind: 'opt_row', row });
}

self._stopFlag = false;
self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.kind === 'stop') { self._stopFlag = true; return; }
  if (msg.kind === 'run_sim') {
    self._stopFlag = false;
    try { await runSimulatorTask(msg.params); } catch (err) { self.postMessage({ kind: 'error', error: String(err) }); }
    return;
  }
  if (msg.kind === 'run_combo') {
    self._stopFlag = false;
    try { await runOptimizerCombo(msg.combo); }
    catch (err) {
      self.postMessage({ kind: 'opt_row', row: {
        StartingBalance: msg.combo.starting_balance, Trials: msg.combo.n_trials,
        BetDiv: msg.combo.bet_div, ProfitMult: msg.combo.profit_mult,
        'W%': msg.combo.w*100, L: msg.combo.l, 'Buffer%': (msg.combo.buffer-1)*100,
        AvgHigh: 0, StdDev: 0, MaxHigh: 0, AvgCycles: 0, AvgRounds: 0,
        'CycleSuccess%': 0, 'Bust%': 100, Score: 0
      }});
    }
    self.postMessage({ kind: 'opt_combo_done' });
  }
};
`;

    function makeWorker() {
        const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }


    /* =========================================================
       CSS — injected once into the casino page
       ========================================================= */
    const CSS = `
#${PANEL_ID}, #${BUTTON_ID} {
  --dt-bg: #161616;
  --dt-fg: #e6fffb;
  --dt-label-fg: #17c7b8;
  --dt-field-bg: #050505;
  --dt-select-bg: #17c7b8;
  --dt-select-fg: #000;
  --dt-button-bg: #0a0a0a;
  --dt-border: #17c7b8;
  --dt-danger: #ff5a44;
  --dt-progress: #00ff80;
  --dt-trough: #2a2a2a;
  --dt-row-even: #1c1c1c;
  --dt-row-odd: #252525;
  --dt-font-scale: 1;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
#${PANEL_ID}[data-theme="stake"], #${BUTTON_ID}[data-theme="stake"] {
  --dt-bg: #0b1a22; --dt-fg: #ffffff; --dt-label-fg: #17c7b8;
  --dt-field-bg: #030a0f; --dt-select-bg: #1f333e; --dt-select-fg: #ffffff;
  --dt-button-bg: #030a0f; --dt-border: #17c7b8; --dt-progress: #00ff80;
  --dt-row-even: #0f212e; --dt-row-odd: #162a35;
}
#${PANEL_ID}[data-theme="shuffle"], #${BUTTON_ID}[data-theme="shuffle"] {
  --dt-bg: #0c0c0c; --dt-fg: #ffffff; --dt-label-fg: #c084fc;
  --dt-field-bg: #050505; --dt-select-bg: #a855f7; --dt-select-fg: #ffffff;
  --dt-button-bg: #1a1a1a; --dt-border: #a855f7; --dt-progress: #c084fc;
  --dt-row-even: #171717; --dt-row-odd: #202020;
}
#${PANEL_ID}[data-large-fonts="true"] { --dt-font-scale: 1.2; }

/* Floating toggle button */
#${BUTTON_ID} {
  position: fixed;
  right: 16px;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 90px);
  z-index: 2147483646;
  width: 52px; height: 52px;
  border-radius: 50%;
  background: var(--dt-bg);
  border: 2px solid var(--dt-border);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5), 0 0 10px color-mix(in srgb, var(--dt-border) 40%, transparent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: var(--dt-label-fg);
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  padding: 0;
}
#${BUTTON_ID}:active { transform: scale(0.92); }
#${BUTTON_ID}.has-unread::after {
  content: '';
  position: absolute;
  top: -2px; right: -2px;
  width: 12px; height: 12px;
  background: var(--dt-progress);
  border-radius: 50%;
  border: 2px solid var(--dt-bg);
}

/* Backdrop when panel is open */
#dt-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 2147483645;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
#dt-backdrop.show {
  opacity: 1;
  pointer-events: auto;
}

/* The panel itself — bottom sheet.
   NOTE: z-index is intentionally one lower than #dt-tooltip / #dt-toast
   so tooltips pop in front of the panel instead of behind it. */
#${PANEL_ID} {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 2147483646;
  background: var(--dt-bg);
  color: var(--dt-fg);
  border-top: 2px solid var(--dt-border);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.6);
  max-height: 92vh;
  max-height: 92dvh;
  height: 92vh;
  height: 92dvh;
  transform: translateY(100%);
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  font-size: calc(14px * var(--dt-font-scale));
  line-height: 1.5;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
#${PANEL_ID}.show { transform: translateY(0); }
#${PANEL_ID} * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

/* Panel header */
#${PANEL_ID} .dt-head {
  position: relative;
  padding: 14px 16px 8px;
  text-align: center;
  flex-shrink: 0;
  border-bottom: 1px solid var(--dt-border);
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
#${PANEL_ID} .dt-head::before {
  content: '';
  display: block;
  width: 40px; height: 4px;
  background: var(--dt-border);
  border-radius: 2px;
  margin: -4px auto 8px;
  opacity: 0.6;
}
#${PANEL_ID} .dt-title {
  font-family: 'Times New Roman', Georgia, serif;
  font-style: italic;
  font-weight: bold;
  font-size: 1.2em;
  color: var(--dt-label-fg);
  text-decoration: underline;
  margin: 0;
}
#${PANEL_ID} .dt-close {
  position: absolute;
  top: 8px; right: 10px;
  width: 30px; height: 30px;
  border: none;
  background: transparent;
  color: var(--dt-fg);
  font-size: 22px;
  font-weight: 700;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
#${PANEL_ID} .dt-close:active { background: var(--dt-field-bg); }

/* Panel body & panels */
#${PANEL_ID} .dt-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 8px;
}
#${PANEL_ID} .dt-panel { display: none; animation: dt-fade 0.2s ease; }
#${PANEL_ID} .dt-panel.active { display: block; }
@keyframes dt-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

/* Cards — clearly elevated from the darker panel surface. */
#${PANEL_ID} .dt-card {
  background: color-mix(in srgb, var(--dt-bg) 78%, white 22%);
  border: 2px solid var(--dt-border);
  border-radius: 10px;
  padding: 14px 12px 12px;
  margin-bottom: 14px;
  position: relative;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
#${PANEL_ID} .dt-card-title {
  position: absolute;
  top: -11px; left: 14px;
  background: var(--dt-bg);
  color: var(--dt-label-fg);
  padding: 0 8px;
  font-family: 'Times New Roman', Georgia, serif;
  font-weight: bold;
  font-style: italic;
  font-size: 0.95em;
  text-decoration: underline;
}

/* Fields */
#${PANEL_ID} .dt-field {
  display: flex;
  align-items: center;
  margin: 6px 0;
  gap: 8px;
}
#${PANEL_ID} .dt-field label,
#${PANEL_ID} .dt-field .dt-label {
  flex: 1;
  color: var(--dt-label-fg);
  font-weight: 600;
  font-size: 0.95em;
  display: flex;
  align-items: center;
  gap: 6px;
}
#${PANEL_ID} .dt-help {
  width: 20px; height: 20px;
  border: 1px solid var(--dt-border);
  border-radius: 50%;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dt-label-fg);
  background: transparent;
  cursor: help;
  font-weight: 700;
  flex-shrink: 0;
  padding: 0;
  line-height: 1;
  -webkit-appearance: none;
  appearance: none;
  touch-action: manipulation;
}
#${PANEL_ID} .dt-help:active { background: var(--dt-label-fg); color: var(--dt-bg); }
#${PANEL_ID} .dt-field input[type="text"],
#${PANEL_ID} .dt-field input[type="number"],
#${PANEL_ID} input.dt-text-input {
  width: 100px;
  min-width: 80px;
  padding: 8px 10px;
  background: var(--dt-field-bg);
  color: var(--dt-fg);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  font-size: 1em;
  font-family: inherit;
  text-align: right;
  -webkit-appearance: none;
  appearance: none;
}
#${PANEL_ID} .dt-field input:focus { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--dt-label-fg) 35%, transparent); }
#${PANEL_ID} .dt-field input[readonly] { opacity: 0.95; font-weight: 600; color: var(--dt-label-fg); }
#${PANEL_ID} .dt-field-wide { flex-direction: column; align-items: stretch; gap: 4px; }
#${PANEL_ID} .dt-field-wide input { width: 100%; text-align: left; }
#${PANEL_ID} .dt-hint { font-size: 0.78em; color: var(--dt-fg); opacity: 0.55; margin: -2px 0 6px; font-style: italic; }

/* Buttons */
#${PANEL_ID} .dt-btn {
  padding: 10px 14px;
  background: var(--dt-button-bg);
  color: var(--dt-label-fg);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  font-size: 0.95em;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  min-height: 42px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
}
#${PANEL_ID} .dt-btn:active { background: color-mix(in srgb, var(--dt-button-bg) 70%, white 30%); transform: scale(0.985); }
#${PANEL_ID} .dt-btn:disabled { opacity: 0.45; }
#${PANEL_ID} .dt-btn-primary { background: var(--dt-label-fg); color: var(--dt-bg); border-color: var(--dt-label-fg); }
#${PANEL_ID} .dt-btn-danger { background: transparent; color: var(--dt-danger); border-color: var(--dt-danger); }
#${PANEL_ID} .dt-btn-row { display: flex; gap: 8px; margin-top: 8px; }
#${PANEL_ID} .dt-btn-row .dt-btn { flex: 1; }
#${PANEL_ID} .dt-btn-block { display: block; width: 100%; margin-top: 8px; }
#${PANEL_ID} .dt-btn-small { padding: 6px 10px; min-height: 34px; font-size: 0.85em; }

/* Progress */
#${PANEL_ID} .dt-progress-wrap {
  margin: 10px 0 4px;
  background: var(--dt-trough);
  border-radius: 6px;
  overflow: hidden;
  height: 10px;
  border: 1px solid var(--dt-border);
}
#${PANEL_ID} .dt-progress-bar {
  height: 100%;
  width: 0%;
  background: var(--dt-progress);
  transition: width 0.2s ease;
}
#${PANEL_ID} .dt-status-line {
  text-align: center;
  font-size: 0.85em;
  opacity: 0.8;
  margin: 4px 0 10px;
  min-height: 1.2em;
}

/* Tables */
#${PANEL_ID} .dt-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  background: var(--dt-field-bg);
  max-height: 45vh;
  overflow-y: auto;
}
#${PANEL_ID} table.dt-results {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85em;
}
#${PANEL_ID} table.dt-results th, #${PANEL_ID} table.dt-results td {
  padding: 7px 8px;
  text-align: center;
  white-space: nowrap;
  border-bottom: 1px solid var(--dt-border);
}
#${PANEL_ID} table.dt-results th {
  background: var(--dt-button-bg);
  color: var(--dt-label-fg);
  font-weight: 700;
  position: sticky;
  top: 0;
  cursor: pointer;
}
#${PANEL_ID} table.dt-results tr:nth-child(even) td { background: var(--dt-row-even); }
#${PANEL_ID} table.dt-results tr:nth-child(odd) td { background: var(--dt-row-odd); }
#${PANEL_ID} table.dt-results tr.selected td { background: var(--dt-select-bg) !important; color: var(--dt-select-fg); font-weight: 600; }
#${PANEL_ID} table.dt-stats { width: 100%; font-size: 0.92em; }
#${PANEL_ID} table.dt-stats td { padding: 8px 10px; border-bottom: 1px solid var(--dt-border); }
#${PANEL_ID} table.dt-stats tr:last-child td { border-bottom: none; }
#${PANEL_ID} table.dt-stats td:first-child { color: var(--dt-label-fg); font-weight: 600; width: 55%; }
#${PANEL_ID} table.dt-stats td:last-child { text-align: right; font-variant-numeric: tabular-nums; }

/* Settings rows */
#${PANEL_ID} .dt-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--dt-border) 30%, transparent);
  gap: 10px;
}
#${PANEL_ID} .dt-setting-row:last-child { border-bottom: none; }
#${PANEL_ID} .dt-setting-label { color: var(--dt-label-fg); font-weight: 600; }
#${PANEL_ID} .dt-setting-desc { font-size: 0.8em; opacity: 0.65; margin-top: 2px; font-style: italic; }
#${PANEL_ID} select.dt-theme-select, #${PANEL_ID} input.dt-num-input {
  padding: 8px 10px;
  background: var(--dt-field-bg);
  color: var(--dt-fg);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.95em;
}
#${PANEL_ID} input.dt-num-input { width: 64px; text-align: center; }
#${PANEL_ID} .dt-switch { position: relative; width: 46px; height: 26px; flex-shrink: 0; }
#${PANEL_ID} .dt-switch input { opacity: 0; width: 0; height: 0; }
#${PANEL_ID} .dt-switch .dt-slider {
  position: absolute; inset: 0;
  background: var(--dt-trough);
  border-radius: 26px;
  transition: 0.2s;
  cursor: pointer;
}
#${PANEL_ID} .dt-switch .dt-slider::before {
  content: '';
  position: absolute;
  height: 20px; width: 20px;
  left: 3px; top: 3px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}
#${PANEL_ID} .dt-switch input:checked + .dt-slider { background: var(--dt-label-fg); }
#${PANEL_ID} .dt-switch input:checked + .dt-slider::before { transform: translateX(20px); }

/* Tabs */
#${PANEL_ID} .dt-tabs {
  display: flex;
  background: var(--dt-button-bg);
  border-top: 1px solid var(--dt-border);
  flex-shrink: 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
#${PANEL_ID} .dt-tab-btn {
  flex: 1;
  padding: 8px 2px;
  background: transparent;
  border: none;
  color: var(--dt-fg);
  font-size: 0.72em;
  font-weight: 600;
  cursor: pointer;
  border-top: 3px solid transparent;
  min-height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-family: inherit;
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
#${PANEL_ID} .dt-tab-btn .dt-tab-icon { font-size: 1.25em; line-height: 1; }
#${PANEL_ID} .dt-tab-btn.active {
  color: var(--dt-label-fg);
  background: var(--dt-bg);
  border-top-color: var(--dt-label-fg);
}

/* Toast */
#dt-toast {
  position: fixed;
  left: 50%;
  bottom: calc(12vh + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%) translateY(30px);
  background: var(--dt-bg, #3f3f3f);
  color: var(--dt-fg, #17c7b8);
  border: 1px solid var(--dt-border, #249f87);
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 0.9em;
  max-width: 85%;
  text-align: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s, transform 0.2s;
  z-index: 2147483647;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  font-family: -apple-system, sans-serif;
}
#dt-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

/* Tooltip popover for ? helpers */
#dt-tooltip {
  position: fixed;
  max-width: 260px;
  padding: 10px 12px;
  background: var(--dt-bg, #3f3f3f);
  color: var(--dt-fg, #17c7b8);
  border: 1px solid var(--dt-border, #249f87);
  border-radius: 8px;
  font-size: 0.85em;
  line-height: 1.45;
  z-index: 2147483647;
  box-shadow: 0 6px 18px rgba(0,0,0,0.5);
  display: none;
  font-family: -apple-system, sans-serif;
}
#dt-tooltip.show { display: block; }
#dt-tooltip .dt-tt-title { color: var(--dt-label-fg, #249f87); font-weight: 700; margin: 0 0 4px; }

/* Streak Counter HUD — always-visible floating pill */
#${COUNTER_ID} {
  --dt-bg: #1a1a1a;
  --dt-fg: #ffffff;
  --dt-label-fg: #17c7b8;
  --dt-border: #249f87;
  --dt-danger: #e74c3c;
  position: fixed;
  top: 70px;
  right: 8px;
  z-index: 2147483644;
  background: var(--dt-bg);
  color: var(--dt-fg);
  border: 2px solid var(--dt-border);
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.5);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  padding: 6px 8px;
  min-width: 120px;
  max-width: 180px;
  display: none;
}
#${COUNTER_ID}[data-theme="stake"] { --dt-bg: #0f212e; --dt-border: #249f87; --dt-label-fg: #17c7b8; }
#${COUNTER_ID}[data-theme="shuffle"] { --dt-bg: #131313; --dt-border: #a855f7; --dt-label-fg: #a855f7; }
#${COUNTER_ID}.show { display: block; }
#${COUNTER_ID} .dt-ctr-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
#${COUNTER_ID} .dt-ctr-row + .dt-ctr-row { margin-top: 4px; }
#${COUNTER_ID} .dt-ctr-w {
  color: var(--dt-label-fg);
  font-weight: 700;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  transition: transform 0.3s;
  min-width: 28px;
  text-align: center;
}
#${COUNTER_ID} .dt-ctr-l {
  color: var(--dt-fg);
  font-weight: 600;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  transition: transform 0.3s, color 0.3s;
  min-width: 22px;
  text-align: center;
}
#${COUNTER_ID} .dt-ctr-l.has-loss { color: var(--dt-danger); }
#${COUNTER_ID} .dt-ctr-lbl {
  font-size: 10px;
  opacity: 0.7;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
#${COUNTER_ID} .dt-ctr-target {
  background: transparent;
  color: var(--dt-fg);
  border: 1px solid var(--dt-border);
  border-radius: 4px;
  width: 38px;
  padding: 2px 4px;
  font-size: 12px;
  font-family: inherit;
  text-align: center;
  -webkit-appearance: none;
  appearance: none;
}
#${COUNTER_ID} .dt-ctr-btn {
  background: var(--dt-border);
  color: var(--dt-bg);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  font-family: inherit;
  padding: 3px 8px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
#${COUNTER_ID} .dt-ctr-btn:active { opacity: 0.75; }
#${COUNTER_ID} .dt-ctr-btn:disabled { opacity: 0.5; cursor: progress; }
#${COUNTER_ID} .dt-ctr-btn-wide { flex: 1; padding: 5px 10px; }
#${COUNTER_ID} .dt-ctr-vol {
  -webkit-appearance: none;
  appearance: none;
  width: 70px;
  height: 3px;
  background: var(--dt-border);
  border-radius: 2px;
  flex: 1;
}
#${COUNTER_ID} .dt-ctr-vol::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px; height: 12px;
  background: var(--dt-label-fg);
  border-radius: 50%;
  cursor: pointer;
}
#${COUNTER_ID} .dt-ctr-vol::-moz-range-thumb {
  width: 12px; height: 12px;
  background: var(--dt-label-fg);
  border-radius: 50%;
  border: none;
  cursor: pointer;
}
#${COUNTER_ID} .dt-ctr-drag {
  color: var(--dt-label-fg);
  opacity: 0.55;
  font-size: 10px;
  cursor: move;
  letter-spacing: 1px;
  flex-shrink: 0;
}
`;


    /* =========================================================
       TERMS GLOSSARY — one-line definitions for tooltip helpers.
       Pulled from terms_tab.py content.
       ========================================================= */
    const GLOSSARY = {
        'Balance': 'Your total bankroll for each simulation or calculation.',
        'Win Increase %': 'The percentage amount the bet increases after every win.',
        'Loss Reset': 'Number of consecutive losses required before resetting the bet to its base size.',
        'Balance Divisor': 'Balance is divided by this number to determine the starting bet size. Higher = smaller bets.',
        'Profit Multiplier': 'The multiplier applied to the base bet that defines the profit stop.',
        'Buffer %': 'An additional percentage added to the multiplier for extra margin or protection.',
        'Multiplier': 'The payout odds or target multiplier determined by input parameters.',
        'Bet Size': 'The first wager placed based on the current balance and balance divisor.',
        'Profit Stop': 'The profit goal for the current cycle, derived from the bet and multiplier.',
        'Balance Target': 'The balance amount where the simulation stops a successful cycle.',
        'Trials': 'Number of simulated runs. Higher values improve accuracy but take longer.',
        'Starting Balance': 'The initial balance applied to all combos during optimization.',
        'Trials per Combo': 'The number of simulations run for each parameter combination.',
        'Bet Divisor Range': 'Range or list of divisors to test. Syntax: 256-512;step=1 or 25,30,40',
        'Profit Multiplier Range': 'Range or list of profit multipliers to test. Syntax: 25-150;step=5',
        'Win Increase % Range': 'Range or list of win increases to test. Syntax: 50-150;step=5',
        'Loss Reset (whole)': 'Range or list of loss reset counts. Syntax: 3-8 (integers only)',
        'Buffer % Range': 'Range or list of buffer percentages. Syntax: 20-40;step=2'
    };

    /* =========================================================
       DOM BUILDER — inject button + panel into page body
       ========================================================= */
    function injectUI() {
        // Inject styles
        const style = document.createElement('style');
        style.id = 'dt-aio-styles';
        style.textContent = CSS;
        document.head.appendChild(style);

        // Toggle button
        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.innerHTML = '🎲';
        btn.setAttribute('aria-label', 'Open Dice Tools');
        document.body.appendChild(btn);

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'dt-backdrop';
        document.body.appendChild(backdrop);

        // Toast container
        const toastEl = document.createElement('div');
        toastEl.id = 'dt-toast';
        document.body.appendChild(toastEl);
        toastEl.id = 'dt-toast';

        // Tooltip popover
        const tt = document.createElement('div');
        tt.id = 'dt-tooltip';
        document.body.appendChild(tt);

        // Streak counter HUD (hidden until applyStateToUI runs)
        buildCounterHUD();

        // Panel
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="dt-head" data-drag-handle="true">
              <h2 class="dt-title">Dice Tools</h2>
              <button class="dt-close" id="dt-close-btn" aria-label="Close">×</button>
            </div>
            <div class="dt-body">
              ${buildCalcPanel()}
              ${buildOptPanel()}
              ${buildResultsPanel()}
              ${buildSettingsPanel()}
            </div>
            <nav class="dt-tabs" role="tablist">
              <button class="dt-tab-btn active" data-tab="calc"><span class="dt-tab-icon">🎲</span>Calc</button>
              <button class="dt-tab-btn" data-tab="opt"><span class="dt-tab-icon">⚙️</span>Optimizer</button>
              <button class="dt-tab-btn" data-tab="results"><span class="dt-tab-icon">📊</span>Results</button>
              <button class="dt-tab-btn" data-tab="settings"><span class="dt-tab-icon">⚙</span>Settings</button>
            </nav>
        `;
        document.body.appendChild(panel);
    }

    /* ---- Helper: field with ? tooltip ----
       NOTE: we use <span class="dt-label"> instead of <label> to avoid an iOS
       Safari quirk where tapping an interactive child of a <label> still
       forwards focus to the associated <input>, triggering a virtual-keyboard
       scroll that immediately hides the tooltip. */
    function helpBtn(label) {
        const gl = GLOSSARY[label];
        return gl ? `<button type="button" class="dt-help" data-tooltip="${label}" aria-label="Help about ${label}">?</button>` : '';
    }
    function fieldHTML(label, id, value, type = 'text', inputmode = 'decimal') {
        return `
          <div class="dt-field">
            <span class="dt-label">${label}${helpBtn(label)}</span>
            <input type="${type}" inputmode="${inputmode}" id="dt-${id}" value="${value}">
          </div>`;
    }
    function fieldWideHTML(label, id, value, hint = '') {
        const hintHTML = hint ? `<div class="dt-hint">${hint}</div>` : '';
        return `
          <div class="dt-field dt-field-wide">
            <span class="dt-label">${label}${helpBtn(label)}</span>
            <input type="text" id="dt-${id}" class="dt-text-input" value="${value}">
            ${hintHTML}
          </div>`;
    }

    /* ---- Tab: Calculator / Simulator ---- */
    function buildCalcPanel() {
        return `
          <section class="dt-panel active" id="dt-panel-calc">
            <div class="dt-card">
              <div class="dt-card-title">Parameters</div>
              ${fieldHTML('Balance', 'balance', '20')}
              ${fieldHTML('Win Increase %', 'win_inc', '78')}
              ${fieldHTML('Loss Reset', 'loss_reset', '5', 'text', 'numeric')}
              ${fieldHTML('Balance Divisor', 'bet_div', '500')}
              ${fieldHTML('Profit Multiplier', 'profit_mult', '100')}
              ${fieldHTML('Buffer %', 'buffer', '25')}
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Calculated Values</div>
              <div class="dt-field">
                <span class="dt-label">Multiplier${helpBtn('Multiplier')}</span>
                <input type="text" id="dt-out_mult" readonly>
                <button class="dt-btn dt-btn-small" data-copy="out_mult">Copy</button>
              </div>
              <div class="dt-field">
                <span class="dt-label">Bet Size${helpBtn('Bet Size')}</span>
                <input type="text" id="dt-out_bet" readonly>
                <button class="dt-btn dt-btn-small" data-copy="out_bet">Copy</button>
              </div>
              <div class="dt-field">
                <span class="dt-label">Profit Stop${helpBtn('Profit Stop')}</span>
                <input type="text" id="dt-out_profit" readonly>
                <button class="dt-btn dt-btn-small" data-copy="out_profit">Copy</button>
              </div>
              <div class="dt-field">
                <span class="dt-label">Balance Target${helpBtn('Balance Target')}</span>
                <input type="text" id="dt-out_target" readonly>
                <button class="dt-btn dt-btn-small" data-copy="out_target">Copy</button>
              </div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Simulation Controls</div>
              ${fieldHTML('Trials', 'n_trials', '100', 'text', 'numeric')}
              <div class="dt-btn-row">
                <button class="dt-btn dt-btn-primary" id="dt-sim_run">Run Simulation</button>
                <button class="dt-btn dt-btn-danger" id="dt-sim_stop" disabled>Stop</button>
              </div>
              <div class="dt-progress-wrap"><div class="dt-progress-bar" id="dt-sim_progress"></div></div>
              <div class="dt-status-line" id="dt-sim_status">Idle</div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Simulation Results</div>
              <div class="dt-scroll">
                <table class="dt-stats" id="dt-sim_results">
                  <tbody>
                    <tr><td colspan="2" style="text-align:center; opacity:0.5; padding:16px;">Run a simulation to see stats.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Game Integration</div>
              <button class="dt-btn dt-btn-primary dt-btn-block" id="dt-game_sync">Export Balance &amp; Update Strategy</button>
              <button class="dt-btn dt-btn-block" id="dt-game_import">Import New Strategy</button>
              <div class="dt-hint" style="margin-top:8px;">Sync reads your in-game balance, recalculates, then writes the new bet size + profit stop into your existing strategy. Import creates a fresh strategy from scratch.</div>
            </div>
          </section>
        `;
    }

    /* ---- Tab: Optimizer ---- */
    function buildOptPanel() {
        return `
          <section class="dt-panel" id="dt-panel-opt">
            <div class="dt-card">
              <div class="dt-card-title">Parameter Ranges</div>
              ${fieldWideHTML('Starting Balance', 'opt_balance', '20')}
              ${fieldWideHTML('Trials per Combo', 'opt_trials', '10')}
              ${fieldWideHTML('Bet Divisor Range', 'opt_betdiv', '256,500', 'e.g. 256-512;step=1 or 25,30,40')}
              ${fieldWideHTML('Profit Multiplier Range', 'opt_profit', '50,100', 'e.g. 25-150;step=5')}
              ${fieldWideHTML('Win Increase % Range', 'opt_w', '50-100;step=5', 'e.g. 50-150;step=5')}
              ${fieldWideHTML('Loss Reset (whole)', 'opt_l', '3-5;step=1', 'e.g. 3-8 (integers only)')}
              ${fieldWideHTML('Buffer % Range', 'opt_buf', '25,30,40', 'e.g. 20-40;step=2')}
              <button class="dt-btn dt-btn-primary dt-btn-block" id="dt-opt_run">Run Optimizer</button>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Progress</div>
              <div class="dt-progress-wrap"><div class="dt-progress-bar" id="dt-opt_progress"></div></div>
              <div class="dt-status-line" id="dt-opt_status">Idle</div>
              <div class="dt-btn-row">
                <button class="dt-btn" id="dt-opt_clear">Clear Results</button>
                <button class="dt-btn dt-btn-danger" id="dt-opt_stop" disabled>Stop</button>
              </div>
            </div>
          </section>
        `;
    }

    /* ---- Tab: Results ---- */
    function buildResultsPanel() {
        return `
          <section class="dt-panel" id="dt-panel-results">
            <div class="dt-card">
              <div class="dt-card-title">Optimizer Results</div>
              <div class="dt-status-line" id="dt-res_status">No results yet. Run the Optimizer.</div>
              <div class="dt-scroll">
                <table class="dt-results" id="dt-res_table">
                  <thead><tr id="dt-res_head"></tr></thead>
                  <tbody id="dt-res_body"></tbody>
                </table>
              </div>
              <div class="dt-btn-row">
                <button class="dt-btn" id="dt-res_apply">Apply Selected</button>
                <button class="dt-btn" id="dt-res_csv">Save to CSV</button>
              </div>
              <div class="dt-hint" style="margin-top:8px;">Tap a row to select it, then "Apply Selected" to load those parameters into the Calculator.</div>
            </div>
          </section>
        `;
    }

    /* ---- Tab: Settings ---- */
    function buildSettingsPanel() {
        return `
          <section class="dt-panel" id="dt-panel-settings">
            <div class="dt-card">
              <div class="dt-card-title">Interface</div>
              <div class="dt-setting-row">
                <div class="dt-setting-label">Color Theme</div>
                <select class="dt-theme-select" id="dt-theme_select">
                  <option value="original">Original</option>
                  <option value="stake">Stake</option>
                  <option value="shuffle">Shuffle</option>
                </select>
              </div>
              <div class="dt-setting-row">
                <div>
                  <div class="dt-setting-label">Large Fonts (+20%)</div>
                  <div class="dt-setting-desc">Increases text size across the app.</div>
                </div>
                <label class="dt-switch"><input type="checkbox" id="dt-large_fonts"><span class="dt-slider"></span></label>
              </div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Optimizer</div>
              <div class="dt-setting-row">
                <div>
                  <div class="dt-setting-label">Append Results</div>
                  <div class="dt-setting-desc">If on, new Optimizer runs append to Results instead of replacing.</div>
                </div>
                <label class="dt-switch"><input type="checkbox" id="dt-keep_prev"><span class="dt-slider"></span></label>
              </div>
              <div class="dt-setting-row">
                <div>
                  <div class="dt-setting-label">Parallel Workers</div>
                  <div class="dt-setting-desc">Number of Web Workers used.</div>
                </div>
                <input type="number" min="1" max="8" class="dt-num-input" id="dt-worker_count">
              </div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">Streak Counter</div>
              <div class="dt-setting-row">
                <div>
                  <div class="dt-setting-label">Show Counter HUD</div>
                  <div class="dt-setting-desc">Draggable floating widget tracking win/loss streaks from the live dice results.</div>
                </div>
                <label class="dt-switch"><input type="checkbox" id="dt-show_counter"><span class="dt-slider"></span></label>
              </div>
              <div class="dt-setting-row">
                <div>
                  <div class="dt-setting-label">Auto-Stop Autoplay</div>
                  <div class="dt-setting-desc">Automatically click "Stop Autoplay" once win streak reaches the target.</div>
                </div>
                <label class="dt-switch"><input type="checkbox" id="dt-counter_autostop"><span class="dt-slider"></span></label>
              </div>
            </div>
            <div class="dt-card">
              <div class="dt-card-title">About</div>
              <div class="dt-setting-row">
                <div class="dt-setting-label">Version</div>
                <div style="opacity:0.7;">AiO 1.1</div>
              </div>
              <button class="dt-btn dt-btn-block dt-btn-small" id="dt-reset_state">Reset All Saved Data</button>
            </div>
          </section>
        `;
    }


    /* =========================================================
       CALCULATOR
       ========================================================= */
    function calcValues() {
        try {
            const balance = parseFloat($('balance').value);
            const w = parseFloat($('win_inc').value) / 100;
            const l = parseInt($('loss_reset').value);
            const bet_div = parseFloat($('bet_div').value);
            const profit_mult = parseFloat($('profit_mult').value);
            const buffer = 1 + parseFloat($('buffer').value) / 100;
            if (![balance, w, bet_div, profit_mult, buffer].every(isFinite) || !Number.isFinite(l)) throw 0;
            const m = ((1 + w) * l) * buffer;
            const bet_size = balance / bet_div;
            const profit_stop = bet_size * profit_mult;
            const target = balance + profit_stop;
            $('out_mult').value = m.toFixed(2) + 'x';
            $('out_bet').value = bet_size.toFixed(4);
            $('out_profit').value = profit_stop.toFixed(2);
            $('out_target').value = target.toFixed(2);
        } catch {
            ['out_mult', 'out_bet', 'out_profit', 'out_target'].forEach(id => $(id).value = 'Invalid');
        }
    }

    function getSimParams() {
        const n = parseInt($('n_trials').value);
        if (!Number.isFinite(n) || n < 1) throw new Error('Invalid trials count');
        const p = {
            starting_balance: parseFloat($('balance').value),
            bet_div: parseFloat($('bet_div').value),
            profit_mult: parseFloat($('profit_mult').value),
            w: parseFloat($('win_inc').value) / 100,
            l: parseInt($('loss_reset').value),
            buffer: 1 + parseFloat($('buffer').value) / 100,
            n_trials: n
        };
        for (const [k, v] of Object.entries(p)) {
            if (!Number.isFinite(v)) throw new Error('Invalid value for ' + k);
        }
        return p;
    }

    /* =========================================================
       SIMULATOR
       ========================================================= */
    function startSimulation() {
        if (simRunning) return;
        let params;
        try { params = getSimParams(); } catch { toast('Please enter valid positive numbers.'); return; }
        simRunning = true;
        $('sim_run').disabled = true;
        $('sim_stop').disabled = false;
        $('sim_progress').style.width = '0%';
        $('sim_status').textContent = 'Running...';
        simWorker = makeWorker();
        simWorker.onmessage = (e) => {
            const m = e.data;
            if (m.kind === 'sim_progress') {
                const pct = (m.done / m.total * 100).toFixed(1);
                $('sim_progress').style.width = pct + '%';
                $('sim_status').textContent = `Progress: ${pct}% (${m.done}/${m.total})`;
            } else if (m.kind === 'sim_done') {
                renderSimStats(m.stats);
                endSimulation('Done');
            } else if (m.kind === 'error') {
                toast('Simulation error: ' + m.error);
                endSimulation('Error');
            }
        };
        simWorker.postMessage({ kind: 'run_sim', params });
    }
    function stopSimulation() {
        if (!simRunning || !simWorker) return;
        simWorker.postMessage({ kind: 'stop' });
        setTimeout(() => endSimulation('Stopped'), 200);
    }
    function endSimulation(status) {
        if (simWorker) { try { simWorker.terminate(); } catch {} simWorker = null; }
        simRunning = false;
        $('sim_run').disabled = false;
        $('sim_stop').disabled = true;
        $('sim_status').textContent = status;
    }
    function renderSimStats(s) {
        const rows = [
            ['Average highest balance', s.avg_high ? '$' + s.avg_high.toFixed(2) : 'N/A'],
            ['Std dev (highest)', s.std_high ? '$' + s.std_high.toFixed(2) : 'N/A'],
            ['Max highest balance', s.max_high ? '$' + s.max_high.toFixed(2) : 'N/A'],
            ['Average cycles', s.avg_cycles.toFixed(2)],
            ['Average rounds', s.avg_rounds.toFixed(2)],
            ['Cycle success rate', s.cycle_success.toFixed(2) + '%'],
            ['Bust rate', s.bust_rate.toFixed(2) + '%']
        ];
        const tbody = $('sim_results').querySelector('tbody');
        tbody.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    }

    /* =========================================================
       OPTIMIZER (parseRange + combo pool)
       ========================================================= */
    function parseRange(text, integer = false) {
        try {
            text = (text || '').trim();
            if (!text) return [];
            if (text.includes(',')) {
                return text.split(',').map(s => s.trim()).filter(Boolean)
                    .map(p => integer ? Math.trunc(parseFloat(p)) : parseFloat(p));
            }
            let step = null;
            if (text.includes(';')) {
                const [left, right] = text.split(';', 2).map(s => s.trim());
                text = left;
                if (right.includes('=')) {
                    const [k, v] = right.split('=').map(s => s.trim());
                    if (k.toLowerCase() === 'step') step = integer ? Math.trunc(parseFloat(v)) : parseFloat(v);
                }
            }
            if (text.includes('-') && text.lastIndexOf('-') > 0) {
                const idx = text[0] === '-' ? text.indexOf('-', 1) : text.indexOf('-');
                const start_s = text.slice(0, idx);
                const end_s = text.slice(idx + 1);
                const start = integer ? Math.trunc(parseFloat(start_s)) : parseFloat(start_s);
                const end = integer ? Math.trunc(parseFloat(end_s)) : parseFloat(end_s);
                if (step != null) {
                    if (step === 0) return [];
                    const out = [];
                    if (start <= end) {
                        const count = Math.floor((end - start) / step) + 1;
                        for (let i = 0; i < count; i++) out.push(start + i * step);
                    } else {
                        const count = Math.floor((start - end) / step) + 1;
                        for (let i = 0; i < count; i++) out.push(start - i * step);
                    }
                    return out;
                }
                if (integer) {
                    const dir = start <= end ? 1 : -1;
                    const out = [];
                    for (let v = start; dir > 0 ? v <= end : v >= end; v += dir) out.push(v);
                    return out;
                }
                if (start === end) return [start];
                const out = [];
                for (let i = 0; i < 10; i++) out.push(start + i * (end - start) / 9);
                return out;
            }
            return [integer ? Math.trunc(parseFloat(text)) : parseFloat(text)];
        } catch { return []; }
    }

    function getOptParams() {
        const opt = {
            starting_balance: parseFloat($('opt_balance').value),
            n_trials: parseInt($('opt_trials').value),
            bet_div_range: parseRange($('opt_betdiv').value),
            profit_mult_range: parseRange($('opt_profit').value),
            w_range: parseRange($('opt_w').value),
            l_range: parseRange($('opt_l').value, true),
            buffer_range: parseRange($('opt_buf').value)
        };
        if (!Number.isFinite(opt.starting_balance) || !Number.isFinite(opt.n_trials) || opt.n_trials < 1) throw new Error('Invalid balance or trials');
        if ([opt.bet_div_range, opt.profit_mult_range, opt.w_range, opt.l_range, opt.buffer_range].some(r => !r.length)) throw new Error('Empty range');
        return opt;
    }
    function buildCombos(opt) {
        const combos = [];
        for (const bet_div of opt.bet_div_range)
            for (const profit_mult of opt.profit_mult_range)
                for (const w of opt.w_range)
                    for (const l of opt.l_range)
                        for (const buf of opt.buffer_range)
                            combos.push({
                                bet_div, profit_mult,
                                w: w / 100, l,
                                buffer: 1 + buf / 100,
                                starting_balance: opt.starting_balance,
                                n_trials: opt.n_trials
                            });
        return combos;
    }
    function startOptimizer() {
        if (optRunning) return;
        let opt;
        try { opt = getOptParams(); } catch { toast('Check your range syntax (e.g. 100-500 or 20,30,40).'); return; }
        const combos = buildCombos(opt);
        if (!combos.length) { toast('No combinations to run.'); return; }
        if (combos.length > 50000) {
            if (!confirm(`${combos.length} combinations may take a long time. Continue?`)) return;
        }
        if (!$('keep_prev').checked) { optResults = []; renderResults(); }
        optQueue = combos.slice();
        optTotal = combos.length;
        optDone = 0;
        optRunning = true;
        $('opt_run').disabled = true;
        $('opt_stop').disabled = false;
        $('opt_progress').style.width = '0%';
        $('opt_status').textContent = `Running 0 / ${optTotal}...`;
        const poolSize = Math.min(parseInt($('worker_count').value) || 1, combos.length);
        optWorkers = [];
        for (let i = 0; i < poolSize; i++) {
            const w = makeWorker();
            w.onmessage = (e) => handleOptMsg(w, e.data);
            optWorkers.push(w);
            dispatchNext(w);
        }
    }
    function handleOptMsg(worker, msg) {
        if (msg.kind === 'opt_row') optResults.push(msg.row);
        else if (msg.kind === 'opt_combo_done') {
            optDone++;
            const pct = (optDone / optTotal * 100);
            $('opt_progress').style.width = pct.toFixed(1) + '%';
            $('opt_status').textContent = `Running ${optDone} / ${optTotal} (${pct.toFixed(1)}%)`;
            if (optDone >= optTotal || !optRunning) finishOptimizer();
            else dispatchNext(worker);
        }
    }
    function dispatchNext(worker) {
        if (!optRunning) return;
        const combo = optQueue.shift();
        if (!combo) return;
        worker.postMessage({ kind: 'run_combo', combo });
    }
    function stopOptimizer() {
        if (!optRunning) return;
        optRunning = false;
        optQueue = [];
        for (const w of optWorkers) { try { w.postMessage({ kind: 'stop' }); } catch {} }
        setTimeout(finishOptimizer, 250);
    }
    function finishOptimizer() {
        if (!optRunning && !optWorkers.length) return;
        for (const w of optWorkers) { try { w.terminate(); } catch {} }
        optWorkers = [];
        optRunning = false;
        optResults.sort((a, b) => b.Score - a.Score);
        state.results = optResults.slice();
        saveState();
        renderResults();
        $('opt_run').disabled = false;
        $('opt_stop').disabled = true;
        $('opt_status').textContent = `Done (${optResults.length} results)`;
        toast('Optimizer complete');
        switchTab('results');
    }

    /* =========================================================
       RESULTS TABLE
       ========================================================= */
    function renderResults() {
        const head = $('res_head');
        const body = $('res_body');
        if (!head) return;
        head.innerHTML = RES_COLS.map(c => `<th data-col="${c}">${c}${c === resultsSortCol ? (resultsSortAsc ? ' ▲' : ' ▼') : ''}</th>`).join('');
        if (!optResults.length) {
            body.innerHTML = '';
            $('res_status').textContent = 'No results yet. Run the Optimizer.';
            return;
        }
        $('res_status').textContent = optResults.length + ' result' + (optResults.length === 1 ? '' : 's');
        const sorted = optResults.slice().sort((a, b) => {
            const av = a[resultsSortCol], bv = b[resultsSortCol];
            if (av == null && bv == null) return 0;
            const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
            return resultsSortAsc ? cmp : -cmp;
        });
        body.innerHTML = sorted.map((r, i) => {
            const cells = RES_COLS.map(c => {
                const v = r[c];
                return `<td>${typeof v === 'number' ? v.toFixed(2) : v}</td>`;
            }).join('');
            const origIdx = optResults.indexOf(r);
            return `<tr data-idx="${origIdx}" class="${origIdx === selectedRowIdx ? 'selected' : ''}">${cells}</tr>`;
        }).join('');
    }
    function onResTableClick(e) {
        const th = e.target.closest('th');
        if (th && th.dataset.col) {
            const col = th.dataset.col;
            if (resultsSortCol === col) resultsSortAsc = !resultsSortAsc;
            else { resultsSortCol = col; resultsSortAsc = false; }
            renderResults();
            return;
        }
        const tr = e.target.closest('tr[data-idx]');
        if (tr) {
            $$('#dt-res_body tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            selectedRowIdx = parseInt(tr.dataset.idx);
        }
    }
    function applySelectedToCalculator() {
        if (selectedRowIdx < 0 || !optResults[selectedRowIdx]) { toast('Select a row first.'); return; }
        const r = optResults[selectedRowIdx];
        $('bet_div').value = r.BetDiv;
        $('profit_mult').value = r.ProfitMult;
        $('win_inc').value = r['W%'];
        $('loss_reset').value = r.L;
        $('buffer').value = r['Buffer%'];
        calcValues();
        saveState();
        switchTab('calc');
        toast('Parameters applied to Calculator');
    }
    function clearResults() {
        if (!optResults.length) return;
        if (!confirm('Clear all optimizer results?')) return;
        optResults = [];
        state.results = [];
        selectedRowIdx = -1;
        saveState();
        renderResults();
    }
    function exportResultsCSV() {
        if (!optResults.length) { toast('No results to save.'); return; }
        const sorted = optResults.slice().sort((a, b) => {
            const cmp = a[resultsSortCol] - b[resultsSortCol];
            return resultsSortAsc ? cmp : -cmp;
        });
        const lines = [RES_COLS.join(',')];
        for (const r of sorted) {
            lines.push(RES_COLS.map(c => {
                const v = r[c];
                if (v == null) return '';
                const s = String(v);
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(','));
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dice_tool_results_' + Date.now() + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('CSV downloaded');
    }


    /* =========================================================
       GAME INTEGRATION — site-aware functions that read balance
       from the casino DOM and write strategy back into it.
       Mirrors the desktop userscript exactly, per-site selectors.
       ========================================================= */

    /* ---- Close the strategy popup after updating. Just clicks the X. ---- */
    async function closeStrategyPopup_shuffle() {
        await sleep(400);
        const btn = document.querySelector('button[aria-label*="close" i]');
        if (btn) { btn.click(); return true; }
        return false;
    }
    async function closeStrategyPopup_stake() {
        await sleep(400);
        const btn = document.querySelector('button[data-testid="game-modal-close"]');
        if (btn) { btn.click(); return true; }
        return false;
    }

    /* ---- Shuffle.us ---- */
    async function shuffle_exportBalance() {
        const activeBtn = document.querySelector('button.TabView_active__G842W p');
        if (!activeBtn || !activeBtn.textContent.trim()) { toast('Active balance element not found'); return; }
        const raw = activeBtn.textContent.trim();
        let cleaned = raw.replace(/,/g, '').replace(/[^0-9.]/g, '');
        const parts = cleaned.split('.');
        if (parts.length > 2) cleaned = parts.shift() + '.' + parts.join('');
        if (!cleaned || isNaN(cleaned)) { toast('Invalid balance: ' + raw); return; }
        const balance = Number(cleaned);
        $('balance').value = balance;
        calcValues();
        saveState();
        toast(`Balance imported: ${balance}`);
    }
    async function shuffle_updateExisting() {
        try {
            const v = currentCalcValues();
            const betSize = v.bet_size;
            const profitStop = v.profit_stop;
            if (!betSize || !profitStop || betSize === 'Invalid') { toast('Missing bet_size or profit_stop.'); return; }
            const betInput = document.querySelector('input[data-testid="bet-amount"]');
            if (betInput) setNativeValue(betInput, betSize);
            const editBtn = await waitForText('button', 'Edit');
            if (!editBtn) { toast('Edit button not found'); return; }
            editBtn.click();
            await sleep(1000);
            const headers = document.querySelectorAll('.AdvancedDiceCondition_header__jDZzw');
            const cond4 = Array.from(headers).find(h => h.textContent.includes('Condition 4'));
            if (!cond4) { toast('Condition 4 not found.'); return; }
            cond4.click();
            await sleep(500);
            const conditionDiv = cond4.closest('.AdvancedDiceCondition_root__CaIQo');
            const inputs = conditionDiv ? conditionDiv.querySelectorAll('input[type="number"]') : [];
            if (inputs[0]) setNativeValue(inputs[0], profitStop);
            await closeStrategyPopup_shuffle();
            toast('Existing strategy updated.');
        } catch (err) { toast('Update failed: ' + err); console.error(err); }
    }
    async function shuffle_importNew() {
        try {
            const v = currentCalcValues();
            const { bet_size, profit_stop, multiplier, win_increase, loss_reset } = v;
            if (bet_size === 'Invalid' || profit_stop === 'Invalid') { toast('Calculator values invalid.'); return; }
            const advancedTab = document.getElementById('advanced-bet');
            if (advancedTab && !advancedTab.classList.contains('TabView_active__G842W')) {
                advancedTab.click();
                await sleep(800);
            }
            const betInfoInputs = document.querySelectorAll('input#betInfo');
            if (betInfoInputs.length < 2) throw 'betInfo inputs not found';
            setNativeValue(betInfoInputs[0], multiplier);
            await sleep(600);
            const winChance = betInfoInputs[1].value;
            const betInput = document.querySelector('input[data-testid="bet-amount"]');
            if (betInput) setNativeValue(betInput, bet_size);
            const createBtn = await waitForText('button', 'Create strategy');
            if (!createBtn) throw 'Create strategy button not found';
            createBtn.click();
            await sleep(800);
            const labels = Array.from(document.querySelectorAll('label'));
            const nameLabel = labels.find(l => l.textContent.includes('Strategy name'));
            let nameInput = null;
            if (nameLabel) {
                const container = nameLabel.closest('div.TextInput_formControlWrapper__iBF1i') || nameLabel.parentElement.parentElement;
                nameInput = container.querySelector('input');
            }
            if (!nameInput) nameInput = document.querySelector('.ModalContent_modalContent__rbnMN input[type="text"]') || document.querySelector('.ModalContent_modalContent__rbnMN input:not([type="hidden"])');
            if (!nameInput) throw 'Could not locate Strategy Name input field.';
            nameInput.focus();
            setNativeValue(nameInput, `${multiplier}x`);
            await sleep(300);
            if (nameInput.value !== `${multiplier}x`) { setNativeValue(nameInput, `${multiplier}x`); await sleep(300); }
            const getStartedBtn = await waitForText('button', 'Get Started');
            if (!getStartedBtn) throw 'Get Started button not found';
            getStartedBtn.click();
            const addBtn = await waitForText('button', 'Add new condition block', 10000);
            if (!addBtn) throw 'Add condition block button not found';
            for (let i = 0; i < 4; i++) { addBtn.click(); await sleep(500); }
            await sleep(1000);
            const headers = document.querySelectorAll('.AdvancedDiceCondition_header__jDZzw');
            if (headers.length < 4) throw `Only ${headers.length} conditions created.`;
            for (let i = 0; i < 4; i++) {
                headers[i].click();
                await sleep(500);
                const conditionDiv = headers[i].closest('.AdvancedDiceCondition_root__CaIQo');
                const radioLabels = conditionDiv.querySelectorAll('.AdvancedDiceCondition_customRadio__H__kC');
                const targetRadioIndex = (i === 0 || i === 3) ? 1 : 0;
                if (radioLabels[targetRadioIndex] && !radioLabels[targetRadioIndex].classList.contains('AdvancedDiceCondition_checked__Hivoo')) {
                    radioLabels[targetRadioIndex].click();
                    await sleep(300);
                }
                const selects = conditionDiv.querySelectorAll('select');
                const inputs = conditionDiv.querySelectorAll('input[type="number"]');
                if (i === 0) {
                    setSelectValue(selects[0], 'balance');
                    setSelectValue(selects[1], 'greaterThanOrEqualTo');
                    setNativeValue(inputs[0], '0.00');
                    setSelectValue(selects[2], 'setWinChance');
                    await sleep(300);
                    const refreshedInputs = conditionDiv.querySelectorAll('input[type="number"]');
                    const winChanceInput = refreshedInputs[1];
                    if (!winChanceInput) throw 'Win chance input not found after re-render';
                    setNativeValue(winChanceInput, winChance);
                } else if (i === 1) {
                    setSelectValue(selects[0], 'every');
                    setNativeValue(inputs[0], '1');
                    setSelectValue(selects[1], 'wins');
                    setSelectValue(selects[2], 'increaseBetAmountPercentage');
                    await sleep(300);
                    const refreshedInputs = conditionDiv.querySelectorAll('input[type="number"]');
                    const increaseInput = refreshedInputs[1];
                    if (!increaseInput) throw 'Increase % input not found after re-render';
                    setNativeValue(increaseInput, win_increase);
                } else if (i === 2) {
                    setSelectValue(selects[0], 'everyStreakOf');
                    setNativeValue(inputs[0], loss_reset);
                    setSelectValue(selects[1], 'losses');
                    setSelectValue(selects[2], 'resetBetAmount');
                } else if (i === 3) {
                    setSelectValue(selects[0], 'profit');
                    setSelectValue(selects[1], 'greaterThanOrEqualTo');
                    setNativeValue(inputs[0], profit_stop);
                    setSelectValue(selects[2], 'stopAutobet');
                }
                await sleep(400);
            }
            toast(`"${multiplier}x" strategy created. Click "Save Strategy".`);
        } catch (err) { toast('Import failed: ' + err); console.error(err); }
    }

    /* ---- Stake.us / Stake.com ---- */
    async function stake_exportBalance() {
        const el = document.querySelector('span.ds-body-md-strong[data-ds-text="true"][style*="max-width: 16ch"]') ||
                   document.querySelector('span.ds-body-md-strong[data-ds-text="true"]');
        if (!el) { toast('Balance element not found'); return; }
        const rawText = el.textContent.trim();
        let cleaned = rawText.replace(/,/g, '').replace(/[^\d.]/g, '');
        const parts = cleaned.split('.');
        if (parts.length > 2) cleaned = parts.shift() + '.' + parts.join('');
        const balance = parseFloat(cleaned);
        if (isNaN(balance)) { toast('Invalid balance: ' + rawText); return; }
        $('balance').value = balance;
        calcValues();
        saveState();
        toast(`Balance imported: ${balance}`);
    }
    async function stake_updateExisting() {
        try {
            const v = currentCalcValues();
            const betSize = v.bet_size;
            const profitStop = v.profit_stop;
            if (!betSize || !profitStop || betSize === 'Invalid') { toast('Missing bet_size or profit_stop.'); return; }
            const betInput = await waitFor('input[data-testid="input-game-amount"]');
            betInput.value = betSize; trigger(betInput);
            const cond4BlockBtn = await waitFor('button[data-testid="block-condition-4"]');
            cond4BlockBtn.click();
            await sleep(600);
            const editBtn = document.querySelector('button[data-testid="conditional-block-edit-condition-4"]');
            if (editBtn) { editBtn.click(); await sleep(600); }
            const profitInput = await waitFor('input[data-testid="condition-profit-amount-input"]');
            profitInput.value = profitStop; trigger(profitInput);
            await closeStrategyPopup_stake();
            toast('Existing strategy updated.');
        } catch (err) { toast('Update failed: ' + err); console.error(err); }
    }
    async function stake_importNew() {
        try {
            const v = currentCalcValues();
            const { bet_size, profit_stop, multiplier, win_increase, loss_reset } = v;
            if (bet_size === 'Invalid' || profit_stop === 'Invalid') { toast('Calculator values invalid.'); return; }
            const payoutInput = await waitFor('input[data-testid="payout"]');
            payoutInput.value = multiplier; trigger(payoutInput);
            await sleep(600);
            const chanceEl = await waitFor('input[data-testid="chance"]');
            const winChance = chanceEl.value;
            const betInput = document.querySelector('input[data-testid="input-game-amount"]');
            if (betInput) { betInput.value = bet_size; trigger(betInput); }
            const advBtn = await waitFor('svg[data-ds-icon="BetAdvanced"]');
            advBtn.closest('button').click();
            await sleep(800);
            const createBtn = await waitFor('button[data-testid="create-strategy-button"]');
            createBtn.click();
            await sleep(800);
            const nameInput = await waitFor('input[data-testid="strategy-name-input"]');
            nameInput.value = `${multiplier}x`; trigger(nameInput);
            const getStartedBtn = Array.from(document.querySelectorAll('div, button')).find(el => el.textContent.trim() === 'Get Started' || el.textContent.trim() === 'Get started');
            if (!getStartedBtn) throw 'Get Started button not found';
            getStartedBtn.click();
            await sleep(1500);
            const addBtn = await waitFor('button[data-testid="conditional-block-add"]');
            for (let i = 0; i < 4; i++) { addBtn.click(); await sleep(800); }
            await sleep(1000);
            const editPencils = document.querySelectorAll('svg[data-ds-icon="Edit"]');
            if (editPencils.length < 4) throw `Only ${editPencils.length} conditions created`;
            editPencils[0].closest('button').click();
            await sleep(600);
            const profitRadio1 = await waitFor('label[data-testid="condition-type-radio-profit"]');
            profitRadio1.click(); await sleep(300);
            let sel = await waitFor('select[data-testid="condition-profit-type"]');
            sel.value = 'balance'; trigger(sel);
            sel = await waitFor('select[data-testid="condition-profit-term-type-options"]');
            sel.value = 'greaterThanOrEqualTo'; trigger(sel);
            let inp = await waitFor('input[data-testid="condition-profit-amount-input"]');
            inp.value = '0.00'; trigger(inp);
            sel = await waitFor('select[data-testid="condition-action-options"]');
            sel.value = 'setWinChance'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-action-percentage-input"]');
            inp.value = winChance; trigger(inp);
            await sleep(500);
            editPencils[1].closest('button').click(); await sleep(600);
            sel = await waitFor('select[data-testid="condition-term-options"]');
            sel.value = 'every'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-count-input"]');
            inp.value = '1'; trigger(inp);
            sel = await waitFor('select[data-testid="condition-bet-type-options"]');
            sel.value = 'win'; trigger(sel);
            sel = await waitFor('select[data-testid="condition-action-options"]');
            sel.value = 'increaseByPercentage'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-action-percentage-input"]');
            inp.value = win_increase; trigger(inp);
            await sleep(500);
            editPencils[2].closest('button').click(); await sleep(600);
            sel = await waitFor('select[data-testid="condition-term-options"]');
            sel.value = 'everyStreakOf'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-count-input"]');
            inp.value = loss_reset; trigger(inp);
            sel = await waitFor('select[data-testid="condition-bet-type-options"]');
            sel.value = 'lose'; trigger(sel);
            sel = await waitFor('select[data-testid="condition-action-options"]');
            sel.value = 'resetAmount'; trigger(sel);
            await sleep(500);
            editPencils[3].closest('button').click(); await sleep(600);
            const profitRadio4 = await waitFor('label[data-testid="condition-type-radio-profit"]');
            profitRadio4.click(); await sleep(300);
            sel = await waitFor('select[data-testid="condition-profit-type"]');
            sel.value = 'profit'; trigger(sel);
            sel = await waitFor('select[data-testid="condition-profit-term-type-options"]');
            sel.value = 'greaterThanOrEqualTo'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-profit-amount-input"]');
            inp.value = profit_stop; trigger(inp);
            sel = await waitFor('select[data-testid="condition-action-options"]');
            sel.value = 'stop'; trigger(sel);
            toast(`"${multiplier}x" strategy created. Click "Save Strategy".`);
        } catch (err) { toast('Import failed: ' + err); console.error(err); }
    }

    /* Pick the right site's implementation */
    function gameExport() {
        if (location.hostname.includes('shuffle.us')) return shuffle_exportBalance();
        return stake_exportBalance();
    }
    function gameUpdate() {
        if (location.hostname.includes('shuffle.us')) return shuffle_updateExisting();
        return stake_updateExisting();
    }
    function gameImport() {
        if (location.hostname.includes('shuffle.us')) return shuffle_importNew();
        return stake_importNew();
    }
    /* Combined one-tap flow: scrape balance → recompute → push new bet size
       and profit stop into the existing in-game strategy. */
    async function gameSync() {
        await gameExport();
        // Let the calculator settle before reading its outputs
        await sleep(150);
        await gameUpdate();
    }


    /* =========================================================
       STREAK COUNTER HUD — win/loss tracking + autoplay stopper.
       Site-aware DOM observers ported from the desktop userscript.
       ========================================================= */
    let _winStreak = 0, _lossStreak = 0;
    let _counterObservers = [];
    let _counterInitPoll = null;

    function buildCounterHUD() {
        const host = document.createElement('div');
        host.id = COUNTER_ID;
        host.innerHTML = `
          <div class="dt-ctr-row" data-ctr-drag="true">
            <div>
              <div class="dt-ctr-lbl">Wins</div>
              <div class="dt-ctr-w" id="dt-ctr_w">0</div>
            </div>
            <div>
              <div class="dt-ctr-lbl">Losses</div>
              <div class="dt-ctr-l" id="dt-ctr_l">0</div>
            </div>
            <span class="dt-ctr-drag" title="Drag">⠿</span>
          </div>
          <div class="dt-ctr-row">
            <span class="dt-ctr-lbl">Stop @</span>
            <input type="number" min="0" class="dt-ctr-target" id="dt-ctr_target" value="10">
            <button class="dt-ctr-btn" id="dt-ctr_reset">Reset</button>
          </div>
          <div class="dt-ctr-row">
            <span id="dt-ctr_vol_icon" style="font-size:13px;">🔊</span>
            <input type="range" min="0" max="100" value="100" class="dt-ctr-vol" id="dt-ctr_vol">
          </div>
          <div class="dt-ctr-row">
            <button class="dt-ctr-btn dt-ctr-btn-wide" id="dt-ctr_update">Update</button>
          </div>
        `;
        document.body.appendChild(host);
        return host;
    }

    function setCounterVisible(visible) {
        const host = document.getElementById(COUNTER_ID);
        if (!host) return;
        host.classList.toggle('show', !!visible);
    }
    function applyCounterTheme() {
        const host = document.getElementById(COUNTER_ID);
        if (!host) return;
        const panel = document.getElementById(PANEL_ID);
        const val = panel ? (panel.getAttribute('data-theme') || '') : '';
        host.setAttribute('data-theme', val);
    }
    function animateSpan(el) {
        if (!el) return;
        el.style.transform = 'scale(1.25)';
        setTimeout(() => { el.style.transform = 'scale(1)'; }, 300);
    }
    function updateCounterDisplay() {
        const w = document.getElementById('dt-ctr_w');
        const l = document.getElementById('dt-ctr_l');
        if (w) w.textContent = _winStreak;
        if (l) { l.textContent = _lossStreak; l.classList.toggle('has-loss', _lossStreak > 0); }
    }
    function playBeep() {
        const vol = state.counter_volume / 100;
        if (!vol) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.connect(gain);
            gain.connect(ctx.destination);
            gain.gain.value = vol * 0.35;
            osc.start();
            setTimeout(() => { osc.stop(); try { ctx.close(); } catch {} }, 200);
        } catch {}
    }
    function stopAutoplay_shuffle() {
        const stopText = document.querySelector('button[data-testid="bet-button"] span.ButtonVariants_buttonContent__mRPrs');
        if (stopText && stopText.innerText.includes('Stop Autoplay')) {
            const btn = stopText.closest('button');
            if (btn && !btn.disabled) btn.click();
        }
    }
    function stopAutoplay_stake() {
        const btn = document.querySelector('button[data-testid="auto-bet-button"][data-autobet-status="stop"]');
        if (btn && !btn.disabled) btn.click();
    }
    function stopAutoplayAction() {
        if (location.hostname.includes('shuffle.us')) return stopAutoplay_shuffle();
        return stopAutoplay_stake();
    }
    function onWinDetected() {
        _winStreak++;
        _lossStreak = 0;
        updateCounterDisplay();
        animateSpan(document.getElementById('dt-ctr_w'));
        playBeep();
        if (state.counter_autostop && _winStreak >= (state.counter_target || 0) && state.counter_target > 0) {
            stopAutoplayAction();
        }
    }
    function onLossDetected() {
        _lossStreak++;
        updateCounterDisplay();
        animateSpan(document.getElementById('dt-ctr_l'));
    }

    /* ---- Shuffle observer ---- */
    let _sh_prev3Active = false, _sh_lastSeenText = '';
    function initCounter_shuffle() {
        const conditionContainer = document.querySelector('.AdvancedDiceBet_conditionContainer__6o_z9');
        const resultsWrapper = document.querySelector('.OriginalGameRecentResult_originalGameResultsWrapper__aCNPr');
        if (!conditionContainer || !resultsWrapper) return false;
        const initialNewest = resultsWrapper.children[0];
        if (initialNewest) {
            const initialButton = initialNewest.querySelector('button');
            if (initialButton) _sh_lastSeenText = initialButton.innerText;
        }
        function checkCondition3() {
            const buttons = conditionContainer.querySelectorAll('button.AdvancedDiceConditionTag_condition__8L8IB');
            let cond3Btn = null;
            buttons.forEach(b => { if (b.innerText.trim() === '3') cond3Btn = b; });
            if (!cond3Btn) return;
            const tagDiv = cond3Btn.querySelector('div.AdvancedDiceConditionTag_tag__gdVMG');
            if (!tagDiv) return;
            const current3Active = tagDiv.classList.contains('AdvancedDiceConditionTag_active__7Rex1');
            if (current3Active && !_sh_prev3Active) { _winStreak = 0; updateCounterDisplay(); }
            _sh_prev3Active = current3Active;
        }
        const resultsObs = new MutationObserver(() => {
            const newest = resultsWrapper.children[0];
            if (!newest) return;
            const button = newest.querySelector('button');
            if (!button) return;
            const currentText = button.innerText;
            if (currentText === _sh_lastSeenText) return;
            _sh_lastSeenText = currentText;
            const isWin = button.style.backgroundColor === 'rgb(61, 209, 121)';
            if (isWin) onWinDetected(); else onLossDetected();
        });
        resultsObs.observe(resultsWrapper, { childList: true, subtree: true, attributes: true });
        const condObs = new MutationObserver(checkCondition3);
        condObs.observe(conditionContainer, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
        checkCondition3();
        _counterObservers.push(resultsObs, condObs);
        return true;
    }

    /* ---- Stake observer ---- */
    let _st_prev3Success = false, _st_lastSeenBetId = null;
    function initCounter_stake() {
        const container = document.querySelector('div[class*="condition-list-wrap"]');
        const pastBets = document.querySelector('.past-bets');
        if (!container || !pastBets) return false;
        function checkButton3() {
            const smallBlocks = container.querySelectorAll('div[class*="small-block"]');
            let b3div = null;
            smallBlocks.forEach(div => {
                const b = div.querySelector('button');
                if (b && b.innerText.trim() === '3') b3div = div;
            });
            if (!b3div) return;
            const curr = b3div.classList.contains('success');
            if (curr && !_st_prev3Success) { _winStreak = 0; updateCounterDisplay(); }
            _st_prev3Success = curr;
        }
        const betObs = new MutationObserver(() => {
            const newest = pastBets.querySelector('button[data-last-bet-index="0"]');
            if (!newest) return;
            const betId = newest.getAttribute('data-past-bet-id');
            if (betId === _st_lastSeenBetId) return;
            _st_lastSeenBetId = betId;
            const isWin = newest.classList.contains('variant-positive');
            if (isWin) onWinDetected(); else onLossDetected();
        });
        betObs.observe(pastBets, { childList: true, subtree: true });
        const condObs = new MutationObserver(checkButton3);
        condObs.observe(container, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
        checkButton3();
        _counterObservers.push(betObs, condObs);
        return true;
    }

    function initStreakCounter() {
        const initFn = location.hostname.includes('shuffle.us') ? initCounter_shuffle : initCounter_stake;
        if (initFn()) return;
        _counterInitPoll = setInterval(() => {
            if (initFn()) { clearInterval(_counterInitPoll); _counterInitPoll = null; }
        }, 500);
    }

    function setupCounterDrag(host) {
        let dragging = false, startX = 0, startY = 0, offsetX = 0, offsetY = 0;
        const begin = (x, y, ev) => {
            const target = ev && ev.target;
            if (target && target.matches('input, button, .dt-ctr-vol')) return false;
            dragging = true;
            const r = host.getBoundingClientRect();
            offsetX = x - r.left; offsetY = y - r.top;
            startX = x; startY = y;
            return true;
        };
        const move = (x, y) => {
            if (!dragging) return;
            const w = host.offsetWidth, h = host.offsetHeight;
            let nx = Math.max(4, Math.min(x - offsetX, window.innerWidth - w - 4));
            let ny = Math.max(4, Math.min(y - offsetY, window.innerHeight - h - 4));
            host.style.left = nx + 'px';
            host.style.top = ny + 'px';
            host.style.right = 'auto';
            state.counter_x = nx; state.counter_y = ny;
        };
        const end = () => {
            if (!dragging) return;
            dragging = false;
            saveState();
        };
        host.addEventListener('mousedown', e => {
            if (!begin(e.clientX, e.clientY, e)) return;
        });
        host.addEventListener('touchstart', e => {
            const t = e.touches[0];
            if (t && begin(t.clientX, t.clientY, e)) e.preventDefault();
        }, { passive: false });
        document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
        document.addEventListener('touchmove', e => {
            const t = e.touches[0]; if (t) move(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
    }

    function wireCounterControls() {
        const tInput = document.getElementById('dt-ctr_target');
        const reset = document.getElementById('dt-ctr_reset');
        const update = document.getElementById('dt-ctr_update');
        const vol = document.getElementById('dt-ctr_vol');
        const volIcon = document.getElementById('dt-ctr_vol_icon');
        if (tInput) {
            tInput.value = state.counter_target;
            tInput.addEventListener('change', () => {
                state.counter_target = Math.max(0, parseInt(tInput.value) || 0);
                saveState();
            });
        }
        if (reset) reset.addEventListener('click', () => {
            _winStreak = 0; _lossStreak = 0; updateCounterDisplay();
        });
        if (update) update.addEventListener('click', async () => {
            const original = update.textContent;
            update.disabled = true;
            update.textContent = '…';
            try { await gameSync(); }
            finally {
                update.disabled = false;
                update.textContent = original;
            }
        });
        const updateVolIcon = () => {
            const v = state.counter_volume / 100;
            if (!volIcon) return;
            volIcon.textContent = v === 0 ? '🔇' : v < 0.33 ? '🔈' : v < 0.66 ? '🔉' : '🔊';
        };
        if (vol) {
            vol.value = state.counter_volume;
            updateVolIcon();
            vol.addEventListener('input', () => {
                state.counter_volume = parseInt(vol.value) || 0;
                updateVolIcon();
                saveState();
            });
        }
    }


    /* =========================================================
       PANEL OPEN/CLOSE
       ========================================================= */
    function openPanel() {
        state.panel_open = true;
        document.getElementById(PANEL_ID).classList.add('show');
        document.getElementById('dt-backdrop').classList.add('show');
        saveState();
    }
    function closePanel() {
        state.panel_open = false;
        document.getElementById(PANEL_ID).classList.remove('show');
        document.getElementById('dt-backdrop').classList.remove('show');
        saveState();
    }
    function togglePanel() {
        state.panel_open ? closePanel() : openPanel();
    }

    /* =========================================================
       TAB SWITCHING
       ========================================================= */
    function switchTab(name) {
        const panel = document.getElementById(PANEL_ID);
        panel.querySelectorAll('.dt-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        panel.querySelectorAll('.dt-panel').forEach(p => p.classList.toggle('active', p.id === 'dt-panel-' + name));
        panel.querySelector('.dt-body').scrollTop = 0;
    }

    /* =========================================================
       TOOLTIPS (? helpers)
       ========================================================= */
    let _ttCurrentTarget = null;
    function showTooltip(target) {
        const term = target.dataset.tooltip;
        const def = GLOSSARY[term];
        if (!def) return;
        const tt = document.getElementById('dt-tooltip');
        if (!tt) return;
        // Toggle off if tapping the same ? again
        if (_ttCurrentTarget === target && tt.classList.contains('show')) {
            hideTooltip();
            return;
        }
        _ttCurrentTarget = target;
        tt.innerHTML = `<div class="dt-tt-title">${term}</div>${def}`;
        tt.style.visibility = 'hidden';
        tt.style.top = '0px';
        tt.style.left = '0px';
        tt.classList.add('show');
        // Force layout then measure
        const ttRect = tt.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - ttRect.width / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
        let top = rect.top - ttRect.height - 8;
        if (top < 8) top = rect.bottom + 8;
        tt.style.top = top + 'px';
        tt.style.left = left + 'px';
        tt.style.visibility = '';
    }
    function hideTooltip() {
        const tt = document.getElementById('dt-tooltip');
        if (tt) tt.classList.remove('show');
        _ttCurrentTarget = null;
    }

    /* =========================================================
       COPY TO CLIPBOARD
       ========================================================= */
    async function copyById(id) {
        const val = $(id).value;
        if (!val || val === 'Invalid') { toast('Nothing to copy.'); return; }
        try {
            await navigator.clipboard.writeText(val);
            toast('Copied: ' + val);
        } catch {
            const el = $(id);
            el.removeAttribute('readonly');
            el.select();
            try { document.execCommand('copy'); toast('Copied: ' + val); }
            catch { toast('Copy failed.'); }
            el.setAttribute('readonly', '');
            window.getSelection().removeAllRanges();
        }
    }

    /* =========================================================
       THEME & FONT APPLICATION
       ========================================================= */
    function applyTheme() {
        const t = $('theme_select').value;
        const val = t === 'original' ? '' : t;
        document.getElementById(PANEL_ID).setAttribute('data-theme', val);
        document.getElementById(BUTTON_ID).setAttribute('data-theme', val);
        document.getElementById('dt-tooltip').setAttribute('data-theme', val);
        applyCounterTheme();
    }
    function applyFontScale() {
        document.getElementById(PANEL_ID).setAttribute('data-large-fonts', $('large_fonts').checked ? 'true' : 'false');
    }

    /* =========================================================
       STATE RESTORATION TO UI
       ========================================================= */
    function applyStateToUI() {
        const ids = ['balance', 'win_inc', 'loss_reset', 'bet_div', 'profit_mult', 'buffer', 'n_trials',
                     'opt_balance', 'opt_trials', 'opt_betdiv', 'opt_profit', 'opt_w', 'opt_l', 'opt_buf'];
        for (const k of ids) if ($(k) && state[k] != null) $(k).value = state[k];
        $('theme_select').value = state.theme || 'original';
        $('large_fonts').checked = !!state.large_fonts;
        $('keep_prev').checked = !!state.keep_prev;
        $('worker_count').value = state.worker_count || Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));
        $('show_counter').checked = state.show_counter !== false;
        $('counter_autostop').checked = state.counter_autostop !== false;
        applyTheme();
        applyFontScale();
        setCounterVisible(state.show_counter !== false);
        // Restore counter position if previously dragged
        const host = document.getElementById(COUNTER_ID);
        if (host && state.counter_x != null && state.counter_y != null) {
            host.style.left = state.counter_x + 'px';
            host.style.top = state.counter_y + 'px';
            host.style.right = 'auto';
        }
        if (Array.isArray(state.results) && state.results.length) {
            optResults = state.results.slice();
            renderResults();
        }
    }

    /* =========================================================
       DRAGGABLE FLOATING BUTTON
       ========================================================= */
    function setupButtonDrag(btn) {
        let dragging = false;
        let moved = false;
        let startX = 0, startY = 0, offsetX = 0, offsetY = 0;

        const begin = (x, y) => {
            moved = false;
            dragging = true;
            const rect = btn.getBoundingClientRect();
            offsetX = x - rect.left;
            offsetY = y - rect.top;
            startX = x; startY = y;
        };
        const move = (x, y) => {
            if (!dragging) return;
            if (Math.abs(x - startX) > 5 || Math.abs(y - startY) > 5) moved = true;
            const w = btn.offsetWidth, h = btn.offsetHeight;
            let nx = x - offsetX, ny = y - offsetY;
            nx = Math.max(4, Math.min(nx, window.innerWidth - w - 4));
            ny = Math.max(4, Math.min(ny, window.innerHeight - h - 4));
            btn.style.left = nx + 'px';
            btn.style.top = ny + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        };
        const end = (ev) => {
            if (!dragging) return;
            dragging = false;
            if (!moved) {
                ev.preventDefault();
                togglePanel();
            }
        };
        btn.addEventListener('mousedown', e => begin(e.clientX, e.clientY));
        btn.addEventListener('touchstart', e => {
            const t = e.touches[0]; if (t) { e.preventDefault(); begin(t.clientX, t.clientY); }
        }, { passive: false });
        document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
        document.addEventListener('touchmove', e => {
            const t = e.touches[0]; if (t) move(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
    }

    /* =========================================================
       INIT / EVENT WIRING
       ========================================================= */
    function init() {
        // Inject UI first
        injectUI();
        loadState();
        applyStateToUI();
        calcValues();

        // Calculator inputs — live recompute + save
        ['balance', 'win_inc', 'loss_reset', 'bet_div', 'profit_mult', 'buffer'].forEach(id => {
            $(id).addEventListener('input', () => { calcValues(); saveState(); });
        });
        ['n_trials', 'opt_balance', 'opt_trials', 'opt_betdiv', 'opt_profit', 'opt_w', 'opt_l', 'opt_buf']
            .forEach(id => $(id).addEventListener('input', saveState));

        // Copy buttons
        document.getElementById(PANEL_ID).querySelectorAll('[data-copy]').forEach(b => {
            b.addEventListener('click', () => copyById(b.dataset.copy));
        });

        // Tab delegation (click + touchend for iOS reliability)
        const tabsNav = document.getElementById(PANEL_ID).querySelector('.dt-tabs');
        const onTab = (ev) => {
            const btn = ev.target.closest('.dt-tab-btn');
            if (!btn) return;
            ev.preventDefault();
            switchTab(btn.dataset.tab);
        };
        tabsNav.addEventListener('click', onTab);
        tabsNav.addEventListener('touchend', onTab, { passive: false });

        // Tooltip helpers — direct listeners on each ? button for iOS reliability,
        // plus a panel-wide handler so tapping elsewhere in the panel closes the tooltip.
        const panelEl = document.getElementById(PANEL_ID);
        panelEl.querySelectorAll('.dt-help').forEach(btn => {
            const handle = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                showTooltip(btn);
            };
            btn.addEventListener('click', handle);
            btn.addEventListener('touchend', handle, { passive: false });
        });
        panelEl.addEventListener('click', (e) => {
            if (e.target.closest('.dt-help')) return;
            const tt = document.getElementById('dt-tooltip');
            if (tt && tt.classList.contains('show')) hideTooltip();
        });
        // Only hide on scroll of the panel body (not document, which can fire
        // from unrelated casino-page scrolls and kill the tooltip instantly).
        panelEl.querySelector('.dt-body').addEventListener('scroll', hideTooltip, { passive: true });

        // Simulator
        $('sim_run').addEventListener('click', startSimulation);
        $('sim_stop').addEventListener('click', stopSimulation);

        // Optimizer
        $('opt_run').addEventListener('click', startOptimizer);
        $('opt_stop').addEventListener('click', stopOptimizer);
        $('opt_clear').addEventListener('click', clearResults);

        // Results
        $('res_apply').addEventListener('click', applySelectedToCalculator);
        $('res_csv').addEventListener('click', exportResultsCSV);
        document.getElementById('dt-res_table').addEventListener('click', onResTableClick);

        // Settings
        $('theme_select').addEventListener('change', () => { applyTheme(); saveState(); });
        $('large_fonts').addEventListener('change', () => { applyFontScale(); saveState(); });
        $('keep_prev').addEventListener('change', saveState);
        $('worker_count').addEventListener('change', saveState);
        $('show_counter').addEventListener('change', () => {
            setCounterVisible($('show_counter').checked);
            saveState();
        });
        $('counter_autostop').addEventListener('change', saveState);
        $('reset_state').addEventListener('click', () => {
            if (!confirm('Reset all saved data?')) return;
            localStorage.removeItem(STORE_KEY);
            location.reload();
        });

        // Streak counter: wire controls, drag, and site observers
        wireCounterControls();
        setupCounterDrag(document.getElementById(COUNTER_ID));
        initStreakCounter();

        // Game buttons
        $('game_sync').addEventListener('click', gameSync);
        $('game_import').addEventListener('click', gameImport);

        // Panel close (X + backdrop)
        document.getElementById('dt-close-btn').addEventListener('click', closePanel);
        document.getElementById('dt-backdrop').addEventListener('click', closePanel);

        // Floating button toggle (drag-aware)
        setupButtonDrag(document.getElementById(BUTTON_ID));

        // Initial render
        renderResults();
    }

    // Run when DOM is ready (document-end generally means body is present, but be safe)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

})();
