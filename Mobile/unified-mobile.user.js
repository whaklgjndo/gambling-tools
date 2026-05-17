// ==UserScript==
// @name         Unified Mobile (Userscripts)
// @namespace    http://tampermonkey.net/
// @version      2.29-mobile.1
// @description  Mobile / iOS Userscripts.app counterpart of Unified Desktop. All Stake / Nuts.gg / Shuffle tools bundled with a tap-friendly control panel and mobile-responsive HUD overrides.
// @author       .
// @match        https://nuts.gg/*
// @match        https://*.nuts.gg/*
// @match        https://stake.com/*
// @match        https://stake.bet/*
// @match        https://stake.games/*
// @match        https://staketr.com/*
// @match        https://staketr2.com/*
// @match        https://staketr3.com/*
// @match        https://staketr4.com/*
// @match        https://stake.bz/*
// @match        https://stake.us/*
// @match        https://stake.pet/*
// @match        https://shuffle.com/*
// @match        https://shuffle.us/*
// @grant        none
// @inject-into  page
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       MOBILE / USERSCRIPTS-APP COMPAT SHIMS
       --------------------------------------------------------
       The iOS Userscripts app (and most non-Tampermonkey hosts)
       don't expose GM_addStyle / GM_xmlhttpRequest / unsafeWindow.
       We use @grant none + @inject-into page so the script runs
       in the page world and can touch React state directly. The
       few desktop call sites for GM_addStyle are rerouted to
       __addStyle, which is also aliased onto the page as
       GM_addStyle so any third-party caller keeps working.
       ========================================================= */
    function __addStyle(cssText) {
        const style = document.createElement('style');
        style.textContent = cssText;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }
    if (typeof window.GM_addStyle === 'undefined') {
        try { window.GM_addStyle = __addStyle; } catch (e) {}
    }
    // Coarse-pointer / narrow-viewport detection. Mobile has no spacebar,
    // so iow-smart's rapid-fire path falls back from KeyboardEvent('Space')
    // dispatch to direct button.click() polling when this returns true.
    function __isMobile() {
        try {
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
        } catch (e) {}
        return (window.innerWidth || 0) <= 980;
    }
    try { window.__unifiedMobile = true; } catch (e) {}


    /* =========================================================
       PRE-STITCH UI HIDER
       --------------------------------------------------------
       On URLs where we will stitch the Dice Tool into the IOW/Smart
       HUD (Stake/Shuffle dice pages), the dice tool's draggable
       floating chrome (#dt-aio-counter, #dt-aio-button, #dt-aio-panel,
       #dt-backdrop) would otherwise flash on screen for a moment
       before tryStitch runs and applies the bridge CSS. We inject
       a tiny stylesheet at document-start to hide them upfront.

       Removed by tryStitch once the bridge CSS is in place; also
       auto-removed after 10s as a safety net so the dice tool's UI
       still shows if stitching never completes.
       ========================================================= */
    (function injectPreStitchHider() {
        const url = location.href;
        const willStitch =
            /^https:\/\/stake\.(?:us|com)\/casino\/games\/dice(?!\w)/.test(url) ||
            /^https:\/\/shuffle\.(?:us|com)\/games\/originals\/dice(?!\w)/.test(url);
        if (!willStitch) return;
        const style = document.createElement('style');
        style.id = 'dt-pre-stitch-css';
        style.textContent =
            '#dt-aio-counter, #dt-aio-button, #dt-aio-panel, #dt-backdrop ' +
            '{ display: none !important; visibility: hidden !important; pointer-events: none !important; }';
        (document.head || document.documentElement).appendChild(style);
        setTimeout(() => {
            const el = document.getElementById('dt-pre-stitch-css');
            if (el) el.remove();
        }, 10000);
    })();

    /* =========================================================
       IOW/SMART → STATS BRIDGE
       --------------------------------------------------------
       Cross-tool integration layer between the IOW/Smart HUD and
       the Dice Tool's Stats tab (now mounted under "Advanced IOW"
       inside the IOW/Smart HUD).

       The IOW/Smart tool body publishes stats here on every bet;
       the Dice Tool's Stats tab subscribes via __iow_smart_on_publish__
       and renders the data without duplicating bookkeeping.

       Two scopes are tracked:
         - sessionStats: lifetime since page load (cleared by Reset)
         - runStats:     per-cycle since the last Start click

       Public API (set by IOW/Smart, read by Stats tab):
         window.__iow_smart_state__         { sessionStats, runBaseline, runStats }
         window.__iow_smart_snapshot_run__  baseline current state for a new cycle
         window.__iow_smart_handle_bet__    record a bet result for streak math
         window.__iow_smart_publish__       update sessionStats + runStats
         window.__iow_smart_on_publish__    subscriber callback (set by Stats tab)
       ========================================================= */

    window.__iow_smart_state__ = window.__iow_smart_state__ || {
        sessionStats: null,   // populated after every updateUI() in IOW/Smart
        runBaseline: null,    // snapshot taken at startRapidFire()
        runStats: null        // computed each updateUI() as session - baseline
    };

    // Per-cycle streak tracking. Reset by snapshot_run, updated by handle_bet.
    const __iowRunStreaks = {
        winStreaks: [], lossStreaks: [],
        curWin: 0, maxWin: 0, curLoss: 0, maxLoss: 0,
        peakBalance: 0, peakProfit: 0, lastResult: null
    };

    /** Baseline current state so subsequent publishes can compute per-run deltas. */
    window.__iow_smart_snapshot_run__ = function (currentBalance, totalBets, totalWagered, totalWins, totalLosses, profitHistoryLen, sessionInitialBalance, multGames, multWins) {
        window.__iow_smart_state__.runBaseline = {
            startingBalance: currentBalance,
            sessionInitialBalance: sessionInitialBalance,
            totalBets: totalBets,
            totalWagered: totalWagered,
            totalWins: totalWins,
            totalLosses: totalLosses,
            profitHistoryLen: profitHistoryLen,
            multGames: multGames || 0,
            multWins: multWins || 0,
            timestamp: Date.now()
        };
        __iowRunStreaks.winStreaks.length = 0;
        __iowRunStreaks.lossStreaks.length = 0;
        __iowRunStreaks.curWin = 0;
        __iowRunStreaks.maxWin = 0;
        __iowRunStreaks.curLoss = 0;
        __iowRunStreaks.maxLoss = 0;
        __iowRunStreaks.peakBalance = currentBalance;
        __iowRunStreaks.peakProfit = 0;
        __iowRunStreaks.lastResult = null;
    };

    /** Record a settled bet for per-run streak / peak / profit tracking. */
    window.__iow_smart_handle_bet__ = function (isWin, currentBalance) {
        if (!window.__iow_smart_state__.runBaseline) return;
        const s = __iowRunStreaks;
        if (isWin) {
            if (s.lastResult === false && s.curLoss > 0) {
                s.lossStreaks.push(s.curLoss);
                s.lossStreaks.sort((a, b) => b - a);
                if (s.lossStreaks.length > 10) s.lossStreaks.length = 10;
            }
            s.curWin++; s.curLoss = 0;
        } else {
            if (s.lastResult === true && s.curWin > 0) {
                s.winStreaks.push(s.curWin);
                s.winStreaks.sort((a, b) => b - a);
                if (s.winStreaks.length > 10) s.winStreaks.length = 10;
            }
            s.curLoss++; s.curWin = 0;
        }
        s.lastResult = isWin;
        s.maxWin = Math.max(s.maxWin, s.curWin);
        s.maxLoss = Math.max(s.maxLoss, s.curLoss);
        if (currentBalance > s.peakBalance) s.peakBalance = currentBalance;
        const baseline = window.__iow_smart_state__.runBaseline;
        const profit = currentBalance - baseline.startingBalance;
        if (profit > s.peakProfit) s.peakProfit = profit;
    };

    // Listener registered by the Stats tab. Called synchronously after every
    // publish so the UI refreshes per-bet instead of waiting for the 500ms
    // ticker — same cadence the SMART/IOW/Manual HUDs render at because they
    // call updateUI() directly inside processNewBet.
    window.__iow_smart_on_publish__ = null;

    /** Push the latest IOW/Smart state into __iow_smart_state__ and notify subscribers. */
    window.__iow_smart_publish__ = function (currentBalance, initialBalance, sessionPeak, highestProfit, totalWagered, totalWins, totalLosses, totalBets, curWinStreak, maxWinStreak, curLossStreak, maxLossStreak, topWinStreaks, topLossStreaks, profitHistory, isRapidFiring, multGames, multWins, trackedMultiplier) {
        const sessionProfit = currentBalance - initialBalance;
        window.__iow_smart_state__.sessionStats = {
            startingBalance: initialBalance,
            balance: currentBalance,
            profit: sessionProfit,
            sessionPeak: sessionPeak,
            peakProfit: highestProfit,
            totalWagered: totalWagered,
            totalWins: totalWins,
            totalLosses: totalLosses,
            totalBets: totalBets,
            rtp: totalWagered > 0 ? ((totalWagered + sessionProfit) / totalWagered) * 100 : 100,
            curWinStreak: curWinStreak,
            maxWinStreak: maxWinStreak,
            curLossStreak: curLossStreak,
            maxLossStreak: maxLossStreak,
            topWinStreaks: topWinStreaks ? topWinStreaks.slice() : [],
            topLossStreaks: topLossStreaks ? topLossStreaks.slice() : [],
            profitHistory: profitHistory ? profitHistory.slice() : [],
            isRapidFiring: isRapidFiring,
            multGames: multGames || 0,
            multWins: multWins || 0,
            trackedMultiplier: trackedMultiplier || 0
        };

        const b = window.__iow_smart_state__.runBaseline;
        if (b) {
            const s = __iowRunStreaks;
            const runProfit = currentBalance - b.startingBalance;
            const runWagered = totalWagered - b.totalWagered;
            // Per-run profit history is profit relative to per-run start.
            // profitHistory entries are balance - sessionInitialBalance, so we
            // shift by (b.startingBalance - sessionInitialBalance).
            const offset = b.startingBalance - b.sessionInitialBalance;
            const ph = profitHistory && profitHistory.length > b.profitHistoryLen
                ? profitHistory.slice(b.profitHistoryLen).map(p => p - offset)
                : [];
            window.__iow_smart_state__.runStats = {
                startingBalance: b.startingBalance,
                balance: currentBalance,
                profit: runProfit,
                sessionPeak: s.peakBalance,
                peakProfit: s.peakProfit,
                totalBets: totalBets - b.totalBets,
                totalWagered: runWagered,
                totalWins: totalWins - b.totalWins,
                totalLosses: totalLosses - b.totalLosses,
                rtp: runWagered > 0 ? ((runWagered + runProfit) / runWagered) * 100 : 100,
                curWinStreak: s.curWin,
                maxWinStreak: s.maxWin,
                curLossStreak: s.curLoss,
                maxLossStreak: s.maxLoss,
                topWinStreaks: s.winStreaks.slice(),
                topLossStreaks: s.lossStreaks.slice(),
                profitHistory: ph,
                multGames: (multGames || 0) - (b.multGames || 0),
                multWins: (multWins || 0) - (b.multWins || 0),
                trackedMultiplier: trackedMultiplier || 0
            };
        } else {
            window.__iow_smart_state__.runStats = null;
        }

        // Notify the Stats tab synchronously so it refreshes per-bet.
        if (typeof window.__iow_smart_on_publish__ === 'function') {
            try { window.__iow_smart_on_publish__(); } catch (e) {}
        }
    };

    /* =========================================================
       UNIFIED LOADER — STORAGE KEYS & SETTINGS
       --------------------------------------------------------
       Settings layout: { [toolId]: boolean } stored as JSON in
       localStorage under SETTINGS_KEY. Missing entries fall back
       to tool.defaultEnabled (defaults to true).
       ========================================================= */

    const SETTINGS_KEY    = '__stake_nuts_unified_tools_v1__';
    const PANEL_POS_KEY   = '__stake_nuts_unified_panel_pos_v1__';
    const PANEL_OPEN_KEY  = '__stake_nuts_unified_panel_open_v1__';
    const VISIBILITY_STYLE_ID = 'unified-tools-visibility-css';

    /** Read tool-enable settings from localStorage. */
    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch { return {}; }
    }
    /** Persist tool-enable settings to localStorage. */
    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
    }
    let settings = loadSettings();

    /** True when the user has the tool enabled (or defaultEnabled if never set). */
    function isEnabled(tool) {
        if (Object.prototype.hasOwnProperty.call(settings, tool.id)) return !!settings[tool.id];
        return tool.defaultEnabled !== false;
    }
    /** Look up a tool by id and check its enabled state. Used by tool
     *  bodies (Stake/Shuffle IOW/Smart, Nuts IOW/Smart) to gate runtime
     *  behavior per-URL without needing the tool object passed in. */
    function isToolIdEnabled(toolId) {
        const tool = TOOLS.find(t => t.id === toolId);
        if (!tool) return true;
        return isEnabled(tool);
    }
    /** Save the user's enable/disable choice. */
    function setEnabled(toolId, enabled) {
        settings[toolId] = !!enabled;
        saveSettings(settings);
    }

    /* =========================================================
       URL MATCHING
       Mirrors Tampermonkey's `*` wildcard (matches any chars).
       Each tool's regex list is compiled lazily and cached on
       tool._matcher.
       ========================================================= */

    function makePatternMatcher(patterns) {
        const regexes = patterns.map(p => {
            let re = '';
            for (const ch of p) {
                if (ch === '*') re += '.*';
                else if ('.+?^${}()|[]\\'.indexOf(ch) !== -1) re += '\\' + ch;
                else re += ch;
            }
            return new RegExp('^' + re + '$');
        });
        return url => regexes.some(r => r.test(url));
    }

    function urlMatches(tool, url) {
        if (!tool._matcher) tool._matcher = makePatternMatcher(tool.matches);
        return tool._matcher(url);
    }

    /** True when at least one of the tool's match patterns covers the current
     *  hostname (regardless of path). Used to scope URL-mismatch CSS so a
     *  tool for site A doesn't accidentally hide site B's UI that shares an
     *  element id (e.g. stake-mines and nuts-mines both use #mines-auto-gui). */
    function isToolOnThisSite(tool) {
        if (!tool._domainMatcher) {
            // Strip everything after the host: https://stake.us/casino/games/dice*
            // becomes https://stake.us/*. Handles subdomain wildcards like
            // https://*.nuts.gg/* by keeping them intact (the matcher knows *).
            const domainPatterns = tool.matches.map(p => {
                const m = String(p).match(/^(https?:\/\/[^/]+)\//);
                return m ? m[1] + '/*' : p;
            });
            tool._domainMatcher = makePatternMatcher(domainPatterns);
        }
        return tool._domainMatcher('https://' + location.hostname + '/');
    }

    /* =========================================================
       TOOL EXECUTION
       --------------------------------------------------------
       Once a tool's URL matches, its body runs exactly once and
       stays loaded for the lifetime of the page. The enable
       toggle does NOT re-gate execution — disabled tools just
       have their UI hidden via `applyToolVisibility` below. This
       means re-enabling is instant: no remount, no replay.

       Exception: tools with hijacksPage:true (IOW/Smart, Nuts
       IOW/Smart) re-parent the site's native bet panel into
       their own HUD. Hiding that container with display:none
       would also hide the relocated bet panel and brick the
       page. For those tools the disable gate is enforced at
       run time and toggles trigger a page reload — see
       buildPanel() in the Control Panel section.
       ========================================================= */

    /** Run a tool body, swallowing exceptions so one bad tool doesn't kill the rest. */
    function safeRun(tool) {
        try {
            tool._fn();
            tool._ran = true;
        } catch (e) {
            console.error('[UnifiedTools] error running ' + tool.id + ':', e);
        }
    }

    /** Execute a tool if it matches the current URL and is in the right boot phase. */
    function maybeRun(tool, phase) {
        if (tool._ran) return;
        if (tool.runAt !== phase) return;
        if (!urlMatches(tool, location.href)) return;
        if (tool.hijacksPage && !isEnabled(tool)) return;
        safeRun(tool);
    }

    /* =========================================================
       PER-TOOL UI VISIBILITY
       --------------------------------------------------------
       Disabled tools aren't unloaded — we just inject a CSS
       rule that hides every selector listed in tool.uiSelectors
       when <html> carries the tool's "disabled" class. Toggling
       back on removes the class instantly.

       Skipped for hijacksPage tools (see TOOL EXECUTION above).
       ========================================================= */

    /** Build the per-tool disabled-class name (sanitized for CSS). */
    function disabledClass(toolId) {
        return 'uts-disabled-' + toolId.replace(/[^a-z0-9_-]/gi, '-');
    }

    /** Build the per-tool URL-mismatch class name. Applied when the user has
     *  SPA-navigated away from a tool's matched game URL — hides the tool's UI
     *  so its overlay doesn't sit on top of an unrelated page. */
    function urlMismatchClass(toolId) {
        return 'uts-url-mismatch-' + toolId.replace(/[^a-z0-9_-]/gi, '-');
    }

    /** Inject the visibility stylesheet. Idempotent; safe to call repeatedly. */
    function injectVisibilityCss() {
        if (document.getElementById(VISIBILITY_STYLE_ID)) return;
        // Wait for <head> to exist — at document-start it might not yet.
        if (!document.head && !document.documentElement) return;
        const HIDE_PROPS = ' { display: none !important; visibility: hidden !important; pointer-events: none !important; }';
        const css = TOOLS
            .filter(t => Array.isArray(t.uiSelectors) && t.uiSelectors.length)
            .map(t => {
                const disSel = t.uiSelectors.map(s => 'html.' + disabledClass(t.id) + ' ' + s).join(',\n');
                const urlSel = t.uiSelectors.map(s => 'html.' + urlMismatchClass(t.id) + ' ' + s).join(',\n');
                return disSel + HIDE_PROPS + '\n' + urlSel + HIDE_PROPS;
            }).join('\n');
        const style = document.createElement('style');
        style.id = VISIBILITY_STYLE_ID;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    /** Toggle disabled + url-mismatch classes for a single tool based on
     *  current enable state and URL. Hides the tool's UI when:
     *   - the tool is disabled via the control panel, OR
     *   - the user is on the tool's site but SPA-navigated off the tool's
     *     matched game URL (e.g. moved from /mines to the lobby). */
    function applyToolVisibility(tool) {
        if (!tool || !tool.id) return;
        // hijacksPage tools manage their own visibility via the run gate +
        // page reload. Skipping here avoids the case where hiding the HUD
        // container would also hide the native bet panel relocated inside.
        if (tool.hijacksPage) return;
        const disCls = disabledClass(tool.id);
        const urlCls = urlMismatchClass(tool.id);
        const root = document.documentElement;
        if (!root) return;
        const onSameSite = isToolOnThisSite(tool);
        const onMatchingUrl = urlMatches(tool, location.href);
        // Disabled class: only on matching URL when tool is disabled. Several
        // tools share UI element IDs across sites (e.g. stake-keno and
        // nuts-keno both build #keno-preset-gui; stake-mines and nuts-mines
        // both build #mines-auto-gui) — applying the disable class
        // unconditionally would hide a different site's UI by mistake.
        if (onMatchingUrl && !isEnabled(tool)) {
            root.classList.add(disCls);
        } else {
            root.classList.remove(disCls);
        }
        // URL-mismatch class: applied only when we're on the tool's SITE but
        // off its matched game URL — so it hides the tool's UI after SPA nav
        // away from the game. CRITICAL: skip the class entirely when we're on
        // a different site, otherwise nuts-mines's url-mismatch rule would
        // hide #mines-auto-gui (used by both stake-mines and nuts-mines)
        // while the user is sitting on stake.com/mines.
        if (Array.isArray(tool.uiSelectors) && tool.uiSelectors.length) {
            if (onSameSite && !onMatchingUrl) {
                root.classList.add(urlCls);
            } else {
                root.classList.remove(urlCls);
            }
        }
    }

    /** Refresh visibility for every registered tool. */
    function applyAllVisibility() {
        injectVisibilityCss();
        for (const t of TOOLS) applyToolVisibility(t);
    }

    /* =========================================================
       PER-TOOL QUICK-TOGGLE BUTTONS
       --------------------------------------------------------
       A small floating chip pinned to the bottom-left (above the
       ⚙ control panel button) on every URL that a non-autovault
       tool matches. One click toggles that tool's enabled state.

       The button stays visible whether the tool is enabled or
       disabled — so after disabling, the user still has a way to
       re-enable without opening the control panel.

       Autovault tools are excluded by design: they have no
       game-specific URL ("home") so there's no natural place to
       anchor their quick toggle. Disable/enable them via the ⚙
       control panel instead.
       ========================================================= */

    const QUICK_TOGGLE_STYLE_ID = 'unified-tools-quick-toggle-css';
    const AUTOVAULT_TOOL_IDS = new Set(['stake-autovault', 'shuffle-autovault', 'nuts-autovault']);

    function injectQuickToggleCss() {
        if (document.getElementById(QUICK_TOGGLE_STYLE_ID)) return;
        if (!document.head && !document.documentElement) return;
        const style = document.createElement('style');
        style.id = QUICK_TOGGLE_STYLE_ID;
        style.textContent = `
            .uts-quick-toggle {
                position: fixed;
                left: 64px;
                z-index: 2147483645;
                padding: 7px 14px;
                border-radius: 18px;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                border: 1px solid;
                transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
                user-select: none;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                letter-spacing: 0.3px;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }
            .uts-quick-toggle.on {
                background: linear-gradient(135deg, #10b981, #059669);
                color: #ffffff;
                border-color: rgba(16, 185, 129, 0.7);
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            .uts-quick-toggle.off {
                background: linear-gradient(135deg, #1f2937, #0f172a);
                color: #94a3b8;
                border-color: rgba(148, 163, 184, 0.3);
            }
            .uts-quick-toggle:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
            }
            .uts-quick-toggle .uts-qt-dot {
                width: 8px; height: 8px; border-radius: 50%;
                flex: 0 0 auto;
            }
            .uts-quick-toggle.on .uts-qt-dot {
                background: #ffffff; box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
            }
            .uts-quick-toggle.off .uts-qt-dot {
                background: #475569;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /** Build a short, user-friendly label for the quick-toggle button —
     *  strips site prefix so the chip stays compact. With the {Site} {Game}
     *  naming convention, "Stake Dice" → "Dice", "Nuts Limbo/Target" →
     *  "Limbo/Target", "Shuffle Dice" → "Dice". */
    function quickToggleLabel(tool) {
        return (tool.name || tool.id)
            .replace(/^Stake\/Shuffle\s+/i, '')
            .replace(/^Stake\.gg\s+/i, '')
            .replace(/^Stake\s+/i, '')
            .replace(/^Shuffle\s+/i, '')
            .replace(/^Nuts\.gg\s+/i, '')
            .replace(/^Nuts\s+/i, '')
            .replace(/\s*\(.*\)$/i, '');
    }

    /** (Re)create the quick-toggle buttons for every non-autovault tool that
     *  matches the current URL. Removes stale buttons when the URL no longer
     *  matches. Idempotent — safe to call on every SPA navigation tick. */
    function applyQuickToggles() {
        injectQuickToggleCss();
        if (!document.body) return;
        const matching = TOOLS.filter(t =>
            !AUTOVAULT_TOOL_IDS.has(t.id) && urlMatches(t, location.href)
        );
        const seen = new Set();
        matching.forEach((tool, idx) => {
            const btnId = 'uts-quick-toggle-' + tool.id;
            seen.add(btnId);
            let btn = document.getElementById(btnId);
            if (!btn) {
                btn = document.createElement('button');
                btn.id = btnId;
                btn.className = 'uts-quick-toggle';
                btn.innerHTML = '<span class="uts-qt-dot"></span><span class="uts-qt-label"></span>';
                btn.addEventListener('click', () => quickToggleClick(tool));
                document.body.appendChild(btn);
            }
            // Stack above the ⚙ control panel button (bottom: 16px, ~38px tall).
            btn.style.bottom = (16 + 44 + idx * 36) + 'px';
            const enabled = isEnabled(tool);
            btn.classList.toggle('on', enabled);
            btn.classList.toggle('off', !enabled);
            const label = btn.querySelector('.uts-qt-label');
            if (label) label.textContent = quickToggleLabel(tool);
            btn.title = (enabled ? 'Click to disable: ' : 'Click to enable: ') + (tool.name || tool.id);
        });
        // Tear down buttons whose tool no longer matches the URL.
        document.querySelectorAll('.uts-quick-toggle').forEach(b => {
            if (!seen.has(b.id)) b.remove();
        });
    }

    /** Click handler for a quick-toggle button. Mirrors the control-panel
     *  switch handler: flips state, refreshes visibility, syncs the panel
     *  switch if open, and triggers a reload only for hijacksPage tools or
     *  when enabling a tool that hasn't initialized yet. */
    function quickToggleClick(tool) {
        const newState = !isEnabled(tool);
        setEnabled(tool.id, newState);
        applyToolVisibility(tool);
        applyQuickToggles();
        // Sync the matching control-panel switch if the panel is open.
        document.querySelectorAll('[data-switch="' + tool.id + '"]').forEach(el => {
            el.classList.toggle('on', newState);
        });
        // hijacksPage tools always reload — their HUD owns relocated native
        // page DOM that can't be hidden in place (matches control-panel behavior).
        if (tool.hijacksPage && urlMatches(tool, location.href)) {
            location.reload();
            return;
        }
        // Enabling a tool that didn't initialize on this page → reload so its
        // setup phases (document-start / document-end body) get a clean run.
        if (newState && urlMatches(tool, location.href) && !tool._ran) {
            location.reload();
        }
    }

    /* =========================================================
       TOOL REGISTRY
       The TOOLS array holds every tool's definition + body.
       Use register(definition, fn) to add a tool — see the
       "Tool Registry — Definitions" section near the bottom.
       ========================================================= */
    const TOOLS = [];

    /**
     * Add a tool to the registry.
     * @param {Object} definition - id, name, description, matches, runAt, defaultEnabled, group, uiSelectors, hijacksPage
     * @param {Function} fn - the tool's body function (one of the tool_xxx functions below)
     */
    function register(definition, fn) {
        definition._fn = fn;
        TOOLS.push(definition);
    }


    /* === source: stake-autovault-desktop.user.js === */
    function tool_stake_autovault() {
        'use strict';
// --- Config ---
    const INIT_DELAY = 2000;
    const DEFAULT_CURRENCY = 'bnb';
    const DEFAULT_US_CURRENCY = 'sc';
    const MIN_BALANCE_CHECKS = 2;
    const DEPOSIT_VAULT_PERCENTAGE = 0.2;
    const CURRENCY_CACHE_TIMEOUT = 5000;
    const BALANCE_INIT_RETRIES = 5;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

    // Load config from localStorage or use defaults
    function loadConfig() {
        const saved = localStorage.getItem('autovault-config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                log('Failed to load saved config:', e);
            }
        }
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000
        };
    }

    function saveConfig(config) {
        localStorage.setItem('autovault-config', JSON.stringify(config));
    }

    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;

    // --- Site detection ---
    const hostname = window.location.hostname;
    const isStakeUS = hostname.endsWith('.us');
    let isScriptInitialized = false;

    // --- Activity Log ---
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null; // callback for UI updates

    function logActivity(message, type = 'info') {
        const entry = {
            time: new Date(),
            message,
            type // 'info', 'success', 'warning', 'profit', 'bigwin'
        };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[AutoVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');

    // --- Flavor Text ---
    const FLAVOR = {
        profit: [
            "Positive difference,",
            "Profit detected"
        ],
        bigWin: [
            "Big win detected",
            "Large profit"
        ],
        deposit: [
            "Deposit detected",
        
        ],
        start: [
            "AutoVault started",
            "Monitoring active"
        ],
        stop: [
            "AutoVault stopped",
            "Monitoring paused"
        ],
        rateLimit: [
            "Rate limited, vaulting paused. Please wait until it resets",
            "Limit reached, vaulting paused. Please wait until it resets"
        ]
    };
    const pickFlavor = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // --- Cookie helper ---
    const getCookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
        return m ? m.pop().replace(/"/g, '') : '';
    };

    // --- Balance selectors (updated for current Stake DOM structure) ---
    // Primary: coin-toggle button contains balance in .content span
    // Fallbacks included for potential variations
    const BALANCE_SELECTORS = [
        '[data-testid="coin-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="balance-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="coin-toggle"] .content span',
        '[data-testid="balance-toggle"] span.content span',
        // Legacy selectors as final fallback
        '[data-testid="user-balance"] .numeric',
        '.numeric.variant-highlighted',
        '[data-testid="user-balance"]',
        '.balance-value'
    ];

    // --- Stake API ---
    class StakeApi {
        constructor() {
            this.apiUrl = window.location.origin + '/_api/graphql';
            this._accessToken = getCookie("session");
            this.headers = {
                'content-type': 'application/json',
                'x-access-token': this._accessToken,
                'x-language': 'en'
            };
        }
        async call(body, opName) {
            const headers = {...this.headers};
            if (opName) headers['x-operation-name'] = opName;
            try {
                const res = await fetch(this.apiUrl, {
                    credentials: 'include',
                    headers,
                    referrer: window.location.origin,
                    body: body,
                    method: 'POST',
                    mode: 'cors',
                    cache: 'no-cache'
                });
                if (!res.ok) {
                    log(`API call failed with status ${res.status}: ${res.statusText}`);
                    return { error: true, status: res.status, message: res.statusText };
                }
                return res.json();
            } catch (e) {
                log('API call failed:', e);
                return { error: true, message: e.message, type: 'network' };
            }
        }
        async getBalances() {
            const q = {
                query: `query UserBalances {
                    user { id balances {
                        available { amount currency }
                        vault { amount currency }
                    }}}`,
                variables: {}
            };
            return this.call(JSON.stringify(q), 'UserBalances');
        }
        async depositToVault(currency, amount) {
            const q = {
                query: `mutation CreateVaultDeposit($currency: CurrencyEnum!, $amount: Float!) {
                    createVaultDeposit(currency: $currency, amount: $amount) {
                        id amount currency user {
                            id balances {
                                available { amount currency }
                                vault { amount currency }
                            }
                        }
                        __typename
                    }
                }`,
                variables: { currency, amount }
            };
            return this.call(JSON.stringify(q), 'CreateVaultDeposit');
        }
    }

    // --- Vault Display UI (floaty) ---
    class VaultDisplay {
        constructor() {
            this._el = document.createElement("span");
            this._el.id = "vaultDisplayElement";
            this._vaulted = 0;
            this._currency = getCurrency();
            this._el.title = "Vaulted this session";
            Object.assign(this._el.style, {
                marginLeft: "8px",
                color: "#00c4a7",
                fontSize: "1em",
                fontWeight: "bold",
                background: "#1a2c38",
                borderRadius: "6px",
                padding: "2px 8px",
                boxShadow: "0 2px 8px #0002"
            });
            // Instead of inserting into nav, floaty UI will show this in the widget
            this._load();
            this.render();
        }
        _storageKey() {
            const c = (this._currency || getCurrency() || '').toLowerCase();
            return `autovault-vaulted-session:${c}`;
        }
        _load() {
            try {
                const raw = sessionStorage.getItem(this._storageKey());
                const v = parseFloat(raw);
                if (!isNaN(v) && v >= 0) this._vaulted = v;
            } catch (e) {
                // ignore
            }
        }
        _save() {
            try {
                sessionStorage.setItem(this._storageKey(), String(this._vaulted));
            } catch (e) {
                // ignore
            }
        }
        setCurrency(currency) {
            this._currency = (currency || getCurrency() || '').toLowerCase();
            this._load();
            this.render();
        }
        render() {
            if (!this._el) return;
            this._el.innerText = (this._vaulted || 0).toFixed(8);
        }
        update(amount) {
            const add = +amount;
            if (isNaN(add) || add <= 0) return;
            this._vaulted = (this._vaulted || 0) + add;
            this._save();
            this.render();
        }
        reset() {
            this._vaulted = 0;
            this._save();
            this.render();
        }
    }

    // --- Simplified currency detection ---
    function parseStakeAmount(text) {
        if (!text) return NaN;
        const raw = String(text).replace(/\u00a0/g, ' ').trim();
        if (!raw) return NaN;
        if (/[•*]+/.test(raw)) return NaN;

        const m = raw.match(/[-+]?\d[\d\s,.'’]*(?:[.,]\d+)?[kmbt]?/i);
        if (!m) return NaN;

        let token = m[0].trim();
        const suffixMatch = token.match(/[kmbt]$/i);
        const suffix = suffixMatch ? suffixMatch[0].toLowerCase() : '';
        token = token.replace(/[kmbt]$/i, '').trim();

        token = token.replace(/[\s'’]/g, '');

        const hasDot = token.includes('.');
        const hasComma = token.includes(',');
        if (hasDot && hasComma) {
            if (token.lastIndexOf('.') > token.lastIndexOf(',')) {
                token = token.replace(/,/g, '');
            } else {
                token = token.replace(/\./g, '').replace(/,/g, '.');
            }
        } else if (hasComma && !hasDot) {
            const parts = token.split(',');
            if (parts.length === 2 && parts[1].length <= 2) token = `${parts[0]}.${parts[1]}`;
            else token = token.replace(/,/g, '');
        } else {
            token = token.replace(/,/g, '');
        }

        const n = parseFloat(token);
        if (isNaN(n)) return NaN;

        const mult =
            suffix === 'k' ? 1e3 :
            suffix === 'm' ? 1e6 :
            suffix === 'b' ? 1e9 :
            suffix === 't' ? 1e12 :
            1;

        return n * mult;
    }

    function detectCurrencyFromBalanceBar() {
        const el =
            document.querySelector('[data-testid="coin-toggle"]') ||
            document.querySelector('[data-testid="balance-toggle"]');
        if (!el) return null;
        const txt = (el.textContent || '').trim();
        const m = txt.match(/\b[A-Z]{2,5}\b/);
        return m ? m[0].toLowerCase() : null;
    }

    function getCurrency() {
        const now = Date.now();
        if (getCurrency.cached && getCurrency.cacheTime && (now - getCurrency.cacheTime < CURRENCY_CACHE_TIMEOUT)) {
            return getCurrency.cached;
        }
        const el = document.querySelector('[data-active-currency]');
        if (el) {
            const c = el.getAttribute('data-active-currency');
            if (c) {
                getCurrency.cached = c.toLowerCase();
                getCurrency.cacheTime = now;
                return getCurrency.cached;
            }
        }
        const fromBar = detectCurrencyFromBalanceBar();
        if (fromBar) {
            getCurrency.cached = fromBar;
            getCurrency.cacheTime = now;
            return getCurrency.cached;
        }
        const defaultCurr = isStakeUS ? DEFAULT_US_CURRENCY : DEFAULT_CURRENCY;
        getCurrency.cached = defaultCurr;
        getCurrency.cacheTime = now;
        return defaultCurr;
    }

    // --- Get balance from UI ---
    function getCurrentBalance() {
        const curCode = (activeCurrency || getCurrency() || '').toLowerCase();
        const uiCode = (detectCurrencyFromBalanceBar() || '').toLowerCase();
        if (curCode && uiCode && uiCode !== curCode) {
            const apiVal = getCurrentBalance._api?.[curCode];
            if (typeof apiVal === 'number' && apiVal >= 0) return apiVal;
        }
        // Try each selector in order until we find a valid balance
        for (const selector of BALANCE_SELECTORS) {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    const val = parseStakeAmount(el.textContent);
                    if (!isNaN(val) && val >= 0) {
                        // Cache the working selector for performance
                        if (!getCurrentBalance._workingSelector || getCurrentBalance._workingSelector !== selector) {
                            getCurrentBalance._workingSelector = selector;
                            log(`📍 Balance detected using selector: ${selector}`);
                        }
                        getCurrentBalance.lastKnownBalance = val;
                        return val;
                    }
                }
            } catch (e) {
                // Continue to next selector
            }
        }
        if (curCode) {
            const apiVal = getCurrentBalance._api?.[curCode];
            if (typeof apiVal === 'number' && apiVal >= 0) return apiVal;
        }
        // If no selector worked, log a warning (but only once per session)
        if (!getCurrentBalance._warned) {
            getCurrentBalance._warned = true;
            log('⚠️ Could not detect balance with any known selector. Please check if Stake updated their UI.');
        }
        return getCurrentBalance.lastKnownBalance || 0;
    }

    // --- Vault Rate Limit Tracking ---
    function loadRateLimitData() {
        const saved = sessionStorage.getItem('autovault-ratelimit');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            } catch (e) {
                log('Failed to load rate limit data:', e);
            }
        }
        return [];
    }

    function saveRateLimitData(timestamps) {
        sessionStorage.setItem('autovault-ratelimit', JSON.stringify(timestamps));
    }

    let vaultActionTimestamps = loadRateLimitData();

    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }

    function getVaultCountLastHour() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        return vaultActionTimestamps.length;
    }

    // --- Floaty UI Widget ---
    // View modes: 'full', 'mini', 'stealth'
    let currentViewMode = 'full';

    function createVaultFloatyUI(startCallback, stopCallback, getParams, setParams, vaultDisplay) {
        // Remove old if present
        if (document.getElementById('autovault-floaty')) {
            document.getElementById('autovault-floaty').remove();
        }
        if (document.getElementById('autovault-stealth')) {
            document.getElementById('autovault-stealth').remove();
        }

        // Style - Clean, minimal design
        const style = document.createElement('style');
        style.id = 'autovault-styles';
        style.textContent = `
        /* === FULL PANEL === */
        #autovault-floaty {
            background: #0f212e;
            color: #b1bad3;
            border: 1px solid #2f4553;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            min-width: 240px;
            max-width: 280px;
            user-select: none;
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            transition: opacity 0.2s, transform 0.2s;
        }
        #autovault-floaty.hidden { display: none; }
        #autovault-floaty .av-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #1a2c38;
            padding: 8px 10px;
            border-radius: 8px 8px 0 0;
            border-bottom: 1px solid #2f4553;
            cursor: grab;
        }
        #autovault-floaty .av-header:active { cursor: grabbing; }
        #autovault-floaty .av-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 12px;
            color: #fff;
            letter-spacing: 0.3px;
        }
        #autovault-floaty .av-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #4a5568;
        }
        #autovault-floaty .av-status-dot.running { background: #10b981; }
        #autovault-floaty .av-header-btns {
            display: flex;
            gap: 2px;
        }
        #autovault-floaty .av-header-btn {
            background: none;
            border: none;
            color: #64748b;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            font-size: 14px;
            line-height: 1;
            transition: color 0.15s, background 0.15s;
        }
        #autovault-floaty .av-header-btn:hover {
            color: #fff;
            background: #2f4553;
        }
        #autovault-floaty .av-content {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #autovault-floaty .av-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        #autovault-floaty .av-label {
            color: #94a3b8;
            font-size: 12px;
        }
        #autovault-floaty input[type="number"] {
            background: #1a2c38;
            color: #e2e8f0;
            border: 1px solid #2f4553;
            border-radius: 4px;
            padding: 4px 6px;
            font-size: 12px;
            width: 60px;
            text-align: right;
            transition: border-color 0.15s;
        }
        #autovault-floaty input[type="number"]:focus {
            outline: none;
            border-color: #3b82f6;
        }
        #autovault-floaty .av-btn-row {
            display: flex;
            gap: 6px;
            margin-top: 4px;
        }
        #autovault-floaty .av-btn {
            flex: 1;
            background: #1a2c38;
            color: #b1bad3;
            border: 1px solid #2f4553;
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        #autovault-floaty .av-btn:hover:not(:disabled) {
            background: #2f4553;
            color: #fff;
        }
        #autovault-floaty .av-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        #autovault-floaty .av-btn.primary {
            background: #10b981;
            border-color: #10b981;
            color: #fff;
        }
        #autovault-floaty .av-btn.primary:hover:not(:disabled) {
            background: #059669;
        }
        #autovault-floaty .av-btn.danger {
            background: #ef4444;
            border-color: #ef4444;
            color: #fff;
        }
        #autovault-floaty .av-btn.danger:hover:not(:disabled) {
            background: #dc2626;
        }
        #autovault-floaty .av-stats {
            display: flex;
            justify-content: space-between;
            padding-top: 8px;
            border-top: 1px solid #2f4553;
            font-size: 11px;
        }
        #autovault-floaty .av-stat {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        #autovault-floaty .av-stat-label {
            color: #64748b;
            font-size: 10px;
            text-transform: uppercase;
        }
        #autovault-floaty .av-stat-value {
            color: #10b981;
            font-weight: 600;
        }
        #autovault-floaty .av-footer {
            display: flex;
            justify-content: center;
            padding: 6px;
            border-top: 1px solid #2f4553;
        }
        #autovault-floaty .av-link {
            color: #64748b;
            font-size: 10px;
            text-decoration: none;
            transition: color 0.15s;
        }
        #autovault-floaty .av-link:hover { color: #94a3b8; }

        /* === LOG PANEL === */
        #autovault-floaty .av-log-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: #1a2c38;
            border-top: 1px solid #2f4553;
            cursor: pointer;
            transition: background 0.15s;
        }
        #autovault-floaty .av-log-toggle:hover { background: #243442; }
        #autovault-floaty .av-log-toggle-text {
            font-size: 10px;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        #autovault-floaty .av-log-toggle-icon {
            font-size: 10px;
            color: #64748b;
            transition: transform 0.2s;
        }
        #autovault-floaty .av-log-toggle.open .av-log-toggle-icon {
            transform: rotate(180deg);
        }
        #autovault-floaty .av-log {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.25s ease-out;
            background: #0a1a24;
        }
        #autovault-floaty .av-log.open {
            max-height: 120px;
        }
        #autovault-floaty .av-log-inner {
            padding: 8px;
            max-height: 120px;
            overflow-y: auto;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 10px;
            line-height: 1.4;
        }
        #autovault-floaty .av-log-inner::-webkit-scrollbar {
            width: 4px;
        }
        #autovault-floaty .av-log-inner::-webkit-scrollbar-track {
            background: #0a1a24;
        }
        #autovault-floaty .av-log-inner::-webkit-scrollbar-thumb {
            background: #2f4553;
            border-radius: 2px;
        }
        #autovault-floaty .av-log-entry {
            padding: 2px 0;
            color: #64748b;
            display: flex;
            gap: 6px;
        }
        #autovault-floaty .av-log-entry.success { color: #10b981; }
        #autovault-floaty .av-log-entry.profit { color: #10b981; }
        #autovault-floaty .av-log-entry.bigwin { color: #fbbf24; }
        #autovault-floaty .av-log-entry.warning { color: #f59e0b; }
        #autovault-floaty .av-log-entry.error { color: #ef4444; }
        #autovault-floaty .av-log-time {
            color: #475569;
            flex-shrink: 0;
        }
        #autovault-floaty .av-log-empty {
            color: #475569;
            font-style: italic;
            text-align: center;
            padding: 8px;
        }

        /* === MINI MODE === */
        #autovault-floaty.mini {
            min-width: auto;
            max-width: none;
            border-radius: 20px;
        }
        #autovault-floaty.mini .av-header {
            border-radius: 20px;
            padding: 6px 12px;
            border-bottom: none;
        }
        #autovault-floaty.mini .av-content,
        #autovault-floaty.mini .av-log-toggle,
        #autovault-floaty.mini .av-log,
        #autovault-floaty.mini .av-footer { display: none; }
        #autovault-floaty.mini .av-title span { display: none; }

        /* === STEALTH MODE === */
        #autovault-stealth {
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4a5568;
            cursor: pointer;
            z-index: 999999;
            transition: transform 0.15s, background 0.15s;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        #autovault-stealth:hover {
            transform: scale(1.5);
        }
        #autovault-stealth.running { background: #10b981; }
        #autovault-stealth.hidden { display: none; }

        @media (max-width: 500px) {
            #autovault-floaty {
                right: 10px !important;
                left: 10px !important;
                max-width: none;
                min-width: auto;
            }
        }
        `;
        document.head.appendChild(style);

        // Main widget container
        const widget = document.createElement('div');
        widget.id = 'autovault-floaty';

        // Stealth indicator (separate element)
        const stealthDot = document.createElement('div');
        stealthDot.id = 'autovault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'AutoVault (click to expand)';
        document.body.appendChild(stealthDot);

        // Header
        const header = document.createElement('div');
        header.className = 'av-header';
        header.innerHTML = `
            <div class="av-title">
                <div class="av-status-dot" id="avStatusDot"></div>
                <span>AutoVault</span>
            </div>
            <div class="av-header-btns">
                <button class="av-header-btn" id="avMinBtn" title="Minimize">−</button>
                <button class="av-header-btn" id="avStealthBtn" title="Stealth Mode">○</button>
                <button class="av-header-btn" id="avCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'av-content';
        content.innerHTML = `
            <div class="av-row">
                <span class="av-label">Save %</span>
                <input type="number" id="vaultSaveAmount" min="0" max="1" step="0.01" value="${getParams().saveAmount}">
            </div>
            <div class="av-row">
                <span class="av-label">Big Win Threshold</span>
                <input type="number" id="vaultBigWinThreshold" min="1" step="0.1" value="${getParams().bigWinThreshold}">
            </div>
            <div class="av-row">
                <span class="av-label">Big Win Multiplier</span>
                <input type="number" id="vaultBigWinMultiplier" min="1" step="0.1" value="${getParams().bigWinMultiplier}">
            </div>
            <div class="av-row">
                <span class="av-label">Check Interval (sec)</span>
                <input type="number" id="vaultCheckInterval" min="10" step="1" value="${getParams().checkInterval}">
            </div>
            <div class="av-btn-row">
                <button class="av-btn primary" id="vaultStartBtn">Start</button>
                <button class="av-btn danger" id="vaultStopBtn" disabled>Stop</button>
            </div>
            <div class="av-stats">
                <div class="av-stat">
                    <span class="av-stat-label">Vault Balance</span>
                    <span class="av-stat-value" id="avVaultBal">0.00</span>
                </div>
                <div class="av-stat">
                    <span class="av-stat-label">Actions/hr</span>
                    <span class="av-stat-value" id="avVaultCount">0/50</span>
                </div>
            </div>
        `;
        widget.appendChild(content);

        // Log toggle
        const logToggle = document.createElement('div');
        logToggle.className = 'av-log-toggle';
        logToggle.innerHTML = `
            <span class="av-log-toggle-text">Activity Log</span>
            <span class="av-log-toggle-icon">▼</span>
        `;
        widget.appendChild(logToggle);

        // Log panel
        const logPanel = document.createElement('div');
        logPanel.className = 'av-log';
        logPanel.innerHTML = `<div class="av-log-inner" id="avLogInner"><div class="av-log-empty">No activity yet...</div></div>`;
        widget.appendChild(logPanel);

        const logInner = logPanel.querySelector('#avLogInner');

        // Toggle log panel
        logToggle.onclick = () => {
            logToggle.classList.toggle('open');
            logPanel.classList.toggle('open');
        };

        // Format time for log
        const formatTime = (date) => {
            const h = date.getHours().toString().padStart(2, '0');
            const m = date.getMinutes().toString().padStart(2, '0');
            const s = date.getSeconds().toString().padStart(2, '0');
            return `${h}:${m}:${s}`;
        };

        // Add log entry to UI
        function addLogEntry(entry) {
            // Remove empty message if present
            const empty = logInner.querySelector('.av-log-empty');
            if (empty) empty.remove();

            const div = document.createElement('div');
            div.className = `av-log-entry ${entry.type}`;
            div.innerHTML = `<span class="av-log-time">${formatTime(entry.time)}</span><span>${entry.message}</span>`;
            logInner.insertBefore(div, logInner.firstChild);

            // Keep only last 20 entries in UI
            while (logInner.children.length > 20) {
                logInner.removeChild(logInner.lastChild);
            }
        }

        // Set up log callback
        onLogUpdate = addLogEntry;

        // Footer
        const footer = document.createElement('div');
        footer.className = 'av-footer';
        footer.innerHTML = `<a href="https://stakestats.net/" target="_blank" class="av-link">stakestats.net</a>`;
        widget.appendChild(footer);

        // Replace vault display element reference
        const vaultBalEl = content.querySelector('#avVaultBal');
        vaultDisplay._el = vaultBalEl;
        vaultDisplay.render();

        // View mode switching
        const statusDot = widget.querySelector('#avStatusDot');
        const minBtn = widget.querySelector('#avMinBtn');
        const stealthBtn = widget.querySelector('#avStealthBtn');
        const closeBtn = widget.querySelector('#avCloseBtn');

        function setViewMode(mode) {
            currentViewMode = mode;
            if (mode === 'full') {
                widget.classList.remove('mini', 'hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'mini') {
                widget.classList.add('mini');
                widget.classList.remove('hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'stealth') {
                widget.classList.add('hidden');
                stealthDot.classList.remove('hidden');
            }
        }

        minBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
            minBtn.textContent = currentViewMode === 'mini' ? '+' : '−';
            minBtn.title = currentViewMode === 'mini' ? 'Expand' : 'Minimize';
        };

        stealthBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode('stealth');
        };

        stealthDot.onclick = () => {
            setViewMode('full');
            minBtn.textContent = '−';
        };

        closeBtn.onclick = () => {
            widget.remove();
            stealthDot.remove();
        };

        // Drag logic (works on header)
        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
        header.addEventListener('mousedown', function(e) {
            if (e.target.closest('.av-header-btns')) return;
            isDragging = true;
            dragOffsetX = e.clientX - widget.getBoundingClientRect().left;
            dragOffsetY = e.clientY - widget.getBoundingClientRect().top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            let newLeft = e.clientX - dragOffsetX;
            let newTop = e.clientY - dragOffsetY;
            newLeft = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, newTop));
            widget.style.left = newLeft + 'px';
            widget.style.top = newTop + 'px';
            widget.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        // Status & vault count updates
        const startBtn = content.querySelector('#vaultStartBtn');
        const stopBtn = content.querySelector('#vaultStopBtn');
        const vaultCountEl = content.querySelector('#avVaultCount');

        function updateVaultCountUI() {
            const count = getVaultCountLastHour();
            vaultCountEl.textContent = `${count}/50`;
            vaultCountEl.style.color = count >= 50 ? '#ef4444' : count >= 40 ? '#f59e0b' : '#10b981';
        }
        window.__updateVaultCountUI = updateVaultCountUI;
        updateVaultCountUI();
        setInterval(updateVaultCountUI, 10000);

        function setRunningState(isRunning) {
            statusDot.classList.toggle('running', isRunning);
            stealthDot.classList.toggle('running', isRunning);
            startBtn.disabled = isRunning;
            stopBtn.disabled = !isRunning;
        }

        startBtn.onclick = () => {
            setRunningState(true);
            startCallback();
            updateVaultCountUI();
        };
        stopBtn.onclick = () => {
            setRunningState(false);
            stopCallback();
            updateVaultCountUI();
        };

        // Parameter change handlers
        content.querySelector('#vaultSaveAmount').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            setParams({saveAmount: v});
            this.value = v;
        };
        content.querySelector('#vaultBigWinThreshold').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinThreshold: v});
            this.value = v;
        };
        content.querySelector('#vaultBigWinMultiplier').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinMultiplier: v});
            this.value = v;
        };
        content.querySelector('#vaultCheckInterval').onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            setParams({checkInterval: v});
            this.value = v;
        };

        document.body.appendChild(widget);

        return {
            setStatus: (txt, color) => {},
            setRunning: setRunningState,
            updateVaultCount: updateVaultCountUI
        };
    }

    // --- Main logic ---
    let vaultInterval = null;
    let vaultDisplay = null;
    let stakeApi = null;
    let activeCurrency = null;
    let apiBalanceInterval = null;
    let oldBalance = 0;
    let isProcessing = false;
    let isInitialized = false;
    let balanceChecks = 0;
    let lastDepositDetected = 0;
    let lastDepositAmount = 0;
    let lastBalance = 0;
    let lastVaultedDeposit = 0;
    let running = false;
    let uiWidget = null;

    async function refreshApiBalance() {
        try {
            if (!stakeApi) stakeApi = new StakeApi();
            const cur = (activeCurrency || getCurrency() || '').toLowerCase();
            if (!cur) return;
            const resp = await stakeApi.getBalances();
            const balances = resp?.data?.user?.balances;
            if (!Array.isArray(balances)) return;
            const bal = balances.find(x => x?.available?.currency?.toLowerCase() === cur);
            const amt = bal?.available?.amount;
            const n = typeof amt === 'number' ? amt : parseFloat(amt);
            if (isNaN(n) || n < 0) return;
            if (!getCurrentBalance._api) getCurrentBalance._api = {};
            getCurrentBalance._api[cur] = n;
        } catch (e) {
            // ignore
        }
    }

    function startApiBalancePolling() {
        if (apiBalanceInterval) clearInterval(apiBalanceInterval);
        apiBalanceInterval = setInterval(refreshApiBalance, 5000);
        refreshApiBalance();
    }

    function stopApiBalancePolling() {
        if (apiBalanceInterval) clearInterval(apiBalanceInterval);
        apiBalanceInterval = null;
    }

    function getParams() {
        return {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: Math.round(CHECK_INTERVAL/1000)
        };
    }
    function setParams(obj) {
        if (obj.saveAmount !== undefined) SAVE_AMOUNT = obj.saveAmount;
        if (obj.bigWinThreshold !== undefined) BIG_WIN_THRESHOLD = obj.bigWinThreshold;
        if (obj.bigWinMultiplier !== undefined) BIG_WIN_MULTIPLIER = obj.bigWinMultiplier;
        if (obj.checkInterval !== undefined) CHECK_INTERVAL = obj.checkInterval * 1000;

        // Save config to localStorage
        config = {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: CHECK_INTERVAL
        };
        saveConfig(config);

        if (running) {
            stopVaultScript();
            startVaultScript();
        }
    }

    function checkCurrencyChange() {
        getCurrency.cached = null;
        getCurrency.cacheTime = null;
        const newCurrency = getCurrency();
        if (newCurrency !== activeCurrency) {
            log(`💱 Currency changed: ${activeCurrency} → ${newCurrency}`);
            activeCurrency = newCurrency;
            startApiBalancePolling();
            vaultDisplay.setCurrency(activeCurrency);
            vaultDisplay.reset();
            isInitialized = false;
            balanceChecks = 0;
            updateCurrentBalance();
            return true;
        }
        return false;
    }

    function updateCurrentBalance() {
        const cur = getCurrentBalance();
        if (cur > 0) {
            oldBalance = cur;
            if (!isInitialized && balanceChecks++ >= MIN_BALANCE_CHECKS) {
                isInitialized = true;
                log(`🐾 Initial balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
            }
        }
    }

    // --- Vault Rate Limit Enforcement in processDeposit ---
    async function processDeposit(amount, isBigWin) {
        if (amount < 1e-8 || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)} - Rate limit reached`, 'warning');
            if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
            return;
        }
        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        const flavor = pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit);
        logActivity(`${flavor} Vaulting ${pct}%: ${amount.toFixed(6)} ${activeCurrency.toUpperCase()}`, isBigWin ? 'bigwin' : 'profit');
        try {
            const resp = await stakeApi.depositToVault(activeCurrency, amount);
            isProcessing = false;
            if (resp && resp.data && resp.data.createVaultDeposit) {
                vaultDisplay.update(amount);
                vaultActionTimestamps.push(Date.now());
                saveRateLimitData(vaultActionTimestamps);
                // Re-read balance after successful deposit to avoid drift
                oldBalance = getCurrentBalance();
                if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
                logActivity(`Secured ${amount.toFixed(6)} ${activeCurrency.toUpperCase()}`, 'success');
            } else {
                logActivity('Vault failed - may be rate limited', 'error');
            }
        } catch (e) {
            isProcessing = false;
            logActivity('Vault error: ' + (e.message || 'unknown'), 'error');
        }
    }

    function initializeBalance() {
        updateCurrentBalance();
        let tries = 0;
        const intv = setInterval(() => {
            updateCurrentBalance();
            if (++tries >= BALANCE_INIT_RETRIES) {
                clearInterval(intv);
                if (oldBalance > 0) {
                    isInitialized = true;
                    log(`Initialized with starting balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                } else {
                    log(`Unable to detect starting balance! Using current balance.`);
                    const cur = getCurrentBalance();
                    if (cur > 0) {
                        oldBalance = cur;
                        isInitialized = true;
                        log(`Last attempt balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                    }
                }
            }
        }, 1000);
    }

    function detectDepositEvent() {
        let found = false;
        let depositAmount = 0;
        const possibleSelectors = [
            '[data-testid*="notification"]',
            '[class*="notification"]',
            '[class*="transaction"]',
            '[class*="history"]',
            '[class*="activity"]'
        ];
        for (const sel of possibleSelectors) {
            const nodes = document.querySelectorAll(sel);
            for (const node of nodes) {
                const txt = (node.textContent || '');
                const lower = txt.toLowerCase();
                if (lower.includes('deposit') && /\d/.test(lower)) {
                    const amt = parseStakeAmount(txt);
                    if (!isNaN(amt) && amt > 0) {
                        depositAmount = amt;
                        found = true;
                        break;
                    }
                }
            }
            if (found) break;
        }
        if (found) {
            lastDepositDetected = Date.now();
            lastDepositAmount = depositAmount;
            return depositAmount;
        }
        return 0;
    }

    function checkBalanceChanges() {
        if (checkCurrencyChange()) return;
        const cur = getCurrentBalance();
        if (!isInitialized) return updateCurrentBalance();

        let depositAmt = detectDepositEvent();
        if (depositAmt > 0) {
            if (cur - lastBalance >= depositAmt * 0.95 && lastVaultedDeposit !== depositAmt) {
                const toVault = depositAmt * SAVE_AMOUNT;
                logActivity(`${pickFlavor(FLAVOR.deposit)} +${depositAmt.toFixed(4)} ${activeCurrency.toUpperCase()}`, 'info');
                processDeposit(toVault, false);
                lastVaultedDeposit = depositAmt;
                oldBalance = cur;
            }
        } else if (cur > oldBalance) {
            const profit = cur - oldBalance;
            const isBig = cur > oldBalance * BIG_WIN_THRESHOLD;
            const depAmt = profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1);
            processDeposit(depAmt, isBig);
            oldBalance = cur;
        } else if (cur < oldBalance) {
            oldBalance = cur;
        }
        lastBalance = cur;
        if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
    }

    function startVaultScript() {
        if (running) return;
        isScriptInitialized = true;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        logActivity(`Watching ${getCurrency().toUpperCase()} on ${isStakeUS ? 'Stake.us' : 'Stake.com'}`, 'info');
        if (!vaultDisplay) vaultDisplay = new VaultDisplay();
        stakeApi = new StakeApi();
        activeCurrency = getCurrency();
        startApiBalancePolling();
        vaultDisplay.setCurrency(activeCurrency);
        vaultDisplay.reset();
        oldBalance = 0;
        isProcessing = false;
        isInitialized = false;
        balanceChecks = 0;
        lastDepositDetected = 0;
        lastDepositAmount = 0;
        lastBalance = getCurrentBalance();
        lastVaultedDeposit = 0;
        vaultActionTimestamps = [];
        initializeBalance();
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) {
            uiWidget.setStatus('Running', '#00c4a7');
            uiWidget.setRunning(true);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
    }
    function stopVaultScript() {
        if (!running) return;
        running = false;
        isScriptInitialized = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        stopApiBalancePolling();
        if (vaultDisplay) vaultDisplay.reset();
        if (uiWidget) {
            uiWidget.setStatus('Stopped', '#fff');
            uiWidget.setRunning(false);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
        logActivity(pickFlavor(FLAVOR.stop), 'info');
    }

    // --- UI Widget setup (floaty) ---
    setTimeout(() => {
        if (!uiWidget) {
            if (!vaultDisplay) vaultDisplay = new VaultDisplay();
            uiWidget = createVaultFloatyUI(
                startVaultScript,
                stopVaultScript,
                getParams,
                setParams,
                vaultDisplay
            );
            vaultDisplay.setCurrency(getCurrency());
        }
    }, INIT_DELAY);



    }

    /* === source: stake-iow-smart-desktop.user.js === */
    function tool_stake_iow_smart() {
        'use strict';

    // ==================== PLATFORM DETECTION ====================
    function isShuffle() { return /shuffle\./.test(location.hostname); }

    /**
     * Returns true only when the current URL is a dice/limbo (or stake primedice)
     * page the IOW/Smart HUD is designed for. Used by buildHUD to tear down the
     * HUD after SPA navigation moves us to a different game (Mines, Plinko, Keno,
     * Blackjack, etc.) — the script's @match patterns only gate the INITIAL load,
     * but Shuffle/Stake's React router can swap the page underneath without
     * reloading the script, so we re-check the URL on every periodic tick.
     */
    function isOnSupportedGamePage() {
        const path = location.pathname || '';
        if (isShuffle()) {
            return /\/games\/originals\/(dice|limbo)(?:\/|$|\?|#)/i.test(path);
        }
        // Stake (stake.com / stake.us)
        return /\/casino\/games\/(dice|limbo|primedice)(?:\/|$|\?|#)/i.test(path);
    }

    /** True on a Dice page only (not Limbo). Used to conditionally render
     *  the Switch Over/Under button — Limbo has no direction to swap. */
    function isOnDicePage() {
        const path = location.pathname || '';
        if (isShuffle()) {
            return /\/games\/originals\/dice(?:\/|$|\?|#)/i.test(path);
        }
        return /\/casino\/games\/(?:dice|primedice)(?:\/|$|\?|#)/i.test(path);
    }

    /** Native Roll Over/Under swap clickable — platform-aware (Stake vs Shuffle). */
    function getRollOverUnderSwap() {
        return document.querySelector('button[class*="RollOverInput_inputContainer"]')  // Shuffle
            || document.querySelector('input[data-testid="reverse-roll"]')               // Stake
            || document.querySelector('[data-testid="reverse-roll"]');
    }

    /**
     * Map the current URL to one of the four split tool ids and check whether
     * the user has that specific tool enabled. Returns true when no
     * dice/limbo URL pattern matches (the isOnSupportedGamePage check
     * handles that case separately).
     *
     * Used by buildHUD to tear the HUD down when the user has disabled the
     * specific game they're on (e.g. on Stake Limbo with stake-limbo disabled).
     */
    function isCurrentGameEnabled() {
        const path = location.pathname || '';
        let toolId = null;
        if (isShuffle()) {
            if (/\/games\/originals\/dice(?:\/|$|\?|#)/i.test(path)) toolId = 'shuffle-dice';
            else if (/\/games\/originals\/limbo(?:\/|$|\?|#)/i.test(path)) toolId = 'shuffle-limbo';
        } else {
            if (/\/casino\/games\/(?:dice|primedice)(?:\/|$|\?|#)/i.test(path)) toolId = 'stake-dice';
            else if (/\/casino\/games\/limbo(?:\/|$|\?|#)/i.test(path)) toolId = 'stake-limbo';
        }
        if (!toolId) return true; // unknown URL — buildHUD's isOnSupportedGamePage handles it
        try { return isToolIdEnabled(toolId); }
        catch (e) { return true; }
    }

    // ==================== SHUFFLE TRANSPORT INTERCEPTORS ====================
    // Hook fetch / XHR / WebSocket so we can pull bet results out of
    // Shuffle's GraphQL responses. The DOM observer is also wired below
    // (startShuffleObserver) as a backup — whichever fires first wins
    // (dedup guard via _shuffleLastBetMs).
    if (isShuffle()) {
        // ==================== AUDIO: mute the bet-button click sound ====================
        // Shuffle plays an immediate UI click sound via the Web Audio API when
        // the Play / Bet button is pressed. The win sound plays AFTER the
        // server bet result returns (100ms+). We mute Web Audio playback for
        // a 60ms window starting at the click, which always catches the click
        // (fires within ~20ms of the event) and never catches the win.
        //
        // Tampermonkey scripts run in an isolated world by default — patching
        // window.AudioContext from here would NOT affect the page's audio. So
        // we inject an inline <script> that runs in the main world.
        (function injectShuffleAudioMute() {
            try {
                const s = document.createElement('script');
                s.textContent = '(' + (function () {
                    let suppressUntil = 0;
                    // Bet-button click → arm the suppression window
                    document.addEventListener('click', function (e) {
                        if (!e.target) return;
                        const btn = e.target.closest && e.target.closest('button[data-testid="bet-button"]');
                        if (btn) suppressUntil = Date.now() + 60;
                    }, true);
                    function wrapBufferSource(node) {
                        const origStart = node.start;
                        if (!origStart || origStart.__shuffleMutePatched) return;
                        const wrapped = function () {
                            if (Date.now() < suppressUntil) return;  // skip play
                            return origStart.apply(this, arguments);
                        };
                        wrapped.__shuffleMutePatched = true;
                        try { node.start = wrapped; } catch (e) {}
                    }
                    function patchProto(Ctor) {
                        if (!Ctor || !Ctor.prototype) return;
                        const origCreate = Ctor.prototype.createBufferSource;
                        if (!origCreate || origCreate.__shuffleMutePatched) return;
                        const wrapped = function () {
                            const node = origCreate.apply(this, arguments);
                            wrapBufferSource(node);
                            return node;
                        };
                        wrapped.__shuffleMutePatched = true;
                        Ctor.prototype.createBufferSource = wrapped;
                    }
                    patchProto(window.AudioContext);
                    patchProto(window.webkitAudioContext);
                    // Some sites play one-shot SFX via plain Audio elements.
                    // Wrap HTMLMediaElement.play to honor the same window.
                    const origPlay = HTMLMediaElement.prototype.play;
                    if (origPlay && !origPlay.__shuffleMutePatched) {
                        const wrapped = function () {
                            if (Date.now() < suppressUntil) {
                                // Return a resolved promise so callers awaiting play() don't reject.
                                try { this.pause(); } catch (e) {}
                                return Promise.resolve();
                            }
                            return origPlay.apply(this, arguments);
                        };
                        wrapped.__shuffleMutePatched = true;
                        HTMLMediaElement.prototype.play = wrapped;
                    }
                }).toString() + ')();';
                (document.head || document.documentElement).appendChild(s);
                s.remove();
            } catch (e) { console.error('[Shuffle audio mute] inject failed:', e); }
        })();

        function _tryParseBet(text) {
            try {
                const data = JSON.parse(text);
                const direct = data && data.data && data.data.dicePlay;
                if (direct) { onShuffleBetResult(direct); return; }
                const ws = data && data.payload && data.payload.data && data.payload.data.dicePlay;
                if (ws) { onShuffleBetResult(ws); return; }
                if (Array.isArray(data)) {
                    data.forEach(function (item) {
                        const b = item && item.payload && item.payload.data && item.payload.data.dicePlay;
                        if (b) onShuffleBetResult(b);
                    });
                }
            } catch (e) {}
        }
        const _origFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await _origFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                if (url.includes('graphql') || url.includes('/main-api/')) {
                    response.clone().text().then(function (t) { _tryParseBet(t); }).catch(function () {});
                }
            } catch (e) {}
            return response;
        };
        const _origOpen = XMLHttpRequest.prototype.open;
        const _origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._shuffleURL = (typeof url === 'string') ? url : '';
            return _origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            if (this._shuffleURL && (this._shuffleURL.includes('graphql') || this._shuffleURL.includes('/main-api/'))) {
                this.addEventListener('load', function () { _tryParseBet(this.responseText); });
            }
            return _origSend.apply(this, arguments);
        };
        const _origWS = window.WebSocket;
        function ShuffleWS(url, protocols) {
            const ws = protocols ? new _origWS(url, protocols) : new _origWS(url);
            ws.addEventListener('message', function (ev) {
                if (typeof ev.data === 'string') _tryParseBet(ev.data);
            });
            return ws;
        }
        ShuffleWS.prototype = _origWS.prototype;
        ShuffleWS.CONNECTING = _origWS.CONNECTING;
        ShuffleWS.OPEN = _origWS.OPEN;
        ShuffleWS.CLOSING = _origWS.CLOSING;
        ShuffleWS.CLOSED = _origWS.CLOSED;
        window.WebSocket = ShuffleWS;
    }

let ACTIVE_MODE = 'smart';
    let baseBet = 0.01;
    let manualBet = 0.01;          // Manual mode's wager (mirrors baseBet's role for Manual)
    let winIncreasePercent = 125;
    let lossStreakReset = 3;
    let winsBeforeReset = 5;
    let autoStopBalance = null;
    let minBaseBet = 0.01;
    let maxBaseBet = 99999999999999;
    let lastBetId = null;
    let lossStreak = 0;
    let counter = 0;
    // Shuffle-specific state: dedup between WS interceptor and DOM observer
    let _shuffleLastBetMs = 0;
    let _shuffleFeedObsEl = null;
    let _shuffleObsBalance = 0;
    let _shuffleBalObsEl = null;

    let isRapidFiring = false;
    let sessionPeak = 0;
    let initialBalance = 0;
    let lastKnownBalance = 0;
    let totalWagered = 0;
    let highestProfit = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalBets = 0;
    let observer = null;
    let pastBetsContainer = null;
    let profitHistory = [0];
    const MAX_GRAPH_POINTS = 10000;
    const RAPID_BLOCKED_STOP_MS = 1200;
    const RAPID_STALL_STOP_MS = 3000;
    let aggressionLevel = 1.0;
    let historyWindow = 30;
    let safeDivisor = 300;
    let aggressiveDivisor = 150;
    let winsNeeded = 15;
    let lastAmount = null;
    let curLossStreak = 0;
    let maxLossStreak = 0;
    let curWinStreak = 0;
    let maxWinStreak = 0;
    let betHistory = [];
    let recentWins = [];
    let topWinStreaks = [];
    let topLossStreaks = [];
    let trackedMultiplier = 0;
    let multGames = 0;
    let multWins = 0;
    let lastResult = null;
    let stopLossPct = 0;
    let takeProfitPct = 0;
    let autoPaused = false;
    let winResetPulseTimer = null;
    let rapidBlockedSince = 0;
    let rapidFireStartedAt = 0;
    let lastObservedBetTime = 0;
    let spacePressInterval = null;
    // --- Lock Aggression State variables ---
    let lockAggressionState = false;
    let lockedGearLevel = 1;

    __addStyle(`
        #ratchet-master-container,
        #ratchet-master-container * { box-sizing: border-box !important; }
        #ratchet-master-container {
            --hud-bg: rgba(15, 33, 46, 0.97);
            --hud-panel: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96));
            --hud-border: rgba(82, 109, 130, 0.55);

            --hud-border-soft: rgba(255, 255, 255, 0.06);
            --hud-green: #00ff9d;
            --hud-green-dark: #00cc7a;
            --hud-red: #e11d48;
            position: absolute !important;
            inset: 0 !important;
            width: 100% !important;
            max-width: none !important;

            height: 100% !important;
            max-height: none !important;
            background: var(--hud-bg) !important;
            border: 1px solid var(--hud-border) !important;
            border-radius: 0 !important;
            padding: 8px !important;
            box-shadow: 0 18px
            50px rgba(0, 0, 0, 0.82) !important;
            z-index: auto !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            font-family: "Proxima Nova", "Segoe UI", sans-serif !important;
            pointer-events: auto !important;
            overflow: hidden !important;
            backdrop-filter: blur(10px);
            line-height: 1.15;
        }
        #ratchet-master-container::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 0;
            pointer-events: none;
            opacity: 0;
            border: 1px solid transparent;
            box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0);
        }
        #ratchet-master-container.iow-win-reset-pulse::after { animation: ratchet-iow-win-reset-pulse 720ms ease-out 1;
        }
        @keyframes ratchet-iow-win-reset-pulse {
            0% { opacity: 0;
            }
            20% { opacity: 1;
            border-color: rgba(74, 222, 128, 0.9); box-shadow: inset 0 0 0 1px rgba(74, 222, 128, 0.75), inset 0 0 18px rgba(74, 222, 128, 0.35);
            }
            55% { opacity: 1;
            border-color: rgba(74, 222, 128, 0.8); box-shadow: inset 0 0 0 2px rgba(74, 222, 128, 0.85), inset 0 0 24px rgba(74, 222, 128, 0.45);
            }
            100% { opacity: 0; border-color: transparent;
            box-shadow: inset 0 0 0 0 rgba(74, 222, 128, 0), inset 0 0 0 0 rgba(74, 222, 128, 0);
            }
        }
        #ratchet-master-container[data-mode="iow"] { min-height: 0 !important;
        }
        #ratchet-master-container .hud-frame { display: flex; flex: 1 1 0; min-height: 0;
        min-width: 0; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-workspace { display: flex;
        flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden;
        }
        #ratchet-master-container .hud-native-sidebar-slot { display: flex; flex: 0 0 300px; width: 300px;
        min-width: 300px; max-width: 300px; min-height: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-sidebar-slot:empty,
        #ratchet-master-container .hud-native-past-bets-slot:empty,
        #ratchet-master-container .hud-native-game-footer-slot:empty,
        #ratchet-master-container .hud-footer-slot:empty { display: none !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .game-sidebar { width: 100% !important; height: 100% !important;
        min-width: 0 !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; gap: 0 !important; padding: 0 !important;
        overflow: auto !important; }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-top,
        #ratchet-master-container .hud-native-sidebar-slot .sticky-bottom { position: relative !important;
        top: auto !important; bottom: auto !important; z-index: auto !important; flex: 0 0 auto !important; padding: 8px 8px 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-bottom { padding: 0 8px 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .sticky-top { margin-top: 40px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content { flex: 1 1 0 !important; min-height: 0 !important;
        max-height: none !important; overflow: auto !important; padding: 0 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .game-tabs { margin: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .tabs-wrapper,
        #ratchet-master-container .hud-native-sidebar-slot .slider,
        #ratchet-master-container .hud-native-sidebar-slot .content-wrapper { width: 100% !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot { display: flex; flex: 0 0 auto; min-height: 42px;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-past-bets-slot > .past-bets { width: 100% !important;
        min-width: 0 !important; display: flex !important; gap: 6px !important; padding: 6px !important; background: var(--hud-panel) !important; border: 1px solid var(--hud-border-soft) !important;
        border-radius: 12px !important; overflow-x: auto !important; overflow-y: hidden !important; }
        #ratchet-master-container .hud-native-past-bets-slot > .past-bets > button { flex: 0 0 auto !important;
        }
        /* Shuffle's recent-results feed lives inside .hud-native-past-bets-slot
           via syncNativeHudElements. Style it to look like Stake's past-bets row. */
        #ratchet-master-container .hud-native-past-bets-slot > [class*="OriginalGameRecentResult_originalGameResultsWrapper"] {
            width: 100% !important;
            min-width: 0 !important;
            display: flex !important;
            gap: 6px !important;
            padding: 6px !important;
            background: var(--hud-panel) !important;
            border: 1px solid var(--hud-border-soft) !important;
            border-radius: 12px !important;
            overflow-x: auto !important;
            overflow-y: hidden !important;
            align-items: center !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot > [class*="OriginalGameRecentResult_originalGameResultsWrapper"] > * {
            flex: 0 0 auto !important;
        }
        #ratchet-master-container #hud-content { display: flex; flex: 1 1 0; min-height: 0;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-shell { display: flex; flex-direction: column;
        flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden;
        }
        #ratchet-master-container .hud-panel { background: var(--hud-panel); border: 1px solid var(--hud-border-soft); border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03); }
        #ratchet-master-container .mode-wrap { display: flex;
        flex: 0 0 auto; flex-wrap: nowrap; gap: 5px; background: #13232d; padding: 5px; border-radius: 12px;
        }
        #ratchet-master-container .mode-btn { flex: 1 1 0; min-width: 0; padding: 8px 12px;
        border: none; border-radius: 999px; font-size: 12px; font-weight: 900; cursor: pointer;
        transition: transform 0.18s ease, filter 0.18s ease, background 0.18s ease, color 0.18s ease; text-transform: uppercase; letter-spacing: 0.4px;
        }
        #ratchet-master-container .mode-btn.active { background: #00ff9d; color: #0f212e; box-shadow: 0 0 12px #00ff9d;
        }
        #ratchet-master-container .mode-btn:not(.active) { background: #2f4553; color: #94a3b8;
        }
        #ratchet-master-container .mode-btn:hover { filter: brightness(1.08); transform: translateY(-1px);
        }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split, #ratchet-master-container .input-row, #ratchet-master-container .input-cluster, #ratchet-master-container .btn-group, #ratchet-master-container .hud-stat-rail, #ratchet-master-container .hud-stats-grid, #ratchet-master-container .hud-meta-row, #ratchet-master-container .hud-header { display: flex;
        min-width: 0; }
        #ratchet-master-container .hud-header, #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck { flex: 0 0 auto;
        }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { gap: 8px;
        align-items: stretch; }
        #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { flex: 1 1 0;
        min-height: 0; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
        #ratchet-master-container .hud-header, #ratchet-master-container .input-row, #ratchet-master-container .hud-meta-row { justify-content: space-between;
        align-items: center; gap: 8px; }
        #ratchet-master-container .hud-pane, #ratchet-master-container .graph-col, #ratchet-master-container .stats-col { flex: 1 1 0;
        min-height: 0; min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-pane { display: flex;
        flex-direction: column; gap: 8px; }
        #ratchet-master-container .hud-pane.primary { flex: 1.15 1 0;
        }
        #ratchet-master-container .hud-pane.secondary, #ratchet-master-container .stats-col { flex: 0.95 1 0; display: flex;
        flex-direction: column; gap: 8px; }
        #ratchet-master-container .control-section { flex: 1 1 0;
        min-width: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px;
        }
        #ratchet-master-container .input-row { align-items: flex-end; flex-wrap: nowrap;
        }
        #ratchet-master-container .input-cluster { flex: 1 1 0; flex-wrap: wrap; align-items: flex-end;
        gap: 8px; min-width: 0; }
        #ratchet-master-container .input-group { display: flex; align-items: center;
        gap: 5px; flex: 0 0 auto; }
        #ratchet-master-container .quick-btn { padding: 0;
        width: 26px; height: 26px; font-size: 10px; font-weight: 900; background: #1a2c38; border: 1px solid #2f4553; color: #fff; border-radius: 6px; cursor: pointer;
        flex: 0 0 auto; }
        #ratchet-master-container .quick-btn:hover { background: #2f4553;
        }
        #ratchet-master-container input[type="number"] { background: #0b0e17; border: 1px solid #2f4553; color: white;
        padding: 5px 6px; border-radius: 7px; width: 76px; font-size: 12px; font-weight: 700; text-align: center; outline: none;
        }
        #ratchet-master-container input[type="number"]:focus { border-color: var(--hud-green);
        box-shadow: 0 0 0 2px rgba(0, 255, 157, 0.12); }
        #ratchet-master-container .hud-risk-container { display: flex;
        flex: 1 1 100%; flex-wrap: nowrap; gap: 6px; min-width: 0;
        }
        #ratchet-master-container .hud-risk-container label { color: #94a3b8; font-size: 10px; font-weight: 800; display: flex;
        flex-direction: column; justify-content: space-between; gap: 4px; text-transform: uppercase; flex: 1 1 0; min-width: 0;
        }
        #ratchet-master-container .hud-risk-container input[type="number"] { width: 100%; min-width: 0;
        }
        #ratchet-master-container .btn-group { align-items: stretch; gap: 6px; flex-wrap: nowrap; justify-content: flex-end;
        flex: 0 0 auto; }
        #ratchet-master-container .hud-rapid-btn, #ratchet-master-container .hud-reset-btn { min-height: 38px;
        }
        #ratchet-master-container .hud-rapid-btn { border: none; color: #fff; font-size: 12px; font-weight: 900;
        padding: 8px 16px; border-radius: 9px; cursor: pointer; min-width: 108px; letter-spacing: 0.5px; text-transform: uppercase; flex: 1 1 0;
        }
        #ratchet-master-container .hud-rapid-btn.start { background: var(--hud-green); color: #0f212e;
        }
        #ratchet-master-container .hud-rapid-btn.start:hover { background: var(--hud-green-dark);
        }
        #ratchet-master-container .hud-rapid-btn.stop { background: var(--hud-red);
        }
        #ratchet-master-container .hud-rapid-btn.stop:hover { background: #be123c;
        }
        #ratchet-master-container .hud-reset-btn { background: transparent; border: 1px solid var(--hud-red); color: var(--hud-red);
        font-size: 11px; font-weight: 900; padding: 8px 14px; border-radius: 9px; cursor: pointer; flex: 1 1 0;
        }
        #ratchet-master-container .hud-reset-btn:hover { background: var(--hud-red); color: #fff;
        }
        /* Switch Over/Under — neutral cyan, distinct from green start and red reset. */
        #ratchet-master-container .hud-switch-ou-btn { background: transparent; border: 1px solid #06b6d4; color: #06b6d4;
        font-size: 11px; font-weight: 900; padding: 8px 14px; border-radius: 9px; cursor: pointer; flex: 1 1 0; min-height: 38px; letter-spacing: 0.4px; text-transform: uppercase; transition: background 0.18s, color 0.18s; line-height: 1.1;
        }
        #ratchet-master-container .hud-switch-ou-btn:hover { background: #06b6d4; color: #0f212e;
        }
        #ratchet-master-container .status-bar { background: var(--hud-panel); padding: 8px 10px; border-radius: 12px; text-align: center;
        font-size: 13px; font-weight: 900; letter-spacing: 0.2px; border: 1px solid var(--hud-border-soft); display: flex; align-items: center; justify-content: center; min-height: 42px;
        flex: 0 0 auto; }
        #ratchet-master-container .hud-graph-box { flex: 1 1 0;
        min-height: 0; height: 100%; background: linear-gradient(180deg, rgba(11, 14, 23, 0.96), rgba(15, 33, 46, 0.98)); border: 1px solid #2f4553; border-radius: 12px;
        overflow: hidden; position: relative; display: flex; }
        #ratchet-master-container .hud-graph-box canvas { width: 100%;
        height: 100%; display: block; flex: 1 1 auto; }
        #ratchet-master-container .hud-header { padding: 0 2px;
        }
        #ratchet-master-container .hud-header h2 { margin: 0; color: #fff; font-size: 14px; font-weight: 900;
        letter-spacing: 0.8px; text-transform: uppercase; }
        #ratchet-master-container .hud-target-text { color: #b1bad3; font-size: 12px;
        font-weight: 800; font-style: italic; letter-spacing: 0.2px; }
        /* Controls-deck layout: wrap onto multiple rows, align labels at the
           bottom, separate columns and rows independently so a wrapped row
           sits closer to the row above than control-groups within a row. */
        #ratchet-master-container .hud-controls-deck { padding: 10px;
        border-radius: 12px; border: 1px solid var(--hud-border-soft); background: var(--hud-panel);
        flex-wrap: wrap; column-gap: 12px; row-gap: 8px; align-items: flex-end;
        }
        /* Each control-group sizes to its content; ranges expand to fill */
        #ratchet-master-container .hud-control-group { display: flex; flex-direction: column; gap: 4px;
        flex: 0 1 auto; min-width: 0; max-width: 100%; }
        #ratchet-master-container .hud-control-group:has(input[type="range"]) { flex: 1 1 160px;
        min-width: 140px; }
        /* Labels stay on one line so they never wrap and overlap their input */
        #ratchet-master-container .hud-control-group label { color: #94a3b8;
        font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.02em;
        white-space: nowrap; overflow: visible; display: flex; justify-content: space-between; gap: 6px;
        }
        #ratchet-master-container .hud-control-group input[type="range"] { width: 100%; height: 6px; accent-color: #00ff9d; cursor: pointer;
        }
        #ratchet-master-container .hud-control-group input[type="number"] { width: 100%;
        }
        /* LOCK OPTION STYLES */
        #ratchet-master-container select { background: #0b0e17;
        border: 1px solid #2f4553; color: white; padding: 4px 6px; border-radius: 7px; font-size: 11px; font-weight: 700; width: 100%; outline: none;
        appearance: auto; }
        #ratchet-master-container select:disabled { opacity: 0.4; cursor: not-allowed;
        }
        #ratchet-master-container input[type="checkbox"] { accent-color: #00ff9d; cursor: pointer; margin: 0; width: 14px;
        height: 14px; }
        #ratchet-master-container .hud-stat-rail { flex: 1 1 0; min-height: 0;
        min-width: 0; flex-direction: column; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-stats-grid { flex: 1 1 0;
        min-height: 0; min-width: 0; gap: 8px; flex-wrap: wrap; align-content: stretch; overflow: hidden;
        }
        #ratchet-master-container .stats-col-inner, #ratchet-master-container .hud-stat-card { flex: 1 1 calc(50% - 4px);
        min-height: 0; min-width: 0; background: var(--hud-panel); padding: 10px; border-radius: 12px; border: 1px solid var(--hud-border-soft); display: flex; flex-direction: column; gap: 6px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03); overflow: hidden;
        }
        #ratchet-master-container .hud-row { display: flex; justify-content: space-between; align-items: center; gap: 8px;
        min-width: 0; padding: 6px 8px; background: rgba(255, 255, 255, 0.04); border-radius: 8px; flex: 1 1 0; min-height: 0;
        }
        #ratchet-master-container .hud-label { color: #b1bad3; font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.3px; }
        #ratchet-master-container .hud-val { color: #fff; font-size: 12px; font-weight: 800;
        font-family: "Roboto Mono", monospace; text-align: right; }
        #ratchet-master-container .hud-meta-row { gap: 8px;
        padding: 0 2px; flex: 0 0 auto; }
        #ratchet-master-container .hud-meta-chip { display: flex;
        align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 0; min-width: 0; padding: 8px 10px; background: var(--hud-panel);
        border: 1px solid var(--hud-border-soft); border-radius: 10px; overflow: hidden; }
        #ratchet-master-container .gear-text { font-style: italic;
        font-weight: 900; text-transform: uppercase; }
        #ratchet-master-container .gear-1-text { color: #94a3b8;
        }
        #ratchet-master-container .gear-2-text { color: #cbd5e1;
        }
        #ratchet-master-container .gear-3-text { color: #facc15;
        }
        #ratchet-master-container .gear-4-text { color: #fb923c;
        }
        #ratchet-master-container .gear-5-text { color: #f43f5e;
        text-shadow: 0 0 8px rgba(244, 63, 94, 0.4); }
        #ratchet-master-container .hud-footer-slot { display: flex;
        flex: 0 0 auto; min-width: 0; min-height: 88px; max-height: 88px; overflow: hidden;
        }
        #ratchet-master-container .hud-footer-slot > .footer, #ratchet-master-container .hud-footer-slot > .footer.svelte-fjwd2n { width: 100%;
        height: 100%; margin: auto !important; position: relative !important; left: auto !important; right: auto !important; bottom: auto !important; border-radius: 10px;
        overflow: hidden; }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"] { border-radius: 10px !important;
        }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) { min-width: 0 !important;
        }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) [class*="label-content"] { color: #b1bad3 !important; font-size: 12px !important;
        font-weight: 700 !important; letter-spacing: 0 !important; text-transform: none !important; }
        #ratchet-master-container .hud-footer-slot label:has([data-testid="reverse-roll"]) [class*="label-left-wrapper"] { justify-content: flex-start !important;
        width: auto !important; }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"]:has([data-testid="reverse-roll"]) { border: 1px solid #2f4553 !important;
        border-radius: 10px !important; background: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96)) !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important; overflow: hidden !important; padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot [class*="input-content"]:has([data-testid="reverse-roll"]) { display: flex !important; align-items: center !important;
        gap: 8px !important; width: 100% !important; }
        #ratchet-master-container .hud-footer-slot [class*="input-content"]:has(input[data-testid="reverse-roll"]) [class*="after-icon"] { width: auto !important;
        min-width: 20px !important; height: 100% !important; display: flex !important; align-items: center !important; justify-content: center !important; color: #9fb3c8 !important;
        flex: 0 0 auto !important; margin-left: auto !important; }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"] { appearance: none !important;
        -webkit-appearance: none !important; display: block !important; flex: 0 0 96px !important; width: 96px !important; min-width: 96px !important; max-width: 96px !important;
        height: 28px !important; padding: 0 10px !important; border: none !important; border-radius: 7px !important; background: #0b0e17 !important; color: #e2e8f0 !important;
        font-size: 12px !important; font-weight: 800 !important; font-family: "Roboto Mono", monospace !important; text-align: left !important; box-shadow: none !important; white-space: nowrap !important;
        transition: transform 0.18s ease, filter 0.18s ease !important; cursor: pointer !important; outline: none !important;
        }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"]:hover { filter: brightness(1.08);
        }
        #ratchet-master-container .hud-footer-slot [class*="input-wrap"]:has([data-testid="reverse-roll"]):hover { border-color: rgba(0, 255, 157, 0.55) !important;
        }
        #ratchet-master-container .hud-footer-slot input[data-testid="reverse-roll"]:active { transform: translateY(1px);
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] { min-width: 0 !important;
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="label-content"] { color: #b1bad3 !important; font-size: 12px !important;
        font-weight: 700 !important; letter-spacing: 0 !important; text-transform: none !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="label-left-wrapper"] { justify-content: flex-start !important;
        width: auto !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-wrap"] { border: 1px solid #2f4553 !important;
        border-radius: 10px !important; background: linear-gradient(180deg, rgba(26, 44, 56, 0.98), rgba(15, 33, 46, 0.96)) !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important; overflow: hidden !important; padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-content"] { display: flex !important; align-items: center !important;
        gap: 8px !important; width: 100% !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] [class*="input-content"] [class*="after-icon"] { width: auto !important;
        min-width: 20px !important; height: 100% !important; display: flex !important; align-items: center !important; justify-content: center !important; color: #9fb3c8 !important;
        flex: 0 0 auto !important; margin-left: auto !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] input { appearance: none !important;
        -webkit-appearance: none !important; display: block !important; flex: 0 0 96px !important; width: 96px !important; min-width: 96px !important; max-width: 96px !important;
        height: 28px !important; padding: 0 10px !important; border: none !important; border-radius: 7px !important; background: #0b0e17 !important; color: #e2e8f0 !important;
        font-size: 12px !important; font-weight: 800 !important; font-family: "Roboto Mono", monospace !important; text-align: left !important; box-shadow: none !important; white-space: nowrap !important;
        outline: none !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field] input[data-testid="reverse-roll"] { cursor: pointer !important;
        transition: transform 0.18s ease, filter 0.18s ease !important; }
        #ratchet-master-container .hud-footer-slot label[data-ratchet-footer-field]:hover [class*="input-wrap"] { border-color: rgba(0, 255, 157, 0.55) !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot { display: flex; flex: 0 0 auto; min-height: 56px;
        min-width: 0; overflow: hidden; }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer { width: 100% !important;
        height: auto !important; min-height: 56px !important; background: var(--hud-panel) !important; border: 1px solid var(--hud-border-soft) !important; border-radius: 12px !important; overflow: hidden !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer > .stack { width: 100% !important;
        min-height: 56px !important; padding-right: 10px !important; }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer > .flex.items-center.absolute { display: none !important;
        }
        #ratchet-master-container .hud-native-game-footer-slot > .game-footer .right { margin-left: auto !important;
        }
        @media (max-width: 980px) {
            #ratchet-master-container { padding: 6px !important;
            }
            #ratchet-master-container .hud-frame { flex-direction: column !important;
            }
            #ratchet-master-container .hud-native-sidebar-slot { width: 100% !important;
            min-width: 0 !important; max-width: none !important; flex: 0 0 auto !important; max-height: 330px !important;
            }
        }
        .result.svelte-1oweb16, .multiplier-result, .result-multiplier, .crash-result, .limbo-result, [class*="crash"], [class*="result"][class*="multiplier"], span.result { display: none !important;
        }

        /* UNIFIED STYLING FOR THE SCROLLABLE BETTING AREA */
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content {
            background: var(--hud-panel) !important;
            border: 1px solid var(--hud-border-soft) !important;
            border-radius: 12px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03) !important;
            margin: 4px 8px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .input-wrap,
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .state-layer-surface {
            background: #0b0e17 !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content input {
            background: #0b0e17 !important;
            color: #fff !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content button {
            background: #1a2c38 !important;
            color: #b1bad3 !important;
            border: 1px solid #2f4553 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content button:hover {
            background: #2f4553 !important;
            color: #fff !important;
            filter: brightness(1.1);
        }
        #ratchet-master-container .hud-native-sidebar-slot .scrollable-content .ds-body-md-strong {
            color: #b1bad3 !important;
        }

        /* ==================== SHUFFLE THEME ==================== */
        /* Purple palette + full-overlay positioning that covers Shuffle's
           native dice/limbo content area. Activated by .shuffle-theme on
           the HUD root (toggled in buildHUD when on shuffle.us/com). */
        #ratchet-master-container.shuffle-theme {
            --hud-green: #6c47ff;
            --hud-green-dark: #4f35b3;
            --hud-bg: rgba(10, 8, 24, 0.97);
            --hud-panel: linear-gradient(180deg, rgba(26, 18, 56, 0.98), rgba(10, 8, 24, 0.96));
            --hud-border: rgba(108, 71, 255, 0.5);
            --hud-border-soft: rgba(108, 71, 255, 0.18);
            top: 0 !important;
            bottom: auto !important;
            left: 0 !important;
            right: 0 !important;
            inset: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            min-height: 420px !important;
            max-height: none !important;
        }
        /* Shuffle: ensure flex sections have room so graph doesn't collapse */
        #ratchet-master-container.shuffle-theme #hud-content { flex: 1 1 0; min-height: 250px !important; }
        #ratchet-master-container.shuffle-theme .hud-shell { flex: 1 1 0; min-height: 240px !important; }
        #ratchet-master-container.shuffle-theme .hud-body,
        #ratchet-master-container.shuffle-theme .hud-split { min-height: 200px !important; }
        #ratchet-master-container.shuffle-theme .hud-pane { min-height: 180px !important; }
        #ratchet-master-container.shuffle-theme .hud-footer-slot { min-height: 0; max-height: none; flex: 0 0 auto; }
        /* Shuffle: collapse the row-direction .hud-frame + .hud-workspace
           wrappers into a single column flow so mode-wrap can't get
           clipped by inherited overflow:hidden on those wrappers. */
        #ratchet-master-container.shuffle-theme .hud-frame {
            flex-direction: column !important;
            overflow: visible !important;
            gap: 6px !important;
        }
        #ratchet-master-container.shuffle-theme .hud-workspace {
            overflow: visible !important;
            min-height: 0 !important;
        }
        /* Always show the sidebar slot as collapsed on Shuffle (no game-sidebar) */
        #ratchet-master-container.shuffle-theme .hud-native-sidebar-slot { display: none !important; }
        /* Hard-force mode-wrap visible & sized so it can never be clipped */
        #ratchet-master-container.shuffle-theme .mode-wrap {
            background: #140d2e;
            display: flex !important;
            flex: 0 0 auto !important;
            min-height: 38px !important;
            visibility: visible !important;
            opacity: 1 !important;
            z-index: 5 !important;
            position: relative !important;
        }
        #ratchet-master-container.shuffle-theme .mode-wrap .mode-btn {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            visibility: visible !important;
            opacity: 1 !important;
        }
        #ratchet-master-container.shuffle-theme .mode-btn.active { background: #6c47ff !important; color: #fff !important; box-shadow: 0 0 12px #6c47ff !important; }
        #ratchet-master-container.shuffle-theme .mode-btn:not(.active) { background: #2a1a52; color: #7c5cbf; }
        #ratchet-master-container.shuffle-theme .hud-rapid-btn.start { color: #fff; }
        #ratchet-master-container.shuffle-theme .hud-rapid-btn.start:hover { background: var(--hud-green-dark); }
        #ratchet-master-container.shuffle-theme input[type="number"]:focus { border-color: var(--hud-green); box-shadow: 0 0 0 2px rgba(108, 71, 255, 0.18); }
        #ratchet-master-container.shuffle-theme .hud-control-group input[type="range"] { accent-color: var(--hud-green); }
        /* Shuffle native footer relocated into the HUD slot */
        #ratchet-master-container .hud-footer-slot [class*="TBYuRq__footer"] {
            width: 100% !important; position: relative !important; left: auto !important;
            right: auto !important; bottom: auto !important; border-radius: 10px !important;
            overflow: hidden !important; flex: 1 1 auto !important;
        }
        #ratchet-master-container .hud-footer-slot [class*="DimmedWrapper"] { opacity: 1 !important; pointer-events: auto !important; }
        #ratchet-master-container .hud-footer-slot [data-sharkid] { color: #fff !important; background: transparent !important; }

        /* ---- Shuffle dice info panel (roll-over bar) ---- */
        #ratchet-master-container .shuffle-dice-panel { display: flex; flex-direction: column; gap: 5px; padding: 7px 10px; background: var(--hud-panel); border: 1px solid var(--hud-border-soft); border-radius: 12px; width: 100%; }
        #ratchet-master-container .dice-bar-wrapper { display: flex; flex-direction: column; gap: 3px; }
        #ratchet-master-container .dice-bar-ticks { display: flex; justify-content: space-between; padding: 0 1px; }
        #ratchet-master-container .dice-bar-ticks span { color: #b1bad3; font-size: 9px; font-weight: 700; }
        #ratchet-master-container .dice-bar-line { position: relative; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: visible; }
        #ratchet-master-container .dice-bar-fill { position: absolute; top: 0; height: 100%; border-radius: 3px; background: var(--hud-green); opacity: 0.55; transition: width 0.25s, left 0.25s; }
        #ratchet-master-container .dice-bar-thumb { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 14px; background: #fff; border-radius: 2px; transition: left 0.25s; }
        #ratchet-master-container .di-range-overlay { position: absolute; inset: -5px 0; width: 100%; opacity: 0; cursor: pointer; z-index: 2; margin: 0; }
    `);

    /* ==================== SHUFFLE DICE INFO PANEL ==================== */
    function getDiceInfo() {
        const rvEl = document.querySelector('#rollver-input');
        const rollOver = rvEl ? parseFloat(rvEl.value) || 50.5 : 50.5;
        let multiplier = 2, chance = 49.5;
        document.querySelectorAll('label').forEach(lbl => {
            const inp = lbl.parentElement && lbl.parentElement.querySelector('input');
            if (!inp) return;
            const t = (lbl.textContent || '').trim();
            const v = parseFloat(inp.value);
            if (t === 'Multiplier' && !isNaN(v)) multiplier = v;
            else if (t === 'Chance' && !isNaN(v)) chance = v;
        });
        const higherBar = document.querySelector('[class*="higherBar"]');
        const isRollOver = higherBar ? higherBar.className.includes('isRollOver') : true;
        return { multiplier, rollOver, chance, isRollOver };
    }
    function buildDiceInfoPanel() {
        const footerSlot = document.getElementById('hud-footer-slot');
        if (!footerSlot) return;
        const isDice = window.location.pathname.toLowerCase().includes('/dice');
        if (!isShuffle() || !isDice) {
            const existing = document.getElementById('shuffle-dice-panel');
            if (existing) existing.remove();
            return;
        }
        if (document.getElementById('shuffle-dice-panel')) return;
        const { rollOver, isRollOver } = getDiceInfo();
        const fillStyle = isRollOver
            ? 'left:' + rollOver + '%;width:' + (100 - rollOver).toFixed(2) + '%'
            : 'left:0;width:' + rollOver.toFixed(2) + '%';
        const dicePanel = document.createElement('div');
        dicePanel.id = 'shuffle-dice-panel';
        dicePanel.className = 'shuffle-dice-panel';
        dicePanel.innerHTML =
            '<div class="dice-bar-wrapper">' +
              '<div class="dice-bar-ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>' +
              '<div class="dice-bar-line">' +
                '<div id="di-bar-fill" class="dice-bar-fill" style="' + fillStyle + '"></div>' +
                '<div id="di-bar-thumb" class="dice-bar-thumb" style="left:' + rollOver.toFixed(2) + '%"></div>' +
                '<input id="di-range" type="range" min="2" max="98" step="0.01" value="' + rollOver.toFixed(2) + '" class="di-range-overlay">' +
              '</div>' +
            '</div>';
        footerSlot.insertBefore(dicePanel, footerSlot.firstChild);
        attachDiceInputListeners();
    }
    function attachDiceInputListeners() {
        function pushToGame(sharkId, value) {
            const gameInput = document.querySelector('[data-sharkid="' + sharkId + '"]');
            if (!gameInput) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(gameInput, String(value));
            ['input', 'change', 'blur'].forEach(t => gameInput.dispatchEvent(new Event(t, { bubbles: true })));
        }
        const rangeInp = document.getElementById('di-range');
        if (rangeInp) rangeInp.addEventListener('input', () => {
            const v = parseFloat(rangeInp.value);
            if (!isNaN(v)) pushToGame('__2', v.toFixed(2));
        });
    }
    function updateDiceInfoPanel() {
        const isDice = window.location.pathname.toLowerCase().includes('/dice');
        if (!isShuffle() || !isDice) return;
        if (!document.getElementById('shuffle-dice-panel')) { buildDiceInfoPanel(); return; }
        const { rollOver, isRollOver } = getDiceInfo();
        const active = document.activeElement;
        const rangeEl = document.getElementById('di-range');
        if (rangeEl && active !== rangeEl) rangeEl.value = rollOver.toFixed(2);
        const fill = document.getElementById('di-bar-fill');
        if (fill) {
            if (isRollOver) { fill.style.left = rollOver.toFixed(2) + '%'; fill.style.width = (100 - rollOver).toFixed(2) + '%'; }
            else { fill.style.left = '0'; fill.style.width = rollOver.toFixed(2) + '%'; }
        }
        const thumb = document.getElementById('di-bar-thumb');
        if (thumb) thumb.style.left = rollOver.toFixed(2) + '%';
    }
    let _clampLast = 0;
    function clampHUDAboveShuffleFooter() {
        if (!isShuffle()) return;
        const footerSlot = document.getElementById('hud-footer-slot');
        const nativeFooter = document.querySelector('[class*="TBYuRq__footer"]');
        // If native footer is already inside our HUD slot, no clamping needed
        if (footerSlot && nativeFooter && footerSlot.contains(nativeFooter)) return;
        const now = Date.now();
        if (now - _clampLast < 3000) return;
        _clampLast = now;
        const hud = document.getElementById('ratchet-master-container');
        if (!hud || !nativeFooter) return;
        const footerH = Math.round(nativeFooter.getBoundingClientRect().height);
        if (footerH > 0) hud.style.bottom = (footerH + 4) + 'px';
    }

    function getUserSetMultiplier() {
        const isDice = window.location.pathname.toLowerCase().includes('/dice');
        if (ACTIVE_MODE !== 'smart') return 2;
        if (isShuffle()) {
            // Shuffle's DiceGameFooter has two inputs both with id="betInfo"
            // (Multiplier and Chance) inside .InfoBetInput_inputContainer
            // wrappers. Pick the one whose container has the "Multiplier"
            // label. Fall back to legacy selectors in case Shuffle restores
            // them in a future deploy.
            const containers = document.querySelectorAll('[class*="InfoBetInput_inputContainer"]');
            for (const c of containers) {
                const labelText = (c.querySelector('label, span, p')?.textContent || '').trim();
                if (labelText === 'Multiplier') {
                    const inp = c.querySelector('input');
                    if (inp && inp.value) return parseFloat(inp.value) || 2;
                }
            }
            const mI = document.querySelector('input[data-sharkid="__3"]') ||
                       document.querySelector('input[data-testid="target-multiplier"], input[placeholder*="Multiplier"]');
            return mI ? parseFloat(mI.value) || 2 : 2;
        }
        if (isDice) {
            let inp = document.querySelector('input[data-testid="payout"]');
            if (inp) return parseFloat(inp.value) || 1.01;
            const winningsLabels = document.querySelectorAll('span, label, div');
            for (let el of winningsLabels) {
                if ((el.textContent || '').trim() === 'Winnings' || (el.getAttribute && el.getAttribute('slot') === 'label' && el.textContent.trim() === 'Winnings')) {
                    let container = el.closest('label') ||
                    el.parentElement;
                    if (container && container.shadowRoot) {
                        inp = container.shadowRoot.querySelector('input[data-testid="payout"], input[type="number"]');
                        if (inp) return parseFloat(inp.value) || 1.01;
                    }
                    if (container) {
                        inp = container.querySelector('input[data-testid="payout"], input[type="number"]');
                        if (inp) return parseFloat(inp.value) || 1.01;
                    }
                }
            }
            inp = document.querySelector('input[min="1.0102"], input[data-testid="payout"]');
            if (inp) return parseFloat(inp.value) || 1.01;
            return 1.01;
        }
        const mI = document.querySelector('input[data-testid="target-multiplier"]');
        return mI ? parseFloat(mI.value) || 2 : 2;
    }
    function getLatestBetEntry(container = pastBetsContainer || findPastBetsContainer()) {
        if (!container) return null;
        const element = container.querySelector('button[data-last-bet-index="0"]');
        if (!element) return null;
        const id = element.getAttribute('data-past-bet-id') || element.getAttribute('data-bet-id') || element.getAttribute('aria-label') || element.textContent.trim();
        return id ? { element, id } : null;
    }
    function syncLastSeenBet(container = pastBetsContainer || findPastBetsContainer()) {
        const latestBet = getLatestBetEntry(container);
        lastBetId = latestBet ? latestBet.id : null;
    }
    function triggerWinResetPulse() {
        const hud = document.getElementById('ratchet-master-container');
        if (!hud || ACTIVE_MODE !== 'iow') return;
        if (winResetPulseTimer) clearTimeout(winResetPulseTimer);
        hud.classList.remove('iow-win-reset-pulse');
        void hud.offsetWidth;
        hud.classList.add('iow-win-reset-pulse');
        winResetPulseTimer = setTimeout(() => {
            hud.classList.remove('iow-win-reset-pulse');
            winResetPulseTimer = null;
        }, 800);
    }
    function syncFooterFieldStyles() {
        const footerSlot = document.getElementById('hud-footer-slot');
        if (!footerSlot) return;
        const footerLabels = footerSlot.querySelectorAll('label');
        footerLabels.forEach(label => {
            label.removeAttribute('data-ratchet-footer-field');
            const labelTextEl = label.querySelector('[slot="label"], [class*="label-content"]');
            const labelText = (labelTextEl ? labelTextEl.textContent : label.textContent || '').replace(/\s+/g, ' ').trim();
            if (labelText === 'Winnings' || labelText === 'Roll Over' || labelText === 'Win Chance') {

                label.setAttribute('data-ratchet-footer-field', 'true');
            }
        });
    }
    function syncModeButtons() {
        document.querySelectorAll('#ratchet-master-container .mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `mode-${ACTIVE_MODE}`);
        });
    }
    function getHudHost() {
        if (isShuffle()) {
            // Preferred mount: GameLayout_gameContent — sibling of the
            // sidebar (so we don't cover the native bet panel) and spans the
            // entire right-side game area top to bottom. Larger than the
            // inner DiceGameContent_root by ~24px on all sides, so the HUD's
            // purple overlay fills the visible space the way Stake's does.
            const gameContent = document.querySelector('[class*="GameLayout_gameContent"]');
            if (gameContent) {
                const r = gameContent.getBoundingClientRect();
                if (r.height >= 400 && r.width >= 400) return gameContent;
            }
            // Fallback: walk up from the rolling bar (which only exists
            // inside the dice/limbo game UI) until we find a container
            // that's at least 400px tall.
            const rollingBar = document.querySelector('[class*="rollingWrapper"], [class*="DiceGameRollingBar"], [class*="RollingBar"]');
            if (rollingBar) {
                let p = rollingBar.parentElement;
                for (let i = 0; i < 6 && p; i++) {
                    const r = p.getBoundingClientRect();
                    if (r.height >= 400) return p;
                    p = p.parentElement;
                }
            }
            // Returns null when no Shuffle game container is on the page —
            // buildHUD then tears the HUD down. Previously this fell back to
            // <main>, which caused the absolute-positioned overlay to cover
            // shuffle.us/ (home page / lobby) after SPA navigation away from
            // /dice or /limbo.
            return document.querySelector('[class*="OriginalGameContentWrapper"]')
                || document.querySelector('[class*="DiceGameContent"]')
                || document.querySelector('[class*="LimboGameContent"]')
                || document.querySelector('[class*="GameContentWrapper"]')
                || document.querySelector('[data-testid="game-view"]')
                || document.querySelector('.game-content')
                || null;
        }
        return document.querySelector('div[data-testid="game-frame"]')
            ||
            document.querySelector('.game-frame')
            ||
            document.querySelector('.game-content')
            || document.querySelector('[data-testid="game-view"]');
    }
    // Detect the bottom edge of Shuffle's fixed global nav so the HUD can
    // start below it instead of being hidden behind. Cached in a ref so we
    // don't query every tick. */
    function getShuffleHeaderBottom() {
        // Likely candidates: a fixed/sticky header at the top of the page
        const candidates = [
            'header',
            '[class*="GlobalHeader"]',
            '[class*="globalHeader"]',
            '[class*="TopBar"]',
            '[class*="topbar"]',
            '[class*="MainHeader"]',
            '[class*="NavHeader"]',
            'nav[class*="header"]'
        ];
        let bestBottom = 0;
        for (const sel of candidates) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const cs = getComputedStyle(el);
                if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
                const r = el.getBoundingClientRect();
                if (r.top <= 4 && r.bottom > bestBottom && r.bottom < 200) {
                    bestBottom = r.bottom;
                }
            }
        }
        return bestBottom;
    }
    function findNativeElement(selector) {
        const host = getHudHost();
        const scope = host || document;
        const scoped = Array.from(scope.querySelectorAll(selector));
        const pick = scoped.find(el => !el.closest('#ratchet-master-container')) || scoped[0];
        if (pick) return pick;
        const fallback = Array.from(document.querySelectorAll(selector));
        return fallback.find(el => !el.closest('#ratchet-master-container')) || fallback[0] || null;
    }
    function findShuffleFooter() {
        // Shuffle's CSS module hashes change on every deploy — use broad
        // selectors that catch most variants, with a label-based fallback.
        const byClass = document.querySelector(
            '[class*="footer"][class*="dice"], [class*="Dice"][class*="footer"], ' +
            '[class*="TBYuRq__footer"], [class*="gameFooter"], [class*="GameFooter"], ' +
            '[class*="betControls"], [class*="BetControls"], [class*="gameControls"], [class*="GameControls"]'
        );
        if (byClass) return byClass;
        // Fallback: find the element containing a "Multiplier" label + ≥2 inputs
        for (const el of document.querySelectorAll('label, p, span, div')) {
            if ((el.textContent || '').trim() === 'Multiplier') {
                let p = el.parentElement;
                for (let i = 0; i < 7; i++) {
                    if (!p || p === document.body) break;
                    if (p.querySelectorAll('input').length >= 2) return p;
                    p = p.parentElement;
                }
            }
        }
        return null;
    }
    function mountSingleElement(slot, element) {
        if (!slot || !element) return;
        if (slot.childElementCount === 1 && slot.firstElementChild === element) return;
        slot.replaceChildren(element);
    }
    function syncNativeHudElements() {
        if (isShuffle()) {
            // Shuffle has no .game-sidebar / .past-bets / .footer in the
            // Stake sense — instead we move its bet-controls footer (which
            // contains amount/multiplier/play) into the HUD's footer slot.
            const footer = findShuffleFooter();
            const footerSlot = document.getElementById('hud-footer-slot');
            if (footer && footerSlot && footer.parentElement !== footerSlot) {
                footerSlot.appendChild(footer);
            }
            // Relocate Shuffle's recent-results feed (the row of colored
            // outcome pills above the game) into the HUD's past-bets slot
            // so it appears at the top, mirroring Stake's .past-bets row.
            const feed = document.querySelector('[class*="OriginalGameRecentResult_originalGameResultsWrapper"]');
            const pastBetsSlot = document.getElementById('hud-native-past-bets-slot');
            if (feed && pastBetsSlot && feed.parentElement !== pastBetsSlot) {
                pastBetsSlot.appendChild(feed);
            }
            return;
        }
        mountSingleElement(document.getElementById('hud-native-sidebar-slot'), findNativeElement('.game-sidebar'));
        mountSingleElement(document.getElementById('hud-native-past-bets-slot'), findNativeElement('.past-bets'));
        mountSingleElement(document.getElementById('hud-footer-slot'), findNativeElement('.footer'));
        mountSingleElement(document.getElementById('hud-native-game-footer-slot'), findNativeElement('.game-footer'));
        syncFooterFieldStyles();
    }
    function buildHUD() {
        // URL guard: only build/maintain the HUD on dice/limbo pages. After
        // SPA navigation to a different game (Mines, Plinko, Keno, etc.),
        // tear down the HUD so its overlay doesn't sit on top of the new
        // game's UI. Shuffle's GameLayout_gameContent class is shared by
        // every original-game page, so getHudHost would otherwise mount the
        // HUD on whatever game the user navigated to.
        //
        // Per-game enable gate: also tear down when the user has disabled
        // the specific tool for the current URL (e.g. on Stake Limbo with
        // stake-limbo disabled — the user wants Dice but not Limbo).
        if (!isOnSupportedGamePage() || !isCurrentGameEnabled()) {
            const existing = document.getElementById('ratchet-master-container');
            if (existing) existing.remove();
            return;
        }
        const gameDisplay = getHudHost();
        if (!gameDisplay) {
            // SPA navigation away from a Stake/Shuffle game page (e.g. user
            // clicked the site logo to go home / open the lobby). Remove any
            // existing HUD so its absolute-positioned overlay doesn't sit
            // on top of the new page. Native elements we relocated into
            // HUD slots get torn down with the HUD; the site re-renders them
            // when the user navigates back to a game.
            const existing = document.getElementById('ratchet-master-container');
            if (existing) existing.remove();
            return;
        }
        let hud = document.getElementById('ratchet-master-container');
        if (window.getComputedStyle(gameDisplay).position === 'static') gameDisplay.style.position = 'relative';
        if (hud && hud.parentElement !== gameDisplay) gameDisplay.appendChild(hud);
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'ratchet-master-container';
            hud.innerHTML = `
                <div class="hud-frame">
                    <div id="hud-native-sidebar-slot" class="hud-native-sidebar-slot"></div>
                    <div class="hud-workspace">
                        <div id="hud-native-past-bets-slot" class="hud-native-past-bets-slot"></div>

                        <div class="mode-wrap">
                            <button id="mode-manual" class="mode-btn">Manual</button>
                            <button id="mode-iow" class="mode-btn">IOW</button>

             <button id="mode-smart" class="mode-btn">Smart</button>
                        </div>
                        <div id="hud-content"></div>
                        <div id="hud-footer-slot" class="hud-footer-slot"></div>

             </div>
                </div>
                <div id="hud-native-game-footer-slot" class="hud-native-game-footer-slot"></div>
            `;
            gameDisplay.appendChild(hud);
            document.getElementById('mode-manual').onclick = () => switchMode('manual');
            document.getElementById('mode-iow').onclick = () => switchMode('iow');
            document.getElementById('mode-smart').onclick = () => switchMode('smart');
            buildHUDContent();
        }
        hud.dataset.mode = ACTIVE_MODE;
        hud.classList.toggle('shuffle-theme', isShuffle());
        if (isShuffle()) {
            // Shuffle: full overlay sized to the container's natural height
            // (rolling bar + footer). Our HUD is position:absolute so
            // containerRect.height reflects only native Shuffle content.
            const containerRect = hud.parentElement ? hud.parentElement.getBoundingClientRect() : null;
            let hudH = 640;
            if (containerRect && containerRect.height > 200) {
                hudH = Math.max(containerRect.height, 400);
            } else {
                const rollingBar = document.querySelector('[class*="rollingWrapper"], [class*="DiceGameRollingBar"], [class*="RollingBar"]');
                if (rollingBar && containerRect) {
                    const rbRect = rollingBar.getBoundingClientRect();
                    hudH = Math.max(rbRect.bottom - containerRect.top + 80, 400);
                }
            }
            hud.style.setProperty('height', hudH + 'px', 'important');
            // If the host is the global page wrapper (MAIN or similar),
            // Shuffle's fixed header sits over our top edge and hides the
            // mode-wrap. Detect the header's bottom edge and push the HUD
            // down by that much so the mode buttons clear it.
            const parent = hud.parentElement;
            const parentRect = parent ? parent.getBoundingClientRect() : null;
            const headerBottom = getShuffleHeaderBottom();
            if (parentRect && headerBottom > parentRect.top) {
                const offset = Math.max(0, headerBottom - parentRect.top + 4);
                hud.style.setProperty('top', offset + 'px', 'important');
                // shrink height so the bottom doesn't fall off the parent
                const adjusted = Math.max(400, hudH - offset);
                hud.style.setProperty('height', adjusted + 'px', 'important');
            } else {
                hud.style.setProperty('top', '0', 'important');
            }
        } else {
            hud.style.removeProperty('height');
            hud.style.removeProperty('top');
        }
        syncModeButtons();
        syncNativeHudElements();
        setTimeout(syncNativeHudElements, 350);
        // Shuffle dice info panel (roll-over bar in the footer slot)
        if (isShuffle()) buildDiceInfoPanel();
    }
    function buildHUDContent() {
        const content = document.getElementById('hud-content');
        const hud = document.getElementById('ratchet-master-container');
        if (!content) return;
        if (hud) hud.dataset.mode = ACTIVE_MODE;
        syncModeButtons();
        content.innerHTML = '';
        let html = '';
        if (ACTIVE_MODE === 'iow') {
            html = `
                <div class="hud-shell">
                    <div class="hud-top-bar">
                        <div class="control-section hud-panel">

                            <div class="input-row">
                                <div class="input-cluster">
                                    <label style="color:#94a3b8;font-size:10px;font-weight:800;white-space:nowrap;">Base bet</label>

                                    <div class="input-group">
                                        <input id="h-base" type="number" step="0.01" value="${baseBet.toFixed(2)}">

         <button id="h-double-base" class="quick-btn">2x</button>
                                        <button id="h-half-base" class="quick-btn">1/2</button>
                                    </div>

                                     <div class="hud-risk-container">
                                        <label>Win increase % <input id="h-win-inc" type="number" min="0" value="${winIncreasePercent}"></label>

         <label>Loss reset <input id="h-loss-reset" type="number" min="1" value="${lossStreakReset}"></label>
                                        <label>Win reset <input id="h-wins-reset" type="number" min="1" value="${winsBeforeReset ||
''}"></label>
                                        <label>Autostop on Balance: <input id="h-autostop" type="number" step="0.01" value="${autoStopBalance !== null ?
autoStopBalance.toFixed(2) : ''}" placeholder="OFF"></label>
                                    </div>
                                </div>

                                 <div class="btn-group">
                                    <button id="h-reset" class="hud-reset-btn">RESET STATS</button>
                                    ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                                    <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>

                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="hud-split">
                        <div class="hud-pane primary">
                            <div class="status-bar" id="h-target"> base bet: 0.01 | Wins: 0 | LossStreak: 0 </div>

             <div class="hud-graph-box" id="h-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>

                        <div class="hud-pane secondary">
                            <div class="hud-stat-rail">
                                <div class="hud-stat-card">

                                     <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                   <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>
                                </div>

                                     <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>

                                      <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>

                                     </div>
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:#00ff9d;">-</span>
                                </div>
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:#f87171;">-</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

             `;
        } else if (ACTIVE_MODE === 'smart') {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Initializing Data Link...</span>

                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Aggression <span id="h-agg-val" style="color:#fff;">${aggressionLevel.toFixed(1)}x</span></label>

                            <input type="range" id="h-agg" min="0.5" max="3.0" step="0.1" value="${aggressionLevel.toFixed(1)}">
                        </div>
                        <div class="hud-control-group">

                             <label style="flex-direction: row; justify-content: flex-start; gap: 6px; cursor: pointer; color: #94a3b8;">
                                <input type="checkbox" id="h-lock-agg-chk" ${lockAggressionState ?
'checked' : ''}> Lock State
                            </label>
                            <select id="h-lock-gear-sel" ${lockAggressionState ?
'' : 'disabled'}>
                                <option value="1" ${lockedGearLevel === 1 ?
'selected' : ''}>Conservative</option>
                                <option value="2" ${lockedGearLevel === 2 ?
'selected' : ''}>Steady</option>
                                <option value="3" ${lockedGearLevel === 3 ?
'selected' : ''}>Balanced</option>
                                <option value="4" ${lockedGearLevel === 4 ?
'selected' : ''}>Press</option>
                                <option value="5" ${lockedGearLevel === 5 ?
'selected' : ''}>Aggro</option>
                            </select>
                        </div>
                        <div class="hud-control-group">

                             <label>Stop Loss %</label>
                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">

                            <label>Take Profit %</label>
                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Autostop on Balance:</label>
                            <input id="h-autostop" type="number" step="0.01" value="${autoStopBalance !== null ? autoStopBalance.toFixed(2) : ''}" placeholder="OFF">
                        </div>

                         <div class="btn-group">
                            <button id="h-reset" class="hud-reset-btn">RESET</button>
                            ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>

                    </div>
                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">

                                 <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="stats-col">

                                <div class="hud-stats-grid">
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>

                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                 <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">

                                     <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>

                                     <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                </div>

                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Aggression state</span><span id="h-state" class="hud-val gear-text gear-1-text">GEAR 1</span></div>
                                    <div
class="hud-row"><span class="hud-label">Momentum Window</span><span id="h-hot" class="hud-val">0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 |
0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>

                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">

                                     <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:#00ff9d;">-</span>
                                </div>

                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:#f87171;">-</span>

                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            `;
        } else {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Manual • Full Stats • Spacebar Rapid</span>

                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Bet</label>
                            <div class="input-group">
                                <input id="h-manual-bet" type="number" step="0.01" min="0.01" value="${manualBet.toFixed(2)}" style="width: 76px; flex: 0 0 auto;">
                                <button id="h-manual-double" class="quick-btn">2x</button>
                                <button id="h-manual-half" class="quick-btn">1/2</button>
                            </div>
                        </div>
                        <div class="hud-control-group">
                            <label>Stop Loss %</label>

                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Take Profit %</label>

                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Autostop on Balance:</label>
                            <input id="h-autostop" type="number" step="0.01" value="${autoStopBalance !== null ? autoStopBalance.toFixed(2) : ''}" placeholder="OFF">
                        </div>
                        <div class="btn-group">

                             <button id="h-reset" class="hud-reset-btn">RESET</button>
                            ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>
                    </div>

                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">
                                <canvas id="h-custom-graph"></canvas>

                            </div>
                        </div>
                        <div class="stats-col">
                            <div class="hud-stats-grid">

                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>

                                     <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:#00ff9d;">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:#00ff9d;">0.00</span></div>

                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total
Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>

                                     <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 |
0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                            <div class="hud-meta-row">

                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>

                                     <span id="h-best-w" class="hud-val" style="color:#00ff9d;">-</span>
                                </div>
                                <div class="hud-meta-chip">

                                     <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:#f87171;">-</span>
                                </div>
</div>

                            </div>
                            </div>
                        </div>
                    </div>
                </div>

            `;
        }
        content.innerHTML = html;
        attachListeners();
    }
    function switchMode(newMode) {
        // Detect "empty hud-content" — happens when leaving Advanced IOW
        // back to the same mode that was active before (activateTools clears
        // #hud-content but doesn't touch ACTIVE_MODE, so a same-mode click
        // would otherwise early-return and leave the HUD blank).
        const content = document.getElementById('hud-content');
        const needsRebuild = !!content && content.children.length === 0;
        if (newMode === ACTIVE_MODE && !needsRebuild) return;
        ACTIVE_MODE = newMode;
        syncModeButtons();
        if (isRapidFiring) stopRapidFire();
        // Entering Manual: seed manualBet from Stake's wager input so the
        // HUD's bet field reflects what the user already had typed there.
        if (newMode === 'manual') {
            const cur = getCurrentBet();
            if (isFinite(cur) && cur >= minBaseBet) manualBet = cur;
        }
        buildHUDContent();
        resetStats();
    }
    function attachListeners() {
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) rapidBtn.onclick = () => { if (!isRapidFiring) startRapidFire(); else stopRapidFire(); };
        const resetBtn = document.getElementById('h-reset');
        if (resetBtn) resetBtn.onclick = resetStats;
        // Autostop on Balance — shared across Manual / IOW / Smart modes.
        // Each mode's HTML renders its own #h-autostop input; the rapid-fire
        // tick already checks autoStopBalance globally and stops when reached.
        const autostopInp = document.getElementById('h-autostop');
        if (autostopInp) {
            autostopInp.addEventListener('input', () => { autoStopBalance = parseFloat(autostopInp.value) || null; });
            autostopInp.addEventListener('blur', () => { let v = parseFloat(autostopInp.value) || 0; autostopInp.value = v ? v.toFixed(2) : ''; autoStopBalance = v || null; });
        }
        // Switch Over/Under — Dice only, shared across Manual / IOW / Smart.
        // Rapid-fire clicks the bet button fast enough that a single direct
        // swap click often lands in the middle of an in-flight bet and gets
        // ignored. Briefly pause rapid-fire → swap → resume so the swap
        // always commits cleanly between bets. The interruption is <100 ms
        // so gameplay barely feels it.
        const switchOuBtn = document.getElementById('h-switch-ou');
        if (switchOuBtn) {
            switchOuBtn.addEventListener('click', async () => {
                if (switchOuBtn.disabled) return;
                switchOuBtn.disabled = true;
                try {
                    const wasRunning = isRapidFiring;
                    if (wasRunning) stopRapidFire();
                    // Tiny pause so the last in-flight bet click settles
                    // before we send the swap click.
                    await new Promise(r => setTimeout(r, 40));
                    const swap = getRollOverUnderSwap();
                    if (swap) swap.click();
                    // Tiny pause so Stake commits the swap state before
                    // rapid-fire resumes and starts placing bets again.
                    await new Promise(r => setTimeout(r, 60));
                    if (wasRunning) startRapidFire();
                } catch (e) { console.error('[Switch Over/Under] failed:', e); }
                setTimeout(() => { switchOuBtn.disabled = false; }, 250);
            });
        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) {
                baseInp.addEventListener('input', () => { baseBet = parseFloat(baseInp.value) || minBaseBet; });
                baseInp.addEventListener('blur', () => { let v = parseFloat(baseInp.value) || minBaseBet; baseInp.value = v.toFixed(2); baseBet = v; });
            }
            const doubleBtn = document.getElementById('h-double-base');
            if (doubleBtn) doubleBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet; val *= 2; document.getElementById('h-base').value = val.toFixed(2); baseBet = val;
            });
            const halfBtn = document.getElementById('h-half-base');
            if (halfBtn) halfBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet; val *= 0.5; val = Math.max(minBaseBet, val); document.getElementById('h-base').value = val.toFixed(2); baseBet = val;
            });
            const winInc = document.getElementById('h-win-inc'); if (winInc) winInc.addEventListener('input', () => { winIncreasePercent = parseFloat(winInc.value) || 125; });
            const lossReset = document.getElementById('h-loss-reset');
            if (lossReset) lossReset.addEventListener('input', () => { lossStreakReset = parseInt(lossReset.value, 10) || 3; });
            const winsReset = document.getElementById('h-wins-reset');
            if (winsReset) winsReset.addEventListener('input', () => { winsBeforeReset = parseInt(winsReset.value, 10) || null; });
        } else {
            const slInp = document.getElementById('h-sl');
            if (slInp) slInp.addEventListener('input', () => { stopLossPct = parseFloat(slInp.value) || 0; });
            const tpInp = document.getElementById('h-tp');
            if (tpInp) tpInp.addEventListener('input', () => { takeProfitPct = parseFloat(tpInp.value) || 0; });
            if (ACTIVE_MODE === 'manual') {
                // Manual mode bet controls — input + 2x/1/2 buttons that
                // immediately push the new value into Stake's wager input
                // when rapid-fire is running, so the user can change bet
                // size without stopping autoplay.
                const manualInp = document.getElementById('h-manual-bet');
                if (manualInp) {
                    manualInp.addEventListener('input', () => {
                        const v = parseFloat(manualInp.value);
                        if (isFinite(v) && v >= minBaseBet) {
                            manualBet = v;
                            if (isRapidFiring) setBet(v);
                        }
                    });
                    manualInp.addEventListener('blur', () => {
                        let v = parseFloat(manualInp.value) || minBaseBet;
                        if (v < minBaseBet) v = minBaseBet;
                        manualInp.value = v.toFixed(2);
                        manualBet = v;
                        if (isRapidFiring) setBet(v);
                    });
                }
                const manualDouble = document.getElementById('h-manual-double');
                if (manualDouble) manualDouble.addEventListener('click', () => {
                    const inp = document.getElementById('h-manual-bet');
                    let v = parseFloat(inp.value) || minBaseBet;
                    v *= 2;
                    inp.value = v.toFixed(2);
                    manualBet = v;
                    if (isRapidFiring) setBet(v);
                });
                const manualHalf = document.getElementById('h-manual-half');
                if (manualHalf) manualHalf.addEventListener('click', () => {
                    const inp = document.getElementById('h-manual-bet');
                    let v = parseFloat(inp.value) || minBaseBet;
                    v = Math.max(minBaseBet, v * 0.5);
                    inp.value = v.toFixed(2);
                    manualBet = v;
                    if (isRapidFiring) setBet(v);
                });
            }
            if (ACTIVE_MODE === 'smart') {
                const aggInp = document.getElementById('h-agg');
                if (aggInp) aggInp.addEventListener('input', e => { aggressionLevel = parseFloat(e.target.value); const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`; });
                const lockChk = document.getElementById('h-lock-agg-chk');
                const gearSel = document.getElementById('h-lock-gear-sel');
                if (lockChk && gearSel) {
                    lockChk.addEventListener('change', (e) => {
                        lockAggressionState = e.target.checked;
                        gearSel.disabled = !lockAggressionState;

                        updateUI();
                    });
                    gearSel.addEventListener('change', (e) => {
                        lockedGearLevel = parseInt(e.target.value, 10);
                        updateUI();
                    });
                }
            }
        }
    }
    function resetStats() {
        const bal = getCurrentBalance();
        sessionPeak = bal; initialBalance = bal; lastKnownBalance = bal;
        totalWagered = 0; highestProfit = 0; totalWins = 0;
        totalLosses = 0; totalBets = 0;
        lossStreak = 0; counter = 0; lastBetId = null; profitHistory = [0];
        lastAmount = null;
        betHistory = []; recentWins = []; topWinStreaks = []; topLossStreaks = [];
        curLossStreak = 0;
        maxLossStreak = 0; curWinStreak = 0; maxWinStreak = 0;
        multGames = 0; multWins = 0; lastResult = null;
        autoPaused = false; stopLossPct = 0; takeProfitPct = 0;
        rapidBlockedSince = 0; rapidFireStartedAt = 0; lastObservedBetTime = 0;
        if (isRapidFiring) stopRapidFire();
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) baseInp.value = baseBet.toFixed(2);
        } else if (ACTIVE_MODE === 'smart') {
            const aggInp = document.getElementById('h-agg');
            if (aggInp) aggInp.value = aggressionLevel.toFixed(1);
            const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`;
        }
        const sl = document.getElementById('h-sl'); if (sl) sl.value = '0';
        const tp = document.getElementById('h-tp'); if (tp) tp.value = '0';
        syncLastSeenBet();
        updateUI();
    }
    function getCurrentBalance() {
        if (isShuffle()) {
            // Shuffle balance — active currency tab button (aria-selected, disabled)
            const activeTabBtn = document.querySelector('button[aria-selected="true"][disabled][data-testid]');
            if (activeTabBtn) {
                const p = activeTabBtn.querySelector('p');
                if (p) {
                    const val = parseFloat(p.textContent.trim().replace(/,/g, ''));
                    if (!isNaN(val)) { lastKnownBalance = val; return val; }
                }
            }
            const sels = ['[data-testid="balance"]', '.balance-amount', '.wallet-balance span', 'header [class*="balance"] span', 'div[class*="balance"] strong', 'span[class*="amount"]'];
            for (const sel of sels) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const val = parseFloat(el.textContent.trim().replace(/[^0-9.]/g, ''));
                    if (!isNaN(val) && val > 0.001) { lastKnownBalance = val; return val; }
                }
            }
            return lastKnownBalance || 0;
        }
        const betField = document.getElementById('text-field-container') || document.querySelector('input[data-testid="input-game-amount"]');
        const activeCurrency = (betField && betField.getAttribute('data-bet-amount-active-currency')) || '';
        const iconName = activeCurrency.toUpperCase();
        const parseBalText = (txt) => {
            const cleaned = (txt || '').replace(/[^0-9.]/g, '');
            const val = parseFloat(cleaned);
            return !isNaN(val) ? val : null;
        };
        const balanceElems = document.querySelectorAll('span.text-neutral-default.ds-body-md-strong[data-ds-text="true"][style*="max-width: 16ch"]');
        let fallbackVal = null;
        for (let elem of balanceElems) {
            const val = parseBalText(elem.textContent);
            if (val === null) continue;
            if (fallbackVal === null) fallbackVal = val;
            if (!iconName) continue;
            const sibling = elem.parentElement && elem.parentElement.nextElementSibling;
            if (!sibling) continue;
            const svg = sibling.querySelector('svg[data-ds-icon]');
            const svgIcon = svg && (svg.getAttribute('data-ds-icon') || '').toUpperCase();
            const title = (sibling.getAttribute('title') || '').toUpperCase();
            if (svgIcon === iconName || title === iconName) {
                lastKnownBalance = val;
                return val;
            }
        }
        if (fallbackVal !== null) {
            lastKnownBalance = fallbackVal;
            return fallbackVal;
        }
        return lastKnownBalance || 0;
    }
    function getBetContainer() { return document.getElementById('text-field-container');
    }
    function getCurrentBet() {
        if (isShuffle()) {
            const input = document.querySelector('input[data-testid="bet-amount"], input[placeholder*="Amount"], input[placeholder*="Bet"], input[type="text"][inputmode="decimal"]');
            if (input) return parseFloat(input.value.replace(/[^0-9.]/g, '')) || minBaseBet;
            const displayed = document.querySelector('[class*="bet-amount"], [class*="wager"] span');
            if (displayed) {
                const num = parseFloat(displayed.textContent.replace(/[^0-9.]/g, ''));
                return isNaN(num) ? minBaseBet : num;
            }
            return minBaseBet;
        }
        const amountDiv = document.querySelector('#text-field-container #editing-view-port > div');
        if (amountDiv) return parseFloat(amountDiv.textContent.trim().replace(/[^0-9.]/g, '')) || minBaseBet;
        const oldInput = document.querySelector('input[data-testid="input-game-amount"]');
        return oldInput ? parseFloat(oldInput.value.replace(/,/g, '')) || minBaseBet : minBaseBet;
    }
    function setBet(amount) {
        // IOW + Manual both write to Stake's wager input. Smart writes via its
        // own updateBetAmount() and shouldn't go through this path; Advanced
        // IOW is owned by the dice tool and doesn't write through the HUD.
        if (ACTIVE_MODE !== 'iow' && ACTIVE_MODE !== 'manual') return false;
        if (!isFinite(amount) || amount < 0) return false;
        const targetStr = Math.min(amount, maxBaseBet).toFixed(2);
        if (isShuffle()) {
            const input = document.querySelector('input[data-testid="bet-amount"], input[placeholder*="Amount"], input[placeholder*="Bet"], input[type="text"][inputmode="decimal"]');
            if (!input) return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, targetStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        const container = getBetContainer();
        if (container) {
            container.focus(); container.click();
            setTimeout(() => {
                const display = document.querySelector('#editing-view-port > div');
                if (display) { display.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, targetStr); }
                ['input','change','blur','keydown','keyup','focus'].forEach(type => {
                    const e = new Event(type, { bubbles: true });

                     container.dispatchEvent(e); if (display) display.dispatchEvent(e);
                });
            }, 10);
            return true;
        }
        const input = document.querySelector('input[data-testid="input-game-amount"]');
        if (input) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, targetStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }
    function getPlayButton() {
        if (isShuffle()) {
            return document.querySelector('button[data-testid="bet-button"]') ||
                   Array.from(document.querySelectorAll('button')).find(b => /^(Bet|Roll|Play)$/i.test((b.textContent || '').trim()) && b.offsetParent !== null);
        }
        let btn = document.querySelector('button[data-testid="bet-button"]');
        if (btn) return btn;
        const spans = document.querySelectorAll('span.ds-body-md-strong[data-ds-text="true"]');
        for (let span of spans) {
            if (span.textContent.trim() === 'Play') { const button = span.closest('button');
            if (button) return button; }
        }
        return Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Play') && b.offsetParent !== null);
    }
    function findPastBetsContainer() {
        if (isShuffle()) {
            return document.querySelector('.past-bets, [class*="history"], [class*="bet-history"], [class*="pastBets"], section[class*="history"]') ||
                   document.querySelector('div[class*="bets"]');
        }
        return document.querySelector('div.past-bets');
    }
    function isWin(betDiv) {
        if (!betDiv) return false;
        if (isShuffle()) {
            return betDiv.classList.contains('variant-positive') ||
                   betDiv.classList.contains('win') ||
                   betDiv.querySelector('.positive, .win, svg[class*="green"]') !== null ||
                   /win/i.test(betDiv.textContent || '');
        }
        return betDiv.classList.contains('variant-positive');
    }
    function startObserver() {
        if (isShuffle()) {
            // Shuffle uses a DOM-balance + GraphQL/WS network observer pair
            // (see startShuffleObserver / onShuffleBetResult). The Stake-style
            // past-bets MutationObserver doesn't apply because Shuffle's
            // history layout differs and balances aren't observable from
            // the past-bets container.
            return;
        }
        pastBetsContainer = findPastBetsContainer();
        if (!pastBetsContainer) { setTimeout(startObserver, 500); return; }
        if (observer) observer.disconnect();
        syncLastSeenBet(pastBetsContainer);
        observer = new MutationObserver(() => processNewBet(pastBetsContainer));
        observer.observe(pastBetsContainer, { childList: true, subtree: true });
    }
    function onShuffleBetResult(bet) {
        const now = Date.now();
        // Dedup: DOM balance observer may have already counted this bet
        if (now - _shuffleLastBetMs < 400) return;
        _shuffleLastBetMs = now;
        const payout  = parseFloat(bet.payout) || 0;
        const won     = payout > 0;
        const betAmt  = parseFloat(bet.amount) || minBaseBet;
        const afterBal = parseFloat(bet.afterBalance);
        if (!isNaN(afterBal) && afterBal > 0 && initialBalance === 0) {
            const beforeBal = afterBal - payout + betAmt;
            initialBalance  = beforeBal;
            sessionPeak     = beforeBal;
            lastKnownBalance = afterBal;
        }
        if (!isNaN(afterBal) && afterBal > 0) _shuffleObsBalance = afterBal;
        lastObservedBetTime = now;
        rapidBlockedSince   = 0;
        totalBets++;
        handleBetResult(won, betAmt);
        applyShuffleIOWLogic(won);
        updateUI();
    }
    function applyShuffleIOWLogic(won) {
        if (ACTIVE_MODE !== 'iow') return;
        if (won) {
            lossStreak = 0;
            counter++;
            if (isRapidFiring) {
                const curBet = getCurrentBet();
                let newBet = curBet * (1 + winIncreasePercent / 100);
                newBet = Math.min(newBet, maxBaseBet);
                setBet(newBet);
            }
            if (winsBeforeReset && counter >= winsBeforeReset) {
                counter = 0;
                triggerWinResetPulse();
                if (isRapidFiring) setBet(baseBet);
            }
        } else {
            lossStreak++;
            if (lossStreak >= lossStreakReset) {
                counter = 0;
                if (isRapidFiring) setBet(baseBet);
            }
        }
        if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
    }
    function startShuffleObserver() {
        if (!isShuffle()) return;
        if (_shuffleBalObsEl && _shuffleBalObsEl.isConnected) return;
        const candidates = [
            'button[aria-selected="true"][disabled][data-testid] p',
            'button[data-testid][disabled] p',
            '[data-testid="balance"]',
            'header [class*="Balance"] span',
            'header [class*="balance"] span',
            '[class*="walletBalance"]',
            '[class*="WalletBalance"]',
            '[class*="balance-amount"]'
        ];
        let el = null;
        for (const s of candidates) {
            const found = document.querySelector(s);
            if (!found) continue;
            const v = parseFloat(found.textContent.replace(/[^0-9.]/g, ''));
            if (v > 0) { el = found; break; }
        }
        if (!el) return;
        const seedBal = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
        if (seedBal > 0) {
            _shuffleObsBalance = seedBal;
            lastKnownBalance   = seedBal;
            if (initialBalance === 0) { initialBalance = seedBal; sessionPeak = seedBal; }
        }
        _shuffleBalObsEl = el;
        const obs = new MutationObserver(function () {
            const newBal = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
            if (isNaN(newBal) || Math.abs(newBal - _shuffleObsBalance) < 0.0001) return;
            const now = Date.now();
            if (now - _shuffleLastBetMs < 400) { _shuffleObsBalance = newBal; return; }
            _shuffleLastBetMs = now;
            const betAmt = getCurrentBet() || minBaseBet;
            const isWinResult = newBal > _shuffleObsBalance;
            if (initialBalance === 0) {
                initialBalance = isWinResult ? _shuffleObsBalance : _shuffleObsBalance + betAmt;
                sessionPeak    = initialBalance;
            }
            _shuffleObsBalance = newBal;
            lastObservedBetTime = now;
            rapidBlockedSince   = 0;
            totalBets++;
            handleBetResult(isWinResult, betAmt);
            applyShuffleIOWLogic(isWinResult);
            updateUI();
        });
        obs.observe(el, { childList: true, subtree: true, characterData: true });
    }
    /**
     * Per-bet feed observer for Shuffle. The balance MutationObserver
     * (startShuffleObserver) has a 400ms dedup window that drops bets fired
     * faster than that, so high-cadence runs lose entries. The recent-results
     * feed (`OriginalGameRecentResult_originalGameResultsWrapper`) adds one
     * new child PER bet — observing childList is dedup-free and gives us a
     * reliable per-bet signal.
     *
     * Win/loss is read from the new child's inline background-color:
     *   - rgb(61, 209, 121)  → win (Shuffle's green)
     *   - rgb(40, 46, 61)    → loss (Shuffle's dark slate)
     */
    function startShuffleFeedObserver() {
        if (!isShuffle()) return;
        const feed = document.querySelector('[class*="OriginalGameRecentResult_originalGameResultsWrapper"]');
        if (!feed) return;
        if (_shuffleFeedObsEl === feed && _shuffleFeedObsEl.isConnected) return;
        _shuffleFeedObsEl = feed;
        const obs = new MutationObserver(function (mutations) {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const cls = (node.className && typeof node.className === 'string') ? node.className : '';
                    // Each bet result is a div with class BetResultContainer_...
                    if (!/BetResultContainer/i.test(cls)) continue;
                    const now = Date.now();
                    // Loose dedup against the balance observer firing for the
                    // same bet — much tighter than its own 400ms because we
                    // want every per-bet event to count.
                    if (now - _shuffleLastBetMs < 80) return;
                    _shuffleLastBetMs = now;
                    // Win/loss from inline background-color. Looks at the
                    // node itself OR a child button (Shuffle wraps results
                    // either way across deploys).
                    const target = node.querySelector('button') || node;
                    const bg = (target.style.backgroundColor || '').trim();
                    const isWinResult = bg.includes('61, 209, 121') || bg.includes('rgb(61,209,121)');
                    const betAmt = getCurrentBet() || minBaseBet;
                    if (initialBalance === 0) {
                        const curBal = getCurrentBalance();
                        if (curBal > 0) { initialBalance = curBal; sessionPeak = curBal; }
                    }
                    lastObservedBetTime = now;
                    rapidBlockedSince = 0;
                    totalBets++;
                    handleBetResult(isWinResult, betAmt);
                    applyShuffleIOWLogic(isWinResult);
                    updateUI();
                }
            }
        });
        obs.observe(feed, { childList: true });
    }
    function processNewBet(container) {
        const latestBet = getLatestBetEntry(container);
        if (!latestBet || latestBet.id === lastBetId) return;
        lastBetId = latestBet.id;
        lastObservedBetTime = Date.now();
        rapidBlockedSince = 0;
        totalBets++;
        const betAmt = getCurrentBet();
        const won = isWin(latestBet.element);
        handleBetResult(won, betAmt);
        if (ACTIVE_MODE === 'iow') {
            if (won) {
                lossStreak = 0;
                counter++;
                if (isRapidFiring) { const curBet = getCurrentBet(); let newBet = curBet * (1 + winIncreasePercent / 100);
                newBet = Math.min(newBet, maxBaseBet); setBet(newBet); }
                if (winsBeforeReset && counter >= winsBeforeReset) { counter = 0;
                triggerWinResetPulse(); if (isRapidFiring) setBet(baseBet); }
            } else {
                lossStreak++;
                if (lossStreak >= lossStreakReset) { counter = 0; if (isRapidFiring) setBet(baseBet);
                }
            }
            if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
        }
        updateUI();
    }
    function handleBetResult(isWinResult, betAmt) {
        try { if (typeof window.__iow_smart_handle_bet__ === "function") window.__iow_smart_handle_bet__(isWinResult, getCurrentBalance()); } catch (e) {}
        if (isWinResult) totalWins++;
        else totalLosses++;
        totalWagered += betAmt || minBaseBet;
        const currentProfit = getCurrentBalance() - initialBalance;
        if (currentProfit > highestProfit) highestProfit = currentProfit;
        profitHistory.push(currentProfit); if (profitHistory.length > MAX_GRAPH_POINTS) profitHistory.shift();
        if (isWinResult) {
            if (lastResult === false && curLossStreak > 0) { topLossStreaks.push(curLossStreak);
            topLossStreaks.sort((a,b)=>b-a); if (topLossStreaks.length > 10) topLossStreaks.pop(); }
            curWinStreak++;
            curLossStreak = 0; multWins++;
        } else {
            if (lastResult === true && curWinStreak > 0) { topWinStreaks.push(curWinStreak);
            topWinStreaks.sort((a,b)=>b-a); if (topWinStreaks.length > 10) topWinStreaks.pop(); }
            curLossStreak++;
            curWinStreak = 0;
        }
        lastResult = isWinResult;
        betHistory.push(isWinResult); recentWins.push(isWinResult);
        if (recentWins.length > 10) recentWins.shift();
        if (betHistory.length > historyWindow) betHistory.shift();
        multGames++;
        maxLossStreak = Math.max(maxLossStreak, curLossStreak);
        maxWinStreak = Math.max(maxWinStreak, curWinStreak);
        if (ACTIVE_MODE === 'smart' || ACTIVE_MODE === 'manual') {
            if (stopLossPct > 0 && currentProfit <= -initialBalance * (stopLossPct / 100)) autoPaused = true;
            if (takeProfitPct > 0 && currentProfit >= initialBalance * (takeProfitPct / 100)) autoPaused = true;
            if (autoPaused && isRapidFiring) stopRapidFire();
        }
        // Autostop on Balance — fires for every mode (Manual / IOW / Smart).
        // Previously this check was nested inside the IOW-only branch of the
        // bet handlers, so the input did nothing in Manual or Smart mode.
        if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
    }
    function startRapidFire() {
        try { if (typeof window.__iow_smart_snapshot_run__ === "function") window.__iow_smart_snapshot_run__(getCurrentBalance(), totalBets, totalWagered, totalWins, totalLosses, profitHistory.length, initialBalance, multGames, multWins); } catch (e) {}
        if (isRapidFiring) return;
        isRapidFiring = true;
        rapidBlockedSince = 0;
        rapidFireStartedAt = Date.now();
        lastObservedBetTime = 0;
        if (!isShuffle()) syncLastSeenBet();
        if (ACTIVE_MODE === 'iow') setBet(baseBet);
        if (ACTIVE_MODE === 'manual') setBet(manualBet);
        updateUI();
        if (isShuffle() || __isMobile()) {
            // Shuffle (always) and mobile Stake (no spacebar to dispatch):
            // poll every 150ms for an enabled play button and click it. The
            // button disables itself while the bet processes, so the poll
            // naturally rate-limits.
            spacePressInterval = setInterval(() => {
                if (!isRapidFiring) return;
                const btn = getPlayButton();
                if (btn && !btn.disabled) btn.click();
            }, 150);
            const btn = getPlayButton();
            if (btn && !btn.disabled) btn.click();
            return;
        }
        const keyDown = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true });
        document.dispatchEvent(keyDown);
        spacePressInterval = setInterval(() => {
            if (isRapidFiring) {
                const repeat = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true });
                document.dispatchEvent(repeat);
            }
        }, 42);
    }
    function stopRapidFire() {
        isRapidFiring = false;
        rapidBlockedSince = 0;
        rapidFireStartedAt = 0;
        lastObservedBetTime = 0;
        if (spacePressInterval) {
            clearInterval(spacePressInterval);
            spacePressInterval = null;
        }
        if (!isShuffle()) {
            const keyUp = new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true });
            document.dispatchEvent(keyUp);
        }
        updateUI();
    }
    function monitorRapidFireHealth() {
        if (!isRapidFiring) return;
        const now = Date.now();
        if (isShuffle()) {
            // Shuffle: click-chain driven. The button-disabled state is "bet
            // in progress" (normal) so we can't use it as a freeze indicator.
            // Stall safety: stop autoplay after RAPID_STALL_STOP_MS without a
            // new observed bet — matches Stake dice/limbo behavior so the bot
            // doesn't keep clicking when the site has stopped responding
            // (network freeze, balance gate, captcha, game-screen swap, etc.).
            const lastSeenBetTime = lastObservedBetTime || rapidFireStartedAt;
            if (lastSeenBetTime && now - lastSeenBetTime >= RAPID_STALL_STOP_MS) stopRapidFire();
            return;
        }
        const betBtn = getPlayButton();
        if (!betBtn || betBtn.disabled) {
            if (!rapidBlockedSince) rapidBlockedSince = now;
            if (now - rapidBlockedSince >= RAPID_BLOCKED_STOP_MS) stopRapidFire();
            return;
        }
        rapidBlockedSince = 0;
        const lastSeenBetTime = lastObservedBetTime || rapidFireStartedAt;
        if (lastSeenBetTime && now - lastSeenBetTime >= RAPID_STALL_STOP_MS) stopRapidFire();
    }
    function drawGraph() {
        const canvas = document.getElementById('h-custom-graph');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;
        ctx.clearRect(0, 0, width, height);
        if (profitHistory.length < 2) return;
        let maxVal = Math.max(...profitHistory, 0);
        let minVal = Math.min(...profitHistory, 0);
        const range = (maxVal - minVal) || 1;
        const padding = range * 0.15;
        maxVal += padding; minVal -= padding;
        const totalRange = maxVal - minVal;
        const zeroY = height - ((0 - minVal) / totalRange) * height;
        const zeroPct = Math.max(0, Math.min(1, zeroY / height));
        const lineGrad = ctx.createLinearGradient(0, 0, 0, height);
        lineGrad.addColorStop(0, '#00ff9d'); lineGrad.addColorStop(zeroPct, '#00ff9d');
        lineGrad.addColorStop(zeroPct, '#f87171'); lineGrad.addColorStop(1, '#f87171');
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(0, 255, 157, 0.2)');
        fillGrad.addColorStop(zeroPct, 'rgba(0, 255, 157, 0.2)'); fillGrad.addColorStop(zeroPct, 'rgba(248, 113, 113, 0.2)'); fillGrad.addColorStop(1, 'rgba(248, 113, 113, 0.2)');
        const stepX = width / (profitHistory.length - 1);
        ctx.beginPath();
        profitHistory.forEach((val, i) => {
            const x = i * stepX;
            const y = height - ((val - minVal) / totalRange) * height;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.lineTo(width, zeroY); ctx.lineTo(0, zeroY); ctx.closePath();
        ctx.fillStyle = fillGrad; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    /** Populate Multiplier Performance + Best/Worst Streaks for whichever
     *  mode is currently rendering them. Idempotent — silently skips any
     *  element id that's absent from the current HUD layout. */
    function populateAdvancedStats() {
        const perfEl = document.getElementById('h-mult-perf');
        if (perfEl && multWins > 0) {
            const actualRatio = multGames / multWins;
            const recentHit = recentWins.filter(Boolean).length;
            const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
            const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
            const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? '#00ff9d' : '#f87171') : 'inherit';
            perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
            perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? '#00ff9d' : '#f87171';
        }
        const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
        const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
        const bestWEl = document.getElementById('h-best-w');
        if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
        const worstLEl = document.getElementById('h-worst-l');
        if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
    }

    function updateUI() {
        const balance = getCurrentBalance();
        const profit = balance - initialBalance;
        const startBalEl = document.getElementById('h-start-bal'); if (startBalEl) startBalEl.textContent = initialBalance.toFixed(2);
        const profitEl = document.getElementById('h-profit');
        if (profitEl) { profitEl.textContent = profit.toFixed(2); profitEl.style.color = profit > 0 ?
        '#00ff9d' : (profit < 0 ? '#f87171' : '#fff'); }
        const peakBalEl = document.getElementById('h-peak-bal');
        if (peakBalEl) peakBalEl.textContent = sessionPeak.toFixed(2);
        const highProfitEl = document.getElementById('h-high-profit'); if (highProfitEl) highProfitEl.textContent = highestProfit.toFixed(2);
        const wageredEl = document.getElementById('h-wagered');
        if (wageredEl) wageredEl.textContent = totalWagered.toFixed(2);
        const rtp = totalWagered > 0 ?
        ((totalWagered + profit) / totalWagered) * 100 : 100;
        const rtpEl = document.getElementById('h-rtp');
        if (rtpEl) { rtpEl.textContent = rtp.toFixed(2) + '%'; rtpEl.style.color = rtp >= 100 ? '#00ff9d' : '#f87171';
        }
        const totalBetsEl = document.getElementById('h-total-bets'); if (totalBetsEl) totalBetsEl.textContent = totalBets;
        const wlEl = document.getElementById('h-wl'); if (wlEl) wlEl.innerHTML = `<span style="color:#00ff9d;">${totalWins}</span> / <span style="color:#f87171;">${totalLosses}</span>`;
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) {
            if (isRapidFiring) { rapidBtn.textContent = 'STOP';
            rapidBtn.className = 'hud-rapid-btn stop'; }
            else { rapidBtn.textContent = 'START';
            rapidBtn.className = 'hud-rapid-btn start'; }
        }
        if (ACTIVE_MODE === 'iow') {
            const targetEl = document.getElementById('h-target');
            if (targetEl) targetEl.innerHTML = `base bet: ${baseBet.toFixed(2)} | Wins: <span style="color:#00ff9d">${counter}</span> | LossStreak: <span style="color:#f87171">${lossStreak}</span>`;
            populateAdvancedStats();
        } else if (ACTIVE_MODE === 'smart') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:#00ff9d;">${curWinStreak}/${maxWinStreak}</span> | <span style="color:#f87171;">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const perfEl = document.getElementById('h-mult-perf');
            if (perfEl && multWins > 0) {
                const actualRatio = multGames / multWins;
                const recentHit = recentWins.filter(Boolean).length;
                const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
                const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
                const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? '#00ff9d' : '#f87171') : 'inherit';
                perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
                perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? '#00ff9d' : '#f87171';
            }
            const winsCount = betHistory.filter(Boolean).length;
            const progress = winsNeeded > 0 ? winsCount / winsNeeded : 0;
            let gear = 1;
            let label = 'Gear 1 (Cold)';
            if (lockAggressionState) {
                gear = lockedGearLevel;
                if (gear === 1) { label = 'Conservative (LOCKED)'; }
                else if (gear === 2) { label = 'Steady (LOCKED)';
                }
                else if (gear === 3) { label = 'Balanced (LOCKED)';
                }
                else if (gear === 4) { label = 'Press (LOCKED)';
                }
                else { gear = 5;
                label = 'Aggro (LOCKED)'; }
            } else {
                if (progress <= 0.4) { gear = 1;
                label = 'Conservative'; }
                else if (progress <= 0.8) { gear = 2;
                label = 'Steady'; }
                else if (progress <= 1.1) { gear = 3;
                label = 'Balanced'; }
                else if (progress <= 1.45) { gear = 4;
                label = 'Press'; }
                else { gear = 5;
                label = 'Aggro'; }
            }
            const stateEl = document.getElementById('h-state');
            if (stateEl) { stateEl.textContent = label; stateEl.className = `hud-val gear-text gear-${gear}-text`;
            }
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w');
            if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            const targetMult = getUserSetMultiplier();
            if (targetEl) {
                let txt = `Target: ${targetMult.toFixed(2)}x`;
                if (autoPaused) { targetEl.style.color = '#f87171'; txt = 'PAUSED - THRESHOLD TRIGGERED'; } else { targetEl.style.color = '#b1bad3';
                }
                targetEl.innerHTML = txt;
            }
        } else if (ACTIVE_MODE === 'manual') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:#00ff9d;">${curWinStreak}/${maxWinStreak}</span> | <span style="color:#f87171;">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            populateAdvancedStats();
            const targetEl = document.getElementById('h-target');
            if (targetEl) {
                targetEl.textContent = isRapidFiring ?
                '' : '';
                targetEl.style.color = isRapidFiring ? '#00ff9d' : '#b1bad3';
            }
        }
        drawGraph();
        try { if (typeof window.__iow_smart_publish__ === "function") window.__iow_smart_publish__(getCurrentBalance(), initialBalance, sessionPeak, highestProfit, totalWagered, totalWins, totalLosses, totalBets, curWinStreak, maxWinStreak, curLossStreak, maxLossStreak, topWinStreaks, topLossStreaks, profitHistory, isRapidFiring, multGames, multWins, trackedMultiplier); } catch (e) {}
    }
    function updateBetAmount() {
        if (ACTIVE_MODE !== 'smart') return;
        // While the user is in the Advanced IOW mode (cross-tool integration
        // owns the bet field via the dice tool's strategy editor), do NOT
        // overwrite the wager input. ACTIVE_MODE stays 'smart' here because
        // the injected Advanced IOW button is added by the integration and
        // doesn't go through switchMode(), so the integration signals via
        // a data attribute on the HUD root.
        const hudRoot = document.getElementById('ratchet-master-container');
        if (hudRoot && hudRoot.dataset.toolsActive === '1') return;
        // Platform-aware wager input: Stake uses #input-game-amount; Shuffle
        // uses #bet-amount. Without this, Smart never wrote a bet on Shuffle.
        const input = isShuffle()
            ? document.querySelector('input[data-testid="bet-amount"]')
            : document.querySelector('input[data-testid="input-game-amount"]');
        const balance = getCurrentBalance();
        if (!input || !balance) return;
        if (initialBalance === 0) initialBalance = balance;
        sessionPeak = Math.max(sessionPeak, balance);
        const currentMult = getUserSetMultiplier();
        if (currentMult !== trackedMultiplier) { trackedMultiplier = currentMult; multGames = 0;
        multWins = 0; recentWins = []; }
        const wins = betHistory.filter(Boolean).length;
        let progress = winsNeeded > 0 ? wins / winsNeeded : 0;
        if (lockAggressionState) {
            if (lockedGearLevel === 1) progress = 0.2;
            else if (lockedGearLevel === 2) progress = 0.6;
            else if (lockedGearLevel === 3) progress = 0.95;
            else if (lockedGearLevel === 4) progress = 1.3;
            else if (lockedGearLevel === 5) progress = 1.6;
        }
        const baseWindow = 30 + Math.round(trackedMultiplier * 8);
        const baseDivisor = 300 + Math.round(trackedMultiplier * 6);
        historyWindow = Math.max(5, Math.round(baseWindow / aggressionLevel));
        safeDivisor = Math.max(15, Math.round(baseDivisor / aggressionLevel));
        winsNeeded = Math.max(1, Math.floor(historyWindow / (trackedMultiplier * 0.8)));
        aggressiveDivisor = Math.max(1, Math.round(safeDivisor * (0.6 / aggressionLevel)));
        const dynamicDivisor = safeDivisor - ((safeDivisor - aggressiveDivisor) * Math.min(1, progress / 1.5));
        let targetBet = (sessionPeak / dynamicDivisor) * aggressionLevel;
        const maxBetPct = Math.min(0.18, 0.05 + aggressionLevel * 0.04);
        targetBet = Math.max(minBaseBet, Math.min(targetBet, balance * maxBetPct));
        const betStr = targetBet.toFixed(2);
        if (betStr !== lastAmount) {
            lastAmount = betStr;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, betStr);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    function startObserverWrapper() {
        if (isShuffle()) {
            // Two parallel observers on Shuffle:
            //   - startShuffleObserver: watches active-currency balance text
            //     (catches every bet but throttled to 400ms intervals).
            //   - startShuffleFeedObserver: watches the recent-results feed
            //     (per-bet, reliable, no rate limiting).
            // The 80ms dedup in the feed observer prevents double-counting
            // when both fire for the same bet.
            startShuffleObserver();
            startShuffleFeedObserver();
            return;
        }
        if (!pastBetsContainer || !pastBetsContainer.isConnected) {
            if (observer) observer.disconnect();
            startObserver();
        }
    }
    setInterval(() => {
        // URL guard: SPA navigation (e.g. dice → mines) keeps this interval
        // alive even though we're no longer on a supported game. Stop any
        // running autoplay, tear down the HUD, and skip the rest of this tick
        // so we don't accidentally write bet amounts into a different game.
        if (!isOnSupportedGamePage()) {
            const existing = document.getElementById('ratchet-master-container');
            if (existing) existing.remove();
            try { if (typeof isRapidFiring !== 'undefined' && isRapidFiring) stopRapidFire(); } catch (e) {}
            return;
        }
        buildHUD();
        syncNativeHudElements();
        clampHUDAboveShuffleFooter();
        updateDiceInfoPanel();
        const bal = getCurrentBalance();
        if (bal > 0.01) {
            if (initialBalance === 0) initialBalance = bal;
            sessionPeak = Math.max(sessionPeak, bal);
            lastKnownBalance = bal;

        }
        // Autostop on Balance — read every tick regardless of mode so the
        // Manual / IOW / Smart inputs all stay synced with autoStopBalance.
        {
            const autostopEl = document.getElementById('h-autostop');
            if (autostopEl) {
                const v = parseFloat(autostopEl.value);
                autoStopBalance = !isNaN(v) && v > 0 ? v : null;
            }
        }
        // Periodic safety check — also catches the case where balance ticked
        // past the target between observed bets, or where a bet-result event
        // got missed. Runs for every mode.
        if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) {
            stopRapidFire();
        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseBet = parseFloat(baseInp.value) || minBaseBet;
            const winIncEl = document.getElementById('h-win-inc'); if (winIncEl) winIncreasePercent = parseFloat(winIncEl.value) || 125;
            const lossResetEl = document.getElementById('h-loss-reset'); if (lossResetEl) lossStreakReset = parseInt(lossResetEl.value, 10) || 3;
            const winsResetEl = document.getElementById('h-wins-reset');
        if (winsResetEl) winsBeforeReset = parseInt(winsResetEl.value, 10) || null;
        }
        if (ACTIVE_MODE === 'manual') {
            // Keep manualBet synced from the HUD input so any user edits
            // (typing, paste) take effect even if the input listener missed
            // an event.
            const manualInp = document.getElementById('h-manual-bet');
            if (manualInp) {
                const v = parseFloat(manualInp.value);
                if (isFinite(v) && v >= minBaseBet) manualBet = v;
            }
        }
        updateUI();
        startObserverWrapper();
        monitorRapidFireHealth();
        if (ACTIVE_MODE === 'smart') updateBetAmount();
    }, 500);
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key.toLowerCase() === 'r') resetStats();
        if (ACTIVE_MODE === 'smart') {
            if (e.key === ']' || e.key === '[') {
                if (!lockAggressionState) {

                    lockAggressionState = true;
                    const chk = document.getElementById('h-lock-agg-chk');
                    if (chk) chk.checked = true;
                    const sel = document.getElementById('h-lock-gear-sel');

                    if (sel) sel.disabled = false;
                }
                if (e.key === ']') lockedGearLevel = Math.min(5, lockedGearLevel + 1);
                if (e.key === '[') lockedGearLevel = Math.max(1, lockedGearLevel - 1);
                const gearSel = document.getElementById('h-lock-gear-sel');

                 if (gearSel) gearSel.value = lockedGearLevel;
                updateUI();
            }
        }
    });
    setTimeout(() => { buildHUD(); startObserver(); }, 800);

    try {
        window.__iow_smart_start__ = startRapidFire;
        window.__iow_smart_stop__ = stopRapidFire;
        window.__iow_smart_reset__ = resetStats;
        window.__iow_smart_is_running__ = function () { return isRapidFiring; };
        window.__iow_smart_baseline_now__ = function () {
            try { if (typeof window.__iow_smart_snapshot_run__ === "function") window.__iow_smart_snapshot_run__(getCurrentBalance(), totalBets, totalWagered, totalWins, totalLosses, profitHistory.length, initialBalance, multGames, multWins); } catch (e) {}
        };
    } catch (e) {}

    }

    /* === source: stake-shuffle-dice-tool-desktop.user.js === */
    function tool_dice_tool() {
        'use strict';
/* =========================================================
       STATE & CONSTANTS
       ========================================================= */
    const STORE_KEY = 'dice_tool_aio_desktop_state_v1';
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
            balance_target: $('out_target').value,
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
  top: 90px;
  right: 16px;
  z-index: 2147483646;
  width: 48px; height: 48px;
  border-radius: 50%;
  background: var(--dt-bg);
  border: 2px solid var(--dt-border);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5), 0 0 10px color-mix(in srgb, var(--dt-border) 40%, transparent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--dt-label-fg);
  user-select: none;
  -webkit-user-select: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  padding: 0;
}
#${BUTTON_ID}:hover { transform: scale(1.06); }
#${BUTTON_ID}:active { transform: scale(0.92); }

/* Backdrop when panel is open (lighter than mobile; desktop users expect to click-through) */
#dt-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.25);
  z-index: 2147483645;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
#dt-backdrop.show {
  opacity: 1;
  pointer-events: auto;
}

/* The panel itself — desktop right-side drawer.
   NOTE: z-index is intentionally one lower than #dt-tooltip / #dt-toast
   so tooltips pop in front of the panel instead of behind it. */
#${PANEL_ID} {
  position: fixed;
  top: 50%;
  right: 16px;
  transform: translate(120%, -50%);
  width: 1020px;
  max-width: calc(100vw - 32px);
  height: 90vh;
  max-height: 900px;
  z-index: 2147483646;
  background: var(--dt-bg);
  color: var(--dt-fg);
  border: 2px solid var(--dt-border);
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
  opacity: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  font-size: calc(14px * var(--dt-font-scale));
  line-height: 1.5;
}
#${PANEL_ID}.show { transform: translate(0, -50%); opacity: 1; pointer-events: auto; }
#${PANEL_ID} * { box-sizing: border-box; }

/* Panel header — draggable */
#${PANEL_ID} .dt-head {
  position: relative;
  padding: 10px 44px 10px 16px;
  text-align: center;
  flex-shrink: 0;
  border-bottom: 1px solid var(--dt-border);
  cursor: move;
  -webkit-user-select: none;
  user-select: none;
  background: color-mix(in srgb, var(--dt-bg) 92%, black 8%);
  border-radius: 10px 10px 0 0;
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
  top: 6px; right: 8px;
  width: 28px; height: 28px;
  border: none;
  background: transparent;
  color: var(--dt-fg);
  font-size: 20px;
  font-weight: 700;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
#${PANEL_ID} .dt-close:hover { background: var(--dt-field-bg); }

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
  padding: 5px 6px;
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

/* Tabs — top-positioned for desktop */
#${PANEL_ID} .dt-tabs {
  display: flex;
  background: var(--dt-button-bg);
  border-bottom: 1px solid var(--dt-border);
  flex-shrink: 0;
}
#${PANEL_ID} .dt-tab-btn {
  flex: 1;
  padding: 10px 6px;
  background: transparent;
  border: none;
  color: var(--dt-fg);
  font-size: 0.82em;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-family: inherit;
  -webkit-user-select: none; user-select: none;
  transition: background 0.12s, color 0.12s;
}
#${PANEL_ID} .dt-tab-btn:hover { background: var(--dt-field-bg); }
#${PANEL_ID} .dt-tab-btn .dt-tab-icon { font-size: 1.1em; line-height: 1; }
#${PANEL_ID} .dt-tab-btn.active {
  color: var(--dt-label-fg);
  background: var(--dt-bg);
  border-bottom-color: var(--dt-label-fg);
}

/* Toast */
#dt-toast {
  position: fixed;
  left: 50%;
  top: 24px;
  transform: translateX(-50%) translateY(-20px);
  background: var(--dt-bg, #3f3f3f);
  color: var(--dt-fg, #17c7b8);
  border: 1px solid var(--dt-border, #249f87);
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 0.9em;
  max-width: 600px;
  text-align: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s, transform 0.2s;
  z-index: 2147483647;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  font-family: -apple-system, 'Segoe UI', sans-serif;
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

/* Streak Counter HUD — always-visible draggable widget */
#${COUNTER_ID} {
  --dt-bg: #1a1a1a;
  --dt-fg: #ffffff;
  --dt-label-fg: #17c7b8;
  --dt-border: #249f87;
  --dt-danger: #e74c3c;
  position: fixed;
  top: 150px;
  right: 16px;
  z-index: 2147483644;
  background: var(--dt-bg);
  color: var(--dt-fg);
  border: 2px solid var(--dt-border);
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.5), 0 0 10px color-mix(in srgb, var(--dt-border) 30%, transparent);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  user-select: none;
  -webkit-user-select: none;
  padding: 8px 10px;
  min-width: 180px;
  max-width: 220px;
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
              <h2 class="dt-title">Dice Tool</h2>
              <button class="dt-close" id="dt-close-btn" aria-label="Close">×</button>
            </div>
            <nav class="dt-tabs" role="tablist">
              <button class="dt-tab-btn active" data-tab="calc"><span class="dt-tab-icon">🎲</span>Calculator</button>
              <button class="dt-tab-btn" data-tab="opt"><span class="dt-tab-icon">⚙️</span>Optimizer</button>
              <button class="dt-tab-btn" data-tab="results"><span class="dt-tab-icon">📊</span>Results</button>
              <button class="dt-tab-btn" data-tab="settings"><span class="dt-tab-icon">🛠</span>Settings</button>
            </nav>
            <div class="dt-body">
              ${buildCalcPanel()}
              ${buildOptPanel()}
              ${buildResultsPanel()}
              ${buildSettingsPanel()}
            </div>
        `;
        document.body.appendChild(panel);
    }

    /* ---- Helper: field with ? tooltip ----
       Uses <span class="dt-label"> instead of <label> for consistency with
       the mobile AIO (where nested <button> + <label> broke tooltips on iOS). */
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
                <div style="opacity:0.7;">AiO 2.0 (Desktop)</div>
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
            const balanceTarget = v.balance_target;
            // Condition 4 is "On Balance ≥ Balance Target → Stop autoplay", so
            // the value we write into its threshold input is Balance Target
            // (not Profit Stop, which lives elsewhere).
            if (!betSize || !balanceTarget || betSize === 'Invalid' || balanceTarget === 'Invalid') { toast('Missing bet_size or balance_target.'); return; }
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
            if (inputs[0]) setNativeValue(inputs[0], balanceTarget);
            const closed = await closeStrategyPopup_shuffle();
            toast(closed ? 'Strategy updated & saved.' : 'Strategy updated — close the popup manually.');
        } catch (err) { toast('Update failed: ' + err); console.error(err); }
    }
    async function shuffle_importNew() {
        try {
            const v = currentCalcValues();
            const { bet_size, profit_stop, balance_target, multiplier, win_increase, loss_reset } = v;
            if (bet_size === 'Invalid' || profit_stop === 'Invalid' || balance_target === 'Invalid') { toast('Calculator values invalid.'); return; }
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
            // "Get Started" auto-creates Condition 1, so 4 adds yields 5
            // total conditions. We configure 1-4 below, then delete the
            // empty Condition 5 at the end.
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
                    // Net-Gain Condition: On Balance, ≥ Balance Target, Do
                    // Stop autoplay. Bubble-radio index 1 (selected via the
                    // targetRadioIndex logic above) puts us in Net Gain mode.
                    setSelectValue(selects[0], 'balance');
                    setSelectValue(selects[1], 'greaterThanOrEqualTo');
                    setNativeValue(inputs[0], balance_target);
                    setSelectValue(selects[2], 'stopAutobet');
                }
                await sleep(400);
            }

            // Delete the leftover empty Condition 5 — "Get Started" pre-creates
            // Condition 1, so 4 adds total 5 conditions. Locate it by index
            // among AdvancedDiceCondition_root elements; expand it if needed,
            // then click whatever delete-style button lives inside.
            try {
                await sleep(400);
                const allConds = document.querySelectorAll('.AdvancedDiceCondition_root__CaIQo');
                const cond5 = allConds[4];
                if (cond5) {
                    const header5 = cond5.querySelector('.AdvancedDiceCondition_header__jDZzw');
                    if (header5) { header5.click(); await sleep(400); }
                    const del = cond5.querySelector('button[aria-label*="delete" i]')
                             || cond5.querySelector('button[aria-label*="remove" i]')
                             || cond5.querySelector('button[title*="delete" i]')
                             || [...cond5.querySelectorAll('button')].find(b => /^(Delete|Remove|×)$/i.test((b.textContent||'').trim()))
                             || cond5.querySelector('svg[class*="trash" i], svg[class*="delete" i], svg[class*="remove" i]')?.closest('button');
                    if (del) {
                        del.click();
                        await sleep(400);
                    }
                }
            } catch (e) { console.warn('[shuffle_importNew] Condition 5 cleanup skipped:', e); }

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
            const balanceTarget = v.balance_target;
            // Condition 4 is "On Balance ≥ Balance Target → Stop autoplay", so
            // the value we write into its threshold input is Balance Target
            // (not Profit Stop, which lives elsewhere).
            if (!betSize || !balanceTarget || betSize === 'Invalid' || balanceTarget === 'Invalid') { toast('Missing bet_size or balance_target.'); return; }
            const betInput = await waitFor('input[data-testid="input-game-amount"]');
            betInput.value = betSize; trigger(betInput);
            const cond4BlockBtn = await waitFor('button[data-testid="block-condition-4"]');
            cond4BlockBtn.click();
            await sleep(600);
            const editBtn = document.querySelector('button[data-testid="conditional-block-edit-condition-4"]');
            if (editBtn) { editBtn.click(); await sleep(600); }
            const amountInput = await waitFor('input[data-testid="condition-profit-amount-input"]');
            amountInput.value = balanceTarget; trigger(amountInput);
            const closed = await closeStrategyPopup_stake();
            toast(closed ? 'Strategy updated & saved.' : 'Strategy updated — close the popup manually.');
        } catch (err) { toast('Update failed: ' + err); console.error(err); }
    }
    async function stake_importNew() {
        try {
            const v = currentCalcValues();
            const { bet_size, profit_stop, balance_target, multiplier, win_increase, loss_reset } = v;
            if (bet_size === 'Invalid' || profit_stop === 'Invalid' || balance_target === 'Invalid') { toast('Calculator values invalid.'); return; }
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
            // "Get Started" auto-creates Condition 1, so 4 adds yields 5
            // total conditions. We configure 1-4 below, then delete the
            // empty Condition 5 at the end.
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
            // Net-Gain Condition: On Balance, ≥ Balance Target, Do Stop autoplay.
            // The "condition-type-radio-profit" label drives the Net Gain
            // bubble; the "condition-profit-type" select then chooses what
            // we're gating on — Balance here (not Profit), with the target
            // being the calculator's Balance Target output.
            const profitRadio4 = await waitFor('label[data-testid="condition-type-radio-profit"]');
            profitRadio4.click(); await sleep(300);
            sel = await waitFor('select[data-testid="condition-profit-type"]');
            sel.value = 'balance'; trigger(sel);
            sel = await waitFor('select[data-testid="condition-profit-term-type-options"]');
            sel.value = 'greaterThanOrEqualTo'; trigger(sel);
            inp = await waitFor('input[data-testid="condition-profit-amount-input"]');
            inp.value = balance_target; trigger(inp);
            sel = await waitFor('select[data-testid="condition-action-options"]');
            sel.value = 'stop'; trigger(sel);
            await sleep(400);

            // Delete the leftover empty Condition 5 — the loop above always
            // adds 4 (Stake's "Get Started" pre-creates Condition 1, so total
            // becomes 5). Find Condition 5's delete button (only appears when
            // the condition is expanded); if Condition 5 isn't open yet, open
            // it via its edit pencil first.
            try {
                let del5 = document.querySelector('button[data-testid="conditional-block-delete-condition-5"]');
                if (!del5) {
                    const editBtn5 = document.querySelector('button[data-testid="conditional-block-edit-condition-5"]')
                                  || document.querySelector('button[data-testid="block-condition-5"]');
                    if (editBtn5) {
                        editBtn5.click();
                        await sleep(500);
                        del5 = document.querySelector('button[data-testid="conditional-block-delete-condition-5"]');
                    }
                }
                if (del5) {
                    del5.click();
                    await sleep(400);
                }
            } catch (e) { console.warn('[stake_importNew] Condition 5 cleanup skipped:', e); }

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
    /* Combined one-click flow: scrape balance → recompute → push new bet size
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
        // Win sound is scoped to Advanced IOW mode only. If the IOW/Smart HUD
        // exists on the page but the user isn't in Advanced IOW (toolsActive
        // flag absent), silently skip — Manual / IOW / Smart modes should
        // never trigger the win beep. When the HUD doesn't exist at all (e.g.
        // standalone primedice), the beep behaves as before.
        const hud = document.getElementById('ratchet-master-container');
        if (hud && hud.dataset.toolsActive !== '1') return;
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
       DRAGGABLE FLOATING BUTTON (desktop: click or drag-to-reposition)
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
        btn.addEventListener('mousedown', e => { if (e.button === 0) begin(e.clientX, e.clientY); });
        document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
        document.addEventListener('mouseup', end);
    }

    /* =========================================================
       DRAGGABLE PANEL HEADER (desktop: click-drag the title bar to move)
       ========================================================= */
    function setupPanelDrag(panel) {
        const head = panel.querySelector('.dt-head');
        if (!head) return;
        let dragging = false;
        let startX = 0, startY = 0, panelStartLeft = 0, panelStartTop = 0;
        head.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.dt-close')) return;
            const rect = panel.getBoundingClientRect();
            panelStartLeft = rect.left;
            panelStartTop = rect.top;
            startX = e.clientX;
            startY = e.clientY;
            dragging = true;
            // Switch from right/transform positioning to absolute left/top while dragging
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const w = panel.offsetWidth, h = panel.offsetHeight;
            let nx = Math.max(4, Math.min(panelStartLeft + dx, window.innerWidth - w - 4));
            let ny = Math.max(4, Math.min(panelStartTop + dy, window.innerHeight - h - 4));
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
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

        // Tab delegation
        const tabsNav = document.getElementById(PANEL_ID).querySelector('.dt-tabs');
        tabsNav.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.dt-tab-btn');
            if (!btn) return;
            ev.preventDefault();
            switchTab(btn.dataset.tab);
        });

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

        // Make the panel draggable by its header
        setupPanelDrag(document.getElementById(PANEL_ID));

        // Initial render
        renderResults();
    }

    // Run when DOM is ready (document-end generally means body is present, but be safe)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }


    }

    /* === source: stake-keno-desktop.user.js === */
    function tool_stake_keno() {
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
            <span class="kp-title">Stake Keno</span>
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

    // Track user clicks on tiles in capture phase — toggles our authoritative
    // pick set. Works for both real taps and programmatic clicks from applyPreset.
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

    // Watch for selection / risk changes on the page. The grid element gets
    // destroyed and recreated when the user SPA-navigates away from /keno
    // and back, so we run a persistent attach loop that re-binds whenever
    // the grid identity changes — keeps "Current picks" in sync across
    // unlimited route changes without an F5.
    const observer = new MutationObserver(() => renderCurrent());
    let _observedGrid = null;
    let _observedRisk = null;
    function attachObserver() {
        const grid = document.querySelector('[data-testid="game-keno"]');
        if (grid && grid !== _observedGrid) {
            observer.disconnect();
            observer.observe(grid, { attributes: true, subtree: true, attributeFilter: ['data-selected', 'class'] });
            _observedGrid = grid;
        }
        const risk = document.querySelector(RISK_SELECTOR);
        if (risk && risk !== _observedRisk) {
            if (_observedRisk) _observedRisk.removeEventListener('change', renderCurrent);
            risk.addEventListener('change', renderCurrent);
            _observedRisk = risk;
        }
    }
    // Persistent attach loop. Cheap — only re-binds when the grid element
    // identity changes (initial mount + every SPA navigation that swaps the
    // grid). Re-syncs picks and re-renders the UI on each re-bind.
    setInterval(() => {
        const grid = document.querySelector('[data-testid="game-keno"]');
        if (!grid || !getTiles().length) return;
        if (grid !== _observedGrid) {
            syncPicksFromDOM();
            attachObserver();
            renderCurrent();
        } else {
            attachObserver();
        }
    }, 500);

    renderPresets();
    renderCurrent();

    }

    /* === source: stake-mines-desktop.user.js === */
    function tool_stake_mines() {
        'use strict';
let isRunning = false;

    const gui = document.createElement('div');
    gui.id = 'mines-auto-gui';
    gui.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        background: #0f212e; color: #b1bad3; padding: 14px;
        border-radius: 10px; border: 1px solid #2f4553;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-width: 230px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        cursor: move; user-select: none; transition: box-shadow 0.3s ease;
    `;
    gui.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 10px; text-align: center; color: #f8fafc; font-size: 13px; letter-spacing: 0.3px;">
            Stake Mines
        </div>
        <div style="display: flex; align-items: center; margin: 6px 0;">
            <label style="flex: 1; color: #94a3b8; font-size: 12px; font-weight: 600;">Min:</label>
            <input id="minPicks" type="number" value="3" min="1" max="24" style="width: 64px; padding: 5px 6px; border: 1px solid #2f4553; border-radius: 4px; background: #1a2c38; color: #f5fbff; font-weight: 600; text-align: center; outline: none;">
        </div>
        <div style="display: flex; align-items: center; margin: 6px 0;">
            <label style="flex: 1; color: #94a3b8; font-size: 12px; font-weight: 600;">Max:</label>
            <input id="maxPicks" type="number" value="8" min="1" max="24" style="width: 64px; padding: 5px 6px; border: 1px solid #2f4553; border-radius: 4px; background: #1a2c38; color: #f5fbff; font-weight: 600; text-align: center; outline: none;">
        </div>
        <div style="margin: 12px 0 6px; text-align: center; display: flex; gap: 8px; justify-content: center;">
            <button id="btnStart" style="flex: 1; background: #1fff20; color: #0f212e; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 800; cursor: pointer; transition: background 0.18s, transform 0.15s; font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase;">
                Start
            </button>
            <button id="btnStop" style="flex: 1; background: #ef4444; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 800; cursor: pointer; display: none; transition: background 0.18s, transform 0.15s; font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase;">
                Stop
            </button>
        </div>
        <div id="status" style="font-size: 11px; color: #94a3b8; text-align: center; min-height: 1.2em; margin-top: 4px;"></div>
        <div style="margin-top: 12px; border-top: 1px solid #2f4553; padding-top: 10px;">
            <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #1fff20; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;">
                Live Stats
            </div>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Multiplier:</span><span id="mult" style="font-weight: 700; color: #f5fbff;">—</span></p>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Payout:</span><span id="pout" style="font-weight: 700; color: #f5fbff;">—</span></p>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Next Gem:</span><span id="chance" style="font-weight: 700; color: #f5fbff;">—</span></p>
        </div>
        <div style="margin-top: 8px; border-top: 1px solid #2f4553; padding-top: 10px;">
            <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #1fff20; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;">
                Projected Range
            </div>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Min Mult:</span><span id="minMult" style="font-weight: 700; color: #1fff20;">—</span></p>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Max Mult:</span><span id="maxMult" style="font-weight: 700; color: #1fff20;">—</span></p>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Min Payout:</span><span id="minPayout" style="font-weight: 700; color: #1fff20;">—</span></p>
            <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #94a3b8;">Max Payout:</span><span id="maxPayout" style="font-weight: 700; color: #1fff20;">—</span></p>
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

    let isDragging = false, currentX, currentY, initialX, initialY;
    gui.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
        initialX = e.clientX - currentX;
        initialY = e.clientY - currentY;
        isDragging = true;
        gui.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;
        gui.style.left = currentX + 'px';
        gui.style.top = currentY + 'px';
        gui.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        isDragging = false;
        gui.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
    });

    currentX = window.innerWidth - gui.offsetWidth - 30;
    currentY = 40;
    gui.style.left = currentX + 'px';
    gui.style.top = currentY + 'px';

    const status = document.getElementById('status');

    // Tight, fixed polling cadence — the bot is now fully event-driven via
    // waitFor() on the DOM, so the speed slider's per-step "factor" math is
    // gone. 15ms gives us ~66 readiness checks per second; faster than that
    // doesn't help because Stake's React tree updates aren't synchronous.
    const POLL_INTERVAL_MS = 15;
    // Pause after a successful cashout so the user can see the multiplier
    // their round hit before the bot starts the next one. Loss rounds skip
    // this — Play is clicked the instant it becomes available.
    const POST_WIN_PAUSE_MS = 500;

    function setStatus(txt, color = '#a0a0a0') {
        status.textContent = txt;
        status.style.color = color;
    }

    async function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /** Spin-wait for a predicate to become true, polling every POLL_INTERVAL_MS.
     *  Bails early when the bot stops. Returns true on success, false on timeout. */
    async function waitFor(predicate, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!isRunning) return false;
            try { if (predicate()) return true; } catch (e) {}
            await delay(POLL_INTERVAL_MS);
        }
        return false;
    }

    /** True when the native Play (bet) button is present and clickable. */
    function isPlayReady() {
        const el = document.querySelector('[data-testid="bet-button"]');
        return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    }

    /** True when the native Cashout button is present and clickable. */
    function isCashoutReady() {
        const el = document.querySelector('[data-testid="cashout-button"]');
        return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    }

    function clickPlay() {
        const el = document.querySelector('[data-testid="bet-button"]');
        // Treat a disabled bet button as "not clickable" so the waiting
        // loop can actually time out when the user is out of balance.
        // (Previously this returned true even on a disabled button,
        // causing the bot to silently spin forever and snap back into
        // action the moment balance was replenished — the safety bug.)
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        el.click();
        return true;
    }

    function clickCashout() {
        const el = document.querySelector('[data-testid="cashout-button"]');
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        el.click();
        return true;
    }

    /** Click a random idle tile AND wait for its status to transition out of
     *  "idle" before returning. This serializes tile clicks against React's
     *  state machine — the previous "out-of-sync" hangs were caused by
     *  firing all picks in one tight synchronous loop, where some clicks
     *  landed before React had updated the tile's data-status, so subsequent
     *  clicks targeted tiles that were no longer actually idle.
     *
     *  Returns { ok, busted }:
     *    ok=false → no idle tiles available (board exhausted)
     *    busted=true → the picked tile turned into a mine; round is over
     *    busted=false → tile turned into a gem; round continues */
    async function clickRandomTileAndWait() {
        const idleButtons = document.querySelectorAll('button[data-game-tile-status="idle"]');
        if (idleButtons.length === 0) return { ok: false, busted: false };
        const randomIdx = Math.floor(Math.random() * idleButtons.length);
        const tile = idleButtons[randomIdx];
        tile.click();
        // Block until React updates the tile (gem reveal / mine flip). Cap at
        // 600ms — beyond that something else is wrong; move on rather than
        // freezing the whole loop on a single stuck tile.
        await waitFor(() => tile.getAttribute('data-game-tile-status') !== 'idle', 600);
        const finalStatus = (tile.getAttribute('data-game-tile-status') || '').toLowerCase();
        return { ok: true, busted: finalStatus.indexOf('mine') >= 0 };
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
        setStatus('Running');
        // Safety kill switch: if the bet button stays unavailable for too long
        // (typically because balance is depleted), kill the bot instead of
        // silently spinning. Without this, the bot would resume automatically
        // the moment funds reappeared — including hours/days later from a
        // forgotten session.
        const playReadyStart = Date.now();
        const MAX_WAIT_MS = 20000;  // 20s — plenty for a normal between-round pause
        if (!await waitFor(isPlayReady, MAX_WAIT_MS)) {
            // Distinguish "never appeared in time" (safety kill) from "user
            // stopped the bot" (normal exit). Bot already exited if !isRunning.
            if (isRunning && Date.now() - playReadyStart >= MAX_WAIT_MS) {
                setStatus('Stopped — out of balance', '#ef4444');
                stopBot();
            }
            return;
        }
        if (!isRunning) return;

        if (!clickPlay()) {
            // Race: button was ready a tick ago, gone now. Just retry next loop.
            await delay(100);
            return;
        }

        // Wait for the round to actually start — Stake transitions tiles into
        // the "idle" state once the bet is placed. Skip the previous static
        // 380–820ms post-Play delay in favor of "as soon as idle tiles
        // appear, start clicking." At max speed this is typically <100ms.
        if (!await waitFor(
            () => document.querySelectorAll('button[data-game-tile-status="idle"]').length > 0,
            2500
        )) {
            return;
        }

        const min = parseInt(document.getElementById('minPicks').value) || 3;
        const max = parseInt(document.getElementById('maxPicks').value) || 12;
        const picks = weightedRandom(min, max);
        setStatus(`Picking ${picks} tiles`);

        let busted = false;
        for (let i = 0; i < picks; i++) {
            if (!isRunning) return;
            const result = await clickRandomTileAndWait();
            if (!result.ok) {
                break;
            }
            if (result.busted) {
                // Bust detected on the picked tile. Stake removes the cashout
                // button and re-enables Play almost immediately — short-circuit
                // straight to the next round instead of wasting time on the
                // 3-second waitFor(isCashoutReady).
                busted = true;
                setStatus('Busted');
                break;
            }
        }
        if (!isRunning) return;

        if (busted) {
            // Loss path — no delay. Return immediately; the next iteration's
            // waitFor(isPlayReady) will catch Play the moment Stake re-enables
            // it (typically within one or two poll cycles of the mine reveal).
            return;
        }

        // Win path — wait for whichever round-end signal Stake exposes:
        //   cashout button → normal win, click it
        //   play button    → we somehow busted without the tile-status check
        //                    catching it (rare race); fall through and let the
        //                    next iteration handle clickPlay.
        // The two are mutually exclusive in Stake's DOM (verified live: the
        // bet-button testid doesn't even exist mid-round), so polling for
        // "cashout OR play" reliably tells us the round has settled.
        if (!await waitFor(() => isCashoutReady() || isPlayReady(), 3000)) {
            // Neither surfaced in 3s — weird state, but the 20s Play wait at
            // the top of the next iteration will recover us if Stake settles.
            return;
        }
        if (!isRunning) return;
        if (isCashoutReady()) {
            clickCashout();
            setStatus('Cashed out');
            // Brief pause so the user can read the multiplier popup before
            // the next round starts. Skipped on loss/missed-bust path.
            await delay(POST_WIN_PAUSE_MS);
        }
        // If only Play is ready (missed bust), nothing to do — just return
        // and the next iteration will click it.
    }

    async function runLoop() {
        while (isRunning) {
            // SPA safety: if the user navigated away from /mines, halt the
            // bot immediately. Without this, clickPlay would still find a
            // [data-testid="bet-button"] on whatever Stake game they
            // navigated to (most games have one) and place real bets.
            if (!/\/casino\/games\/mines/i.test(location.pathname)) {
                setStatus('Stopped', '#ef4444');
                stopBot();
                return;
            }
            await doOneRound();
        }
    }

    function startBot() {
        if (isRunning) return;
        isRunning = true;
        btnStart.style.display = 'none';
        btnStop.style.display = 'inline-block';
        setStatus('Running', '#1fff20');
        runLoop();
    }

    function stopBot() {
        isRunning = false;
        btnStart.style.display = 'inline-block';
        btnStop.style.display = 'none';
        setStatus('Stopped', '#ef4444');
    }

    btnStart.onclick = startBot;
    btnStop.onclick = stopBot;
    window.addEventListener('beforeunload', stopBot);

    // ---- Min/Max pick clamping ----
    // Stake Mines has 25 tiles total. If the user picks N mines, the bot can
    // reveal at most 25−N safe tiles. We dynamically clamp the Min/Max pick
    // inputs to that bound so the user can't request more picks than the
    // board can deliver.
    let _lastSafeTiles = null;

    function getSafeTileCount() {
        const minesSelect = document.querySelector('select[data-testid="mines-count"]');
        const mines = minesSelect ? parseInt(minesSelect.value) : NaN;
        if (isNaN(mines)) return 24;
        return Math.max(1, 25 - mines);
    }

    /** Update the `max` attribute on the Min/Max pick inputs so the spinner
     *  arrows stop at the right cap. Cheap to call every tick. */
    function syncPickInputCaps() {
        const safeTiles = getSafeTileCount();
        const minInp = document.getElementById('minPicks');
        const maxInp = document.getElementById('maxPicks');
        if (minInp) minInp.max = String(safeTiles);
        if (maxInp) maxInp.max = String(safeTiles);
        return safeTiles;
    }

    /** Read both inputs, clamp values into [1, safeTiles] and enforce min ≤ max,
     *  write the clamped values back. Skips inputs that are currently focused
     *  so the user's keystrokes aren't disrupted mid-typing. */
    function clampPickInputs() {
        const safeTiles = getSafeTileCount();
        const minInp = document.getElementById('minPicks');
        const maxInp = document.getElementById('maxPicks');
        if (!minInp || !maxInp) return;
        const minFocused = document.activeElement === minInp;
        const maxFocused = document.activeElement === maxInp;

        let minVal = parseInt(minInp.value);
        let maxVal = parseInt(maxInp.value);
        if (isNaN(minVal)) minVal = 1;
        if (isNaN(maxVal)) maxVal = 1;

        minVal = Math.max(1, Math.min(minVal, safeTiles));
        maxVal = Math.max(1, Math.min(maxVal, safeTiles));
        // Enforce Min ≤ Max: bump Max up if Min outgrew it.
        if (minVal > maxVal) maxVal = minVal;

        if (!minFocused && minInp.value !== String(minVal)) minInp.value = String(minVal);
        if (!maxFocused && maxInp.value !== String(maxVal)) maxInp.value = String(maxVal);
    }

    // Stake Mines multiplier formula (house edge 1%):
    //   multiplier(picks, mines) = 0.99 × C(25, picks) / C(25−mines, picks)
    // Validated live: mines=3, picks=2 yields 1.29× — matches Stake's display.
    function binomCoeff(n, k) {
        if (k < 0 || k > n) return 0;
        if (k === 0 || k === n) return 1;
        if (k > n - k) k = n - k;
        let result = 1;
        for (let i = 0; i < k; i++) {
            result = result * (n - i) / (i + 1);
        }
        return result;
    }

    /** Compute the cashout multiplier for `picks` safe tiles uncovered on a
     *  board with `mines` mines. Returns NaN if the combination is invalid
     *  (e.g. picks > number of safe tiles available). */
    function computeMinesMultiplier(picks, mines) {
        if (!isFinite(picks) || !isFinite(mines)) return NaN;
        if (picks < 1 || mines < 1 || mines > 24) return NaN;
        const safeTiles = 25 - mines;
        if (picks > safeTiles) return NaN;
        const top = binomCoeff(25, picks);
        const bot = binomCoeff(safeTiles, picks);
        if (!bot) return NaN;
        return 0.99 * top / bot;
    }

    function updateInfo() {
        // Keep the Min/Max input caps in sync with the live mines count, and
        // re-clamp values automatically when the mines count changes (so a
        // user with max=8 doesn't end up requesting more picks than the
        // board can deliver after they bump mines from 3 to 20).
        const safeTiles = syncPickInputCaps();
        if (_lastSafeTiles !== null && _lastSafeTiles !== safeTiles) {
            clampPickInputs();
        }
        _lastSafeTiles = safeTiles;

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

        let chance = '—';
        if (!isNaN(gems) && !isNaN(mines) && (gems + mines) > 0) {
            chance = ((gems / (gems + mines)) * 100).toFixed(2) + '%';
        }

        document.getElementById('mult').textContent = isNaN(multiplier) ? '—' : multiplier.toFixed(2) + '×';
        document.getElementById('pout').textContent = isNaN(payout) ? '—' : payout.toFixed(2);
        document.getElementById('chance').textContent = chance;

        // ---- Projected Range ----
        // Compute the multiplier and payout for the user's min/max pick range,
        // clamped to the number of safe tiles available on the current board
        // (25 − mines). Falls back to "N/A" if any input is invalid.
        const minPicks = parseInt(document.getElementById('minPicks').value);
        const maxPicks = parseInt(document.getElementById('maxPicks').value);
        const betInput = document.querySelector('input[data-testid="input-game-amount"]');
        const bet = betInput ? parseFloat(betInput.value) : NaN;

        const minMultEl = document.getElementById('minMult');
        const maxMultEl = document.getElementById('maxMult');
        const minPayoutEl = document.getElementById('minPayout');
        const maxPayoutEl = document.getElementById('maxPayout');

        if (isNaN(minPicks) || isNaN(maxPicks) || isNaN(mines)) {
            if (minMultEl) minMultEl.textContent = '—';
            if (maxMultEl) maxMultEl.textContent = '—';
            if (minPayoutEl) minPayoutEl.textContent = '—';
            if (maxPayoutEl) maxPayoutEl.textContent = '—';
            return;
        }

        // Clamp to actually-achievable picks (can't reveal more safe tiles
        // than exist on the board). `safeTiles` is already in scope from
        // syncPickInputCaps() at the top of updateInfo.
        const cappedMin = Math.max(1, Math.min(minPicks, safeTiles));
        const cappedMax = Math.max(cappedMin, Math.min(maxPicks, safeTiles));

        const minMult = computeMinesMultiplier(cappedMin, mines);
        const maxMult = computeMinesMultiplier(cappedMax, mines);

        if (minMultEl) minMultEl.textContent = isNaN(minMult) ? '—' : minMult.toFixed(2) + '×';
        if (maxMultEl) maxMultEl.textContent = isNaN(maxMult) ? '—' : maxMult.toFixed(2) + '×';

        if (isFinite(bet) && bet > 0) {
            if (minPayoutEl) minPayoutEl.textContent = isNaN(minMult) ? '—' : (bet * minMult).toFixed(2);
            if (maxPayoutEl) maxPayoutEl.textContent = isNaN(maxMult) ? '—' : (bet * maxMult).toFixed(2);
        } else {
            if (minPayoutEl) minPayoutEl.textContent = '—';
            if (maxPayoutEl) maxPayoutEl.textContent = '—';
        }
    }

    // Refresh on a fixed cadence and also reactively whenever the user
    // edits the min/max pick inputs (instant feedback without waiting for
    // the next tick). Blur runs the clamp so out-of-range typed values get
    // pulled back into [1, 25−mines] the moment the user leaves the field.
    setInterval(updateInfo, 1000);
    ['minPicks', 'maxPicks'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', updateInfo);
        el.addEventListener('blur', () => { clampPickInputs(); updateInfo(); });
    });
    // Initial clamp so any pre-saved values that exceed the current mines
    // count get corrected before the user does anything.
    clampPickInputs();
    updateInfo();

    }

    /* === source: nuts-autovault-desktop.user.js === */
    function tool_nuts_autovault() {
        'use strict';
// === Constants ===
    const UNIT = 1_000_000_000; // 1 SOL = 1,000,000,000 lamports
    const MIN_BALANCE_CHECKS = 2;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
    const WS_URL_MATCH = 'nuts.tools/graphql';

    // === Config ===
    function loadConfig() {
        try {
            const saved = localStorage.getItem('nuts-autovault-config');
            if (saved) return { ...defaults(), ...JSON.parse(saved) };
        } catch (e) {}
        return defaults();
    }
    function defaults() {
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000,
            minDepositSol: 0.001
        };
    }
    function saveConfig() {
        localStorage.setItem('nuts-autovault-config', JSON.stringify(config));
    }

    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;
    let MIN_DEPOSIT_SOL = config.minDepositSol;

    // === Activity log ===
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null;

    function logActivity(message, type = 'info') {
        const entry = { time: new Date(), message, type };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[NutsAutoVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');

    const FLAVOR = {
        profit: ['Positive difference,', 'Profit detected'],
        bigWin: ['Big win detected', 'Large profit'],
        start: ['AutoVault started', 'Monitoring active'],
        stop: ['AutoVault stopped', 'Monitoring paused'],
        rateLimit: ['Rate limited, vaulting paused', 'Limit reached, vaulting paused']
    };
    const pickFlavor = arr => arr[Math.floor(Math.random() * arr.length)];

    // === WebSocket hook — patches prototype.send so it catches sockets opened before this script ===
    let nutsSocket = null;
    let socketAuthenticated = false;
    const attachedSockets = new WeakSet();

    function onIncoming(raw) {
        try {
            const msg = JSON.parse(raw);
            // Any incoming response implies the socket is authenticated
            if (msg.type === 'connection_ack' || msg.type === 'next' || msg.type === 'data') {
                if (!socketAuthenticated) {
                    socketAuthenticated = true;
                    log('Socket authenticated with nuts.tools');
                }
            }
            if (msg.type === 'next' && msg.payload?.data) handleSubscriptionPayload(msg);
        } catch {}
    }

    function attachToSocket(ws) {
        if (!ws || attachedSockets.has(ws)) return;
        attachedSockets.add(ws);
        nutsSocket = ws;
        ws.addEventListener('message', (evt) => onIncoming(evt.data));
        ws.addEventListener('close', () => {
            if (nutsSocket === ws) { nutsSocket = null; socketAuthenticated = false; }
        });
        ws.addEventListener('error', () => {});
        log('Hooked nuts.tools socket (readyState=' + ws.readyState + ')');
    }

    try {
        const OriginalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(data) {
            try {
                if (this && typeof this.url === 'string' && this.url.includes(WS_URL_MATCH)) {
                    attachToSocket(this);
                }
            } catch (e) {}
            return OriginalSend.apply(this, arguments);
        };
    } catch (e) {
        console.error('[NutsAutoVault] Failed to patch WebSocket.prototype.send:', e);
    }

    // Also hook the constructor so we catch fresh sockets earlier
    try {
        const OriginalWebSocket = window.WebSocket;
        function HookedWebSocket(url, protocols) {
            const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            try { if (String(url).includes(WS_URL_MATCH)) attachToSocket(ws); } catch {}
            return ws;
        }
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        HookedWebSocket.OPEN = OriginalWebSocket.OPEN;
        HookedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        HookedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        window.WebSocket = HookedWebSocket;
    } catch (e) {}

    // === State ===
    let playBalance = null;
    let vaultBalance = null;
    let oldBalance = null;
    let lastBalance = null;
    let isInitialized = false;
    let balanceChecks = 0;
    let isProcessing = false;
    let running = false;
    let vaultInterval = null;
    let pendingMutation = null;
    let uiWidget = null;
    let vaultedThisSession = 0;

    function handleSubscriptionPayload(msg) {
        const d = msg.payload.data;
        if (!d) return;
        if ('balance' in d && d.balance && d.balance.after !== undefined) {
            playBalance = Number(d.balance.after);
            if (playBalance > 0 && oldBalance === null) oldBalance = playBalance;
            if (!isInitialized && ++balanceChecks >= MIN_BALANCE_CHECKS && playBalance > 0) {
                isInitialized = true;
                oldBalance = playBalance;
                log(`Initial balance: ${unitToSol(playBalance).toFixed(6)} SOL`);
            }
            if (uiWidget) uiWidget.render();
        }
        if ('vaultBalance' in d && d.vaultBalance && d.vaultBalance.after !== undefined) {
            vaultBalance = Number(d.vaultBalance.after);
            if (uiWidget) uiWidget.render();
        }
        if ('depositToVault' in d && pendingMutation && msg.id === pendingMutation.id) {
            pendingMutation.resolve(msg);
            pendingMutation = null;
        }
    }

    // === Deposit mutation ===
    function sendVaultDeposit(amountUnits) {
        return new Promise((resolve, reject) => {
            if (!nutsSocket || nutsSocket.readyState !== 1 || !socketAuthenticated) {
                return reject(new Error('Nuts socket not ready'));
            }
            const id = uuid();
            const payload = {
                id,
                type: 'subscribe',
                payload: {
                    query: 'mutation depositToVault($amount: Float!) {\n  depositToVault(amount: $amount)\n}',
                    operationName: 'depositToVault',
                    variables: { amount: Math.floor(amountUnits) }
                }
            };
            const timeout = setTimeout(() => {
                if (pendingMutation && pendingMutation.id === id) {
                    pendingMutation = null;
                    reject(new Error('Deposit timed out'));
                }
            }, 15000);
            pendingMutation = {
                id,
                resolve: (msg) => { clearTimeout(timeout); resolve(msg); },
                reject
            };
            try {
                nutsSocket.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timeout);
                pendingMutation = null;
                reject(e);
            }
        });
    }

    function uuid() {
        if (crypto?.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    const unitToSol = u => (Number(u) || 0) / UNIT;
    const solToUnit = s => Math.floor(Number(s) * UNIT);

    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return null;
    }
    function detectDisplayCurrency() {
        const bal = findBalanceContainer();
        if (!bal) return 'SOL';
        if (bal.querySelector('span[title*="$"]')) return 'USD';
        return (bal.textContent || '').trim().startsWith('$') ? 'USD' : 'SOL';
    }
    function getSolToUsdRate() {
        const bal = findBalanceContainer();
        if (!bal) return null;
        const innerSpan = bal.querySelector('span[title*="$"][title*="SOL"]');
        const t = innerSpan ? (innerSpan.getAttribute('title') || '') : '';
        const m = t.match(/\$\s*([\d,]+\.?\d*)\s*\(([\d,]+\.?\d*)\s*SOL\)/);
        if (m) {
            const usd = parseFloat(m[1].replace(/,/g, ''));
            const sol = parseFloat(m[2].replace(/,/g, ''));
            if (sol > 0 && isFinite(usd) && isFinite(sol)) return usd / sol;
        }
        return null;
    }
    function formatBalanceForDisplay(units) {
        if (units === null || units === undefined) return '—';
        const sol = unitToSol(units);
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(sol * rate).toFixed(2)}`;
        }
        return `${sol.toFixed(6)} SOL`;
    }
    function formatSolAmountForDisplay(solAmount) {
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(solAmount * rate).toFixed(2)}`;
        }
        return `${solAmount.toFixed(6)} SOL`;
    }

    // === Rate limiting ===
    function loadRateLimitData() {
        try {
            const saved = sessionStorage.getItem('nuts-autovault-ratelimit');
            if (saved) {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            }
        } catch {}
        return [];
    }
    function saveRateLimitData(ts) {
        sessionStorage.setItem('nuts-autovault-ratelimit', JSON.stringify(ts));
    }
    let vaultActionTimestamps = loadRateLimitData();
    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }
    function getVaultCountLastHour() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        return vaultActionTimestamps.length;
    }

    // === Floaty UI ===
    let currentViewMode = 'full';

    function createUI() {
        if (document.getElementById('nuts-autovault-floaty')) {
            document.getElementById('nuts-autovault-floaty').remove();
        }
        if (document.getElementById('nuts-autovault-stealth')) {
            document.getElementById('nuts-autovault-stealth').remove();
        }

        const style = document.createElement('style');
        style.id = 'nuts-autovault-styles';
        style.textContent = `
        #nuts-autovault-floaty {
            background: #1a1a2a;
            color: #d0d0e0;
            border: 1px solid #3a3a4a;
            border-radius: 10px;
            box-shadow: 0 6px 20px rgba(0,0,0,0.5);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px;
            min-width: 250px;
            max-width: 290px;
            user-select: none;
            position: fixed;
            top: 90px;
            right: 20px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
        }
        #nuts-autovault-floaty.hidden { display: none; }
        #nuts-autovault-floaty .nv-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(135deg, #2a2a3a, #1e1e2e);
            padding: 8px 12px;
            border-radius: 10px 10px 0 0;
            border-bottom: 1px solid #3a3a4a;
            cursor: grab;
        }
        #nuts-autovault-floaty .nv-header:active { cursor: grabbing; }
        #nuts-autovault-floaty .nv-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 700;
            font-size: 12px;
            color: #bb86fc;
            letter-spacing: 0.3px;
        }
        #nuts-autovault-floaty .nv-dot {
            width: 7px; height: 7px; border-radius: 50%; background: #4a5568;
        }
        #nuts-autovault-floaty .nv-dot.running { background: #03dac6; }
        #nuts-autovault-floaty .nv-dot.socket-bad { background: #ff0266; }
        #nuts-autovault-floaty .nv-header-btns { display: flex; gap: 2px; }
        #nuts-autovault-floaty .nv-header-btn {
            background: none; border: none; color: #7a7a8a; cursor: pointer;
            padding: 4px 6px; border-radius: 4px; font-size: 14px; line-height: 1;
        }
        #nuts-autovault-floaty .nv-header-btn:hover { color: #fff; background: #3a3a4a; }
        #nuts-autovault-floaty .nv-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        #nuts-autovault-floaty .nv-row {
            display: flex; align-items: center; justify-content: space-between;
        }
        #nuts-autovault-floaty .nv-label { color: #a0a0b0; font-size: 12px; }
        #nuts-autovault-floaty input[type="number"] {
            background: #0f0f1a; color: #e0e0f0; border: 1px solid #4a4a5a;
            border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 72px;
            text-align: right;
        }
        #nuts-autovault-floaty input[type="number"]:focus { outline: none; border-color: #bb86fc; }
        #nuts-autovault-floaty .nv-btn-row { display: flex; gap: 6px; margin-top: 4px; }
        #nuts-autovault-floaty .nv-btn {
            flex: 1; background: #2a2a3a; color: #d0d0e0; border: 1px solid #3a3a4a;
            border-radius: 4px; padding: 6px 10px; font-size: 11px; font-weight: 600;
            cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
        }
        #nuts-autovault-floaty .nv-btn:hover:not(:disabled) { background: #3a3a4a; color: #fff; }
        #nuts-autovault-floaty .nv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        #nuts-autovault-floaty .nv-btn.primary { background: linear-gradient(135deg, #bb86fc, #8e63c4); border-color: #bb86fc; color: #fff; }
        #nuts-autovault-floaty .nv-btn.danger { background: linear-gradient(135deg, #ff0266, #c2185b); border-color: #ff0266; color: #fff; }
        #nuts-autovault-floaty .nv-stats {
            display: flex; justify-content: space-between; gap: 6px;
            padding-top: 8px; border-top: 1px solid #3a3a4a; font-size: 11px;
        }
        #nuts-autovault-floaty .nv-stat { display: flex; flex-direction: column; gap: 2px; }
        #nuts-autovault-floaty .nv-stat-label { color: #7a7a8a; font-size: 10px; text-transform: uppercase; }
        #nuts-autovault-floaty .nv-stat-value { color: #bb86fc; font-weight: 700; }
        #nuts-autovault-floaty .nv-log-toggle {
            display: flex; align-items: center; justify-content: space-between;
            padding: 6px 12px; background: #1e1e2e; border-top: 1px solid #3a3a4a;
            cursor: pointer;
        }
        #nuts-autovault-floaty .nv-log-toggle:hover { background: #24243a; }
        #nuts-autovault-floaty .nv-log-toggle-text { font-size: 10px; color: #7a7a8a; text-transform: uppercase; }
        #nuts-autovault-floaty .nv-log-toggle-icon { font-size: 10px; color: #7a7a8a; transition: transform 0.2s; }
        #nuts-autovault-floaty .nv-log-toggle.open .nv-log-toggle-icon { transform: rotate(180deg); }
        #nuts-autovault-floaty .nv-log {
            max-height: 0; overflow: hidden; transition: max-height 0.25s ease-out; background: #0f0f1a;
        }
        #nuts-autovault-floaty .nv-log.open { max-height: 130px; }
        #nuts-autovault-floaty .nv-log-inner {
            padding: 8px; max-height: 130px; overflow-y: auto;
            font-family: 'Menlo', 'Monaco', 'Consolas', monospace; font-size: 10px; line-height: 1.4;
        }
        #nuts-autovault-floaty .nv-log-entry { padding: 2px 0; color: #7a7a8a; display: flex; gap: 6px; }
        #nuts-autovault-floaty .nv-log-entry.success,
        #nuts-autovault-floaty .nv-log-entry.profit { color: #03dac6; }
        #nuts-autovault-floaty .nv-log-entry.bigwin { color: #fbbf24; }
        #nuts-autovault-floaty .nv-log-entry.warning { color: #f59e0b; }
        #nuts-autovault-floaty .nv-log-entry.error { color: #ff0266; }
        #nuts-autovault-floaty .nv-log-time { color: #4a4a5a; flex-shrink: 0; }
        #nuts-autovault-floaty .nv-log-empty {
            color: #4a4a5a; font-style: italic; text-align: center; padding: 8px;
        }
        #nuts-autovault-floaty.mini { min-width: auto; max-width: none; border-radius: 20px; }
        #nuts-autovault-floaty.mini .nv-header { border-radius: 20px; padding: 6px 12px; border-bottom: none; }
        #nuts-autovault-floaty.mini .nv-content,
        #nuts-autovault-floaty.mini .nv-log-toggle,
        #nuts-autovault-floaty.mini .nv-log { display: none; }
        #nuts-autovault-floaty.mini .nv-title span { display: none; }
        #nuts-autovault-stealth {
            position: fixed; bottom: 10px; right: 10px; width: 9px; height: 9px;
            border-radius: 50%; background: #4a5568; cursor: pointer; z-index: 999999;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        }
        #nuts-autovault-stealth.running { background: #03dac6; }
        #nuts-autovault-stealth.hidden { display: none; }
        @media (max-width: 500px) {
            #nuts-autovault-floaty { right: 10px !important; left: 10px !important; max-width: none; min-width: auto; }
        }
        `;
        document.head.appendChild(style);

        const widget = document.createElement('div');
        widget.id = 'nuts-autovault-floaty';

        const stealthDot = document.createElement('div');
        stealthDot.id = 'nuts-autovault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'Nuts AutoVault (click to expand)';
        document.body.appendChild(stealthDot);

        const header = document.createElement('div');
        header.className = 'nv-header';
        header.innerHTML = `
            <div class="nv-title">
                <div class="nv-dot" id="nvStatusDot"></div>
                <span>Nuts AutoVault</span>
            </div>
            <div class="nv-header-btns">
                <button class="nv-header-btn" id="nvMinBtn" title="Minimize">−</button>
                <button class="nv-header-btn" id="nvStealthBtn" title="Stealth">○</button>
                <button class="nv-header-btn" id="nvCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);

        const content = document.createElement('div');
        content.className = 'nv-content';
        content.innerHTML = `
            <div class="nv-row">
                <span class="nv-label">Save % of profit</span>
                <input type="number" id="nvSavePct" min="0" max="1" step="0.01" value="${SAVE_AMOUNT}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Big-win threshold (×)</span>
                <input type="number" id="nvBigWin" min="1" step="0.1" value="${BIG_WIN_THRESHOLD}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Big-win multiplier</span>
                <input type="number" id="nvBigMult" min="1" step="0.1" value="${BIG_WIN_MULTIPLIER}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Check interval (s)</span>
                <input type="number" id="nvCheck" min="10" step="1" value="${Math.round(CHECK_INTERVAL/1000)}">
            </div>
            <div class="nv-row">
                <span class="nv-label">Min deposit (SOL)</span>
                <input type="number" id="nvMinDep" min="0" step="0.0001" value="${MIN_DEPOSIT_SOL}">
            </div>
            <div class="nv-btn-row">
                <button class="nv-btn primary" id="nvStart">Start</button>
                <button class="nv-btn danger" id="nvStop" disabled>Stop</button>
            </div>
            <div class="nv-stats">
                <div class="nv-stat"><span class="nv-stat-label">Balance</span><span class="nv-stat-value" id="nvBal">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Vault</span><span class="nv-stat-value" id="nvVault">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Actions/hr</span><span class="nv-stat-value" id="nvCount">0/${RATE_LIMIT_MAX}</span></div>
            </div>
        `;
        widget.appendChild(content);

        const logToggle = document.createElement('div');
        logToggle.className = 'nv-log-toggle';
        logToggle.innerHTML = `<span class="nv-log-toggle-text">Activity</span><span class="nv-log-toggle-icon">▼</span>`;
        widget.appendChild(logToggle);

        const logPanel = document.createElement('div');
        logPanel.className = 'nv-log';
        logPanel.innerHTML = `<div class="nv-log-inner" id="nvLogInner"><div class="nv-log-empty">No activity yet...</div></div>`;
        widget.appendChild(logPanel);
        const logInner = logPanel.querySelector('#nvLogInner');

        logToggle.onclick = () => { logToggle.classList.toggle('open'); logPanel.classList.toggle('open'); };

        const fmt = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        onLogUpdate = (entry) => {
            const empty = logInner.querySelector('.nv-log-empty');
            if (empty) empty.remove();
            const div = document.createElement('div');
            div.className = `nv-log-entry ${entry.type}`;
            div.innerHTML = `<span class="nv-log-time">${fmt(entry.time)}</span><span></span>`;
            div.lastChild.textContent = entry.message;
            logInner.insertBefore(div, logInner.firstChild);
            while (logInner.children.length > 25) logInner.removeChild(logInner.lastChild);
        };

        const statusDot = widget.querySelector('#nvStatusDot');
        const balEl = content.querySelector('#nvBal');
        const vaultEl = content.querySelector('#nvVault');
        const countEl = content.querySelector('#nvCount');
        const startBtn = content.querySelector('#nvStart');
        const stopBtn = content.querySelector('#nvStop');
        const minBtn = widget.querySelector('#nvMinBtn');
        const stealthBtn = widget.querySelector('#nvStealthBtn');
        const closeBtn = widget.querySelector('#nvCloseBtn');

        function setViewMode(mode) {
            currentViewMode = mode;
            widget.classList.toggle('mini', mode === 'mini');
            widget.classList.toggle('hidden', mode === 'stealth');
            stealthDot.classList.toggle('hidden', mode !== 'stealth');
        }
        minBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
            minBtn.textContent = currentViewMode === 'mini' ? '+' : '−';
        };
        stealthBtn.onclick = (e) => { e.stopPropagation(); setViewMode('stealth'); };
        stealthDot.onclick = () => { setViewMode('full'); minBtn.textContent = '−'; };
        closeBtn.onclick = () => { widget.remove(); stealthDot.remove(); };

        // Drag
        let isDragging = false, dx = 0, dy = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.nv-header-btns')) return;
            isDragging = true;
            const rect = widget.getBoundingClientRect();
            dx = e.clientX - rect.left; dy = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let nl = e.clientX - dx, nt = e.clientY - dy;
            nl = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, nl));
            nt = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, nt));
            widget.style.left = nl + 'px'; widget.style.top = nt + 'px'; widget.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        // Parameter bindings
        content.querySelector('#nvSavePct').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            SAVE_AMOUNT = config.saveAmount = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvBigWin').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            BIG_WIN_THRESHOLD = config.bigWinThreshold = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvBigMult').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            BIG_WIN_MULTIPLIER = config.bigWinMultiplier = v;
            this.value = v; saveConfig();
        };
        content.querySelector('#nvCheck').onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            CHECK_INTERVAL = v * 1000; config.checkInterval = CHECK_INTERVAL;
            this.value = v; saveConfig();
            if (running) { stopVault(); startVault(); }
        };
        content.querySelector('#nvMinDep').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            MIN_DEPOSIT_SOL = config.minDepositSol = v;
            this.value = v; saveConfig();
        };

        startBtn.onclick = () => { startVault(); };
        stopBtn.onclick = () => { stopVault(); };

        function render() {
            balEl.textContent = formatBalanceForDisplay(playBalance);
            vaultEl.textContent = formatBalanceForDisplay(vaultBalance);
            const c = getVaultCountLastHour();
            countEl.textContent = `${c}/${RATE_LIMIT_MAX}`;
            countEl.style.color = c >= RATE_LIMIT_MAX ? '#ff0266' : c >= RATE_LIMIT_MAX*0.8 ? '#f59e0b' : '#03dac6';
            statusDot.classList.toggle('running', running);
            statusDot.classList.toggle('socket-bad', !socketAuthenticated);
            stealthDot.classList.toggle('running', running);
            startBtn.disabled = running;
            stopBtn.disabled = !running;
        }
        setInterval(render, 3000);
        document.body.appendChild(widget);
        return { render };
    }

    // === Vault logic ===
    async function processDeposit(amountUnits, isBigWin) {
        if (amountUnits < solToUnit(MIN_DEPOSIT_SOL) || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)} — rate limit reached`, 'warning');
            return;
        }
        if (!socketAuthenticated) {
            logActivity('Socket not authenticated — waiting', 'warning');
            return;
        }
        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        const flavor = pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit);
        logActivity(`${flavor} vaulting ${pct}%: ${formatSolAmountForDisplay(unitToSol(amountUnits))}`, isBigWin ? 'bigwin' : 'profit');
        try {
            const resp = await sendVaultDeposit(amountUnits);
            isProcessing = false;
            // depositToVault returns null on success; vaultBalance subscription auto-updates
            vaultedThisSession += amountUnits;
            vaultActionTimestamps.push(Date.now());
            saveRateLimitData(vaultActionTimestamps);
            oldBalance = playBalance;
            logActivity(`Secured ${formatSolAmountForDisplay(unitToSol(amountUnits))}`, 'success');
            if (uiWidget) uiWidget.render();
        } catch (e) {
            isProcessing = false;
            logActivity(`Vault error: ${e.message}`, 'error');
        }
    }

    function checkBalanceChanges() {
        if (playBalance === null || !isInitialized) return;
        if (oldBalance === null) { oldBalance = playBalance; return; }
        if (playBalance > oldBalance) {
            const profit = playBalance - oldBalance;
            const ratio = oldBalance > 0 ? playBalance / oldBalance : 1;
            const isBig = ratio >= BIG_WIN_THRESHOLD;
            const dep = Math.floor(profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1));
            if (dep > 0) processDeposit(dep, isBig);
            oldBalance = playBalance;
        } else if (playBalance < oldBalance) {
            oldBalance = playBalance;
        }
        lastBalance = playBalance;
        if (uiWidget) uiWidget.render();
    }

    function startVault() {
        if (running) return;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        oldBalance = playBalance;
        isProcessing = false;
        vaultedThisSession = 0;
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) uiWidget.render();
    }
    function stopVault() {
        if (!running) return;
        running = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        logActivity(pickFlavor(FLAVOR.stop), 'info');
        if (uiWidget) uiWidget.render();
    }

    // === Init ===
    function onDomReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    onDomReady(() => {
        setTimeout(() => {
            if (!uiWidget) uiWidget = createUI();
        }, 2000);
    });


    }

    /* === source: nuts-iow-smart-desktop.user.js === */
    function tool_nuts_iow_smart() {
        'use strict';
// ================== SETTINGS & STATE ==================
    let ACTIVE_MODE = 'smart';
    let baseBet = 0.00000001;
    let manualBet = 0.00000001;    // Manual mode's wager (mirrors baseBet's role for Manual)
    let winIncreasePercent = 125;
    let lossStreakReset = 3;
    let winsBeforeReset = 5;
    let autoStopBalance = null;
    let minBaseBet = 0.00000001;
    let maxBaseBet = 99999999999999;
    let lastBetId = null;
    let lossStreak = 0;
    let counter = 0;
    let isRapidFiring = false;
    let sessionPeak = 0;
    let initialBalance = 0;
    let lastKnownBalance = 0;
    let totalWagered = 0;
    let highestProfit = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalBets = 0;
    let observer = null;
    let pastBetsContainer = null;
    let profitHistory = [0];
    const MAX_GRAPH_POINTS = 10000;
    const RAPID_BLOCKED_STOP_MS = 1200;
    const RAPID_STALL_STOP_MS = 3000;
    let aggressionLevel = 1.0;
    let historyWindow = 30;
    let safeDivisor = 300;
    let aggressiveDivisor = 150;
    let winsNeeded = 15;
    let lastAmount = 0;
    let curLossStreak = 0;
    let maxLossStreak = 0;
    let curWinStreak = 0;
    let maxWinStreak = 0;
    let betHistory = [];
    let recentWins = [];
    let topWinStreaks = [];
    let topLossStreaks = [];
    let trackedMultiplier = 0;
    let multGames = 0;
    let multWins = 0;
    let lastResult = null;
    let stopLossPct = 0;
    let takeProfitPct = 0;
    let autoPaused = false;
    let winResetPulseTimer = null;
    let rapidBlockedSince = 0;
    let rapidFireStartedAt = 0;
    let lastObservedBetTime = 0;
    let spacePressInterval = null;
    let lockAggressionState = false;
    let lockedGearLevel = 1;
    // === BET LOCK STATE ===
    let desiredBetAmount = null;
    let betGuardObserver = null;
    // === IOW RELIABLE PROGRESSION ===
    let lastPlacedBet = 0.00000010;
    // === ADVANCED RAPID STATE ===
    let clickInterval = null;
    let spaceTimeout = null;
    let spaceInterval = null;
    let isSpaceHeldDown = false;
    let playButton = null;
    // === IOW ENFORCER ===
    let iowEnforcerInterval = null;

    __addStyle(`
[]        #ratchet-master-container,
        #ratchet-master-container * { box-sizing: border-box !important; }
        #ratchet-master-container {
            --hud-bg:
                radial-gradient(circle at 8% 10%, rgba(122, 124, 255, 0.18), transparent 22%),
                radial-gradient(circle at 94% 4%, rgba(255, 79, 216, 0.2), transparent 24%),
                radial-gradient(circle at 50% 100%, rgba(24, 240, 255, 0.09), transparent 34%),
                linear-gradient(135deg, rgba(7, 10, 18, 0.96), rgba(18, 24, 35, 0.94) 42%, rgba(10, 12, 18, 0.98));
            --hud-panel: linear-gradient(160deg, rgba(36, 42, 56, 0.54), rgba(14, 18, 28, 0.76));
            --hud-border: rgba(128, 202, 255, 0.28);
            --hud-border-soft: rgba(255, 255, 255, 0.1);
            --hud-green: #19f3ff;
            --hud-green-dark: #8f63ff;
            --hud-red: #ff4c94;
            --hud-accent-a: #19f3ff;
            --hud-accent-b: #8f63ff;
            --hud-accent-c: #ff4fd8;
            --hud-positive: #43f6ff;
            --hud-negative: #ff6bb0;
            --hud-text: #f5fbff;
            --hud-text-soft: #aab6c9;
            position: absolute !important;
            inset: 0 !important;
            width: 100% !important;
            max-width: none !important;
            height: 100% !important;
            max-height: none !important;
            background: var(--hud-bg) !important;
            border: 1px solid var(--hud-border) !important;
            border-radius: 0 !important;
            padding: 8px !important;
            box-shadow: 0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
            z-index: auto !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            font-family: "Proxima Nova", "Segoe UI", sans-serif !important;
            pointer-events: auto !important;
            overflow: hidden !important;
            backdrop-filter: blur(24px) saturate(1.32);
            line-height: 1.15;
            color: var(--hud-text) !important;
        }
        #ratchet-master-container::before {
            content: '';
            position: absolute;
            inset: 0;
            pointer-events: none;
            background:
                linear-gradient(120deg, rgba(255, 255, 255, 0.05), transparent 22%, transparent 78%, rgba(255, 255, 255, 0.03)),
                radial-gradient(circle at 15% 18%, rgba(25, 243, 255, 0.08), transparent 18%),
                radial-gradient(circle at 82% 14%, rgba(255, 79, 216, 0.1), transparent 20%);
            opacity: 0.95;
        }
        #ratchet-master-container::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 0;
            pointer-events: none;
            opacity: 0;
            border: 1px solid transparent;
            box-shadow: inset 0 0 0 0 rgba(25, 243, 255, 0), inset 0 0 0 0 rgba(255, 79, 216, 0);
        }
        #ratchet-master-container.iow-win-reset-pulse::after { animation: ratchet-iow-win-reset-pulse 720ms ease-out 1; }
        @keyframes ratchet-iow-win-reset-pulse {
            0% { opacity: 0; }
            20% { opacity: 1; border-color: rgba(25, 243, 255, 0.88); box-shadow: inset 0 0 0 1px rgba(25, 243, 255, 0.74), inset 0 0 18px rgba(143, 99, 255, 0.26); }
            55% { opacity: 1; border-color: rgba(255, 79, 216, 0.78); box-shadow: inset 0 0 0 2px rgba(255, 79, 216, 0.72), inset 0 0 24px rgba(25, 243, 255, 0.24); }
            100% { opacity: 0; border-color: transparent; box-shadow: inset 0 0 0 0 rgba(25, 243, 255, 0), inset 0 0 0 0 rgba(255, 79, 216, 0); }
        }
        #ratchet-master-container[data-mode="iow"] { min-height: 0 !important; }
        #ratchet-master-container .hud-frame { display: flex; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 2; }
        #ratchet-master-container .hud-workspace { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 3; }
        #ratchet-master-container .hud-native-sidebar-slot { display: flex; flex: 0 0 300px; width: 300px; min-width: 300px; max-width: 300px; min-height: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-native-sidebar-slot:empty,
        #ratchet-master-container .hud-native-past-bets-slot:empty,
        #ratchet-master-container .hud-native-game-footer-slot:empty,
        #ratchet-master-container .hud-footer-slot:empty { display: none !important; }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 {
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            padding: 10px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow: auto !important;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(22px) saturate(1.28) !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 > .sc-8d275cfe-2 {
            width: 100% !important;
            min-width: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-fe9b8b64-1,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-80ffdcd5-0,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-8d275cfe-1 .sc-9e158b58-0 {
            width: 100% !important;
            max-width: 100% !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-1,
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-0 {
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
            padding: 10px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow: auto !important;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(22px) saturate(1.28) !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .sc-9b1418e2-1 {
            padding-top: 10px !important;
            margin-top: 0 !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .styles-module___IID9a__game {
            width: 100% !important;
            min-height: 28px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            border-radius: 8px !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot { display: flex; flex: 0 0 auto; min-height: 42px; min-width: 0; overflow: hidden; position: relative; z-index: 5; }
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-1,
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-0 {
            width: 100% !important;
            min-width: 0 !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            padding: 6px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 12px !important;
            overflow-x: auto !important;
            overflow-y: hidden !important;
            box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(20px) saturate(1.22) !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot > .sc-9b1418e2-1 {
            height: auto !important;
            width: 100% !important;
            padding-left: 6px !important;
            margin-left: 0 !important;
            flex-direction: row !important;
            align-items: center !important;
            padding-top: 0 !important;
            margin-top: 0 !important;
        }
        #ratchet-master-container .hud-native-past-bets-slot .styles-module___IID9a__game { flex: 0 0 auto !important; }
        #ratchet-master-container #hud-content { display: flex; flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-shell { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; min-width: 0; gap: 8px; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-panel { background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .mode-wrap { display: flex; flex: 0 0 auto; flex-wrap: nowrap; gap: 5px; background: linear-gradient(180deg, rgba(23, 29, 42, 0.7), rgba(14, 18, 27, 0.82)); padding: 6px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.09); box-shadow: 0 18px 36px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 3; backdrop-filter: blur(22px) saturate(1.26); }
        #ratchet-master-container .mode-btn { flex: 1 1 0; min-width: 0; padding: 8px 12px; border: none; border-radius: 999px; font-size: 12px; font-weight: 900; cursor: pointer; transition: transform 0.18s ease, filter 0.18s ease, background 0.18s ease, color 0.18s ease; text-transform: uppercase; letter-spacing: 0.4px; }
        #ratchet-master-container .mode-btn.active { background: linear-gradient(135deg, var(--hud-accent-a), var(--hud-accent-b) 45%, var(--hud-accent-c)); color: #070911; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) inset, 0 0 18px rgba(25, 243, 255, 0.22), 0 0 26px rgba(255, 79, 216, 0.18); }
        #ratchet-master-container .mode-btn:not(.active) { background: rgba(77, 97, 123, 0.45); color: #c1cbda; }
        #ratchet-master-container .mode-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split, #ratchet-master-container .input-row, #ratchet-master-container .input-cluster, #ratchet-master-container .btn-group, #ratchet-master-container .hud-stat-rail, #ratchet-master-container .hud-stats-grid, #ratchet-master-container .hud-meta-row, #ratchet-master-container .hud-header { display: flex; min-width: 0; }
        #ratchet-master-container .hud-header, #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck { flex: 0 0 auto; }
        #ratchet-master-container .hud-top-bar, #ratchet-master-container .hud-controls-deck, #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { gap: 8px; align-items: stretch; }
        #ratchet-master-container .hud-body, #ratchet-master-container .hud-split { flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; flex-wrap: nowrap; position: relative; z-index: 4; }
        #ratchet-master-container .hud-body { justify-content: space-between; }
        #ratchet-master-container .hud-header, #ratchet-master-container .input-row, #ratchet-master-container .hud-meta-row { justify-content: space-between; align-items: center; gap: 8px; }
        #ratchet-master-container .hud-pane, #ratchet-master-container .graph-col, #ratchet-master-container .stats-col { flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .hud-pane { display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .hud-pane.primary { flex: 1.15 1 0; }
        #ratchet-master-container .hud-pane.secondary, #ratchet-master-container .stats-col { flex: 0 0 340px; width: 340px; min-width: 340px; max-width: 340px; display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .graph-col { display: flex; flex: 1 1 auto; min-width: 320px; }
        #ratchet-master-container .control-section { flex: 1 1 0; min-width: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        #ratchet-master-container .input-row { align-items: flex-end; flex-wrap: nowrap; }
        #ratchet-master-container .input-cluster { flex: 1 1 0; flex-wrap: wrap; align-items: flex-end; gap: 8px; min-width: 0; }
        #ratchet-master-container .input-group { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
        #ratchet-master-container .quick-btn { padding: 0; width: 26px; height: 26px; font-size: 10px; font-weight: 900; background: linear-gradient(180deg, rgba(39, 48, 63, 0.88), rgba(17, 22, 33, 0.94)); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); border-radius: 8px; cursor: pointer; flex: 0 0 auto; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05); }
        #ratchet-master-container .quick-btn:hover { background: linear-gradient(180deg, rgba(78, 96, 123, 0.7), rgba(24, 29, 43, 0.94)); }
        #ratchet-master-container input[type="number"] { background: rgba(8, 11, 18, 0.78); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); padding: 5px 6px; border-radius: 9px; width: 76px; font-size: 12px; font-weight: 700; text-align: center; outline: none; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container input[type="number"]:focus { border-color: rgba(25, 243, 255, 0.72); box-shadow: 0 0 0 2px rgba(25, 243, 255, 0.12), 0 0 18px rgba(255, 79, 216, 0.12); }
        #ratchet-master-container .hud-risk-container { display: flex; flex: 1 1 100%; flex-wrap: nowrap; gap: 6px; min-width: 0; }
        #ratchet-master-container .hud-risk-container label { color: var(--hud-text-soft); font-size: 10px; font-weight: 800; display: flex; flex-direction: column; justify-content: space-between; gap: 4px; text-transform: uppercase; flex: 1 1 0; min-width: 0; }
        #ratchet-master-container .hud-risk-container input[type="number"] { width: 100%; min-width: 0; }
        #ratchet-master-container .btn-group { align-items: stretch; gap: 6px; flex-wrap: nowrap; justify-content: flex-end; flex: 0 0 auto; }
        #ratchet-master-container .hud-rapid-btn, #ratchet-master-container .hud-reset-btn { min-height: 38px; }
        #ratchet-master-container .hud-rapid-btn { border: none; color: #fff; font-size: 12px; font-weight: 900; padding: 8px 16px; border-radius: 9px; cursor: pointer; min-width: 108px; letter-spacing: 0.5px; text-transform: uppercase; flex: 1 1 0; }
        #ratchet-master-container .hud-rapid-btn.start { background: linear-gradient(135deg, var(--hud-accent-a), var(--hud-accent-b) 44%, var(--hud-accent-c)); color: #070911; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18) inset, 0 0 20px rgba(25, 243, 255, 0.2), 0 0 28px rgba(255, 79, 216, 0.16); }
        #ratchet-master-container .hud-rapid-btn.start:hover { filter: brightness(1.05) saturate(1.04); }
        #ratchet-master-container .hud-rapid-btn.stop { background: linear-gradient(135deg, rgba(255, 79, 216, 0.94), rgba(255, 76, 148, 0.94)); box-shadow: 0 0 18px rgba(255, 79, 216, 0.18); }
        #ratchet-master-container .hud-rapid-btn.stop:hover { filter: brightness(1.05); }
        #ratchet-master-container .hud-reset-btn { background: rgba(255, 79, 216, 0.06); border: 1px solid rgba(255, 79, 216, 0.58); color: #ff78bf; font-size: 11px; font-weight: 900; padding: 8px 14px; border-radius: 11px; cursor: pointer; flex: 1 1 0; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container .hud-reset-btn:hover { background: linear-gradient(135deg, rgba(255, 79, 216, 0.18), rgba(255, 76, 148, 0.22)); color: #fff; }
        #ratchet-master-container .status-bar { background: var(--hud-panel); padding: 8px 10px; border-radius: 14px; text-align: center; font-size: 13px; font-weight: 900; letter-spacing: 0.2px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: center; min-height: 42px; flex: 0 0 auto; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-graph-box { flex: 1 1 0; min-height: 0; height: 100%; background: radial-gradient(circle at top left, rgba(25, 243, 255, 0.08), transparent 24%), radial-gradient(circle at top right, rgba(255, 79, 216, 0.1), transparent 24%), linear-gradient(180deg, rgba(8, 10, 17, 0.95), rgba(14, 17, 25, 0.98)); border: 1px solid rgba(146, 184, 224, 0.16); border-radius: 16px; overflow: hidden; position: relative; display: flex; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 20px 40px rgba(0, 0, 0, 0.28); }
        #ratchet-master-container .hud-graph-box canvas { width: 100%; height: 100%; display: block; flex: 1 1 auto; }
        #ratchet-master-container .hud-header { padding: 8px 12px; background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 4; backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-header h2 { margin: 0; color: #fff; font-size: 14px; font-weight: 900; letter-spacing: 0.8px; text-transform: uppercase; }
        #ratchet-master-container .hud-target-text { color: #eef8ff; font-size: 12px; font-weight: 800; font-style: italic; letter-spacing: 0.2px; text-shadow: 0 0 14px rgba(25, 243, 255, 0.14); }
        /* Controls-deck layout: wrap onto multiple rows, align labels at the
           bottom, separate columns and rows independently so a wrapped row
           sits closer to the row above than control-groups within a row. */
        #ratchet-master-container .hud-controls-deck { padding: 10px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); background: var(--hud-panel); flex-wrap: wrap; column-gap: 12px; row-gap: 8px; align-items: flex-end; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); position: relative; z-index: 2; backdrop-filter: blur(20px) saturate(1.24); }
        /* Each control-group sizes to its content; ranges expand to fill */
        #ratchet-master-container .hud-control-group { display: flex; flex-direction: column; gap: 4px; flex: 0 1 auto; min-width: 0; max-width: 100%; }
        #ratchet-master-container .hud-control-group:has(input[type="range"]) { flex: 1 1 160px; min-width: 140px; }
        /* Labels stay on one line so they never wrap and overlap their input */
        #ratchet-master-container .hud-control-group label { color: var(--hud-text-soft); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.02em; white-space: nowrap; overflow: visible; display: flex; justify-content: space-between; gap: 6px; }
        #ratchet-master-container .hud-control-group input[type="range"] { width: 100%; height: 6px; accent-color: var(--hud-green); cursor: pointer; }
        #ratchet-master-container .hud-control-group input[type="number"] { width: 100%; }
        #ratchet-master-container select { background: rgba(8, 11, 18, 0.78); border: 1px solid rgba(142, 174, 212, 0.18); color: var(--hud-text); padding: 4px 6px; border-radius: 9px; font-size: 11px; font-weight: 700; width: 100%; outline: none; appearance: auto; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04); }
        #ratchet-master-container select:disabled { opacity: 0.4; cursor: not-allowed; }
        #ratchet-master-container input[type="checkbox"] { accent-color: var(--hud-green); cursor: pointer; margin: 0; width: 14px; height: 14px; }
        #ratchet-master-container .hud-stat-rail { flex: 1 1 0; min-height: 0; min-width: 0; flex-direction: column; gap: 8px; overflow: hidden; }
        #ratchet-master-container .hud-stats-grid { flex: 1 1 0; min-height: 0; min-width: 0; display: grid; grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); gap: 6px; align-content: stretch; overflow: hidden; position: relative; z-index: 4; }
        #ratchet-master-container .stats-col-inner, #ratchet-master-container .hud-stat-card { min-height: 0; min-width: 0; background: var(--hud-panel); padding: 6px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 3px; box-shadow: 0 18px 36px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.05); overflow: hidden; position: relative; z-index: 4; backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .hud-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; padding: 3px 8px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(148, 177, 214, 0.08); border-radius: 999px; flex: 1 1 0; min-height: 0; }
        #ratchet-master-container .hud-label { color: var(--hud-text-soft); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.34px; }
        #ratchet-master-container .hud-val { color: var(--hud-text); font-size: 12px; font-weight: 800; font-family: "Roboto Mono", monospace; text-align: right; }
        #ratchet-master-container .hud-meta-row { gap: 8px; padding: 0 2px; flex: 0 0 auto; position: relative; z-index: 4; }
        #ratchet-master-container .hud-meta-chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 0; min-width: 0; padding: 8px 10px; background: var(--hud-panel); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; overflow: hidden; box-shadow: 0 16px 34px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(20px) saturate(1.24); }
        #ratchet-master-container .gear-text { font-style: italic; font-weight: 900; text-transform: uppercase; }
        #ratchet-master-container .gear-1-text { color: #94a3b8; }
        #ratchet-master-container .gear-2-text { color: #cbd5e1; }
        #ratchet-master-container .gear-3-text { color: #facc15; }
        #ratchet-master-container .gear-4-text { color: #fb923c; }
        #ratchet-master-container .gear-5-text { color: #f43f5e; text-shadow: 0 0 8px rgba(244, 63, 94, 0.4); }
        #ratchet-master-container .hud-footer-slot { display: flex; flex: 0 0 auto; min-width: 0; min-height: 88px; max-height: 88px; overflow: hidden; position: relative; z-index: 5; }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 {
            width: 100% !important;
            height: 100% !important;
            display: flex !important;
            gap: 8px !important;
            align-items: stretch !important;
            background: transparent !important;
            overflow: hidden !important;
        }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 > * {
            flex: 1 1 0 !important;
            min-width: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: space-between !important;
            gap: 8px !important;
            padding: 10px 12px !important;
            background: var(--hud-panel) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 14px !important;
            box-shadow: 0 16px 34px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
            overflow: hidden !important;
            backdrop-filter: blur(20px) saturate(1.24) !important;
        }
        #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 > * > span {
            color: var(--hud-text-soft) !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            text-transform: none !important;
            text-align: left !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-0,
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1,
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-2 { width: 100% !important; }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1 {
            background: rgba(8, 11, 18, 0.78) !important;
            border: 1px solid rgba(142, 174, 212, 0.18) !important;
            border-radius: 11px !important;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
            padding: 0 10px !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-2 { display: flex !important; align-items: center !important; gap: 8px !important; }
        #ratchet-master-container .hud-footer-slot .sc-941e0ad-0,
        #ratchet-master-container .hud-footer-slot .sc-4932c000-0 {
            display: block !important;
            width: 100% !important;
            min-width: 0 !important;
            background: rgba(8, 11, 18, 0.78) !important;
            border: 1px solid rgba(142, 174, 212, 0.18) !important;
            border-radius: 9px !important;
            color: var(--hud-text) !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            font-family: "Roboto Mono", monospace !important;
            padding: 6px 10px !important;
            box-shadow: none !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-4932c000-1 {
            color: var(--hud-text) !important;
            font-size: 12px !important;
            font-weight: 800 !important;
            font-family: "Roboto Mono", monospace !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-4 {
            margin-left: auto !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            min-width: 20px !important;
            color: var(--hud-text-soft) !important;
        }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-4 svg path { fill: var(--hud-text-soft) !important; }
        #ratchet-master-container .hud-footer-slot .sc-7201bf1a-1:hover { border-color: rgba(25, 243, 255, 0.52) !important; box-shadow: 0 0 0 1px rgba(255, 79, 216, 0.16) inset !important; }
        #ratchet-master-container .hud-native-game-footer-slot { display: flex; flex: 0 0 auto; min-height: 0; min-width: 0; overflow: hidden; }
        @media (max-width: 980px) {
            #ratchet-master-container { padding: 6px !important; }
            #ratchet-master-container .hud-frame { flex-direction: column !important; }
            #ratchet-master-container .hud-native-sidebar-slot {
                width: 100% !important;
                min-width: 0 !important;
                max-width: none !important;
                flex: 0 0 auto !important;
                max-height: 240px !important;
            }
            #ratchet-master-container .hud-footer-slot {
                min-height: 0 !important;
                max-height: none !important;
            }
            #ratchet-master-container .hud-footer-slot > .sc-1d9445d-1 {
                flex-direction: column !important;
                height: auto !important;
            }
        }
        .result.svelte-1oweb16, .multiplier-result, .result-multiplier, .crash-result, .limbo-result, [class*="crash"], [class*="result"][class*="multiplier"], span.result { display: none !important; }
        /* === HIDE DICE SLIDER (thumb/track) that bleeds through HUD === */
        .sc-1d9445d-12.dVJOJA,
        .sc-1d9445d-5.dWEMRV,
        .sc-1d9445d-13.ktRmlk {
            display: none !important;
        }
    `);

    function getUserSetMultiplier() {
        const inpTarget = document.querySelector('input[aria-label="payout selector"]');
        if (inpTarget) return parseFloat(inpTarget.value) || 2.00;
        const inpDice = document.querySelector('input.sc-941e0ad-0.eaPPXw');
        if (inpDice) return parseFloat(inpDice.value) || 1.98;
        return 2;
    }
    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return document.querySelector('.sc-cfbf8337-1.eaQLvl') || null;
    }
    function isUSDDisplayMode() {
        const bal = findBalanceContainer();
        if (!bal) return false;
        if (bal.querySelector('span[title*="$"]')) return true;
        return (bal.textContent || '').trim().startsWith('$');
    }
    function getSolToUsdRate() {
        const bal = findBalanceContainer();
        if (!bal) return null;
        const innerSpan = bal.querySelector('span[title*="$"][title*="SOL"]');
        const t = innerSpan ? (innerSpan.getAttribute('title') || '') : '';
        const m = t.match(/\$\s*([\d,]+\.?\d*)\s*\(([\d,]+\.?\d*)\s*SOL\)/);
        if (m) {
            const usd = parseFloat(m[1].replace(/,/g, ''));
            const sol = parseFloat(m[2].replace(/,/g, ''));
            if (sol > 0 && isFinite(usd) && isFinite(sol)) return usd / sol;
        }
        return null;
    }
    function displayToSol(displayVal) {
        if (!isUSDDisplayMode()) return displayVal;
        const rate = getSolToUsdRate();
        return (rate && rate > 0) ? displayVal / rate : displayVal;
    }
    function solToDisplay(solVal) {
        if (!isUSDDisplayMode()) return solVal;
        const rate = getSolToUsdRate();
        return (rate && rate > 0) ? solVal * rate : solVal;
    }
    function getCurrentBalance() {
        // Always returns SOL. Outer title "X SOL" is invariant to display mode.
        const bal = findBalanceContainer();
        if (!bal) return lastKnownBalance || 0;
        const title = bal.getAttribute('title') || '';
        const match = title.match(/([\d.]+)/);
        if (match) {
            const val = parseFloat(match[1]);
            if (isFinite(val)) {
                lastKnownBalance = val;
                return val;
            }
        }
        return lastKnownBalance || 0;
    }
    function getCurrentBet() {
        // Returns SOL-equivalent. Input value is in active display unit.
        const wagerInp = document.querySelector('input[aria-label="wager"]');
        if (!wagerInp) return minBaseBet;
        const rawVal = parseFloat(wagerInp.value.replace(/[^0-9.]/g, ''));
        if (!isFinite(rawVal) || rawVal <= 0) return minBaseBet;
        return displayToSol(rawVal);
    }
    function formatBetForInput(solAmount) {
        if (!isUSDDisplayMode()) return solAmount.toFixed(8);
        const usd = solToDisplay(solAmount);
        const twoDp = usd.toFixed(2);
        // 2dp USD for clean display, but keep 8dp when 2dp would round to 0
        return (parseFloat(twoDp) === 0 && solAmount > 0) ? usd.toFixed(8) : twoDp;
    }
    function typeIntoInput(inp, value) {
        inp.focus();
        try {
            inp.select();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
        } catch (e) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(inp, value);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
    }
    function setBet(amount) {
        if (!isFinite(amount) || amount < minBaseBet) return false;
        const clamped = Math.min(Math.max(amount, minBaseBet), maxBaseBet);
        desiredBetAmount = clamped;
        lastPlacedBet = clamped;
        const inp = document.querySelector('input[aria-label="wager"]');
        if (!inp) return false;
        typeIntoInput(inp, formatBetForInput(clamped));
        setTimeout(() => {
            if (desiredBetAmount) {
                const currentDisplay = parseFloat(inp.value) || 0;
                const targetDisplay = solToDisplay(desiredBetAmount);
                const tol = isUSDDisplayMode() ? 0.005 : 0.00000005;
                if (Math.abs(currentDisplay - targetDisplay) > tol) {
                    typeIntoInput(inp, formatBetForInput(desiredBetAmount));
                }
            }
        }, 50);
        return true;
    }
    function forceSetBet(amount) {
        setBet(amount);
        setTimeout(() => setBet(amount), 8);
        setTimeout(() => setBet(amount), 25);
        setTimeout(() => setBet(amount), 60);
        setTimeout(() => setBet(amount), 120);
    }
    function startBetGuardian() {
        if (betGuardObserver) return;
        const inp = document.querySelector('input[aria-label="wager"]');
        if (!inp) return;
        betGuardObserver = new MutationObserver(() => {
            if (!desiredBetAmount || !isRapidFiring) return;
            const currentDisplay = parseFloat(inp.value) || 0;
            const targetDisplay = solToDisplay(desiredBetAmount);
            const tol = isUSDDisplayMode() ? 0.005 : 0.00000005;
            if (Math.abs(currentDisplay - targetDisplay) > tol) {
                typeIntoInput(inp, formatBetForInput(desiredBetAmount));
            }
        });
        betGuardObserver.observe(inp, { attributes: true, attributeFilter: ['value'] });
    }
    function stopBetGuardian() {
        if (betGuardObserver) {
            betGuardObserver.disconnect();
            betGuardObserver = null;
        }
        desiredBetAmount = null;
    }
    function getPlayButton() {
        let btn = document.querySelector('.sc-fe9b8b64-1.fmKmkj button.sc-67df7f38-0.kkdRMi');
        if (btn) return btn;
        return Array.from(document.querySelectorAll('button')).find(b =>
            (b.textContent || '').trim().includes('PLAY') || (b.textContent || '').trim().includes('ROLL')
        );
    }
    function findPastBetsContainer() {
        return document.querySelector('.sc-9b1418e2-1') || document.querySelector('.sc-9b1418e2-0');
    }
    function isWin(betDiv) {
        if (!betDiv) return false;
        const style = window.getComputedStyle(betDiv);
        return style.backgroundColor.includes('40, 67, 50');
    }
    function getLatestBetEntry(container) {
        if (!container) return null;
        const elements = container.querySelectorAll('.styles-module___IID9a__game');
        if (elements.length === 0) return null;
        const latest = elements[0];
        // ID derivation: prefer a stable attribute (so React rerenders of
        // the tile's content don't mint a new ID), then fall back to the
        // bet count. The previous formula `textContent + count` flipped
        // mid-bet whenever Nuts re-rendered the tile after the round
        // resolved — visible as a double-count in the stats whenever
        // hotkeys were off (slower bet cadence gives React time to do the
        // two-step render the observer was catching twice).
        const id = latest.getAttribute('data-bet-id')
                || latest.getAttribute('data-game-id')
                || latest.getAttribute('id')
                || ('idx-' + elements.length);
        return { element: latest, id };
    }
    function getLowestCommonAncestor(a, b) {
        if (!a || !b) return null;
        const ancestors = new Set();
        let node = a;
        while (node) {
            ancestors.add(node);
            node = node.parentElement;
        }
        node = b;
        while (node) {
            if (ancestors.has(node)) return node;
            node = node.parentElement;
        }
        return null;
    }
    function getHudHost() {
        const nativeSidebar = findNativeElement('.sc-8d275cfe-1.eGfUZM') || findNativeElement('.sc-8d275cfe-1');
        const nativeStage = findNativeElement('.sc-8d275cfe-3.eertbI') || findNativeElement('.sc-8d275cfe-3');
        const sharedHost = getLowestCommonAncestor(nativeSidebar, nativeStage);
        if (sharedHost && sharedHost !== document.body && sharedHost !== document.documentElement) {
            return sharedHost;
        }
        // Returns null when no Nuts game container is on the page — buildHUD
        // then tears the HUD down. Previously this fell back to document.body,
        // which caused our absolute-positioned overlay to cover the home page
        // / lobby after SPA navigation away from /dice or /target.
        return nativeStage
            || nativeSidebar
            || document.querySelector('.sc-1d9445d-0.cCJWrI')
            || document.querySelector('.sc-1d9445d-0')
            || null;
    }
    function findNativeElement(selector) {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => !el.closest('#ratchet-master-container')) || elements[0] || null;
    }
    function mountSingleElement(slot, element) {
        if (!slot || !element) return;
        if (slot.childElementCount === 1 && slot.firstElementChild === element) return;
        slot.replaceChildren(element);
    }
    function syncNativeHudElements() {
        const nativeSidebar = findNativeElement('.sc-8d275cfe-1.eGfUZM') || findNativeElement('.sc-8d275cfe-1');
        const recentBets = findNativeElement('.sc-9b1418e2-1') || findNativeElement('.sc-9b1418e2-0');
        const sidebarSlot = document.getElementById('hud-native-sidebar-slot');
        const pastBetsSlot = document.getElementById('hud-native-past-bets-slot');
        mountSingleElement(sidebarSlot, nativeSidebar);
        mountSingleElement(pastBetsSlot, recentBets);
        mountSingleElement(
            document.getElementById('hud-footer-slot'),
            findNativeElement('.sc-1d9445d-1.hFwXoL') || findNativeElement('.sc-1d9445d-1')
        );
    }
    /** Map the current Nuts URL to one of the two split tool ids and check
     *  if the user has that specific tool enabled. */
    function isCurrentGameEnabledNuts() {
        const path = location.pathname || '';
        let toolId = null;
        if (/\/dice(?:\/|$|\?|#)/i.test(path)) toolId = 'nuts-dice';
        else if (/\/target(?:\/|$|\?|#)/i.test(path)) toolId = 'nuts-limbo-target';
        if (!toolId) return true; // unknown URL — getHudHost null-check handles it
        try { return isToolIdEnabled(toolId); }
        catch (e) { return true; }
    }

    /** True on a Nuts Dice page only (not Target). Used to conditionally
     *  render the Switch Over/Under button — Target has no direction. */
    function isOnDicePage() {
        return /\/dice(?:\/|$|\?|#)/i.test(location.pathname || '');
    }

    /** Find Nuts's "Roll Over / Roll Under" swap button. Nuts uses
     *  hashed CSS module classes that change on every deploy, so we
     *  walk up from the text label to the enclosing button. */
    function getRollOverUnderSwap() {
        const label = Array.from(document.querySelectorAll('span'))
            .find(s => /^Roll\s+Over$|^Roll\s+Under$|^ROLL\s+OVER$|^ROLL\s+UNDER$/.test((s.textContent || '').trim()));
        if (!label) return null;
        return label.closest('button');
    }

    function buildHUD() {
        const gameDisplay = getHudHost();
        if (!gameDisplay || !isCurrentGameEnabledNuts()) {
            // SPA navigation away from a Nuts game page (e.g. user clicked
            // the nuts.gg logo to go home / open the lobby), OR the user
            // disabled the specific game tool (Nuts Dice / Nuts Limbo/Target).
            // Remove any existing HUD so its absolute-positioned overlay
            // doesn't sit on top of the new page. Native elements we
            // relocated into HUD slots get torn down with the HUD; Nuts
            // re-renders them when the user navigates back to a game.
            const existing = document.getElementById('ratchet-master-container');
            if (existing) existing.remove();
            return;
        }
        let hud = document.getElementById('ratchet-master-container');
        if (window.getComputedStyle(gameDisplay).position === 'static') gameDisplay.style.position = 'relative';
        if (hud && hud.parentElement !== gameDisplay) gameDisplay.appendChild(hud);
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'ratchet-master-container';
            hud.innerHTML = `
                <div class="hud-frame">
                    <div id="hud-native-sidebar-slot" class="hud-native-sidebar-slot"></div>
                    <div class="hud-workspace">
                        <div id="hud-native-past-bets-slot" class="hud-native-past-bets-slot"></div>
                        <div class="mode-wrap">
                            <button id="mode-manual" class="mode-btn">Manual</button>
                            <button id="mode-iow" class="mode-btn">IOW</button>
                            <button id="mode-smart" class="mode-btn">Smart</button>
                        </div>
                        <div id="hud-content"></div>
                        <div id="hud-footer-slot" class="hud-footer-slot"></div>
                    </div>
                </div>
                <div id="hud-native-game-footer-slot" class="hud-native-game-footer-slot"></div>
            `;
            gameDisplay.appendChild(hud);
            document.getElementById('mode-manual').onclick = () => switchMode('manual');
            document.getElementById('mode-iow').onclick = () => switchMode('iow');
            document.getElementById('mode-smart').onclick = () => switchMode('smart');
            buildHUDContent();
        }
        hud.dataset.mode = ACTIVE_MODE;
        hud.style.removeProperty('height');
        syncModeButtons();
        syncNativeHudElements();
        setTimeout(syncNativeHudElements, 350);
    }
    function buildHUDContent() {
        const content = document.getElementById('hud-content');
        const hud = document.getElementById('ratchet-master-container');
        if (!content) return;
        if (hud) hud.dataset.mode = ACTIVE_MODE;
        syncModeButtons();
        content.innerHTML = '';
        let html = '';
        if (ACTIVE_MODE === 'iow') {
            html = `
                <div class="hud-shell">
                    <div class="hud-top-bar">
                        <div class="control-section hud-panel">
                            <div class="input-row">
                                <div class="input-cluster">
                                    <label style="color:#94a3b8;font-size:10px;font-weight:800;white-space:nowrap;">Base bet</label>
                                    <div class="input-group">
                                        <input id="h-base" type="number" step="0.00000001" value="${baseBet.toFixed(8)}">
                                        <button id="h-double-base" class="quick-btn">2x</button>
                                        <button id="h-half-base" class="quick-btn">1/2</button>
                                    </div>
                                    <div class="hud-risk-container">
                                        <label>Win increase % <input id="h-win-inc" type="number" min="0" value="${winIncreasePercent}"></label>
                                        <label>Loss reset <input id="h-loss-reset" type="number" min="1" value="${lossStreakReset}"></label>
                                        <label>Win reset <input id="h-wins-reset" type="number" min="1" value="${winsBeforeReset || ''}"></label>
                                        <label>Autostop on Balance: <input id="h-autostop" type="number" step="0.00000001" value="${autoStopBalance !== null ? autoStopBalance.toFixed(8) : ''}" placeholder="OFF"></label>
                                    </div>
                                </div>
                                <div class="btn-group">
                                    <button id="h-reset" class="hud-reset-btn">RESET STATS</button>
                                    ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                                    <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="hud-split">
                        <div class="hud-pane primary">
                            <div class="status-bar" id="h-target"> base bet: 0.00000010 | Wins: 0 | LossStreak: 0 </div>
                            <div class="hud-graph-box" id="h-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="hud-pane secondary">
                            <div class="hud-stat-rail">
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                </div>
                                <div class="hud-stat-card">
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:var(--hud-positive);">-</span>
                                </div>
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:var(--hud-negative);">-</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (ACTIVE_MODE === 'smart') {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Initializing Data Link...</span>
                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Aggression <span id="h-agg-val" style="color:#fff;">${aggressionLevel.toFixed(1)}x</span></label>
                            <input type="range" id="h-agg" min="0.5" max="3.0" step="0.1" value="${aggressionLevel.toFixed(1)}">
                        </div>
                        <div class="hud-control-group">
                            <label style="flex-direction: row; justify-content: flex-start; gap: 6px; cursor: pointer; color: #94a3b8;">
                                <input type="checkbox" id="h-lock-agg-chk" ${lockAggressionState ? 'checked' : ''}> Lock State
                            </label>
                            <select id="h-lock-gear-sel" ${lockAggressionState ? '' : 'disabled'}>
                                <option value="1" ${lockedGearLevel === 1 ? 'selected' : ''}>Conservative</option>
                                <option value="2" ${lockedGearLevel === 2 ? 'selected' : ''}>Steady</option>
                                <option value="3" ${lockedGearLevel === 3 ? 'selected' : ''}>Balanced</option>
                                <option value="4" ${lockedGearLevel === 4 ? 'selected' : ''}>Press</option>
                                <option value="5" ${lockedGearLevel === 5 ? 'selected' : ''}>Aggro</option>
                            </select>
                        </div>
                        <div class="hud-control-group">
                            <label>Stop Loss %</label>
                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Take Profit %</label>
                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Autostop on Balance:</label>
                            <input id="h-autostop" type="number" step="0.00000001" value="${autoStopBalance !== null ? autoStopBalance.toFixed(8) : ''}" placeholder="OFF">
                        </div>
                        <div class="btn-group">
                            <button id="h-reset" class="hud-reset-btn">RESET</button>
                            ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>
                    </div>
                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="stats-col">
                            <div class="hud-stats-grid">
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Aggression state</span><span id="h-state" class="hud-val gear-text gear-1-text">GEAR 1</span></div>
                                    <div class="hud-row"><span class="hud-label">Momentum Window</span><span id="h-hot" class="hud-val">0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 | 0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                            </div>
                            <div class="hud-meta-row">
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Best Streaks</span>
                                    <span id="h-best-w" class="hud-val" style="color:var(--hud-positive);">-</span>
                                </div>
                                <div class="hud-meta-chip">
                                    <span class="hud-label">Worst Streaks</span>
                                    <span id="h-worst-l" class="hud-val" style="color:var(--hud-negative);">-</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            html = `
                <div class="hud-shell">
                    <div class="hud-header">
                        <span id="h-target" class="hud-target-text">Manual • Full Stats • Spacebar Rapid</span>
                    </div>
                    <div class="hud-controls-deck hud-panel">
                        <div class="hud-control-group">
                            <label>Bet</label>
                            <div class="input-group">
                                <input id="h-manual-bet" type="number" step="0.00000001" min="0.00000001" value="${manualBet.toFixed(8)}" style="width: 96px; flex: 0 0 auto;">
                                <button id="h-manual-double" class="quick-btn">2x</button>
                                <button id="h-manual-half" class="quick-btn">1/2</button>
                            </div>
                        </div>
                        <div class="hud-control-group">
                            <label>Stop Loss %</label>
                            <input id="h-sl" type="number" min="0" max="50" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Take Profit %</label>
                            <input id="h-tp" type="number" min="0" max="100" value="0" step="0.5">
                        </div>
                        <div class="hud-control-group">
                            <label>Autostop on Balance:</label>
                            <input id="h-autostop" type="number" step="0.00000001" value="${autoStopBalance !== null ? autoStopBalance.toFixed(8) : ''}" placeholder="OFF">
                        </div>
                        <div class="btn-group">
                            <button id="h-reset" class="hud-reset-btn">RESET</button>
                            ${isOnDicePage() ? '<button id="h-switch-ou" class="hud-switch-ou-btn">Switch Over/Under</button>' : ''}
                            <button id="h-rapid-toggle" class="hud-rapid-btn start">START</button>
                        </div>
                    </div>
                    <div class="hud-body">
                        <div class="graph-col">
                            <div class="hud-graph-box">
                                <canvas id="h-custom-graph"></canvas>
                            </div>
                        </div>
                        <div class="stats-col">
                            <div class="hud-stats-grid">
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Starting Balance</span><span id="h-start-bal" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Profit/Loss</span><span id="h-profit" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Balance</span><span id="h-peak-bal" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Peak Profit</span><span id="h-high-profit" class="hud-val" style="color:var(--hud-positive);">0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-row"><span class="hud-label">Total Bets</span><span id="h-total-bets" class="hud-val">0</span></div>
                                    <div class="hud-row"><span class="hud-label">Total Wagered</span><span id="h-wagered" class="hud-val">0.00</span></div>
                                    <div class="hud-row"><span class="hud-label">Wins / Losses</span><span id="h-wl" class="hud-val">0 / 0</span></div>
                                    <div class="hud-row"><span class="hud-label">Session RTP</span><span id="h-rtp" class="hud-val">100.00%</span></div>
                                    <div class="hud-row"><span class="hud-label">Streak (W|L)</span><span id="h-streaks" class="hud-val">0/0 | 0/0</span></div>
                                    <div class="hud-row"><span class="hud-label">Multiplier Performance</span><span id="h-mult-perf" class="hud-val">1 in 0.00</span></div>
                                </div>
                                <div class="stats-col-inner">
                                    <div class="hud-meta-row">
                                        <div class="hud-meta-chip">
                                            <span class="hud-label">Best Streaks</span>
                                            <span id="h-best-w" class="hud-val" style="color:var(--hud-positive);">-</span>
                                        </div>
                                        <div class="hud-meta-chip">
                                            <span class="hud-label">Worst Streaks</span>
                                            <span id="h-worst-l" class="hud-val" style="color:var(--hud-negative);">-</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }
        content.innerHTML = html;
        attachListeners();
    }
    function switchMode(newMode) {
        // Detect "empty hud-content" — happens when leaving Advanced IOW
        // back to the same mode that was active before (activateTools clears
        // #hud-content but doesn't touch ACTIVE_MODE, so a same-mode click
        // would otherwise early-return and leave the HUD blank).
        const content = document.getElementById('hud-content');
        const needsRebuild = !!content && content.children.length === 0;
        if (newMode === ACTIVE_MODE && !needsRebuild) return;
        ACTIVE_MODE = newMode;
        syncModeButtons();
        if (isRapidFiring) stopRapidFire();
        // Entering Manual: seed manualBet from the wager input so the HUD's
        // bet field reflects what the user already had typed there.
        if (newMode === 'manual') {
            const cur = getCurrentBet();
            if (isFinite(cur) && cur >= minBaseBet) manualBet = cur;
        }
        buildHUDContent();
        resetStats();
    }
    function syncModeButtons() {
        document.querySelectorAll('#ratchet-master-container .mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `mode-${ACTIVE_MODE}`);
        });
    }
    function attachListeners() {
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) rapidBtn.onclick = () => { if (!isRapidFiring) startRapidFire(); else stopRapidFire(); };
        const resetBtn = document.getElementById('h-reset');
        if (resetBtn) resetBtn.onclick = resetStats;
        // Autostop on Balance — shared across Manual / IOW / Smart modes.
        // Each mode's HTML renders its own #h-autostop input; the rapid-fire
        // tick already checks autoStopBalance globally and stops when reached.
        const autostopInp = document.getElementById('h-autostop');
        if (autostopInp) {
            autostopInp.addEventListener('input', () => { autoStopBalance = parseFloat(autostopInp.value) || null; });
            autostopInp.addEventListener('blur', () => { let v = parseFloat(autostopInp.value) || 0; autostopInp.value = v ? v.toFixed(8) : ''; autoStopBalance = v || null; });
        }
        // Switch Over/Under — Dice only, shared across Manual / IOW / Smart.
        // Briefly pause rapid-fire so the swap click always commits cleanly
        // between bets; without this the swap often lands mid-click-cycle
        // and Nuts ignores it.
        const switchOuBtn = document.getElementById('h-switch-ou');
        if (switchOuBtn) {
            switchOuBtn.addEventListener('click', async () => {
                if (switchOuBtn.disabled) return;
                switchOuBtn.disabled = true;
                try {
                    const wasRunning = isRapidFiring;
                    if (wasRunning) stopRapidFire();
                    await new Promise(r => setTimeout(r, 40));
                    const swap = getRollOverUnderSwap();
                    if (swap) swap.click();
                    await new Promise(r => setTimeout(r, 60));
                    if (wasRunning) startRapidFire();
                } catch (e) { console.error('[Switch Over/Under] failed:', e); }
                setTimeout(() => { switchOuBtn.disabled = false; }, 250);
            });
        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base');
            if (baseInp) {
                baseInp.addEventListener('input', () => { baseBet = parseFloat(baseInp.value) || minBaseBet; });
                baseInp.addEventListener('blur', () => { let v = parseFloat(baseInp.value) || minBaseBet; baseInp.value = v.toFixed(8); baseBet = v; });
            }
            const doubleBtn = document.getElementById('h-double-base');
            if (doubleBtn) doubleBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet;
                val *= 2;
                document.getElementById('h-base').value = val.toFixed(8);
                baseBet = val;
                if (isRapidFiring) forceSetBet(val);
            });
            const halfBtn = document.getElementById('h-half-base');
            if (halfBtn) halfBtn.addEventListener('click', () => {
                let val = parseFloat(document.getElementById('h-base').value) || minBaseBet;
                val *= 0.5;
                val = Math.max(minBaseBet, val);
                document.getElementById('h-base').value = val.toFixed(8);
                baseBet = val;
                if (isRapidFiring) forceSetBet(val);
            });
            const winInc = document.getElementById('h-win-inc'); if (winInc) winInc.addEventListener('input', () => { winIncreasePercent = parseFloat(winInc.value) || 125; });
            const lossReset = document.getElementById('h-loss-reset'); if (lossReset) lossReset.addEventListener('input', () => { lossStreakReset = parseInt(lossReset.value, 10) || 3; });
            const winsReset = document.getElementById('h-wins-reset'); if (winsReset) winsReset.addEventListener('input', () => { winsBeforeReset = parseInt(winsReset.value, 10) || null; });
        } else {
            const slInp = document.getElementById('h-sl'); if (slInp) slInp.addEventListener('input', () => { stopLossPct = parseFloat(slInp.value) || 0; });
            const tpInp = document.getElementById('h-tp'); if (tpInp) tpInp.addEventListener('input', () => { takeProfitPct = parseFloat(tpInp.value) || 0; });
            if (ACTIVE_MODE === 'manual') {
                // Manual mode bet controls — input + 2x/1/2 buttons that
                // immediately push the new value into the wager input when
                // rapid-fire is running, so the user can change bet size
                // without stopping autoplay. Mirrors IOW's pattern above.
                const manualInp = document.getElementById('h-manual-bet');
                if (manualInp) {
                    manualInp.addEventListener('input', () => {
                        const v = parseFloat(manualInp.value);
                        if (isFinite(v) && v >= minBaseBet) {
                            manualBet = v;
                            if (isRapidFiring) forceSetBet(v);
                        }
                    });
                    manualInp.addEventListener('blur', () => {
                        let v = parseFloat(manualInp.value) || minBaseBet;
                        if (v < minBaseBet) v = minBaseBet;
                        manualInp.value = v.toFixed(8);
                        manualBet = v;
                        if (isRapidFiring) forceSetBet(v);
                    });
                }
                const manualDouble = document.getElementById('h-manual-double');
                if (manualDouble) manualDouble.addEventListener('click', () => {
                    const inp = document.getElementById('h-manual-bet');
                    let v = parseFloat(inp.value) || minBaseBet;
                    v *= 2;
                    inp.value = v.toFixed(8);
                    manualBet = v;
                    if (isRapidFiring) forceSetBet(v);
                });
                const manualHalf = document.getElementById('h-manual-half');
                if (manualHalf) manualHalf.addEventListener('click', () => {
                    const inp = document.getElementById('h-manual-bet');
                    let v = parseFloat(inp.value) || minBaseBet;
                    v = Math.max(minBaseBet, v * 0.5);
                    inp.value = v.toFixed(8);
                    manualBet = v;
                    if (isRapidFiring) forceSetBet(v);
                });
            }
            if (ACTIVE_MODE === 'smart') {
                const aggInp = document.getElementById('h-agg');
                if (aggInp) aggInp.addEventListener('input', e => { aggressionLevel = parseFloat(e.target.value); const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`; });
                const lockChk = document.getElementById('h-lock-agg-chk');
                const gearSel = document.getElementById('h-lock-gear-sel');
                if (lockChk && gearSel) {
                    lockChk.addEventListener('change', (e) => {
                        lockAggressionState = e.target.checked;
                        gearSel.disabled = !lockAggressionState;
                        updateUI();
                    });
                    gearSel.addEventListener('change', (e) => {
                        lockedGearLevel = parseInt(e.target.value, 10);
                        updateUI();
                    });
                }
            }
        }
    }
    function resetStats() {
        const bal = getCurrentBalance();
        sessionPeak = bal; initialBalance = bal; lastKnownBalance = bal;
        totalWagered = 0; highestProfit = 0; totalWins = 0; totalLosses = 0; totalBets = 0;
        lossStreak = 0; counter = 0; lastBetId = null; profitHistory = [0]; lastAmount = 0;
        betHistory = []; recentWins = []; topWinStreaks = []; topLossStreaks = [];
        curLossStreak = 0; maxLossStreak = 0; curWinStreak = 0; maxWinStreak = 0;
        multGames = 0; multWins = 0; lastResult = null; autoPaused = false; stopLossPct = 0; takeProfitPct = 0;
        rapidBlockedSince = 0; rapidFireStartedAt = 0; lastObservedBetTime = 0;
        lastPlacedBet = baseBet;
        if (isRapidFiring) stopRapidFire();
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseInp.value = baseBet.toFixed(8);
        } else if (ACTIVE_MODE === 'smart') {
            const aggInp = document.getElementById('h-agg'); if (aggInp) aggInp.value = aggressionLevel.toFixed(1);
            const valEl = document.getElementById('h-agg-val'); if (valEl) valEl.textContent = `${aggressionLevel.toFixed(1)}x`;
        }
        const sl = document.getElementById('h-sl'); if (sl) sl.value = '0';
        const tp = document.getElementById('h-tp'); if (tp) tp.value = '0';
        syncLastSeenBet();
        updateUI();
    }
    function syncLastSeenBet(container = pastBetsContainer || findPastBetsContainer()) {
        const latestBet = getLatestBetEntry(container);
        lastBetId = latestBet ? latestBet.id : null;
    }
    function triggerWinResetPulse() {
        const hud = document.getElementById('ratchet-master-container');
        if (!hud || ACTIVE_MODE !== 'iow') return;
        if (winResetPulseTimer) clearTimeout(winResetPulseTimer);
        hud.classList.remove('iow-win-reset-pulse');
        void hud.offsetWidth;
        hud.classList.add('iow-win-reset-pulse');
        winResetPulseTimer = setTimeout(() => {
            hud.classList.remove('iow-win-reset-pulse');
            winResetPulseTimer = null;
        }, 800);
    }
    // Tracks bet tile DOM nodes we've already counted. WeakSet so we don't
    // pin DOM nodes alive after Nuts GC's old bets out of the feed. Solves
    // the double-count seen on Nuts target/limbo when hotkeys are off:
    // there, the slower bet cadence lets the observer see two distinct
    // mutations per bet (placeholder + real result render), and the prior
    // ID-based dedup couldn't keep them apart.
    const _nutsProcessedBetEls = new WeakSet();
    function startObserver() {
        pastBetsContainer = findPastBetsContainer();
        if (!pastBetsContainer) { setTimeout(startObserver, 500); return; }
        if (observer) observer.disconnect();
        // Seed already-present bet tiles into the processed set so they
        // don't get re-counted on first mount or after resetStats.
        const existing = pastBetsContainer.querySelectorAll('.styles-module___IID9a__game');
        existing.forEach(el => _nutsProcessedBetEls.add(el));
        syncLastSeenBet(pastBetsContainer);
        observer = new MutationObserver((mutations) => {
            // Confirmed live: Nuts Target/Limbo emits **TWO tiles per single
            // bet** in the same mutation batch — different multipliers but
            // both share the win/loss background color (one bet shown two
            // ways in the feed). Counting both was the "double-count when
            // hotkeys are off" symptom. Solution: per-callback-batch dedup —
            // only the first matching tile in this batch gets counted. Real
            // back-to-back bets always land in separate mutation batches
            // (separate microtasks) so this doesn't undercount rapid fire.
            let countedThisBatch = false;
            outer: for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (countedThisBatch) break outer;
                    if (node.nodeType !== 1) continue;
                    const tile = node.matches && node.matches('.styles-module___IID9a__game')
                        ? node
                        : (node.querySelector && node.querySelector('.styles-module___IID9a__game'));
                    if (!tile) continue;
                    // Per-tile WeakSet dedup — protects against the same DOM
                    // node bubbling through twice (defense in depth on top
                    // of per-batch).
                    if (_nutsProcessedBetEls.has(tile)) continue;
                    // Skip placeholder/loading tiles (empty text).
                    if (!(tile.textContent || '').trim()) continue;
                    _nutsProcessedBetEls.add(tile);
                    countedThisBatch = true;
                    processNewBet(pastBetsContainer, tile);
                }
            }
        });
        observer.observe(pastBetsContainer, { childList: true, subtree: true });
    }
    function processNewBet(container, specificTile) {
        // If called with a specific tile (from the observer's addedNodes
        // path), use it directly. Falling back to "find latest" preserves
        // compatibility with the syncLastSeenBet / manual probe callers.
        const latestBet = specificTile
            ? { element: specificTile, id: specificTile }
            : getLatestBetEntry(container);
        if (!latestBet || (!specificTile && latestBet.id === lastBetId)) return;
        lastBetId = latestBet.id;
        lastObservedBetTime = Date.now();
        rapidBlockedSince = 0;
        totalBets++;
        const betAmt = getCurrentBet();
        const won = isWin(latestBet.element);
        handleBetResult(won, betAmt);
        if (ACTIVE_MODE === 'iow') {
            if (won) {
                lossStreak = 0; counter++;
                if (isRapidFiring) {
                    const curBet = lastPlacedBet;
                    let newBet = curBet * (1 + winIncreasePercent / 100);
                    newBet = Math.min(newBet, maxBaseBet);
                    forceSetBet(newBet);
                    lastPlacedBet = newBet;
                }
                if (winsBeforeReset && counter >= winsBeforeReset) {
                    counter = 0;
                    triggerWinResetPulse();
                    if (isRapidFiring) {
                        forceSetBet(baseBet);
                        lastPlacedBet = baseBet;
                    }
                }
            } else {
                lossStreak++;
                if (lossStreak >= lossStreakReset) {
                    counter = 0;
                    if (isRapidFiring) {
                        forceSetBet(baseBet);
                        lastPlacedBet = baseBet;
                    }
                }
            }
            if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
        }
        updateUI();
    }
    function handleBetResult(isWinResult, betAmt) {
        if (isWinResult) totalWins++; else totalLosses++;
        totalWagered += betAmt || minBaseBet;
        const currentProfit = getCurrentBalance() - initialBalance;
        if (currentProfit > highestProfit) highestProfit = currentProfit;
        profitHistory.push(currentProfit); if (profitHistory.length > MAX_GRAPH_POINTS) profitHistory.shift();
        if (isWinResult) {
            if (lastResult === false && curLossStreak > 0) { topLossStreaks.push(curLossStreak); topLossStreaks.sort((a,b)=>b-a); if (topLossStreaks.length > 10) topLossStreaks.pop(); }
            curWinStreak++; curLossStreak = 0; multWins++;
        } else {
            if (lastResult === true && curWinStreak > 0) { topWinStreaks.push(curWinStreak); topWinStreaks.sort((a,b)=>b-a); if (topWinStreaks.length > 10) topWinStreaks.pop(); }
            curLossStreak++; curWinStreak = 0;
        }
        lastResult = isWinResult;
        betHistory.push(isWinResult); recentWins.push(isWinResult);
        if (recentWins.length > 10) recentWins.shift();
        if (betHistory.length > historyWindow) betHistory.shift();
        multGames++;
        maxLossStreak = Math.max(maxLossStreak, curLossStreak);
        maxWinStreak = Math.max(maxWinStreak, curWinStreak);
        if ((ACTIVE_MODE === 'smart' || ACTIVE_MODE === 'manual')) {
            if (stopLossPct > 0 && currentProfit <= -initialBalance * (stopLossPct / 100)) autoPaused = true;
            if (takeProfitPct > 0 && currentProfit >= initialBalance * (takeProfitPct / 100)) autoPaused = true;
            if (autoPaused && isRapidFiring) stopRapidFire();
        }
        // Autostop on Balance — fires for every mode (Manual / IOW / Smart).
        // Previously this check was nested inside the IOW-only branch of the
        // bet handler, so the input did nothing in Manual or Smart mode.
        if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) stopRapidFire();
    }
    function updateClicks(cps) {
        if (clickInterval) { clearInterval(clickInterval); clickInterval = null; }
        if (cps > 0 && playButton) {
            const clickIntervalTime = 1000 / cps;
            clickInterval = setInterval(() => { playButton.click(); }, clickIntervalTime);
        }
    }
    function updateSpacePWM(duty) {
        if (spaceTimeout) { clearTimeout(spaceTimeout); spaceTimeout = null; }
        if (spaceInterval) { clearInterval(spaceInterval); spaceInterval = null; }
        if (isSpaceHeldDown && duty !== 100) {
            simulateKeyUp(32);
            isSpaceHeldDown = false;
        }
        if (duty <= 0) { if (!isSpaceHeldDown) simulateKeyUp(32); return; }
        if (duty === 100) {
            if (!isSpaceHeldDown) {
                simulateKeyDown(32, false);
                isSpaceHeldDown = true;
                spaceTimeout = setTimeout(() => {
                    spaceInterval = setInterval(() => { simulateKeyDown(32, true); }, 30);
                }, 400);
            }
            return;
        }
        const period = 100;
        const downTime = (duty / 100) * period;
        const upTime = period - downTime;
        function pulse() {
            simulateKeyDown(32, false);
            spaceTimeout = setTimeout(() => {
                simulateKeyUp(32);
                spaceTimeout = setTimeout(pulse, upTime);
            }, downTime);
        }
        pulse();
    }
    function simulateKeyDown(keyCode, repeat = false) {
        const downEvent = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: repeat });
        document.dispatchEvent(downEvent);
        const pressEvent = new KeyboardEvent('keypress', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: repeat });
        document.dispatchEvent(pressEvent);
    }
    function simulateKeyUp(keyCode) {
        const event = new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
    }
    function startRapidFire() {
        if (isRapidFiring) return;
        isRapidFiring = true;
        rapidBlockedSince = 0;
        rapidFireStartedAt = Date.now();
        lastObservedBetTime = 0;
        syncLastSeenBet();
        lastPlacedBet = baseBet;
        if (ACTIVE_MODE === 'iow') forceSetBet(baseBet);
        if (ACTIVE_MODE === 'manual') forceSetBet(manualBet);
        startBetGuardian();
        updateUI();
        playButton = getPlayButton();
        if (!playButton) {
            console.error('Play button not found!');
            stopRapidFire();
            return;
        }
        updateClicks(30);
        updateSpacePWM(70);
        if (ACTIVE_MODE === 'iow' && !iowEnforcerInterval) {
            iowEnforcerInterval = setInterval(() => {
                if (isRapidFiring && ACTIVE_MODE === 'iow') {
                    const current = getCurrentBet();
                    if (Math.abs(current - lastPlacedBet) > 0.00000005) {
                        forceSetBet(lastPlacedBet);
                    }
                }
            }, 80);
        }
    }
    function stopRapidFire() {
        isRapidFiring = false;
        updateClicks(0);
        if (spaceTimeout) { clearTimeout(spaceTimeout); spaceTimeout = null; }
        if (spaceInterval) { clearInterval(spaceInterval); spaceInterval = null; }
        simulateKeyUp(32);
        isSpaceHeldDown = false;
        if (iowEnforcerInterval) {
            clearInterval(iowEnforcerInterval);
            iowEnforcerInterval = null;
        }
        stopBetGuardian();
        updateUI();
    }
    function monitorRapidFireHealth() {
        if (!isRapidFiring) return;
        const now = Date.now();
        const betBtn = getPlayButton();
        if (!betBtn || betBtn.disabled) {
            if (!rapidBlockedSince) rapidBlockedSince = now;
            if (now - rapidBlockedSince >= RAPID_BLOCKED_STOP_MS) stopRapidFire();
            return;
        }
        rapidBlockedSince = 0;
        const lastSeenBetTime = lastObservedBetTime || rapidFireStartedAt;
        if (lastSeenBetTime && now - lastSeenBetTime >= RAPID_STALL_STOP_MS) stopRapidFire();
    }
    function drawGraph() {
        const canvas = document.getElementById('h-custom-graph');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width = canvas.offsetWidth;
        const height = canvas.height = canvas.offsetHeight;
        ctx.clearRect(0, 0, width, height);
        if (profitHistory.length < 2) return;
        let maxVal = Math.max(...profitHistory, 0);
        let minVal = Math.min(...profitHistory, 0);
        const range = (maxVal - minVal) || 1;
        const padding = range * 0.15;
        maxVal += padding; minVal -= padding;
        const totalRange = maxVal - minVal;
        const zeroY = height - ((0 - minVal) / totalRange) * height;
        const zeroPct = Math.max(0, Math.min(1, zeroY / height));
        const lineGrad = ctx.createLinearGradient(0, 0, 0, height);
        lineGrad.addColorStop(0, '#43f6ff'); lineGrad.addColorStop(zeroPct, '#43f6ff'); lineGrad.addColorStop(zeroPct, '#ff6bb0'); lineGrad.addColorStop(1, '#ff6bb0');
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(67, 246, 255, 0.22)'); fillGrad.addColorStop(zeroPct, 'rgba(67, 246, 255, 0.22)'); fillGrad.addColorStop(zeroPct, 'rgba(255, 107, 176, 0.22)'); fillGrad.addColorStop(1, 'rgba(255, 107, 176, 0.22)');
        const stepX = width / (profitHistory.length - 1);
        ctx.beginPath();
        profitHistory.forEach((val, i) => {
            const x = i * stepX;
            const y = height - ((val - minVal) / totalRange) * height;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.lineTo(width, zeroY); ctx.lineTo(0, zeroY); ctx.closePath();
        ctx.fillStyle = fillGrad; ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    function formatCurrency(solAmount) {
        if (!isFinite(solAmount)) return '0.00';
        if (isUSDDisplayMode()) {
            const rate = getSolToUsdRate();
            if (rate && rate > 0) {
                const usd = solAmount * rate;
                const sign = usd < 0 ? '-$' : '$';
                return `${sign}${Math.abs(usd).toFixed(2)}`;
            }
        }
        return solAmount.toFixed(8);
    }
    /** Populate Multiplier Performance + Best/Worst Streaks for whichever
     *  mode is currently rendering them. Idempotent — silently skips any
     *  element id that's absent from the current HUD layout. */
    function populateAdvancedStats() {
        const perfEl = document.getElementById('h-mult-perf');
        if (perfEl && multWins > 0) {
            const actualRatio = multGames / multWins;
            const recentHit = recentWins.filter(Boolean).length;
            const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
            const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
            const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? 'var(--hud-positive)' : 'var(--hud-negative)') : 'inherit';
            perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
            perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? 'var(--hud-positive)' : 'var(--hud-negative)';
        }
        const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
        const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
        const bestWEl = document.getElementById('h-best-w');
        if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
        const worstLEl = document.getElementById('h-worst-l');
        if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
    }

    function updateUI() {
        const balance = getCurrentBalance();
        const profit = balance - initialBalance;
        const startBalEl = document.getElementById('h-start-bal'); if (startBalEl) startBalEl.textContent = formatCurrency(initialBalance);
        const profitEl = document.getElementById('h-profit'); if (profitEl) { profitEl.textContent = formatCurrency(profit); profitEl.style.color = profit > 0 ? 'var(--hud-positive)' : (profit < 0 ? 'var(--hud-negative)' : 'var(--hud-text)'); }
        const peakBalEl = document.getElementById('h-peak-bal'); if (peakBalEl) peakBalEl.textContent = formatCurrency(sessionPeak);
        const highProfitEl = document.getElementById('h-high-profit'); if (highProfitEl) highProfitEl.textContent = formatCurrency(highestProfit);
        const wageredEl = document.getElementById('h-wagered'); if (wageredEl) wageredEl.textContent = formatCurrency(totalWagered);
        const rtp = totalWagered > 0 ? ((totalWagered + profit) / totalWagered) * 100 : 100;
        const rtpEl = document.getElementById('h-rtp'); if (rtpEl) { rtpEl.textContent = rtp.toFixed(2) + '%'; rtpEl.style.color = rtp >= 100 ? 'var(--hud-positive)' : 'var(--hud-negative)'; }
        const totalBetsEl = document.getElementById('h-total-bets'); if (totalBetsEl) totalBetsEl.textContent = totalBets;
        const wlEl = document.getElementById('h-wl'); if (wlEl) wlEl.innerHTML = `<span style="color:var(--hud-positive);">${totalWins}</span> / <span style="color:var(--hud-negative);">${totalLosses}</span>`;
        const rapidBtn = document.getElementById('h-rapid-toggle');
        if (rapidBtn) {
            if (isRapidFiring) { rapidBtn.textContent = 'STOP'; rapidBtn.className = 'hud-rapid-btn stop'; }
            else { rapidBtn.textContent = 'START'; rapidBtn.className = 'hud-rapid-btn start'; }
        }
        if (ACTIVE_MODE === 'iow') {
            const targetEl = document.getElementById('h-target');
            if (targetEl) targetEl.innerHTML = `base bet: ${formatCurrency(baseBet)} | Wins: <span style="color:var(--hud-positive)">${counter}</span> | LossStreak: <span style="color:var(--hud-negative)">${lossStreak}</span>`;
            populateAdvancedStats();
        } else if (ACTIVE_MODE === 'smart') {
            const streaksEl = document.getElementById('h-streaks'); if (streaksEl) streaksEl.innerHTML = `<span style="color:var(--hud-positive);">${curWinStreak}/${maxWinStreak}</span> | <span style="color:var(--hud-negative);">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            const perfEl = document.getElementById('h-mult-perf');
            if (perfEl && multWins > 0) {
                const actualRatio = multGames / multWins;
                const recentHit = recentWins.filter(Boolean).length;
                const recentRatio = recentWins.length > 0 ? recentWins.length / Math.max(1, recentHit) : actualRatio;
                const trend = recentWins.length >= 10 ? (recentRatio <= actualRatio ? ' ▲' : ' ▼') : '';
                const trendColor = recentWins.length >= 10 ? (recentRatio <= actualRatio ? 'var(--hud-positive)' : 'var(--hud-negative)') : 'inherit';
                perfEl.innerHTML = `1 in ${actualRatio.toFixed(2)}<span style="color:${trendColor}; font-size:12px;">${trend}</span>`;
                perfEl.style.color = actualRatio <= (trackedMultiplier || 1) ? 'var(--hud-positive)' : 'var(--hud-negative)';
            }
            const winsCount = betHistory.filter(Boolean).length;
            const progress = winsNeeded > 0 ? winsCount / winsNeeded : 0;
            let gear = 1; let label = 'Gear 1 (Cold)';
            if (lockAggressionState) {
                gear = lockedGearLevel;
                if (gear === 1) label = 'Conservative (LOCKED)';
                else if (gear === 2) label = 'Steady (LOCKED)';
                else if (gear === 3) label = 'Balanced (LOCKED)';
                else if (gear === 4) label = 'Press (LOCKED)';
                else { gear = 5; label = 'Aggro (LOCKED)'; }
            } else {
                if (progress <= 0.4) { gear = 1; label = 'Conservative'; }
                else if (progress <= 0.8) { gear = 2; label = 'Steady'; }
                else if (progress <= 1.1) { gear = 3; label = 'Balanced'; }
                else if (progress <= 1.45) { gear = 4; label = 'Press'; }
                else { gear = 5; label = 'Aggro'; }
            }
            const stateEl = document.getElementById('h-state');
            if (stateEl) { stateEl.textContent = label; stateEl.className = `hud-val gear-text gear-${gear}-text`; }
            const displayW = topWinStreaks.concat([curWinStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const displayL = topLossStreaks.concat([curLossStreak]).filter(x => x > 0).sort((a, b) => b - a).slice(0, 10);
            const bestWEl = document.getElementById('h-best-w'); if (bestWEl) bestWEl.textContent = displayW.join(', ') || '-';
            const worstLEl = document.getElementById('h-worst-l'); if (worstLEl) worstLEl.textContent = displayL.join(', ') || '-';
            const targetEl = document.getElementById('h-target');
            const targetMult = getUserSetMultiplier();
            if (targetEl) {
                let txt = `Target: ${targetMult.toFixed(2)}x`;
                if (autoPaused) { targetEl.style.color = 'var(--hud-negative)'; txt = 'PAUSED - THRESHOLD TRIGGERED'; } else { targetEl.style.color = 'var(--hud-text-soft)'; }
                targetEl.innerHTML = txt;
            }
        } else if (ACTIVE_MODE === 'manual') {
            const streaksEl = document.getElementById('h-streaks');
            if (streaksEl) streaksEl.innerHTML = `<span style="color:var(--hud-positive);">${curWinStreak}/${maxWinStreak}</span> | <span style="color:var(--hud-negative);">${curLossStreak}/${maxLossStreak}</span>`;
            const hotEl = document.getElementById('h-hot'); if (hotEl) hotEl.textContent = `${betHistory.filter(Boolean).length}/${betHistory.length}`;
            populateAdvancedStats();
            const targetEl = document.getElementById('h-target');
            if (targetEl) {
                targetEl.textContent = isRapidFiring ? '' : '';
                targetEl.style.color = isRapidFiring ? 'var(--hud-positive)' : 'var(--hud-text-soft)';
            }
        }
        drawGraph();
    }
    function updateBetAmount() {
        if (ACTIVE_MODE !== 'smart') return;
        // While the user is in the Advanced IOW mode (cross-tool integration
        // owns the bet field via the dice tool's strategy editor), do NOT
        // overwrite the wager input. ACTIVE_MODE stays 'smart' here because
        // the injected Advanced IOW button is added by the integration and
        // doesn't go through switchMode(), so the integration signals via
        // a data attribute on the HUD root.
        const hudRoot = document.getElementById('ratchet-master-container');
        if (hudRoot && hudRoot.dataset.toolsActive === '1') return;
        const input = document.querySelector('input[aria-label="wager"]');
        const balance = getCurrentBalance();
        if (!input || !balance) return;
        if (initialBalance === 0) initialBalance = balance;
        sessionPeak = Math.max(sessionPeak, balance);
        const currentMult = getUserSetMultiplier();
        if (currentMult !== trackedMultiplier) {
            trackedMultiplier = currentMult;
            multGames = 0;
            multWins = 0;
            recentWins = [];
        }
        const wins = betHistory.filter(Boolean).length;
        let progress = winsNeeded > 0 ? wins / winsNeeded : 0;
        if (lockAggressionState) {
            if (lockedGearLevel === 1) progress = 0.2;
            else if (lockedGearLevel === 2) progress = 0.6;
            else if (lockedGearLevel === 3) progress = 0.95;
            else if (lockedGearLevel === 4) progress = 1.3;
            else if (lockedGearLevel === 5) progress = 1.6;
        }
        const baseWindow = 30 + Math.round(trackedMultiplier * 8);
        const baseDivisor = 300 + Math.round(trackedMultiplier * 6);
        historyWindow = Math.max(5, Math.round(baseWindow / aggressionLevel));
        safeDivisor = Math.max(15, Math.round(baseDivisor / aggressionLevel));
        winsNeeded = Math.max(1, Math.floor(historyWindow / (trackedMultiplier * 0.8)));
        aggressiveDivisor = Math.max(1, Math.round(safeDivisor * (0.6 / aggressionLevel)));
        const dynamicDivisor = safeDivisor - ((safeDivisor - aggressiveDivisor) * Math.min(1, progress / 1.5));
        let targetBet = (sessionPeak / dynamicDivisor) * aggressionLevel;
        const maxBetPct = Math.min(0.18, 0.05 + aggressionLevel * 0.04);
        targetBet = Math.max(minBaseBet, Math.min(targetBet, balance * maxBetPct));
        if (Math.abs(targetBet - lastAmount) > 0.00000005) {
            lastAmount = targetBet;
            setBet(targetBet);
        }
    }
    function startObserverWrapper() {
        if (!pastBetsContainer || !pastBetsContainer.isConnected) {
            if (observer) observer.disconnect();
            startObserver();
        }
    }
    setInterval(() => {
        buildHUD();
        const bal = getCurrentBalance();
        if (bal > 0.00000001) {
            if (initialBalance === 0) initialBalance = bal;
            sessionPeak = Math.max(sessionPeak, bal);
            lastKnownBalance = bal;
        }
        // Autostop on Balance — read every tick regardless of mode so the
        // Manual / IOW / Smart inputs all stay synced with autoStopBalance.
        {
            const autostopEl = document.getElementById('h-autostop');
            if (autostopEl) {
                const v = parseFloat(autostopEl.value);
                autoStopBalance = !isNaN(v) && v > 0 ? v : null;
            }
        }
        // Periodic safety check — also catches the case where balance ticked
        // past the target between observed bets, or where a bet-result event
        // got missed. Runs for every mode.
        if (isRapidFiring && autoStopBalance && getCurrentBalance() >= autoStopBalance) {
            stopRapidFire();
        }
        if (ACTIVE_MODE === 'iow') {
            const baseInp = document.getElementById('h-base'); if (baseInp) baseBet = parseFloat(baseInp.value) || minBaseBet;
            const winIncEl = document.getElementById('h-win-inc'); if (winIncEl) winIncreasePercent = parseFloat(winIncEl.value) || 125;
            const lossResetEl = document.getElementById('h-loss-reset'); if (lossResetEl) lossStreakReset = parseInt(lossResetEl.value, 10) || 3;
            const winsResetEl = document.getElementById('h-wins-reset'); if (winsResetEl) winsBeforeReset = parseInt(winsResetEl.value, 10) || null;
        }
        if (ACTIVE_MODE === 'manual') {
            // Keep manualBet synced from the HUD input so user edits take
            // effect even if the input listener missed an event.
            const manualInp = document.getElementById('h-manual-bet');
            if (manualInp) {
                const v = parseFloat(manualInp.value);
                if (isFinite(v) && v >= minBaseBet) manualBet = v;
            }
        }
        updateUI();
        startObserverWrapper();
        monitorRapidFireHealth();
        if (ACTIVE_MODE === 'smart') updateBetAmount();
        if (isRapidFiring) startBetGuardian();
        else stopBetGuardian();
    }, 500);
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key.toLowerCase() === 'r') resetStats();
        if (ACTIVE_MODE === 'smart') {
            if (e.key === ']' || e.key === '[') {
                if (!lockAggressionState) {
                    lockAggressionState = true;
                    const chk = document.getElementById('h-lock-agg-chk');
                    if (chk) chk.checked = true;
                    const sel = document.getElementById('h-lock-gear-sel');
                    if (sel) sel.disabled = false;
                }
                if (e.key === ']') lockedGearLevel = Math.min(5, lockedGearLevel + 1);
                if (e.key === '[') lockedGearLevel = Math.max(1, lockedGearLevel - 1);
                const gearSel = document.getElementById('h-lock-gear-sel');
                if (gearSel) gearSel.value = lockedGearLevel;
                updateUI();
            }
        }
    });
    setTimeout(() => { buildHUD(); startObserver(); }, 800);
    console.log('%c✅ IOW / Smart v3.5 loaded - DICE SLIDER THUMB/TRACK NOW FULLY HIDDEN', 'color:#43f6ff;font-weight:900;font-size:14px');

    }

    /* === source: nuts-keno-desktop.user.js === */
    function tool_nuts_keno() {
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

    // Picks are tracked from the user's own click events. DOM-based detection
    // breaks during a round because game-drawn HIT tiles introduce a third
    // class (unselected / user-picked / hit), and the frequency heuristic then
    // picks up hits as selections.
    const userPicks = new Set();

    // DOM-based best guess — only reliable while the board is IDLE (no hits
    // showing). Used once on load to seed userPicks, and via the Sync button.
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
        background: rgba(16, 20, 30, 0.55);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        color: #e0ffff; border: 1px solid rgba(0, 255, 255, 0.15);
        border-top: 1px solid rgba(0, 255, 255, 0.3);
        border-left: 1px solid rgba(0, 255, 255, 0.3);
        border-radius: 14px;
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.05);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; width: 260px; user-select: none;
    }
    #keno-preset-gui .kp-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-radius: 14px 14px 0 0;
        border-bottom: 1px solid rgba(0, 255, 255, 0.15); cursor: grab;
    }
    #keno-preset-gui .kp-header:active { cursor: grabbing; }
    #keno-preset-gui .kp-title {
        font-weight: 700; font-size: 13px; color: #00ffff;
        letter-spacing: 1px;
        text-shadow: 0 0 10px rgba(0, 255, 255, 0.6), 0 0 20px rgba(0, 255, 255, 0.2);
    }
    #keno-preset-gui .kp-close {
        background: none; border: none; color: rgba(224, 255, 255, 0.5); cursor: pointer;
        padding: 2px 6px; font-size: 16px; line-height: 1; border-radius: 4px;
    }
    #keno-preset-gui .kp-close:hover { color: #00ffff; background: rgba(0, 255, 255, 0.1); text-shadow: 0 0 5px rgba(0, 255, 255, 0.5); }
    #keno-preset-gui .kp-content { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
    #keno-preset-gui select {
        width: 100%; background: rgba(0, 0, 0, 0.25); color: #00ffff;
        border: 1px solid rgba(0, 255, 255, 0.2); border-radius: 6px;
        padding: 6px 8px; font-size: 12px; font-weight: 600; outline: none;
        text-shadow: 0 0 5px rgba(0, 255, 255, 0.4);
    }
    #keno-preset-gui select:focus { border-color: rgba(0, 255, 255, 0.6); }
    #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; }
    #keno-preset-gui .kp-btn {
        flex: 1; background: rgba(0, 255, 255, 0.05); color: #e0ffff;
        border: 1px solid rgba(0, 255, 255, 0.2); border-radius: 8px;
        padding: 6px 8px; font-size: 11px; font-weight: 700;
        cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
        transition: all 0.18s ease;
    }
    #keno-preset-gui .kp-btn:hover:not(:disabled) {
        background: rgba(0, 255, 255, 0.15); color: #00ffff;
        box-shadow: 0 0 12px rgba(0, 255, 255, 0.25);
    }
    #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #keno-preset-gui .kp-btn.primary {
        background: rgba(0, 255, 255, 0.15); border-color: rgba(0, 255, 255, 0.5);
        color: #00ffff; text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
        box-shadow: 0 0 10px rgba(0, 255, 255, 0.15);
    }
    #keno-preset-gui .kp-btn.primary:hover:not(:disabled) {
        background: rgba(0, 255, 255, 0.25);
        box-shadow: 0 0 18px rgba(0, 255, 255, 0.4);
    }
    #keno-preset-gui .kp-btn.danger { color: #ff0055; border-color: rgba(255, 0, 85, 0.3); }
    #keno-preset-gui .kp-btn.danger:hover:not(:disabled) {
        background: rgba(255, 0, 85, 0.15); color: #ff66a0;
        box-shadow: 0 0 12px rgba(255, 0, 85, 0.3);
    }
    #keno-preset-gui .kp-current {
        padding: 8px 10px; background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(0, 255, 255, 0.1); border-radius: 6px;
        font-size: 11px; color: rgba(224, 255, 255, 0.7); line-height: 1.4; word-break: break-word;
    }
    #keno-preset-gui .kp-current b { color: #00ffff; text-shadow: 0 0 5px rgba(0, 255, 255, 0.4); }
    `;
    document.head.appendChild(style);

    const gui = document.createElement('div');
    gui.id = 'keno-preset-gui';
    gui.innerHTML = `
        <div class="kp-header">
            <span class="kp-title">Nuts Keno</span>
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

    // Track user clicks on tiles — our pick set is the source of truth.
    // Nuts tiles are identified by content (number inside a span), so we map
    // the clicked button back to its index via getTiles().
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

    // Re-render on grid / slider changes. Both the tiles' grid container and
    // the risk slider get destroyed + recreated when the user SPA-navigates
    // away from /keno and back, so we keep a persistent loop that re-binds
    // the observers whenever either element identity changes. Avoids the
    // "UI re-appears but picks don't update" bug after navigation.
    let tilesObserver = null;
    let riskObserver = null;
    let _observedGridParent = null;
    let _observedSlider = null;
    function attachWatchers() {
        const tiles = getTiles();
        if (!tiles.length) return false;
        const gridParent = tiles[0].parentElement;
        if (gridParent && gridParent !== _observedGridParent) {
            if (tilesObserver) tilesObserver.disconnect();
            tilesObserver = new MutationObserver(() => renderCurrent());
            tilesObserver.observe(gridParent, { attributes: true, subtree: true, attributeFilter: ['class'] });
            _observedGridParent = gridParent;
            // Re-sync picks + render only on a fresh grid (initial mount or
            // post-SPA-nav); otherwise we'd thrash on every tick.
            syncPicksFromDOM();
            renderCurrent();
        }
        const slider = getRiskSlider();
        if (slider && slider !== _observedSlider) {
            if (riskObserver) riskObserver.disconnect();
            riskObserver = new MutationObserver(() => renderCurrent());
            riskObserver.observe(slider, { attributes: true, attributeFilter: ['aria-valuenow'] });
            _observedSlider = slider;
        }
        return true;
    }

    // Persistent attach loop — runs forever, cheap because attachWatchers
    // only does real work when the grid or slider element identity changes.
    setInterval(attachWatchers, 500);

    renderPresets();
    renderCurrent();

    }

    /* === source: nuts-mines-desktop.user.js === */
    function tool_nuts_mines() {
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
        <div style="font-weight: 700; margin-bottom: 12px; text-align: center; color: #00ffff; font-size: 1.1em; text-shadow: 0 0 10px rgba(0, 255, 255, 0.6), 0 0 20px rgba(0, 255, 255, 0.2); letter-spacing: 1px;">
            Nuts Mines
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin: 8px 0;">
            <label style="color: rgba(224, 255, 255, 0.8); font-size: 0.9em; font-weight: 500;">Min Tiles:</label>
            <input id="minPicks" type="number" value="3" min="1" max="24" style="${inputStyle}">
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin: 8px 0;">
            <label style="color: rgba(224, 255, 255, 0.8); font-size: 0.9em; font-weight: 500;">Max Tiles:</label>
            <input id="maxPicks" type="number" value="8" min="1" max="24" style="${inputStyle}">
        </div>
        <div style="margin: 16px 0 8px 0; text-align: center; display: flex; gap: 10px; justify-content: center;">
            <button id="btnStart" style="flex: 1; background: rgba(0, 255, 255, 0.1); border: 1px solid rgba(0, 255, 255, 0.4); color: #00ffff; padding: 8px; border-radius: 8px; font-weight: 700; cursor: pointer; transition: all 0.2s; text-shadow: 0 0 5px rgba(0, 255, 255, 0.5); box-shadow: 0 0 10px rgba(0, 255, 255, 0.1); text-transform: uppercase; letter-spacing: 0.5px;">
                Start
            </button>
            <button id="btnStop" style="flex: 1; background: rgba(255, 0, 85, 0.1); border: 1px solid rgba(255, 0, 85, 0.4); color: #ff0055; padding: 8px; border-radius: 8px; font-weight: 700; cursor: pointer; display: none; transition: all 0.2s; text-shadow: 0 0 5px rgba(255, 0, 85, 0.5); box-shadow: 0 0 10px rgba(255, 0, 85, 0.1); text-transform: uppercase; letter-spacing: 0.5px;">
                Stop
            </button>
        </div>
        <div id="status" style="font-size: 0.8em; color: rgba(224, 255, 255, 0.6); text-align: center; min-height: 1.2em; font-weight: 500; letter-spacing: 0.5px;"></div>
        <div style="margin-top: 12px; border-top: 1px solid rgba(0, 255, 255, 0.15); padding-top: 10px;">
            <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #00ffff; font-size: 0.9em; text-shadow: 0 0 5px rgba(0, 255, 255, 0.4); letter-spacing: 0.6px; text-transform: uppercase;">
                Live Stats
            </div>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Multiplier:</span><span id="mult" style="font-weight: 700; color: #00ffff;">—</span></p>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Payout:</span><span id="pout" style="font-weight: 700; color: #00ffff;">—</span></p>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Next Gem:</span><span id="chance" style="font-weight: 700; color: #00ffff;">—</span></p>
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(255, 102, 255, 0.15); padding-top: 10px;">
            <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #ff66ff; font-size: 0.9em; text-shadow: 0 0 5px rgba(255, 102, 255, 0.4); letter-spacing: 0.6px; text-transform: uppercase;">
                Projected Range
            </div>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Min Mult:</span><span id="minMult" style="font-weight: 700; color: #ff66ff;">—</span></p>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Max Mult:</span><span id="maxMult" style="font-weight: 700; color: #ff66ff;">—</span></p>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Min Payout:</span><span id="minPayout" style="font-weight: 700; color: #ff66ff;">—</span></p>
            <p style="margin: 4px 0; font-size: 0.85em; display: flex; justify-content: space-between;"><span style="color: rgba(224, 255, 255, 0.7);">Max Payout:</span><span id="maxPayout" style="font-weight: 700; color: #ff66ff;">—</span></p>
        </div>
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

    let isDragging = false, currentX = 0, currentY = 0;
    gui.addEventListener('mousedown', e => {
        if (['BUTTON','INPUT','LABEL'].includes(e.target.tagName)) return;
        isDragging = true;
        currentX = e.clientX - gui.offsetLeft;
        currentY = e.clientY - gui.offsetTop;
        gui.style.boxShadow = '0 12px 40px 0 rgba(0, 0, 0, 0.5), inset 0 0 20px rgba(0, 255, 255, 0.1)';
        gui.style.transform = 'scale(1.02)';
    });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        gui.style.left = (e.clientX - currentX) + 'px';
        gui.style.top = (e.clientY - currentY) + 'px';
        gui.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        isDragging = false;
        gui.style.boxShadow = '0 8px 32px 0 rgba(0, 0, 0, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.05)';
        gui.style.transform = 'scale(1)';
    });

    gui.style.left = (window.innerWidth - gui.offsetWidth - 30) + 'px';
    gui.style.top = '40px';

    const status = document.getElementById('status');

    function setStatus(txt, color = 'rgba(224, 255, 255, 0.6)') {
        status.textContent = txt;
        status.style.color = color;
    }

    // ==================== CORE LOGIC ====================
    // Speed slider removed — the bot already runs at the game's response
    // ceiling. Fixed small delays keep the click loop loose enough for Nuts's
    // React to register each event before the next one lands.
    const POST_PLAY_DELAY_MS  = 80;   // After Play click, before picking
    const INTER_TILE_DELAY_MS = 30;   // Between successive tile clicks
    const PRE_CASHOUT_DELAY_MS = 50;  // After last pick, before cashout

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

        setStatus('Running', '#00ffff');
        // Safety kill switch: if the Play button stays unavailable for 20s
        // (typically because balance ran out, a session got stuck, or a
        // captcha/disconnect interrupted things), kill the bot instead of
        // spinning forever. Mirrors the Stake Mines safety.
        const playWaitStart = Date.now();
        const MAX_PLAY_WAIT_MS = 20000;
        while (isRunning && !clickPlay()) {
            if (Date.now() - playWaitStart > MAX_PLAY_WAIT_MS) {
                setStatus('Stopped — out of balance', '#ff0055');
                stopBot();
                return;
            }
            await delay(15);
        }
        if (!isRunning) return;

        await delay(POST_PLAY_DELAY_MS);

        const min = parseInt(document.getElementById('minPicks').value) || 3;
        const max = parseInt(document.getElementById('maxPicks').value) || 12;
        const targetAmount = weightedRandom(min, max);

        let availableTiles = getClickableTiles();

        if (availableTiles.length === 0) {
            return;
        }

        // Shuffle array to pick random distinct tiles
        const shuffled = availableTiles.sort(() => 0.5 - Math.random());
        const tilesToClick = shuffled.slice(0, Math.min(targetAmount, availableTiles.length));

        setStatus(`Picking ${tilesToClick.length} tiles`, '#00ffff');

        // Rapid fire loop
        for (let i = 0; i < tilesToClick.length; i++) {
            if (!isRunning) return;
            tilesToClick[i].click();
            // Tiny delay to ensure browser dispatches the click events properly
            await delay(INTER_TILE_DELAY_MS);
        }

        // Polling loop: Wait for the front-end to render the server's response
        let resolved = false;
        let timeoutCounter = 0;

        while (!resolved && timeoutCounter < 60 && isRunning) { // Max wait ~3 seconds
            await delay(50);
            timeoutCounter++;

            // Check 1: Did we hit a mine? Game over, PLAY button reappears.
            if (findButton('PLAY') || findButton('play', true)) {
                setStatus('Busted', '#ff0055');
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
            await delay(PRE_CASHOUT_DELAY_MS);

            const cashed = clickCashout();
            setStatus(cashed ? 'Cashed out' : 'Running', '#00ffff');
        }
    }

    async function runLoop() {
        while (isRunning) {
            // SPA safety: if the user navigated away from /mines, halt the
            // bot immediately so it can't place bets on a different game
            // that happens to expose a matching bet button.
            if (!/\/mines/i.test(location.pathname)) {
                setStatus('Stopped', '#ff0055');
                stopBot();
                return;
            }
            await doOneRound();
        }
    }

    function startBot() {
        if (isRunning) return;
        isRunning = true;
        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
        setStatus('Running', '#00ffff');
        runLoop();
    }

    function stopBot() {
        isRunning = false;
        btnStart.style.display = 'block';
        btnStop.style.display = 'none';
        setStatus('Stopped', '#ff0055');
    }

    btnStart.onclick = startBot;
    btnStop.onclick = stopBot;
    window.addEventListener('beforeunload', stopBot);
    setStatus('Ready', 'rgba(224, 255, 255, 0.6)');

    // ==================== LIVE TELEMETRY + PROJECTED RANGE ====================
    // Nuts uses a 2% house edge on Mines (verified live: 3 mines / 22 picks
    // shows "MAX PAYOUT x2,254" → 0.98 × C(25,22) / C(22,22) = 2254). Apart
    // from the edge, the formula matches Stake's exactly.
    function binomCoeff(n, k) {
        if (k < 0 || k > n) return 0;
        if (k === 0 || k === n) return 1;
        if (k > n - k) k = n - k;
        let result = 1;
        for (let i = 0; i < k; i++) result = result * (n - i) / (i + 1);
        return result;
    }

    function computeNutsMinesMultiplier(picks, mines) {
        if (!isFinite(picks) || !isFinite(mines)) return NaN;
        if (picks < 1 || mines < 1 || mines > 24) return NaN;
        const safeTiles = 25 - mines;
        if (picks > safeTiles) return NaN;
        const top = binomCoeff(25, picks);
        const bot = binomCoeff(safeTiles, picks);
        if (!bot) return NaN;
        return 0.98 * top / bot;
    }

    /** Read Nuts's "N MINES" label to recover the active mines count. */
    function getNutsMinesCount() {
        const labels = Array.from(document.querySelectorAll('*'))
            .filter(el => el.children.length === 0 && /^\d+\s*MINES?$/i.test((el.textContent || '').trim()));
        if (!labels.length) return NaN;
        const m = labels[0].textContent.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : NaN;
    }

    /** Read Nuts's wager input (the bet amount in SOL). */
    function getNutsBetAmount() {
        const wager = document.querySelector('input[aria-label="wager"]');
        if (!wager) return NaN;
        return parseFloat(wager.value);
    }

    /** Count how many gem tiles are currently revealed in an active round.
     *  Returns NaN if no round is in progress. */
    function countNutsRevealedGems() {
        const allTiles = document.querySelectorAll('div[class*="gtVEXU"]');
        if (allTiles.length === 0) return NaN;
        const clickable = getClickableTiles().length;
        // Pre-round: tiles render but none are clickable. Distinguish by the
        // presence of the CASHOUT button (only visible mid-round).
        if (!findButton('CASHOUT') && !findButton('cashout', true)) return NaN;
        return allTiles.length - clickable;
    }

    function getSafeTileCount() {
        const mines = getNutsMinesCount();
        if (isNaN(mines)) return 24;
        return Math.max(1, 25 - mines);
    }

    /** Mirror Stake's pick-input cap behavior: sync `max` attribute to the
     *  current safe-tile count and clamp values on blur so the user can't
     *  request more picks than the board can deliver. */
    let _lastSafeTilesNuts = null;
    function syncPickInputCaps() {
        const safeTiles = getSafeTileCount();
        const minInp = document.getElementById('minPicks');
        const maxInp = document.getElementById('maxPicks');
        if (minInp) minInp.max = String(safeTiles);
        if (maxInp) maxInp.max = String(safeTiles);
        return safeTiles;
    }

    function clampPickInputs() {
        const safeTiles = getSafeTileCount();
        const minInp = document.getElementById('minPicks');
        const maxInp = document.getElementById('maxPicks');
        if (!minInp || !maxInp) return;
        const minFocused = document.activeElement === minInp;
        const maxFocused = document.activeElement === maxInp;
        let minVal = parseInt(minInp.value);
        let maxVal = parseInt(maxInp.value);
        if (isNaN(minVal)) minVal = 1;
        if (isNaN(maxVal)) maxVal = 1;
        minVal = Math.max(1, Math.min(minVal, safeTiles));
        maxVal = Math.max(1, Math.min(maxVal, safeTiles));
        if (minVal > maxVal) maxVal = minVal;
        if (!minFocused && minInp.value !== String(minVal)) minInp.value = String(minVal);
        if (!maxFocused && maxInp.value !== String(maxVal)) maxInp.value = String(maxVal);
    }

    function updateInfo() {
        // Keep pick-input caps in sync with the mines count and auto-clamp
        // whenever the mines slider changes.
        const safeTiles = syncPickInputCaps();
        if (_lastSafeTilesNuts !== null && _lastSafeTilesNuts !== safeTiles) {
            clampPickInputs();
        }
        _lastSafeTilesNuts = safeTiles;

        const mines = getNutsMinesCount();
        const bet = getNutsBetAmount();
        const minPicks = parseInt(document.getElementById('minPicks').value);
        const maxPicks = parseInt(document.getElementById('maxPicks').value);

        // ---- Live telemetry (only meaningful when a round is in progress) ----
        const revealed = countNutsRevealedGems();
        const liveMult = (isFinite(revealed) && revealed > 0 && !isNaN(mines))
            ? computeNutsMinesMultiplier(revealed, mines)
            : NaN;
        const livePayout = (!isNaN(liveMult) && isFinite(bet) && bet > 0) ? bet * liveMult : NaN;

        let chanceText = '—';
        if (isFinite(revealed) && revealed >= 0 && !isNaN(mines)) {
            const remaining = 25 - revealed;
            const safeRemaining = (25 - mines) - revealed;
            if (remaining > 0 && safeRemaining >= 0) {
                chanceText = ((safeRemaining / remaining) * 100).toFixed(2) + '%';
            }
        }

        const multEl = document.getElementById('mult');
        const poutEl = document.getElementById('pout');
        const chanceEl = document.getElementById('chance');
        if (multEl) multEl.textContent = isNaN(liveMult) ? '—' : liveMult.toFixed(2) + '×';
        if (poutEl) poutEl.textContent = isNaN(livePayout) ? '—' : livePayout.toFixed(8);
        if (chanceEl) chanceEl.textContent = chanceText;

        // ---- Projected range (always shown when inputs are valid) ----
        const minMultEl = document.getElementById('minMult');
        const maxMultEl = document.getElementById('maxMult');
        const minPayoutEl = document.getElementById('minPayout');
        const maxPayoutEl = document.getElementById('maxPayout');

        if (isNaN(minPicks) || isNaN(maxPicks) || isNaN(mines)) {
            if (minMultEl) minMultEl.textContent = '—';
            if (maxMultEl) maxMultEl.textContent = '—';
            if (minPayoutEl) minPayoutEl.textContent = '—';
            if (maxPayoutEl) maxPayoutEl.textContent = '—';
            return;
        }

        const cappedMin = Math.max(1, Math.min(minPicks, safeTiles));
        const cappedMax = Math.max(cappedMin, Math.min(maxPicks, safeTiles));
        const minMult = computeNutsMinesMultiplier(cappedMin, mines);
        const maxMult = computeNutsMinesMultiplier(cappedMax, mines);

        if (minMultEl) minMultEl.textContent = isNaN(minMult) ? '—' : minMult.toFixed(2) + '×';
        if (maxMultEl) maxMultEl.textContent = isNaN(maxMult) ? '—' : maxMult.toFixed(2) + '×';

        if (isFinite(bet) && bet > 0) {
            if (minPayoutEl) minPayoutEl.textContent = isNaN(minMult) ? '—' : (bet * minMult).toFixed(8);
            if (maxPayoutEl) maxPayoutEl.textContent = isNaN(maxMult) ? '—' : (bet * maxMult).toFixed(8);
        } else {
            if (minPayoutEl) minPayoutEl.textContent = '—';
            if (maxPayoutEl) maxPayoutEl.textContent = '—';
        }
    }

    setInterval(updateInfo, 1000);
    ['minPicks', 'maxPicks'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', updateInfo);
        el.addEventListener('blur', () => { clampPickInputs(); updateInfo(); });
    });
    clampPickInputs();
    updateInfo();

    }

    /* === source: shuffle-keno-desktop.user.js ===
       Save / load Keno presets on Shuffle. Numbers are 1–40 (not 1–40),
       risks are Classic / Low / Medium / High. Active picks are detected
       by tile background color (purple = picked, dark gray = unpicked).
       Active risk is detected via a span class containing "_active". */
    function tool_shuffle_keno() {
        'use strict';
        const PRESETS_KEY = 'shuffle-keno-presets';
        const TILE_SELECTOR = 'button[data-testid^="keno-button-"]';
        const RISKS = ['classic', 'low', 'medium', 'high'];

        function loadPresets() {
            try { const raw = localStorage.getItem(PRESETS_KEY); if (!raw) return []; const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
        }
        function savePresets(list) { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); }
        function getTiles() { return Array.from(document.querySelectorAll(TILE_SELECTOR)); }
        function getTileNumber(btn) { const m = (btn.dataset.testid || '').match(/keno-button-(\d+)/); return m ? parseInt(m[1], 10) : null; }
        function isTilePicked(btn) {
            // Picked tiles render with a vivid purple background. Unpicked = dark gray.
            const bg = window.getComputedStyle(btn).backgroundColor || '';
            const m = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return false;
            const r = +m[1], g = +m[2], b = +m[3];
            // Purple has high red+blue, low green. Dark gray is ~32/35/41.
            return (r + b) > 200 && g < 100;
        }
        function getSelectedNumbers() { return getTiles().filter(isTilePicked).map(getTileNumber).filter(n => n != null).sort((a,b)=>a-b); }
        function getActiveRisk() {
            for (const r of RISKS) {
                const cap = r.charAt(0).toUpperCase() + r.slice(1);
                const btn = document.querySelector(`button[data-testid="keno-${cap}"]`);
                if (!btn) continue;
                const span = btn.querySelector('span');
                if (span && /RiskSelectButtons_active/.test(span.className || '')) return r;
            }
            return null;
        }
        async function setRisk(risk) {
            const cap = risk.charAt(0).toUpperCase() + risk.slice(1);
            const btn = document.querySelector(`button[data-testid="keno-${cap}"]`);
            if (!btn) return false;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 120));
            return getActiveRisk() === risk;
        }
        async function clickTile(n) {
            const btn = document.querySelector(`button[data-testid="keno-button-${n}"]`);
            if (!btn) return false;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 60));
            return true;
        }
        async function applyPreset(preset) {
            if (!preset || !Array.isArray(preset.numbers)) return;
            if (preset.risk) { await setRisk(preset.risk); await new Promise(r => setTimeout(r, 100)); }
            const current = new Set(getSelectedNumbers());
            const target = new Set(preset.numbers);
            for (const n of current) { if (!target.has(n)) { await clickTile(n); } }
            for (const n of target) { if (!current.has(n)) { await clickTile(n); } }
        }

        // ---- UI (Shuffle purple theme) ----
        const style = document.createElement('style');
        style.textContent = `
        #keno-preset-gui {
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            background: linear-gradient(180deg, rgba(20, 8, 38, 0.96) 0%, rgba(12, 6, 28, 0.96) 100%);
            color: #e9d5ff; border: 1px solid rgba(168, 85, 247, 0.3);
            border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(168, 85, 247, 0.15);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px; width: 270px; user-select: none;
        }
        #keno-preset-gui .kp-header {
            display: flex; align-items: center; justify-content: space-between;
            background: linear-gradient(135deg, rgba(124, 58, 237, 0.4), rgba(76, 29, 149, 0.4));
            padding: 10px 14px; border-radius: 12px 12px 0 0;
            border-bottom: 1px solid rgba(168, 85, 247, 0.25); cursor: grab;
        }
        #keno-preset-gui .kp-header:active { cursor: grabbing; }
        #keno-preset-gui .kp-title { font-weight: 700; font-size: 13px; color: #fff; letter-spacing: 0.3px; }
        #keno-preset-gui .kp-close { background: none; border: none; color: #a78bfa; cursor: pointer; padding: 2px 6px; font-size: 16px; line-height: 1; border-radius: 4px; }
        #keno-preset-gui .kp-close:hover { color: #fff; background: rgba(168, 85, 247, 0.2); }
        #keno-preset-gui .kp-content { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
        #keno-preset-gui select {
            width: 100%; background: rgba(0, 0, 0, 0.4); color: #e9d5ff;
            border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px;
            padding: 6px 8px; font-size: 12px; font-weight: 600; outline: none;
        }
        #keno-preset-gui select:focus { border-color: #a855f7; }
        #keno-preset-gui .kp-btn-row { display: flex; gap: 6px; }
        #keno-preset-gui .kp-btn {
            flex: 1; background: rgba(168, 85, 247, 0.1); color: #e9d5ff;
            border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px;
            padding: 6px 8px; font-size: 11px; font-weight: 700;
            cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
            transition: all 0.18s ease;
        }
        #keno-preset-gui .kp-btn:hover:not(:disabled) { background: rgba(168, 85, 247, 0.25); color: #fff; }
        #keno-preset-gui .kp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        #keno-preset-gui .kp-btn.primary {
            background: linear-gradient(135deg, #a855f7, #7c3aed); border-color: #a855f7; color: #fff;
            box-shadow: 0 0 12px rgba(168, 85, 247, 0.3);
        }
        #keno-preset-gui .kp-btn.primary:hover:not(:disabled) {
            background: linear-gradient(135deg, #c084fc, #8b5cf6);
            box-shadow: 0 0 18px rgba(168, 85, 247, 0.5);
        }
        #keno-preset-gui .kp-btn.danger { color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
        #keno-preset-gui .kp-btn.danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.15); color: #fca5a5; }
        #keno-preset-gui .kp-current {
            padding: 8px 10px; background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(168, 85, 247, 0.15); border-radius: 6px;
            font-size: 11px; color: #d4b8ff; line-height: 1.4; word-break: break-word;
        }
        #keno-preset-gui .kp-current b { color: #fff; }
        `;
        document.head.appendChild(style);

        const gui = document.createElement('div');
        gui.id = 'keno-preset-gui';
        gui.innerHTML = `
            <div class="kp-header">
                <span class="kp-title">Shuffle Keno</span>
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
                opt.textContent = '— no presets saved —'; opt.disabled = true;
                selectEl.appendChild(opt);
                loadBtn.disabled = true; deleteBtn.disabled = true;
                return;
            }
            for (const p of list) {
                const opt = document.createElement('option');
                opt.value = p.name;
                opt.textContent = `${p.name} (${p.numbers.length}#, ${p.risk || '—'})`;
                selectEl.appendChild(opt);
            }
            loadBtn.disabled = false; deleteBtn.disabled = false;
        }
        function renderCurrent() {
            const nums = getSelectedNumbers();
            const risk = getActiveRisk() || '—';
            currentEl.innerHTML = nums.length
                ? `Current: <b>${nums.length}</b> picks · risk <b>${risk}</b><br>${nums.join(', ')}`
                : `Current: <b>0</b> picks · risk <b>${risk}</b>`;
        }

        saveBtn.onclick = () => {
            const nums = getSelectedNumbers();
            const risk = getActiveRisk();
            if (!nums.length) { alert('Pick at least one number first'); return; }
            const name = prompt(`Save preset name (${nums.length} numbers, ${risk || '—'} risk):`);
            if (!name) return;
            const list = loadPresets();
            const existing = list.findIndex(p => p.name === name);
            const preset = { name, numbers: nums, risk };
            if (existing >= 0) {
                if (!confirm(`"${name}" already exists. Overwrite?`)) return;
                list[existing] = preset;
            } else { list.push(preset); }
            savePresets(list); renderPresets(); selectEl.value = name;
        };
        loadBtn.onclick = async () => {
            const p = loadPresets().find(x => x.name === selectEl.value);
            if (!p) return;
            loadBtn.disabled = true;
            await applyPreset(p);
            setTimeout(() => { loadBtn.disabled = false; renderCurrent(); }, 250);
        };
        deleteBtn.onclick = () => {
            const name = selectEl.value;
            if (!name || !confirm(`Delete preset "${name}"?`)) return;
            savePresets(loadPresets().filter(p => p.name !== name));
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

        // Persistent attach loop so the picks display stays in sync with
        // the player's clicks and survives SPA navigation away+back.
        setInterval(renderCurrent, 500);
        renderPresets();
        renderCurrent();
    }

    /* === source: shuffle-mines-desktop.user.js ===
       Auto-plays Mines on Shuffle with weighted random tile picks. Mirrors
       the Stake Mines logic, with Shuffle-specific selectors and a purple
       theme to match the site. */
    function tool_shuffle_mines() {
        'use strict';
        let isRunning = false;
        let runUrl = null; // URL captured when bot starts; bail if it changes
        // 15 ms gives ~66 readiness checks per second — matches Stake's bot.
        // Shuffle's React updates aren't synchronous, so faster polling than
        // this doesn't surface state changes any sooner, it just spins CPU.
        const POLL_INTERVAL_MS = 15;
        // Short pause after cashout so the multiplier popup is visible before
        // the next round starts. Lower = faster cycle time, less readable.
        const POST_WIN_PAUSE_MS = 150;
        const onMinesPage = () => /\/games\/originals\/mines/i.test(location.pathname);
        const urlChanged = () => runUrl !== null && location.pathname !== runUrl;

        const gui = document.createElement('div');
        gui.id = 'mines-auto-gui';
        gui.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 999999;
            background: linear-gradient(180deg, rgba(20, 8, 38, 0.96) 0%, rgba(12, 6, 28, 0.96) 100%);
            color: #e9d5ff; padding: 14px;
            border-radius: 12px; border: 1px solid rgba(168, 85, 247, 0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            min-width: 240px; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(168, 85, 247, 0.15);
            cursor: move; user-select: none; transition: box-shadow 0.3s ease;
        `;
        gui.innerHTML = `
            <div style="font-weight: 700; margin-bottom: 10px; text-align: center; color: #fff; font-size: 13px; letter-spacing: 0.4px;">
                Shuffle Mines
            </div>
            <div style="display: flex; align-items: center; margin: 6px 0;">
                <label style="flex: 1; color: #c4b5fd; font-size: 12px; font-weight: 600;">Min:</label>
                <input id="minPicks" type="number" value="3" min="1" max="24" style="width: 64px; padding: 5px 6px; border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 4px; background: rgba(0,0,0,0.4); color: #fff; font-weight: 600; text-align: center; outline: none;">
            </div>
            <div style="display: flex; align-items: center; margin: 6px 0;">
                <label style="flex: 1; color: #c4b5fd; font-size: 12px; font-weight: 600;">Max:</label>
                <input id="maxPicks" type="number" value="8" min="1" max="24" style="width: 64px; padding: 5px 6px; border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 4px; background: rgba(0,0,0,0.4); color: #fff; font-weight: 600; text-align: center; outline: none;">
            </div>
            <div style="margin: 12px 0 6px; text-align: center; display: flex; gap: 8px; justify-content: center;">
                <button id="btnStart" style="flex: 1; background: linear-gradient(135deg, #a855f7, #7c3aed); color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 800; cursor: pointer; transition: all 0.18s; font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase; box-shadow: 0 0 12px rgba(168, 85, 247, 0.3);">
                    Start
                </button>
                <button id="btnStop" style="flex: 1; background: #ef4444; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-weight: 800; cursor: pointer; display: none; transition: all 0.18s; font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase;">
                    Stop
                </button>
            </div>
            <div id="status" style="font-size: 11px; color: #c4b5fd; text-align: center; min-height: 1.2em; margin-top: 4px;"></div>
            <div style="margin-top: 12px; border-top: 1px solid rgba(168, 85, 247, 0.2); padding-top: 10px;">
                <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #a855f7; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;">
                    Live Stats
                </div>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Multiplier:</span><span id="mult" style="font-weight: 700; color: #fff;">—</span></p>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Payout:</span><span id="pout" style="font-weight: 700; color: #fff;">—</span></p>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Next Gem:</span><span id="chance" style="font-weight: 700; color: #fff;">—</span></p>
            </div>
            <div style="margin-top: 8px; border-top: 1px solid rgba(168, 85, 247, 0.2); padding-top: 10px;">
                <div style="font-weight: 700; margin-bottom: 6px; text-align: center; color: #a855f7; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;">
                    Projected Range
                </div>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Min Mult:</span><span id="minMult" style="font-weight: 700; color: #a855f7;">—</span></p>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Max Mult:</span><span id="maxMult" style="font-weight: 700; color: #a855f7;">—</span></p>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Min Payout:</span><span id="minPayout" style="font-weight: 700; color: #a855f7;">—</span></p>
                <p style="margin: 4px 0; font-size: 12px; display: flex; justify-content: space-between;"><span style="color: #c4b5fd;">Max Payout:</span><span id="maxPayout" style="font-weight: 700; color: #a855f7;">—</span></p>
            </div>
        `;
        document.body.appendChild(gui);

        // Drag
        let isDragging = false, currentX, currentY, initialX, initialY;
        gui.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
            initialX = e.clientX - currentX; initialY = e.clientY - currentY;
            isDragging = true;
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            currentX = e.clientX - initialX; currentY = e.clientY - initialY;
            gui.style.left = currentX + 'px'; gui.style.top = currentY + 'px';
            gui.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });
        currentX = window.innerWidth - gui.offsetWidth - 30; currentY = 40;
        gui.style.left = currentX + 'px'; gui.style.top = currentY + 'px';

        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        const status = document.getElementById('status');
        function setStatus(txt, color = '#c4b5fd') { status.textContent = txt; status.style.color = color; }

        async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
        async function waitFor(predicate, timeoutMs) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                if (!isRunning) return false;
                try { if (predicate()) return true; } catch (e) {}
                await delay(POLL_INTERVAL_MS);
            }
            return false;
        }

        // ---- Shuffle Mines selectors ----
        // Shuffle's UI behavior, observed on the live page:
        //   - Between rounds: button[data-testid="bet-button"] exists with
        //     text "Play".
        //   - Mid-round: the bet-button is REMOVED from the DOM entirely.
        //     A "REDEEM <amount> <currency>" button replaces it (this is
        //     the cashout). The button has no data-testid.
        //   - Tile state isn't stored in a class — it's in the inline
        //     `background-color` style. Unrevealed tiles use a specific
        //     dark grey; revealed tiles get a colored bg (yellow for gem,
        //     red-ish for bomb). We treat any tile whose inline bg is the
        //     dark grey as still-clickable.
        //   - Bust detection: after clicking a tile, if the round ENDS
        //     (Play button reappears) without us pressing Redeem, we
        //     busted on that pick. Otherwise it was a safe gem.
        const TILE_IDLE_BG = 'rgb(32, 35, 41)';
        function isPlayReady() {
            const el = document.querySelector('button[data-testid="bet-button"]');
            if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            return /^play$/i.test((el.textContent || '').trim());
        }
        function clickPlay() {
            if (!isPlayReady()) return false;
            document.querySelector('button[data-testid="bet-button"]').click();
            return true;
        }
        function findCashoutButton() {
            // The mid-round "REDEEM 200.00 GC" button. Exclude the "Redeem
            // Code" menu item (which is a user-menu entry, not a cashout).
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
                if (!b.offsetParent || b.disabled) continue;
                const t = (b.textContent || '').trim();
                if (/^redeem\b/i.test(t) && /\d/.test(t) && !/code/i.test(t)) return b;
            }
            return null;
        }
        function isCashoutReady() { return !!findCashoutButton(); }
        function isTileIdle(tile) {
            // Inline-style bg color is the discriminator; computed style is
            // identical between idle/revealed because Shuffle drives the
            // reveal animation via JS-set inline styles.
            return (tile.style.backgroundColor || '') === TILE_IDLE_BG;
        }
        function getIdleTiles() {
            return Array.from(document.querySelectorAll('button[class*="MinesGameTileWrapper_root"]'))
                .filter(isTileIdle);
        }
        // Batch-pick: fire all clicks in one synchronous burst, then wait
        // for either every requested tile to reveal OR the round to end on
        // a bust. Verified live: Shuffle accepts and processes rapid clicks
        // (7 clicks fired in ~3 ms, full settle in ~275 ms including bust
        // detection — ~10× faster than the per-pick serial approach).
        //
        // Round-state detection after the burst:
        //   - idle tiles == 0  → bust (Shuffle reveals every tile on bust,
        //     regardless of which one was the mine; this is the only fully
        //     reliable bust signal because the Play button can come back
        //     disabled when the user runs out of balance — making
        //     isPlayReady misclassify a bust as "still mid-round")
        //   - idle tiles >  0  AND our N picks landed → safe; cashout
        //     button should be available
        async function batchPickTiles(picks) {
            const idle = getIdleTiles();
            if (idle.length === 0) return { ok: false, busted: false, fired: 0 };
            const n = Math.min(picks, idle.length);
            const revealedBefore = 25 - idle.length;
            const arr = idle.slice();
            for (let i = arr.length - 1; i > arr.length - 1 - n; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            arr.slice(arr.length - n).forEach(t => t.click());
            await waitFor(() => {
                const idleNow = getIdleTiles().length;
                if (idleNow === 0) return true; // bust — all tiles revealed
                return (25 - idleNow) >= revealedBefore + n; // our picks landed
            }, 3000);
            const busted = getIdleTiles().length === 0;
            if (!busted) {
                // Safe path — give the cashout button a brief window to settle
                // into a clickable state before the caller invokes it.
                await waitFor(findCashoutButton, 500);
            }
            return { ok: true, busted, fired: n };
        }
        function getMinesCount() {
            // Shuffle's mines selector has no testid. DOM shape (observed):
            //   <div class="FormControlWrapper_root… Select_formWrapper…">
            //     <div class="LabelBlock_root…"><label>Mines</label></div>
            //     <div><select> with options 1..N </select></div>
            //     <button class="Select_button…">CURRENT_VALUE</button>
            //   </div>
            // Match by walking from the Mines LABEL up to FormControlWrapper.
            // The select holds the canonical value. (Mid-round Shuffle hides
            // the dropdown, but the underlying form element stays mounted.)
            const labels = document.querySelectorAll('label');
            for (const lbl of labels) {
                if (!/^mines$/i.test((lbl.textContent || '').trim())) continue;
                const wrap = lbl.closest('[class*="FormControlWrapper"], [class*="Select_formWrapper"]');
                if (!wrap) continue;
                const sel = wrap.querySelector('select');
                if (sel) {
                    const v = parseInt(sel.value, 10);
                    if (!isNaN(v) && v >= 1 && v < 25) return v;
                }
                // Fallback: read the Select_button text (the visible value).
                const btn = wrap.querySelector('button[class*="Select_button"]');
                if (btn) {
                    const v = parseInt((btn.textContent || '').trim(), 10);
                    if (!isNaN(v) && v >= 1 && v < 25) return v;
                }
            }
            return NaN;
        }
        function getBetAmount() {
            const inp = document.querySelector('input[data-testid="bet-amount"]');
            return inp ? parseFloat(inp.value) : NaN;
        }

        function weightedRandom(min, max) {
            const base = 1.5; let weights = []; let total = 0;
            for (let i = min; i <= max; i++) { const w = Math.pow(base, max - i); weights.push(w); total += w; }
            let r = Math.random() * total, sum = 0;
            for (let idx = 0; idx < weights.length; idx++) { sum += weights[idx]; if (r < sum) return min + idx; }
            return max;
        }

        // Composite live-check: bail not just on user-stop, but also on
        // SPA-navigation away from the mines page. Without this, the bot
        // can fire clickPlay / cashout on whatever the next page happens
        // to render (Stake's bet-button testid is reused across games).
        const stillLive = () => isRunning && !urlChanged();

        // Detect whether Shuffle is currently in an active round (Play button
        // absent from the DOM, idle tiles ready to click). Lets the bot pick
        // up an in-progress round instead of hanging on isPlayReady.
        function isMidRound() {
            return !document.querySelector('button[data-testid="bet-button"]') && getIdleTiles().length > 0;
        }

        async function doOneRound() {
            if (!stillLive()) return;
            setStatus('Running');

            // If we're not already mid-round, wait for Play and start one.
            if (!isMidRound()) {
                const playReadyStart = Date.now();
                const MAX_WAIT_MS = 20000;
                if (!await waitFor(isPlayReady, MAX_WAIT_MS)) {
                    if (isRunning && Date.now() - playReadyStart >= MAX_WAIT_MS) {
                        setStatus('Stopped — out of balance', '#ef4444');
                        stopBot();
                    }
                    return;
                }
                if (!stillLive()) return;
                if (!clickPlay()) { await delay(100); return; }
                if (!await waitFor(() => getIdleTiles().length > 0, 2500)) return;
                if (!stillLive()) return;
            }

            const min = parseInt(document.getElementById('minPicks').value) || 3;
            const max = parseInt(document.getElementById('maxPicks').value) || 12;
            const picks = weightedRandom(min, max);
            setStatus(`Picking ${picks} tiles`);

            const result = await batchPickTiles(picks);
            if (!stillLive()) return;
            if (!result.ok) return;
            if (result.busted) { setStatus('Busted'); return; }

            // Safe — cashout button is up. Click Redeem to lock in the win.
            const cashoutBtn = findCashoutButton();
            if (cashoutBtn) {
                cashoutBtn.click();
                setStatus('Cashed out');
                await delay(POST_WIN_PAUSE_MS);
            }
        }

        async function runLoop() {
            while (stillLive()) {
                await doOneRound();
            }
            if (urlChanged()) { setStatus('Stopped — navigated away', '#ef4444'); stopBot(); }
        }
        function startBot() {
            if (isRunning) return;
            if (!onMinesPage()) { setStatus('Not on Mines page', '#ef4444'); return; }
            isRunning = true;
            runUrl = location.pathname;
            btnStart.style.display = 'none'; btnStop.style.display = 'inline-block';
            setStatus('Running', '#a855f7');
            runLoop();
        }
        function stopBot() {
            isRunning = false;
            runUrl = null;
            btnStart.style.display = 'inline-block'; btnStop.style.display = 'none';
            setStatus('Stopped', '#ef4444');
        }
        btnStart.onclick = startBot;
        btnStop.onclick = stopBot;
        window.addEventListener('beforeunload', stopBot);

        // ---- Multiplier formula (assume 1% house edge, same as Stake) ----
        function binomCoeff(n, k) {
            if (k < 0 || k > n) return 0;
            if (k === 0 || k === n) return 1;
            if (k > n - k) k = n - k;
            let result = 1;
            for (let i = 0; i < k; i++) result = result * (n - i) / (i + 1);
            return result;
        }
        function computeMult(picks, mines) {
            if (!isFinite(picks) || !isFinite(mines)) return NaN;
            if (picks < 1 || mines < 1 || mines > 24) return NaN;
            const safe = 25 - mines;
            if (picks > safe) return NaN;
            return 0.99 * binomCoeff(25, picks) / binomCoeff(safe, picks);
        }

        // ---- Min/Max pick cap (matches Stake/Nuts Mines behavior) ----
        let _lastSafe = null;
        function getSafeTiles() {
            const m = getMinesCount();
            if (isNaN(m)) return 24;
            return Math.max(1, 25 - m);
        }
        function syncCaps() {
            const safe = getSafeTiles();
            const minInp = document.getElementById('minPicks');
            const maxInp = document.getElementById('maxPicks');
            if (minInp) minInp.max = String(safe);
            if (maxInp) maxInp.max = String(safe);
            return safe;
        }
        function clampInputs() {
            const safe = getSafeTiles();
            const minInp = document.getElementById('minPicks');
            const maxInp = document.getElementById('maxPicks');
            if (!minInp || !maxInp) return;
            const minF = document.activeElement === minInp;
            const maxF = document.activeElement === maxInp;
            let mn = parseInt(minInp.value); if (isNaN(mn)) mn = 1;
            let mx = parseInt(maxInp.value); if (isNaN(mx)) mx = 1;
            mn = Math.max(1, Math.min(mn, safe));
            mx = Math.max(1, Math.min(mx, safe));
            if (mn > mx) mx = mn;
            if (!minF && minInp.value !== String(mn)) minInp.value = String(mn);
            if (!maxF && maxInp.value !== String(mx)) maxInp.value = String(mx);
        }

        function updateInfo() {
            const safe = syncCaps();
            if (_lastSafe !== null && _lastSafe !== safe) clampInputs();
            _lastSafe = safe;

            const mines = getMinesCount();
            const bet = getBetAmount();
            const totalTiles = document.querySelectorAll('button[class*="MinesGameTileWrapper_root"]').length;
            const idleCount = getIdleTiles().length;
            const inRound = totalTiles > 0 && idleCount < totalTiles && !isPlayReady();
            const revealed = inRound ? (totalTiles - idleCount) : NaN;

            let liveMult = NaN, livePayout = NaN, chanceText = '—';
            if (isFinite(revealed) && revealed > 0 && !isNaN(mines)) {
                liveMult = computeMult(revealed, mines);
                if (isFinite(bet) && bet > 0) livePayout = bet * liveMult;
                const remaining = 25 - revealed;
                const safeRemaining = (25 - mines) - revealed;
                if (remaining > 0 && safeRemaining >= 0) chanceText = ((safeRemaining / remaining) * 100).toFixed(2) + '%';
            }
            const multEl = document.getElementById('mult');
            const poutEl = document.getElementById('pout');
            const chanceEl = document.getElementById('chance');
            if (multEl) multEl.textContent = isNaN(liveMult) ? '—' : liveMult.toFixed(2) + '×';
            if (poutEl) poutEl.textContent = isNaN(livePayout) ? '—' : livePayout.toFixed(2);
            if (chanceEl) chanceEl.textContent = chanceText;

            const minPicks = parseInt(document.getElementById('minPicks').value);
            const maxPicks = parseInt(document.getElementById('maxPicks').value);
            const minMultEl = document.getElementById('minMult');
            const maxMultEl = document.getElementById('maxMult');
            const minPayEl = document.getElementById('minPayout');
            const maxPayEl = document.getElementById('maxPayout');
            if (isNaN(minPicks) || isNaN(maxPicks) || isNaN(mines)) {
                [minMultEl, maxMultEl, minPayEl, maxPayEl].forEach(el => { if (el) el.textContent = '—'; });
                return;
            }
            const cMin = Math.max(1, Math.min(minPicks, safe));
            const cMax = Math.max(cMin, Math.min(maxPicks, safe));
            const minMult = computeMult(cMin, mines);
            const maxMult = computeMult(cMax, mines);
            if (minMultEl) minMultEl.textContent = isNaN(minMult) ? '—' : minMult.toFixed(2) + '×';
            if (maxMultEl) maxMultEl.textContent = isNaN(maxMult) ? '—' : maxMult.toFixed(2) + '×';
            if (isFinite(bet) && bet > 0) {
                if (minPayEl) minPayEl.textContent = isNaN(minMult) ? '—' : (bet * minMult).toFixed(2);
                if (maxPayEl) maxPayEl.textContent = isNaN(maxMult) ? '—' : (bet * maxMult).toFixed(2);
            } else {
                if (minPayEl) minPayEl.textContent = '—';
                if (maxPayEl) maxPayEl.textContent = '—';
            }
        }
        setInterval(updateInfo, 1000);
        ['minPicks', 'maxPicks'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', updateInfo);
            el.addEventListener('blur', () => { clampInputs(); updateInfo(); });
        });
        clampInputs();
        updateInfo();
    }

    /* === source: shuffle-autovault-desktop.user.js ===
       Shuffle vault auto-depositor. Mirrors the Stake / Nuts auto-vault
       behavior: monitors balance every N seconds, detects profit since the
       last baseline, and auto-deposits a configurable % to the vault when
       the profit threshold is hit. A "big win" multiplier triggers a larger
       deposit on outsized wins.

       Deposit mechanism: GraphQL `vaultDeposit` mutation posted to
       https://shuffle.us/main-api/graphql/api/graphql. Authorization is
       captured live from Shuffle's own outgoing fetch calls so we always
       use a current token — same general pattern as Stake's autovault,
       just adapted to Shuffle's session-bound auth header. */
    function tool_shuffle_autovault() {
        'use strict';

        const CONFIG_KEY = 'shuffle-autovault-config';
        const SESSION_VAULTED_KEY = 'shuffle-autovault-vaulted-session';
        const DEBUG = false; // flip to true to enable verbose console logging
        const MIN_DEPOSIT = 0.01;
        const MIN_BIG_WIN_PROFIT = 10;
        const DEFAULTS = {
            saveAmount: 0.2,        // 20% of profit per deposit
            bigWinThreshold: 5,     // big-win triggers when profit > N% of balance
            bigWinMultiplier: 3,    // deposit N× saveAmount on big wins
            checkInterval: 90000,   // 90 seconds between balance checks
            isRunning: false        // start paused (user clicks Start)
        };
        function loadConfig() {
            try { const raw = localStorage.getItem(CONFIG_KEY); if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }; } catch (e) {}
            return { ...DEFAULTS };
        }
        function saveConfig(c) { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); }
        let config = loadConfig();

        // ---- Activity log ----
        const log = [];
        function logEntry(msg, type = 'info') {
            log.unshift({ time: new Date(), msg, type });
            if (log.length > 30) log.pop();
            renderLog();
            console.log('[Shuffle Auto-Vault]', msg);
        }

        // ---- Active balance button finder (with caching) ----
        // Shuffle's wallet header has two <button> tabs with class
        // `ShuffleUsBalanceSelect_button…` (one for GC, one for SC). The
        // active tab carries an extra `TabView_active…` class. Inside each
        // button: an <img alt="GC|SC"> + the balance as plain text. Caching
        // the resolved button matters because the fast UI tick runs every
        // 1.5s and a fresh querySelectorAll + scan is wasteful when the DOM
        // tree hasn't changed.
        let _activeBalBtnCache = null;
        function getActiveBalanceButton() {
            if (_activeBalBtnCache && _activeBalBtnCache.isConnected && /TabView_active/.test(_activeBalBtnCache.className || '')) {
                return _activeBalBtnCache;
            }
            const btns = document.querySelectorAll('button[class*="ShuffleUsBalanceSelect"]');
            let active = null;
            for (const b of btns) {
                if (/TabView_active/.test(b.className || '') || b.getAttribute('aria-selected') === 'true' || b.dataset.active === 'true') {
                    active = b; break;
                }
            }
            _activeBalBtnCache = active;
            return active;
        }

        // ---- Combined balance + currency reader (single DOM query) ----
        function readBalanceAndCurrency() {
            const active = getActiveBalanceButton();
            if (!active) return { balance: NaN, currency: 'GC' };
            const v = parseFloat((active.textContent || '').trim().replace(/,/g, ''));
            const img = active.querySelector('img[alt="GC"], img[alt="SC"]');
            return {
                balance: isNaN(v) || v < 0 ? NaN : v,
                currency: (img && img.alt) || 'GC'
            };
        }
        function getBalance() { return readBalanceAndCurrency().balance; }
        function getActiveCurrency() { return readBalanceAndCurrency().currency; }

        // ---- GraphQL API helper ----
        // Hook the PAGE's fetch (not the userscript sandbox's) so we can
        // capture the live `authorization` header Shuffle sends on its own
        // GraphQL requests and replay it on ours. Cookies alone aren't
        // enough — Shuffle requires a Bearer token in this header. We use
        // `unsafeWindow` (Tampermonkey's escape hatch) to install the hook
        // on the real page fetch that Shuffle's React app actually calls.
        const PAGE_WIN = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (!PAGE_WIN.__shuffleAvFetchHookInstalled) {
            PAGE_WIN.__shuffleAvFetchHookInstalled = true;
            PAGE_WIN.__shuffleAvLatestAuth = null;
            PAGE_WIN.__shuffleAvLatestAuthAt = 0;
            const origFetch = PAGE_WIN.fetch;
            PAGE_WIN.fetch = function(input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (init && init.headers && /graphql/i.test(url)) {
                        const h = init.headers;
                        let auth = null;
                        if (typeof h.get === 'function') {
                            try { auth = h.get('authorization'); } catch (e) {}
                        } else if (Array.isArray(h)) {
                            const row = h.find(p => (p[0] || '').toLowerCase() === 'authorization');
                            if (row) auth = row[1];
                        } else if (typeof h === 'object') {
                            for (const k of Object.keys(h)) {
                                if (k.toLowerCase() === 'authorization') { auth = h[k]; break; }
                            }
                        }
                        if (auth) {
                            PAGE_WIN.__shuffleAvLatestAuth = auth;
                            PAGE_WIN.__shuffleAvLatestAuthAt = Date.now();
                        }
                    }
                } catch (e) {}
                return origFetch.apply(this, arguments);
            };
        }
        // Token freshness threshold — if we haven't seen Shuffle send an
        // authenticated GraphQL call recently, the cached token may have
        // been rotated by the server. Warn but still attempt the deposit.
        const AUTH_FRESH_MS = 10 * 60 * 1000; // 10 minutes

        const SHUFFLE_GQL_ENDPOINT = 'https://shuffle.us/main-api/graphql/api/graphql';
        function genCorrId() {
            try {
                if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
            } catch (e) {}
            return Date.now() + '-' + Math.random().toString(36).slice(2);
        }
        async function shuffleGqlCall(operationName, query, variables) {
            const headers = {
                'accept': 'application/graphql-response+json,application/json;q=0.9',
                'content-type': 'application/json',
                'x-correlation-id': genCorrId()
            };
            const auth = PAGE_WIN.__shuffleAvLatestAuth;
            if (auth) headers['authorization'] = auth;
            // Apollo Client signature — Shuffle's server may filter on it.
            const bodyObj = {
                operationName,
                variables,
                extensions: { clientLibrary: { name: '@apollo/client', version: '4.1.6' } },
                query
            };
            const bodyJson = JSON.stringify(bodyObj);
            // Use the SANDBOX fetch for our outgoing request — it forwards
            // to the browser's real network stack and avoids the cross-realm
            // object-wrapping problems that bite when calling unsafeWindow's
            // fetch with a sandbox init dict. Cookies are sent via
            // credentials:'include'; the Bearer token rides in the header.
            let res, status, statusText, rawText, parsed;
            try {
                res = await fetch(SHUFFLE_GQL_ENDPOINT, {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: bodyJson,
                    mode: 'cors',
                    cache: 'no-cache'
                });
                status = res.status;
                statusText = res.statusText;
                rawText = await res.text();
            } catch (e) {
                console.error('[Shuffle Auto-Vault] fetch threw:', e);
                return { error: true, status: 0, message: 'fetch-threw: ' + e.message };
            }
            try { parsed = rawText ? JSON.parse(rawText) : null; }
            catch (e) { parsed = null; }
            if (DEBUG) console.log('[Shuffle Auto-Vault] response', { op: operationName, status, statusText, raw: rawText && rawText.slice(0, 800), parsed });
            if (status < 200 || status >= 300) {
                return { error: true, status, message: statusText, raw: rawText, parsed };
            }
            return parsed || { error: true, status: -1, message: 'non-json-body', raw: rawText };
        }

        async function depositToVault(amount) {
            if (!(amount > 0)) return { ok: false, reason: 'amount-invalid' };
            if (!PAGE_WIN.__shuffleAvLatestAuth) {
                // No captured auth yet — Shuffle's React app polls regularly,
                // so this is just a transient state on a fresh page. Skip
                // this tick and wait for the next one.
                return { ok: false, reason: 'awaiting-auth-capture' };
            }
            const tokenAge = Date.now() - (PAGE_WIN.__shuffleAvLatestAuthAt || 0);
            if (tokenAge > AUTH_FRESH_MS) {
                console.warn('[Shuffle Auto-Vault] cached auth token is', Math.round(tokenAge / 60000), 'min old — may be stale');
            }
            const currency = getActiveCurrency();
            const amountStr = amount.toFixed(2);
            const query = `mutation VaultDeposit($data: VaultDepositInput!) {\n  vaultDeposit(data: $data) {\n    id\n    type\n    currency\n    amount\n    createdAt\n    afterVaultBalance\n    __typename\n  }\n}`;
            if (DEBUG) console.log('[Shuffle Auto-Vault] depositing', { currency, amount: amountStr });
            let result;
            try {
                result = await shuffleGqlCall('VaultDeposit', query, {
                    data: { currency, amount: amountStr }
                });
            } catch (e) {
                console.error('[Shuffle Auto-Vault] depositToVault threw:', e);
                return { ok: false, reason: 'exception: ' + e.message, currency };
            }
            // HTTP-level error
            if (result && result.error) {
                const msg = result.parsed && result.parsed.errors && result.parsed.errors[0] && result.parsed.errors[0].message;
                return { ok: false, reason: 'http-' + result.status + (msg ? ': ' + msg : ''), currency, raw: result };
            }
            // GraphQL-level errors
            if (result && result.errors && result.errors.length) {
                const msg = result.errors[0].message || 'graphql-error';
                return { ok: false, reason: msg, currency, raw: result };
            }
            const data = result && result.data && result.data.vaultDeposit;
            // STRICT success check: server must return an id AND a positive
            // amount. Anything else (null record, zero amount, missing id)
            // is treated as failure regardless of HTTP status.
            const serverAmount = data ? parseFloat(data.amount) : NaN;
            const afterVault = data ? parseFloat(data.afterVaultBalance) : NaN;
            if (data && data.id && !isNaN(serverAmount) && serverAmount > 0) {
                return {
                    ok: true,
                    currency: data.currency || currency,
                    amount: serverAmount,
                    afterVault: isNaN(afterVault) ? null : afterVault
                };
            }
            return {
                ok: false,
                reason: data ? `bad-response (id=${data.id || 'none'}, amount=${data.amount || '0'})` : 'no-data',
                currency,
                raw: result
            };
        }

        // ---- Session-vaulted tracking ----
        function getSessionVaulted() {
            try { const v = parseFloat(sessionStorage.getItem(SESSION_VAULTED_KEY)); return isNaN(v) ? 0 : v; } catch { return 0; }
        }
        function addSessionVaulted(amount) {
            const v = getSessionVaulted() + amount;
            try { sessionStorage.setItem(SESSION_VAULTED_KEY, String(v)); } catch {}
            return v;
        }
        function resetSessionVaulted() {
            try { sessionStorage.setItem(SESSION_VAULTED_KEY, '0'); } catch {}
        }

        // ---- UI (Shuffle purple theme, Stake-equivalent layout) ----
        const style = document.createElement('style');
        style.textContent = `
            #autovault-floaty {
                position: fixed; bottom: 64px; left: 16px; z-index: 999998;
                width: 260px;
                background: linear-gradient(180deg, rgba(20, 8, 38, 0.96) 0%, rgba(12, 6, 28, 0.96) 100%);
                color: #e9d5ff;
                border: 1px solid rgba(168, 85, 247, 0.3);
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(168, 85, 247, 0.15);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 13px; user-select: none;
                overflow: hidden;
            }
            #autovault-floaty .av-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 14px;
                background: linear-gradient(135deg, rgba(124, 58, 237, 0.4), rgba(76, 29, 149, 0.4));
                border-bottom: 1px solid rgba(168, 85, 247, 0.25);
                cursor: grab;
            }
            #autovault-floaty .av-header:active { cursor: grabbing; }
            #autovault-floaty .av-title { font-weight: 700; color: #fff; font-size: 13px; }
            #autovault-floaty .av-status {
                font-size: 10px; padding: 2px 8px; border-radius: 10px;
                background: rgba(168, 85, 247, 0.15); color: #c4b5fd; margin-left: 6px;
            }
            #autovault-floaty .av-status.on { background: rgba(16, 185, 129, 0.2); color: #34d399; }
            #autovault-floaty .av-mini-btn {
                background: none; border: none; color: #a78bfa; cursor: pointer;
                padding: 2px 6px; font-size: 14px; line-height: 1; border-radius: 4px;
            }
            #autovault-floaty .av-mini-btn:hover { color: #fff; background: rgba(168, 85, 247, 0.2); }
            #autovault-floaty .av-body { padding: 12px 14px; }
            #autovault-floaty .av-row {
                display: flex; justify-content: space-between; align-items: center;
                margin: 5px 0; font-size: 12px;
            }
            #autovault-floaty .av-row .av-label { color: #c4b5fd; }
            #autovault-floaty .av-row .av-val { font-weight: 700; color: #fff; }
            #autovault-floaty .av-row .av-val.pos { color: #34d399; }
            #autovault-floaty .av-row .av-val.neg { color: #f87171; }
            #autovault-floaty .av-section-title {
                font-size: 10px; color: #a78bfa; text-transform: uppercase;
                letter-spacing: 0.5px; margin: 10px 0 6px; font-weight: 700;
            }
            #autovault-floaty .av-config { display: grid; grid-template-columns: 1fr 70px; gap: 6px 8px; align-items: center; margin-top: 4px; }
            #autovault-floaty .av-config label { font-size: 11px; color: #c4b5fd; }
            #autovault-floaty .av-config input {
                width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(168, 85, 247, 0.3);
                background: rgba(0,0,0,0.4); color: #fff; font-size: 11px; font-weight: 600; text-align: right; outline: none;
            }
            #autovault-floaty .av-config input:focus { border-color: #a855f7; }
            #autovault-floaty .av-btn-row { display: flex; gap: 6px; margin-top: 10px; }
            #autovault-floaty .av-btn {
                flex: 1; background: rgba(168, 85, 247, 0.1); color: #e9d5ff;
                border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px;
                padding: 7px 8px; font-size: 11px; font-weight: 700;
                cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px;
                transition: all 0.18s ease;
            }
            #autovault-floaty .av-btn:hover { background: rgba(168, 85, 247, 0.25); color: #fff; }
            #autovault-floaty .av-btn.primary {
                background: linear-gradient(135deg, #a855f7, #7c3aed); border-color: #a855f7; color: #fff;
                box-shadow: 0 0 12px rgba(168, 85, 247, 0.3);
            }
            #autovault-floaty .av-btn.primary:hover { background: linear-gradient(135deg, #c084fc, #8b5cf6); }
            #autovault-floaty .av-btn.danger { color: #f87171; border-color: rgba(248,113,113,0.3); }
            #autovault-floaty .av-btn.danger:hover { background: rgba(248,113,113,0.15); }
            #autovault-floaty .av-log {
                margin-top: 10px; max-height: 110px; overflow-y: auto;
                background: rgba(0,0,0,0.25); border: 1px solid rgba(168,85,247,0.15);
                border-radius: 6px; padding: 6px 8px;
                font-family: 'Monaco', 'Consolas', monospace; font-size: 10px; line-height: 1.4;
            }
            #autovault-floaty .av-log::-webkit-scrollbar { width: 4px; }
            #autovault-floaty .av-log::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.4); border-radius: 2px; }
            #autovault-floaty .av-log-row { color: #c4b5fd; display: flex; gap: 6px; padding: 1px 0; }
            #autovault-floaty .av-log-row .av-log-time { color: #7c3aed; flex-shrink: 0; }
            #autovault-floaty .av-log-row.success { color: #34d399; }
            #autovault-floaty .av-log-row.bigwin { color: #fbbf24; }
            #autovault-floaty .av-log-row.warning { color: #f59e0b; }
            #autovault-floaty .av-log-row.error { color: #f87171; }
            #autovault-floaty .av-log-empty { color: #6b7280; font-style: italic; text-align: center; padding: 4px; font-size: 10px; }
            #autovault-floaty.mini { width: auto; min-width: 0; }
            #autovault-floaty.mini .av-body { display: none; }
        `;
        document.head.appendChild(style);

        const gui = document.createElement('div');
        gui.id = 'autovault-floaty';
        gui.innerHTML = `
            <div class="av-header">
                <div style="display: flex; align-items: center;">
                    <span class="av-title">Auto-Vault</span>
                    <span class="av-status" id="av-status">OFF</span>
                </div>
                <button class="av-mini-btn" id="av-mini" title="Collapse">−</button>
            </div>
            <div class="av-body">
                <div class="av-row"><span class="av-label">Balance</span><span class="av-val" id="av-bal">—</span></div>
                <div class="av-row"><span class="av-label">Vaulted (session)</span><span class="av-val" id="av-vaulted">0.00</span></div>
                <div class="av-row"><span class="av-label">Last profit</span><span class="av-val" id="av-profit">—</span></div>
                <div class="av-section-title">Settings</div>
                <div class="av-config">
                    <label>Save % of profit</label>
                    <input type="number" id="av-save" min="0.01" max="1" step="0.05" value="${config.saveAmount}">
                    <label>Big-win threshold (% balance)</label>
                    <input type="number" id="av-bwt" min="0" step="0.5" value="${config.bigWinThreshold}">
                    <label>Big-win multiplier</label>
                    <input type="number" id="av-bwm" min="1" step="0.5" value="${config.bigWinMultiplier}">
                    <label>Check interval (sec)</label>
                    <input type="number" id="av-int" min="10" step="10" value="${Math.round(config.checkInterval / 1000)}">
                </div>
                <div class="av-btn-row">
                    <button class="av-btn primary" id="av-toggle">${config.isRunning ? 'Stop' : 'Start'}</button>
                    <button class="av-btn danger" id="av-reset">Reset</button>
                </div>
                <div class="av-section-title">Activity</div>
                <div class="av-log" id="av-log"><div class="av-log-empty">No activity yet</div></div>
            </div>
        `;
        document.body.appendChild(gui);

        const statusEl = document.getElementById('av-status');
        const balEl = document.getElementById('av-bal');
        const vaultedEl = document.getElementById('av-vaulted');
        const profitEl = document.getElementById('av-profit');
        const toggleBtn = document.getElementById('av-toggle');
        const resetBtn = document.getElementById('av-reset');
        const miniBtn = document.getElementById('av-mini');
        const logEl = document.getElementById('av-log');

        function renderLog() {
            if (!log.length) { logEl.innerHTML = '<div class="av-log-empty">No activity yet</div>'; return; }
            logEl.innerHTML = log.map(e => {
                const t = e.time.toTimeString().slice(0, 5);
                return `<div class="av-log-row ${e.type}"><span class="av-log-time">${t}</span><span>${e.msg}</span></div>`;
            }).join('');
        }
        function renderStatus() {
            statusEl.textContent = config.isRunning ? 'ON' : 'OFF';
            statusEl.classList.toggle('on', config.isRunning);
            toggleBtn.textContent = config.isRunning ? 'Stop' : 'Start';
            // Toggle the panel status badge on the menu list too (same hook
            // the loader's refreshStatuses watches for).
            const root = document.documentElement;
            root.classList.toggle('uts-running-shuffle-autovault', config.isRunning);
        }
        // Memoize last rendered values so the 1.5s UI tick doesn't write to
        // the DOM when nothing actually changed — fewer style recalcs and
        // less work for any DOM observers Shuffle might have running.
        const _lastRendered = { bal: '\0', vaulted: '\0', profitText: '\0', profitCls: '\0' };
        function renderStats(bal, profit, vaulted) {
            const balText = isNaN(bal) ? '—' : bal.toFixed(2);
            const vaultedText = (vaulted || 0).toFixed(2);
            const profitText = isNaN(profit) ? '—' : (profit >= 0 ? '+' : '') + profit.toFixed(2);
            const profitCls = isNaN(profit) ? 'av-val' : ('av-val ' + (profit > 0 ? 'pos' : (profit < 0 ? 'neg' : '')));
            if (_lastRendered.bal !== balText) { balEl.textContent = balText; _lastRendered.bal = balText; }
            if (_lastRendered.vaulted !== vaultedText) { vaultedEl.textContent = vaultedText; _lastRendered.vaulted = vaultedText; }
            if (_lastRendered.profitText !== profitText) { profitEl.textContent = profitText; _lastRendered.profitText = profitText; }
            if (_lastRendered.profitCls !== profitCls) { profitEl.className = profitCls; _lastRendered.profitCls = profitCls; }
        }

        // ---- Monitoring loop ----
        let lastBaseline = NaN;
        let monitorTimer = null;
        let depositInProgress = false;

        async function tick() {
            if (depositInProgress) return;
            const bal = getBalance();
            if (isNaN(bal)) { renderStats(bal, NaN, getSessionVaulted()); return; }
            if (isNaN(lastBaseline)) lastBaseline = bal;
            const profit = bal - lastBaseline;
            renderStats(bal, profit, getSessionVaulted());

            if (!config.isRunning) return;
            if (profit <= 0) return;

            // Base deposit = saveAmount × profit. If profit exceeds
            // bigWinThreshold% of the prior balance (and is above a small
            // dust floor), treat it as a big win and scale the deposit by
            // bigWinMultiplier.
            const baseDeposit = profit * config.saveAmount;
            const bigWinFrac = Math.max(0, Number(config.bigWinThreshold) || 0) / 100;
            const isBigWin = bigWinFrac > 0
                && profit > (lastBaseline * bigWinFrac)
                && profit > MIN_BIG_WIN_PROFIT;
            const depositAmount = isBigWin ? baseDeposit * config.bigWinMultiplier : baseDeposit;
            if (depositAmount < MIN_DEPOSIT) return;

            depositInProgress = true;
            logEntry(`${isBigWin ? 'Big win — ' : ''}depositing ${depositAmount.toFixed(2)} (${(config.saveAmount * 100).toFixed(0)}% of ${profit.toFixed(2)})`, isBigWin ? 'bigwin' : 'info');
            try {
                const result = await depositToVault(depositAmount);
                if (result.ok) {
                    // Trust the SERVER's reported amount, not what we asked
                    // for. Track and log what actually moved.
                    const actual = result.amount;
                    addSessionVaulted(actual);
                    lastBaseline = bal - actual;
                    const ccy = result.currency ? ` ${result.currency}` : '';
                    const av = (result.afterVault != null && !isNaN(result.afterVault)) ? ` (vault: ${result.afterVault.toFixed(2)})` : '';
                    logEntry(`✓ Vaulted ${actual.toFixed(2)}${ccy}${av}`, 'success');
                } else {
                    logEntry(`Deposit failed: ${result.reason}`, 'warning');
                }
            } catch (e) {
                logEntry(`Deposit error: ${e.message}`, 'error');
            }
            depositInProgress = false;
            renderStats(getBalance(), getBalance() - lastBaseline, getSessionVaulted());
        }

        function startMonitor() {
            if (monitorTimer) return;
            lastBaseline = getBalance();
            tick();
            monitorTimer = setInterval(tick, config.checkInterval);
            logEntry('Auto-Vault started', 'success');
        }
        function stopMonitor() {
            if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
            logEntry('Auto-Vault stopped');
        }

        // ---- Event handlers ----
        toggleBtn.onclick = () => {
            config.isRunning = !config.isRunning;
            saveConfig(config);
            renderStatus();
            if (config.isRunning) startMonitor(); else stopMonitor();
        };
        resetBtn.onclick = () => {
            if (!confirm('Reset Auto-Vault session?\n\nClears vaulted-this-session total and resets the profit baseline to your current balance.')) return;
            resetSessionVaulted();
            lastBaseline = getBalance();
            log.length = 0;
            renderStats(getBalance(), 0, 0);
            renderLog();
            logEntry('Session reset', 'info');
        };
        miniBtn.onclick = () => {
            gui.classList.toggle('mini');
            miniBtn.textContent = gui.classList.contains('mini') ? '+' : '−';
        };

        // Config inputs
        document.getElementById('av-save').oninput = (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v > 0 && v <= 1) { config.saveAmount = v; saveConfig(config); }
        };
        document.getElementById('av-bwt').oninput = (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v >= 0) { config.bigWinThreshold = v; saveConfig(config); }
        };
        document.getElementById('av-bwm').oninput = (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v >= 1) { config.bigWinMultiplier = v; saveConfig(config); }
        };
        document.getElementById('av-int').oninput = (e) => {
            const v = parseInt(e.target.value);
            if (!isNaN(v) && v >= 10) {
                config.checkInterval = v * 1000; saveConfig(config);
                if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = setInterval(tick, config.checkInterval); }
            }
        };

        // Drag — attach mousemove/mouseup only while dragging so we don't
        // bleed document-wide handlers when the user isn't touching the
        // widget. Removes them on mouseup so multiple panels don't pile up.
        let dx = 0, dy = 0;
        const header = gui.querySelector('.av-header');
        const onMove = (e) => {
            let nl = e.clientX - dx, nt = e.clientY - dy;
            nl = Math.max(0, Math.min(window.innerWidth - gui.offsetWidth, nl));
            nt = Math.max(0, Math.min(window.innerHeight - gui.offsetHeight, nt));
            gui.style.left = nl + 'px'; gui.style.top = nt + 'px';
            gui.style.bottom = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const rect = gui.getBoundingClientRect();
            dx = e.clientX - rect.left; dy = e.clientY - rect.top;
            e.preventDefault();
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // ---- Init ----
        renderStatus();
        renderLog();
        // Fast UI refresh loop — keeps the displayed balance current even
        // when other tools (Limbo/Dice auto-bot) are changing it every
        // second. Independent of the slow deposit-check tick. Guarded with
        // a global timer id so a re-run on SPA navigation replaces the
        // previous timer instead of stacking.
        if (PAGE_WIN.__shuffleAvUiTimer) clearInterval(PAGE_WIN.__shuffleAvUiTimer);
        PAGE_WIN.__shuffleAvUiTimer = setInterval(() => {
            if (depositInProgress) return;
            const bal = getBalance();
            if (isNaN(bal)) return;
            if (isNaN(lastBaseline)) lastBaseline = bal;
            renderStats(bal, bal - lastBaseline, getSessionVaulted());
        }, 1500);
        // First full tick after a brief delay so the header balance has rendered.
        setTimeout(() => { renderStats(getBalance(), NaN, getSessionVaulted()); if (config.isRunning) startMonitor(); }, 1500);
    }

    /* =========================================================
       TOOL REGISTRY — DEFINITIONS
       Add a new tool: define its body as a tool_xxx() function
       above, then call register({...}, tool_xxx) here.
       ========================================================= */

    /* ----- Stake Auto-Vault ----- */
    register({
        id: 'stake-autovault',
        name: 'Stake Auto-Vault',
        description: 'Auto-deposits a % of profits to your Stake vault.',
        matches: [
            'https://stake.com/*',
            'https://stake.bet/*',
            'https://stake.games/*',
            'https://staketr.com/*',
            'https://staketr2.com/*',
            'https://staketr3.com/*',
            'https://staketr4.com/*',
            'https://stake.bz/*',
            'https://stake.us/*',
            'https://stake.pet/*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Stake',
        uiSelectors: ['#autovault-floaty', '#autovault-stealth']
    }, tool_stake_autovault);

    /* ----- Stake / Shuffle IOW/Smart + Dice Tool (split into 4 entries) -----
       Same underlying body code as before, but registered as four separate
       tools (Stake Dice, Stake Limbo, Shuffle Dice, Shuffle Limbo) so the
       user can toggle each game independently. All four invoke the same
       shared wrapper `runIowSmartAndDice` which decides what to initialize
       from the current URL — and which uses module-level init-once flags
       so the heavy setup work happens exactly once per page load no matter
       which of the four registered slots fires it. The HUD/dice-tool then
       persists across SPA navigation between the four games, and the
       per-tool enabled state is enforced by buildHUD (via
       isCurrentGameEnabled), which tears the HUD down when the user has
       the specific game disabled. */
    const _iowDiceInit = { iowSmart: false, diceTool: false };
    function runIowSmartAndDice() {
        const url = location.href;
        const isDiceLimbo = /\/(?:casino\/games|games\/originals)\/(?:dice|limbo|primedice)(?:\/|$|\?|#)/i.test(url);
        const isDicePrime = /\/(?:casino\/games|games\/originals)\/(?:dice|primedice)(?:\/|$|\?|#)/i.test(url);
        if (isDiceLimbo && !_iowDiceInit.iowSmart) {
            try { tool_stake_iow_smart(); _iowDiceInit.iowSmart = true; }
            catch (e) { console.error('[UnifiedTools] iow-smart init error:', e); }
        }
        if (isDicePrime && !_iowDiceInit.diceTool) {
            try { tool_dice_tool(); _iowDiceInit.diceTool = true; }
            catch (e) { console.error('[UnifiedTools] dice-tool init error:', e); }
        }
    }
    register({
        id: 'stake-dice',
        name: 'Stake Dice',
        description: 'Manual / IOW / Smart bet-sizing modes plus the Advanced IOW (Calculator / Optimizer / Results) tab on Stake Dice.',
        matches: [
            'https://stake.us/casino/games/dice*',
            'https://stake.com/casino/games/dice*',
            'https://stake.us/casino/games/primedice*',
            'https://stake.com/casino/games/primedice*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Stake',
        // hijacksPage: re-parents Stake's native bet panel into the HUD.
        // Toggle reloads the page and the body skips when disabled.
        hijacksPage: true
    }, runIowSmartAndDice);
    register({
        id: 'stake-limbo',
        name: 'Stake Limbo',
        description: 'Manual / IOW / Smart bet-sizing modes on Stake Limbo.',
        matches: [
            'https://stake.us/casino/games/limbo*',
            'https://stake.com/casino/games/limbo*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Stake',
        hijacksPage: true
    }, runIowSmartAndDice);
    register({
        id: 'shuffle-dice',
        name: 'Shuffle Dice',
        description: 'Manual / IOW / Smart bet-sizing modes plus the Advanced IOW tab on Shuffle Dice.',
        matches: [
            'https://shuffle.us/games/originals/dice*',
            'https://shuffle.com/games/originals/dice*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Shuffle',
        hijacksPage: true
    }, runIowSmartAndDice);
    register({
        id: 'shuffle-limbo',
        name: 'Shuffle Limbo',
        description: 'Manual / IOW / Smart bet-sizing modes on Shuffle Limbo.',
        matches: [
            'https://shuffle.us/games/originals/limbo*',
            'https://shuffle.com/games/originals/limbo*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Shuffle',
        hijacksPage: true
    }, runIowSmartAndDice);

    /* ----- Shuffle Auto-Vault ----- */
    register({
        id: 'shuffle-autovault',
        name: 'Shuffle Auto-Vault',
        description: 'Tracks balance + session profit on Shuffle, with one-click access to the vault dialog.',
        matches: [
            'https://shuffle.us/*',
            'https://shuffle.com/*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Shuffle',
        uiSelectors: ['#autovault-floaty']
    }, tool_shuffle_autovault);

    /* ----- Shuffle Mines ----- */
    register({
        id: 'shuffle-mines',
        name: 'Shuffle Mines',
        description: 'Auto-plays Mines on Shuffle with weighted random tile picks.',
        matches: [
            'https://shuffle.us/games/originals/mines*',
            'https://shuffle.com/games/originals/mines*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Shuffle',
        uiSelectors: ['#mines-auto-gui']
    }, tool_shuffle_mines);

    /* ----- Shuffle Keno ----- */
    register({
        id: 'shuffle-keno',
        name: 'Shuffle Keno',
        description: 'Save & load Keno number + risk presets on Shuffle.',
        matches: [
            'https://shuffle.us/games/originals/keno*',
            'https://shuffle.com/games/originals/keno*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Shuffle',
        uiSelectors: ['#keno-preset-gui']
    }, tool_shuffle_keno);

    /* ----- Stake Keno ----- */
    register({
        id: 'stake-keno',
        name: 'Stake Keno',
        description: 'Save & load Keno number + difficulty presets on Stake.',
        matches: [
            'https://stake.com/casino/games/keno*',
            'https://stake.us/casino/games/keno*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Stake',
        uiSelectors: ['#keno-preset-gui']
    }, tool_stake_keno);

    /* ----- Stake Mines ----- */
    register({
        id: 'stake-mines',
        name: 'Stake Mines',
        description: 'Auto-plays Mines on Stake with weighted random tile picks.',
        matches: [
            'https://stake.us/casino/games/mines*',
            'https://stake.com/casino/games/mines*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Stake',
        uiSelectors: ['#mines-auto-gui']
    }, tool_stake_mines);

    /* ----- Nuts Auto-Vault ----- */
    register({
        id: 'nuts-autovault',
        name: 'Nuts Auto-Vault',
        description: 'Auto-deposits a % of profits to your Nuts vault.',
        matches: [
            'https://nuts.gg/*',
            'https://*.nuts.gg/*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Nuts',
        uiSelectors: ['#nuts-autovault-floaty', '#nuts-autovault-stealth']
    }, tool_nuts_autovault);

    /* ----- Nuts Dice / Limbo (Target) — same body, split into 2 toggles ----- */
    const _nutsIowSmartInit = { ran: false };
    function runNutsIowSmart() {
        if (_nutsIowSmartInit.ran) return;
        try { tool_nuts_iow_smart(); _nutsIowSmartInit.ran = true; }
        catch (e) { console.error('[UnifiedTools] nuts-iow-smart init error:', e); }
    }
    register({
        id: 'nuts-dice',
        name: 'Nuts Dice',
        description: 'Manual / IOW / Smart bet-sizing modes on Nuts Dice.',
        matches: [
            'https://nuts.gg/dice*',
            'https://*.nuts.gg/dice*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Nuts',
        hijacksPage: true
    }, runNutsIowSmart);
    register({
        id: 'nuts-limbo-target',
        name: 'Nuts Limbo/Target',
        description: 'Manual / IOW / Smart bet-sizing modes on Nuts Target (Limbo equivalent).',
        matches: [
            'https://nuts.gg/target*',
            'https://*.nuts.gg/target*'
        ],
        runAt: 'document-start',
        defaultEnabled: true,
        group: 'Nuts',
        hijacksPage: true
    }, runNutsIowSmart);

    /* ----- Nuts Keno ----- */
    register({
        id: 'nuts-keno',
        name: 'Nuts Keno',
        description: 'Save & load Keno number + risk presets on Nuts.',
        matches: [
            'https://nuts.gg/keno*',
            'https://*.nuts.gg/keno*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Nuts',
        uiSelectors: ['#keno-preset-gui']
    }, tool_nuts_keno);

    /* ----- Nuts Mines ----- */
    register({
        id: 'nuts-mines',
        name: 'Nuts Mines',
        description: 'Auto-plays Mines on Nuts with rapid burst clicking & cashout.',
        matches: [
            'https://nuts.gg/mines*',
            'https://*.nuts.gg/mines*'
        ],
        runAt: 'document-end',
        defaultEnabled: true,
        group: 'Nuts',
        uiSelectors: ['#mines-auto-gui']
    }, tool_nuts_mines);


    /* =========================================================
       CONTROL PANEL UI
       --------------------------------------------------------
       Floating ⚙ button (bottom-left) opens the panel. The panel
       lists every registered tool grouped by site (Stake / Nuts.gg
       / Other), each with a status line and an enable/disable
       switch. Footer has bulk Enable matched / Disable all.
       Header is draggable; position is persisted in localStorage.
       ========================================================= */

    const PANEL_ID         = 'unified-tools-panel';
    const PANEL_TOGGLE_ID  = 'unified-tools-toggle';
    const PANEL_STYLE_ID   = 'unified-tools-style';

    const PANEL_CSS = `
    #${PANEL_TOGGLE_ID} {
        position: fixed; bottom: 16px; left: 16px; z-index: 2147483646;
        width: 38px; height: 38px; border-radius: 50%;
        background: linear-gradient(135deg, #1f2937, #0f172a);
        border: 1px solid rgba(148, 163, 184, 0.3);
        color: #e2e8f0; font-size: 18px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 18px rgba(0,0,0,0.45);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        user-select: none;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    #${PANEL_TOGGLE_ID}:hover {
        transform: scale(1.06);
        box-shadow: 0 8px 22px rgba(0,0,0,0.55);
    }
    #${PANEL_TOGGLE_ID}.has-active::after {
        content: ''; position: absolute; top: 4px; right: 4px;
        width: 8px; height: 8px; border-radius: 50%;
        background: #10b981; box-shadow: 0 0 6px #10b981;
    }
    #${PANEL_ID} {
        position: fixed; bottom: 64px; left: 16px; z-index: 2147483647;
        width: 320px; max-height: 70vh;
        background: linear-gradient(180deg, #111827 0%, #0b1220 100%);
        color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; user-select: none;
        display: flex; flex-direction: column; overflow: hidden;
    }
    #${PANEL_ID}.hidden { display: none; }
    #${PANEL_ID} .ut-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px;
        background: linear-gradient(135deg, #1f2937, #111827);
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
        cursor: grab;
    }
    #${PANEL_ID} .ut-header:active { cursor: grabbing; }
    #${PANEL_ID} .ut-title {
        font-weight: 700; font-size: 13px; color: #f8fafc;
        letter-spacing: 0.3px;
    }
    #${PANEL_ID} .ut-title small {
        display: block; font-weight: 400; font-size: 10px; color: #94a3b8;
        margin-top: 2px;
    }
    #${PANEL_ID} .ut-header-btn {
        background: none; border: none; color: #94a3b8;
        font-size: 18px; line-height: 1; cursor: pointer;
        padding: 2px 6px; border-radius: 4px;
    }
    #${PANEL_ID} .ut-header-btn:hover { color: #fff; background: rgba(148, 163, 184, 0.15); }
    #${PANEL_ID} .ut-body {
        flex: 1 1 auto; overflow-y: auto;
        padding: 8px 0;
    }
    #${PANEL_ID} .ut-body::-webkit-scrollbar { width: 6px; }
    #${PANEL_ID} .ut-body::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 3px; }
    #${PANEL_ID} .ut-group {
        padding: 6px 12px 4px;
        font-size: 10px; color: #64748b;
        text-transform: uppercase; letter-spacing: 0.6px;
        border-top: 1px solid rgba(148, 163, 184, 0.08);
    }
    #${PANEL_ID} .ut-group:first-child { border-top: none; }
    #${PANEL_ID} .ut-tool {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 8px 12px;
        transition: background 0.12s ease;
    }
    #${PANEL_ID} .ut-tool:hover { background: rgba(148, 163, 184, 0.06); }
    #${PANEL_ID} .ut-tool.unmatched { opacity: 0.45; }
    #${PANEL_ID} .ut-tool-info { flex: 1 1 auto; min-width: 0; }
    #${PANEL_ID} .ut-tool-name {
        font-weight: 600; color: #f1f5f9; font-size: 12px;
        line-height: 1.3;
    }
    #${PANEL_ID} .ut-tool-desc {
        font-size: 11px; color: #94a3b8; margin-top: 2px;
        line-height: 1.35;
    }
    #${PANEL_ID} .ut-tool-status {
        font-size: 10px; color: #64748b; margin-top: 4px;
        text-transform: uppercase; letter-spacing: 0.4px;
    }
    #${PANEL_ID} .ut-tool-status.running { color: #10b981; }
    #${PANEL_ID} .ut-tool-status.disabled { color: #f59e0b; }
    #${PANEL_ID} .ut-tool-status.unmatched { color: #475569; }
    #${PANEL_ID} .ut-switch {
        position: relative;
        width: 36px; height: 20px;
        background: #334155; border-radius: 10px; cursor: pointer;
        flex: 0 0 auto;
        transition: background 0.15s ease;
    }
    #${PANEL_ID} .ut-switch::after {
        content: ''; position: absolute;
        top: 2px; left: 2px;
        width: 16px; height: 16px;
        border-radius: 50%; background: #f8fafc;
        transition: transform 0.15s ease;
    }
    #${PANEL_ID} .ut-switch.on { background: #10b981; }
    #${PANEL_ID} .ut-switch.on::after { transform: translateX(16px); }
    #${PANEL_ID} .ut-footer {
        padding: 8px 12px;
        border-top: 1px solid rgba(148, 163, 184, 0.15);
        display: flex; gap: 6px;
        background: rgba(15, 23, 42, 0.6);
    }
    #${PANEL_ID} .ut-footer-btn {
        flex: 1 1 auto;
        background: rgba(148, 163, 184, 0.1);
        border: 1px solid rgba(148, 163, 184, 0.25);
        color: #cbd5e1;
        font-size: 11px; font-weight: 600;
        padding: 6px 8px; border-radius: 6px;
        cursor: pointer;
        text-transform: uppercase; letter-spacing: 0.4px;
    }
    #${PANEL_ID} .ut-footer-btn:hover { background: rgba(148, 163, 184, 0.18); color: #fff; }
    #${PANEL_ID} .ut-footer-btn.danger { color: #fca5a5; }
    #${PANEL_ID} .ut-footer-btn.danger:hover { color: #fff; background: rgba(239, 68, 68, 0.2); }
    #${PANEL_ID} .ut-empty {
        padding: 20px 16px; text-align: center;
        color: #64748b; font-size: 11px; font-style: italic;
    }
    `;

    /** Inject the panel stylesheet once. */
    function injectPanelStyle() {
        if (document.getElementById(PANEL_STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = PANEL_STYLE_ID;
        s.textContent = PANEL_CSS;
        document.head.appendChild(s);
    }

    /** Read the user's saved panel position (or null if never moved). */
    function loadPanelPos() {
        try {
            const raw = localStorage.getItem(PANEL_POS_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw);
            if (typeof p.left === 'number' && typeof p.top === 'number') return p;
        } catch {}
        return null;
    }
    /** Persist the panel position so dragging survives reloads. */
    function savePanelPos(left, top) {
        try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top })); } catch {}
    }

    /** Build the toggle button + panel and wire up all its event handlers. */
    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;
        injectPanelStyle();

        const toggle = document.createElement('button');
        toggle.id = PANEL_TOGGLE_ID;
        toggle.title = 'Open Unified Tools Panel';
        toggle.textContent = '⚙';

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'hidden';

        const initiallyOpen = localStorage.getItem(PANEL_OPEN_KEY) === '1';
        if (initiallyOpen) panel.classList.remove('hidden');

        const savedPos = loadPanelPos();
        if (savedPos) {
            panel.style.left = savedPos.left + 'px';
            panel.style.top = savedPos.top + 'px';
            panel.style.bottom = 'auto';
        }

        const matching = TOOLS.filter(t => urlMatches(t, location.href));
        const groups = {};
        for (const t of TOOLS) {
            const g = t.group || 'Other';
            if (!groups[g]) groups[g] = [];
            groups[g].push(t);
        }

        let body = '<div class="ut-header">' +
            '<div class="ut-title">Unified Tools' +
                '<small id="ut-count">' + matching.length + ' available on this page</small>' +
            '</div>' +
            '<div>' +
                '<button class="ut-header-btn" id="ut-collapse" title="Collapse">×</button>' +
            '</div>' +
        '</div>' +
        '<div class="ut-body">';

        const groupOrder = ['Stake', 'Shuffle', 'Nuts', 'Other'];
        for (const groupName of groupOrder) {
            const list = groups[groupName];
            if (!list || !list.length) continue;
            body += '<div class="ut-group">' + groupName + '</div>';
            for (const t of list) {
                const matched = urlMatches(t, location.href);
                const enabled = isEnabled(t);
                const cls = 'ut-tool' + (matched ? '' : ' unmatched');
                const switchCls = 'ut-switch' + (enabled ? ' on' : '');
                body += '<div class="' + cls + '" data-tool-id="' + t.id + '">' +
                    '<div class="ut-tool-info">' +
                        '<div class="ut-tool-name">' + escapeHtml(t.name) + '</div>' +
                        '<div class="ut-tool-desc">' + escapeHtml(t.description || '') + '</div>' +
                        '<div class="ut-tool-status" data-status="' + t.id + '"></div>' +
                    '</div>' +
                    '<div class="' + switchCls + '" data-switch="' + t.id + '" title="Toggle"></div>' +
                '</div>';
            }
        }

        if (TOOLS.length === 0) {
            body += '<div class="ut-empty">No tools registered.</div>';
        }

        body += '</div>' +
        '<div class="ut-footer">' +
            '<button class="ut-footer-btn" id="ut-enable-all">Enable matched</button>' +
            '<button class="ut-footer-btn danger" id="ut-disable-all">Disable all</button>' +
        '</div>';

        panel.innerHTML = body;
        document.body.appendChild(panel);
        document.body.appendChild(toggle);

        toggle.onclick = () => {
            const willShow = panel.classList.contains('hidden');
            panel.classList.toggle('hidden', !willShow);
            try { localStorage.setItem(PANEL_OPEN_KEY, willShow ? '1' : '0'); } catch {}
        };

        panel.querySelector('#ut-collapse').onclick = () => {
            panel.classList.add('hidden');
            try { localStorage.setItem(PANEL_OPEN_KEY, '0'); } catch {}
        };

        panel.querySelectorAll('[data-switch]').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.getAttribute('data-switch');
                const tool = TOOLS.find(t => t.id === id);
                if (!tool) return;
                const newState = !isEnabled(tool);
                setEnabled(id, newState);
                el.classList.toggle('on', newState);
                applyToolVisibility(tool);
                try { applyQuickToggles(); } catch (e) {}
                refreshStatuses();
                updateToggleBadge();

                // hijacksPage tools always reload on toggle — their HUD owns
                // relocated native page DOM that can't be hidden in place.
                if (tool.hijacksPage && urlMatches(tool, location.href)) {
                    location.reload();
                    return;
                }

                // Non-hijacking tools toggle hide/show via CSS class instantly.
                // The one corner case is enabling a tool that didn't load
                // (corrupted state, race, prior version that gated by enabled).
                // In that case auto-refresh so it can initialize cleanly.
                if (newState && urlMatches(tool, location.href) && !tool._ran) {
                    location.reload();
                }
            });
        });

        panel.querySelector('#ut-enable-all').onclick = () => {
            const matchedTools = TOOLS.filter(t => urlMatches(t, location.href));
            let needsReload = false;
            for (const t of matchedTools) {
                if (!isEnabled(t) && t.hijacksPage) needsReload = true;
                setEnabled(t.id, true);
                if (!t._ran) needsReload = true;
            }
            refreshSwitches();
            for (const t of TOOLS) applyToolVisibility(t);
            try { applyQuickToggles(); } catch (e) {}
            refreshStatuses();
            updateToggleBadge();
            if (needsReload) location.reload();
        };
        panel.querySelector('#ut-disable-all').onclick = () => {
            let needsReload = false;
            for (const t of TOOLS) {
                if (isEnabled(t) && t.hijacksPage && urlMatches(t, location.href) && t._ran) {
                    needsReload = true;
                }
                setEnabled(t.id, false);
            }
            refreshSwitches();
            for (const t of TOOLS) applyToolVisibility(t);
            try { applyQuickToggles(); } catch (e) {}
            refreshStatuses();
            updateToggleBadge();
            if (needsReload) location.reload();
        };

        const header = panel.querySelector('.ut-header');
        let dragging = false, dx = 0, dy = 0;
        const startPanelDrag = (x, y) => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            dx = x - r.left; dy = y - r.top;
        };
        const movePanelDrag = (x, y) => {
            if (!dragging) return;
            let nl = x - dx, nt = y - dy;
            nl = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, nl));
            nt = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, nt));
            panel.style.left = nl + 'px';
            panel.style.top = nt + 'px';
            panel.style.bottom = 'auto'; panel.style.right = 'auto';
            savePanelPos(nl, nt);
        };
        const endPanelDrag = () => { dragging = false; };
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            startPanelDrag(e.clientX, e.clientY);
            e.preventDefault();
        });
        header.addEventListener('touchstart', (e) => {
            if (e.target.closest('button')) return;
            const t = e.touches[0]; if (!t) return;
            startPanelDrag(t.clientX, t.clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('mousemove', (e) => movePanelDrag(e.clientX, e.clientY));
        document.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            const t = e.touches[0]; if (!t) return;
            movePanelDrag(t.clientX, t.clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('mouseup', endPanelDrag);
        document.addEventListener('touchend', endPanelDrag, { passive: true });
        document.addEventListener('touchcancel', endPanelDrag, { passive: true });

        refreshStatuses();
        updateToggleBadge();
    }

    /** Minimal HTML escape used for tool names/descriptions in the panel. */
    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    /** Inline reload-prompt banner (currently unused — kept for future settings flows). */
    function showReloadHint(panel) {
        if (panel.querySelector('.ut-reload-hint')) return;
        const hint = document.createElement('div');
        hint.className = 'ut-reload-hint';
        hint.style.cssText = 'padding:8px 12px;background:rgba(245,158,11,0.15);color:#fbbf24;font-size:11px;text-align:center;border-top:1px solid rgba(245,158,11,0.3);';
        hint.innerHTML = 'Reload the page for new tools to take effect. ' +
            '<button style="margin-left:6px;background:#fbbf24;color:#000;border:none;border-radius:4px;padding:3px 8px;font-weight:700;cursor:pointer;font-size:11px;" onclick="location.reload()">Reload now</button>';
        panel.querySelector('.ut-footer').before(hint);
    }

    /** Sync each switch's visual on/off state to the persisted setting. */
    function refreshSwitches() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelectorAll('[data-switch]').forEach(el => {
            const id = el.getAttribute('data-switch');
            const tool = TOOLS.find(t => t.id === id);
            if (!tool) return;
            el.classList.toggle('on', isEnabled(tool));
        });
    }

    /** Refresh the per-tool status line ("Running" / "Hidden" / "Not for this page" / "Loading…"). */
    function refreshStatuses() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelectorAll('[data-status]').forEach(el => {
            const id = el.getAttribute('data-status');
            const tool = TOOLS.find(t => t.id === id);
            if (!tool) return;
            const matched = urlMatches(tool, location.href);
            const enabled = isEnabled(tool);
            el.className = 'ut-tool-status';
            if (!matched) {
                el.classList.add('unmatched');
                el.textContent = 'Not for this page';
            } else if (!enabled) {
                el.classList.add('disabled');
                el.textContent = tool._ran ? 'Hidden (loaded)' : 'Hidden';
            } else if (tool._ran) {
                el.classList.add('running');
                el.textContent = 'Running';
            } else {
                el.classList.add('disabled');
                el.textContent = 'Loading…';
            }
        });
    }

    /** Add/remove the green dot on the ⚙ toggle button when any tool is running. */
    function updateToggleBadge() {
        const toggle = document.getElementById(PANEL_TOGGLE_ID);
        if (!toggle) return;
        const anyActive = TOOLS.some(t => t._ran);
        toggle.classList.toggle('has-active', anyActive);
    }

    /* =========================================================
       BOOT SEQUENCE
       --------------------------------------------------------
       Order of operations:
         1. document-start: hide disabled-tool selectors as early
            as possible (avoids a flash of UI before they hide).
         2. document-start: run any tools registered with
            runAt: 'document-start' (e.g. the IOW/Smart HUDs that
            need to hijack page DOM before React mounts).
         3. DOMContentLoaded: run document-end tools.
         4. +1500 ms: build the control panel (delay gives slow
            sites time to settle their own DOM mutations so the
            panel doesn't fight a re-render).
         5. setupIowDiceIntegration: stitch the Dice Tool's
            calculator/optimizer into the IOW/Smart HUD as the
            "Advanced IOW" tab.
       ========================================================= */

    /** applyAllVisibility() that swallows pre-DOM errors. */
    function safeApplyAllVisibility() {
        try { applyAllVisibility(); } catch (e) {}
    }

    // Step 1: apply disabled-tool visibility ASAP.
    safeApplyAllVisibility();

    // Re-inject the visibility CSS once <head> exists (in case we ran before
    // <head> was constructed and the style failed to attach).
    if (!document.getElementById(VISIBILITY_STYLE_ID)) {
        const headObserver = new MutationObserver(() => {
            if (document.head) {
                safeApplyAllVisibility();
                if (document.getElementById(VISIBILITY_STYLE_ID)) headObserver.disconnect();
            }
        });
        headObserver.observe(document.documentElement, { childList: true });
    }

    // Step 2: document-start tools.
    for (const t of TOOLS) maybeRun(t, 'document-start');
    safeApplyAllVisibility();

    /** Run `fn` on DOMContentLoaded, or immediately if the DOM is already ready. */
    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    onReady(() => {
        // Step 3: document-end tools.
        for (const t of TOOLS) maybeRun(t, 'document-end');
        safeApplyAllVisibility();
        try { applyQuickToggles(); } catch (e) {}

        // Step 4: control panel (delayed so sites finish mutating).
        setTimeout(() => {
            try { buildPanel(); } catch (e) { console.error('[UnifiedTools] panel build failed:', e); }
            safeApplyAllVisibility();
            try { applyQuickToggles(); } catch (e) {}
        }, 1500);

        // Step 5: cross-tool stitching for IOW/Smart + Dice Tool.
        setupIowDiceIntegration();

        // Step 6: SPA navigation watcher — fires when the user moves between
        // pages without a full reload (Stake/Shuffle/Nuts all use React
        // routers, so clicking between games never reloads the script). Two
        // jobs on each URL change:
        //   1. Re-apply tool visibility, so the URL-mismatch class hides UIs
        //      from tools whose @match patterns no longer match (e.g. Mines
        //      UI stays out of the Stake lobby).
        //   2. Run any not-yet-run tool whose @match now covers the new URL,
        //      so SPA-navigating to /casino/games/mines from elsewhere on
        //      Stake actually loads the Mines tool.
        installSpaNavWatcher();
    });

    /** Detects SPA URL changes (pushState, replaceState, popstate) and
     *  triggers visibility refresh + lazy tool loading. Idempotent — safe
     *  to call once. */
    function installSpaNavWatcher() {
        if (window.__unifiedToolsSpaWatcherInstalled) return;
        window.__unifiedToolsSpaWatcherInstalled = true;

        let lastUrl = location.href;
        function onUrlChange() {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            safeApplyAllVisibility();
            try { applyQuickToggles(); } catch (e) {}
            // Lazy-load tools that haven't run yet but now match. Uses each
            // tool's registered runAt phase. Tools that already ran keep
            // their original intervals/observers alive — their internal URL
            // guards (where present) take care of tear-down.
            for (const t of TOOLS) {
                try { maybeRun(t, t.runAt || 'document-end'); }
                catch (e) { console.error('[UnifiedTools] error running tool on SPA nav:', e); }
            }
        }

        // Patch history methods so SPA-driven URL changes notify us. Defer
        // by a tick because pushState fires before location.href has
        // finished updating in some browsers.
        try {
            const origPush = history.pushState;
            history.pushState = function () {
                const ret = origPush.apply(this, arguments);
                setTimeout(onUrlChange, 0);
                return ret;
            };
            const origReplace = history.replaceState;
            history.replaceState = function () {
                const ret = origReplace.apply(this, arguments);
                setTimeout(onUrlChange, 0);
                return ret;
            };
        } catch (e) { /* userscript world may not let us patch */ }

        window.addEventListener('popstate', () => setTimeout(onUrlChange, 0));

        // Polling fallback: catches any URL changes the patches above miss
        // (e.g. React router replacements that bypass the patched methods,
        // or sites that swap window.history). Cheap — 500ms compare-strings.
        setInterval(onUrlChange, 500);
    }

    /* =========================================================
       IOW/SMART  ↔  DICE TOOL INTEGRATION
       --------------------------------------------------------
       Two responsibilities:

       1. NATIVE BET-MODE ENFORCEMENT
          When the IOW/Smart HUD is present on a Stake page, the
          injected mode buttons (Manual / IOW / Smart / Advanced
          IOW) must keep Stake's native bet mode tabs aligned:
             Manual / IOW / Smart   → native "Manual"
             Advanced IOW           → native "Advanced"
          We click the wrong native tab only when we positively
          detect it as active — never on a guess — so we don't
          spam-click and stop a running auto-bet.

       2. DICE TOOL INTEGRATION ("Advanced IOW" tab)
          When both the IOW/Smart HUD and the Dice Tool panel are
          mounted on the same page, we add an "Advanced IOW" mode
          button to the HUD's mode-wrap that swaps the Dice Tool's
          panel (Calculator / Optimizer / Results / Settings, plus
          a new Stats and Terms tab) into the HUD's #hud-content
          area. The Stats tab uses the IOW/Smart .hud-* classes
          directly so it visually matches the Manual / IOW / Smart
          panels.
       ========================================================= */
    function setupIowDiceIntegration() {
        // ---- State (closed over by everything below) ----
        let stitched          = false;  // true once tryStitch has wired up the HUD
        let toolsActive       = false;  // true while the "Advanced IOW" mode is showing
        let toolsBtn          = null;   // the injected mode button
        let dicePanel         = null;   // reference to the dice tool's #dt-aio-panel
        let hud               = null;   // reference to #ratchet-master-container
        let originalParent    = null;   // where dicePanel lived before we relocated it
        let lastNonToolsMode  = null;   // remembers Manual/IOW/Smart so toggling back works
        let baseBetAtStart    = null;   // wager value captured the moment the user clicked START — used by Switch Over/Under to restore the bet after stopping autoplay
        // Idempotency flags so tryStitch can re-run after SPA navigation
        // rebuilds the HUD without double-attaching listeners/intervals.
        let toolsSyncerStarted    = false;
        let modeBtnListenersAttached = false;
        // Last-seen value of the strategy editor's Condition 4 threshold —
        // only updated when Condition 4 is set up as "Stop autoplay" on
        // "Balance ≥ X". Cached so the Balance Target stat stays populated
        // after the user closes the Advanced Play modal. Cleared on page
        // reload. null = no compatible Condition 4 has been observed yet.
        let cond4BalanceTarget    = null;

        /* ---- NATIVE STAKE MODE DETECTION ---- */

        /** True for any element that belongs to our injected UI (panel, dice panel, mode buttons). */
        function isOurInternalEl(el) {
            return !!(
                el.closest('#unified-tools-panel') ||
                el.closest('#unified-tools-toggle') ||
                el.closest('#dt-aio-panel') ||
                el.id === 'dt-aio-button' ||
                (el.id && el.id.startsWith && el.id.startsWith('mode-'))
            );
        }

        /** Locate Stake's three native bet-mode tab buttons (Manual / Auto / Advanced). */
        function findNativeStakeModeButtons() {
            const result = { manual: null, auto: null, advanced: null };

            // Stake's live DOM (verified from devtools dump) uses:
            //   Manual tab   → [data-testid="manual-tab"]   (also data-analytics="manual-bet-button")
            //   Auto tab     → [data-testid="auto-tab"]     (also data-analytics="auto-bet-button")
            //   Advanced tab → [data-testid="advanced-tab"] (also data-analytics="advanced-bet-button")
            // The shorter "manual"/"auto" forms appeared in older Stake builds; kept as fallback.
            const testIdMap = {
                manual:   ['button[data-testid="manual-tab"]',  '[data-testid="manual-tab"]',  '[data-analytics="manual-bet-button"]',  '[data-testid="manual"]',  '[data-testid="bet-tab-manual"]'],
                auto:     ['button[data-testid="auto-tab"]',    '[data-testid="auto-tab"]',    '[data-analytics="auto-bet-button"]',    '[data-testid="auto"]',    '[data-testid="bet-tab-auto"]'],
                advanced: ['button[data-testid="advanced-tab"]','[data-testid="advanced-tab"]','[data-analytics="advanced-bet-button"]','[data-testid="advanced"]','[data-testid="bet-tab-advanced"]']
            };
            for (const mode of Object.keys(testIdMap)) {
                for (const sel of testIdMap[mode]) {
                    const el = document.querySelector(sel);
                    if (el && !isOurInternalEl(el)) { result[mode] = el; break; }
                }
            }

            // Fallback: scan buttons / tabs by text for any tab we didn't pick up.
            if (!result.manual || !result.auto || !result.advanced) {
                const candidates = document.querySelectorAll('button, [role="tab"]');
                for (const el of candidates) {
                    if (isOurInternalEl(el)) continue;
                    const txt = (el.textContent || '').trim().toLowerCase();
                    if ((txt === 'manual') && !result.manual) result.manual = el;
                    else if ((txt === 'auto') && !result.auto) result.auto = el;
                    else if ((txt === 'advanced' || txt === 'adv') && !result.advanced) result.advanced = el;
                }
            }

            return result;
        }

        /** Heuristic: does this tab button currently look "active" in the page's UI? */
        function isLikelyActive(btn) {
            if (!btn) return false;
            // Stake uses Tailwind "prime-active:" variants which trigger when
            // the button has data-prime-active="true". That + the standard
            // ARIA / data-state patterns covers most React/Svelte UIs.
            const SEL = '.active, .selected, [aria-selected="true"], [aria-pressed="true"], [data-active="true"], [data-selected="true"], [data-prime-active="true"], [data-state="active"], [data-state="open"]';
            if (btn.matches && btn.matches(SEL)) return true;
            // Walk up two levels in case the active-state lives on a wrapper.
            let p = btn.parentElement;
            for (let i = 0; i < 2 && p; i++) {
                if (p.matches && p.matches(SEL)) return true;
                p = p.parentElement;
            }
            for (const cls of btn.classList) {
                const lower = cls.toLowerCase();
                if (lower === 'active' || lower === 'selected') return true;
            }
            return false;
        }

        /** Clean up styling left over by an older script version that greyed out tabs. */
        function clearAnyOldBlock(btn) {
            // Earlier versions of this script greyed out "wrong" tabs. We now
            // just switch instead — make sure no leftover styling persists.
            if (!btn) return;
            if (btn.hasAttribute('data-unified-blocked')) {
                btn.style.pointerEvents = '';
                btn.style.opacity = '';
                btn.style.cursor = '';
                btn.removeAttribute('data-unified-blocked');
            }
            if (btn.hasAttribute('data-unified-original-title')) {
                btn.title = btn.getAttribute('data-unified-original-title') || '';
                btn.removeAttribute('data-unified-original-title');
            }
        }

        /**
         * Periodic enforcement of the native bet-mode tab.
         * Called from the 500ms ticker. Clicks the desired tab ONLY when we
         * positively detect a wrong tab as active — silent (no-op) when we
         * can't tell, so we don't spam-click and stop a running auto-bet.
         */
        function enforceNativeMode() {
            // Only enforce when the IOW/Smart HUD is actually present.
            const localHud = document.getElementById('ratchet-master-container');
            if (!localHud) return;

            const desired = toolsActive ? 'advanced' : 'manual';
            const wrong   = ['manual', 'auto', 'advanced'].filter(m => m !== desired);
            const btns    = findNativeStakeModeButtons();

            // Only click if we POSITIVELY detect a wrong tab as active.
            // Spamming clicks (when isLikelyActive can't tell) was stopping
            // Stake's running auto-bet every 500 ms.
            let wrongIsActive = false;
            for (const m of wrong) {
                if (btns[m] && isLikelyActive(btns[m])) { wrongIsActive = true; break; }
            }
            if (wrongIsActive && btns[desired]) {
                try { btns[desired].click(); } catch (e) {}
            }

            ['manual', 'auto', 'advanced'].forEach(m => clearAnyOldBlock(btns[m]));
        }

        /**
         * Hard force used at transitions (Advanced IOW toggle, mode change).
         * Always clicks the desired tab regardless of detected state — runs
         * at most once per user action, so it can't loop and stop the auto-bet.
         */
        function forceNativeMode(target) {
            const localHud = document.getElementById('ratchet-master-container');
            if (!localHud) return;
            const btns = findNativeStakeModeButtons();
            const btn = btns[target];
            if (!btn) return;
            // Skip if already active to avoid an unnecessary click that might
            // collapse the strategy editor.
            if (isLikelyActive(btn)) return;
            try { btn.click(); } catch (e) {}
        }

        /* ---- DICE TOOL ↔ IOW/SMART HUD STITCHER ----
           One-shot wiring that runs once both the IOW/Smart HUD and the Dice
           Tool panel are present in the DOM. Adds bridge CSS, hides the
           Dice Tool's own floating chrome, injects the Advanced IOW mode
           button, and creates the Stats + Terms tabs. */

        /** Try to stitch the Dice Tool into the HUD. Returns true once successful.
         *  Idempotent: if the Advanced IOW button is already present, just
         *  sync state and return. Safe to call after SPA navigation rebuilds
         *  the HUD without the button. */
        /** True when the current URL is a dice/primedice page where the
         *  Dice Tool actually runs. Limbo / target / other supported IOW/Smart
         *  pages return false — the Advanced IOW bridge button shouldn't
         *  appear there even if the dice tool's DOM elements happen to be
         *  in the document from a previous SPA visit. */
        function isOnDiceUrl() {
            const path = location.pathname || '';
            // Stake (and Stake-themed variants) — /casino/games/dice* and /primedice*
            // Shuffle — /games/originals/dice*
            return /\/(?:casino\/games|games\/originals)\/(?:dice|primedice)(?:\/|$|\?|#)/i.test(path);
        }

        function tryStitch() {
            // URL gate: only stitch on dice/primedice pages. On limbo (and
            // any other supported-but-not-dice IOW/Smart page) the dice tool
            // isn't running, so the Advanced IOW bridge button shouldn't be
            // exposed there. The dice tool's DOM elements may still be in
            // the page from a previous dice visit (SPA persistence), but
            // they're not our concern — we just gate visibility of the
            // bridge button on the URL.
            if (!isOnDiceUrl()) {
                if (toolsActive) {
                    try { deactivateTools(); } catch (e) {}
                }
                const orphanBtn = document.getElementById('mode-dice-tools');
                if (orphanBtn) orphanBtn.remove();
                toolsBtn = null;
                stitched = false;
                return false;
            }
            // Fast path: if the toolsBtn is already in the DOM, we're done.
            const existingBtn = document.getElementById('mode-dice-tools');
            if (existingBtn) {
                stitched = true;
                if (!toolsBtn || !document.contains(toolsBtn)) toolsBtn = existingBtn;
                return true;
            }
            // If we were marked stitched but the button has disappeared (HUD
            // got rebuilt by SPA navigation), reset and re-wire the new HUD.
            if (stitched) {
                stitched = false;
                toolsBtn = null;
            }
            hud = document.getElementById('ratchet-master-container');
            const modeWrap = hud && hud.querySelector('.mode-wrap');
            dicePanel = document.getElementById('dt-aio-panel');
            const diceBtn = document.getElementById('dt-aio-button');
            const backdrop = document.getElementById('dt-backdrop');
            if (!modeWrap || !dicePanel || !diceBtn) return false;

            stitched = true;
            originalParent = dicePanel.parentNode || document.body;

            // The Stats panel (and its deck) is OUR built-in tab — it should
            // match the rest of the IOW/Smart HUD's mode layouts. The other
            // dice-tool tabs (Calculator/Optimizer/Results/Settings) keep
            // their own theming so the user's --dt-* themes still work.
            // Palette pulled from the IOW/Smart HUD CSS at lines 1630-1637.
            const HUD_BG       = '#0f212e';
            const HUD_PANEL_BG = 'rgba(26, 44, 56, 0.85)';
            const HUD_BORDER   = 'rgba(82, 109, 130, 0.55)';
            const HUD_BORDER_X = 'rgba(255, 255, 255, 0.06)';
            const HUD_FG       = '#f5fbff';
            const HUD_LABEL    = '#94a3b8';
            const HUD_GREEN    = '#00ff9d';
            const HUD_GREEN_DK = '#00cc7a';
            const HUD_RED      = '#e11d48';
            const HUD_FIELD_BG = 'rgba(8, 11, 18, 0.65)';
            const HUD_BUTTON_BG = 'rgba(15, 33, 46, 0.75)';

            const bridgeCss = document.createElement('style');
            bridgeCss.id = 'dt-iow-bridge-css';
            bridgeCss.textContent = [
                /* ---- Panel container while hosted inside the HUD ---- */
                '#hud-content > #dt-aio-panel {',
                '  position: static !important;',
                '  inset: auto !important;',
                '  top: auto !important; right: auto !important; bottom: auto !important; left: auto !important;',
                '  width: 100% !important; height: 100% !important;',
                '  max-width: none !important; max-height: none !important;',
                '  margin: 0 !important;',
                '  border: 1px solid rgba(255,255,255,0.08) !important;',
                '  border-radius: 10px !important;',
                '  box-shadow: none !important;',
                '  transform: none !important;',
                '  opacity: 1 !important;',
                '  pointer-events: auto !important;',
                '  visibility: visible !important;',
                '  z-index: auto !important;',
                '  display: flex !important;',
                '  flex-direction: column;',
                '}',
                '#hud-content > #dt-aio-panel .dt-head { display: none !important; }',
                '#hud-content > #dt-aio-panel .dt-tabs { flex: 0 0 auto !important; }',
                '#hud-content > #dt-aio-panel .dt-body { flex: 1 1 auto !important; min-height: 0 !important; overflow: auto !important; }',
                /* ---- Compact mode for the dice tool's other tabs
                       (Calculator / Optimizer / Results / Settings).
                       Scoped to #hud-content so the standalone dice tool on
                       primedice/shuffle keeps its original sizing. The Stats
                       tab uses .hud-* classes (not .dt-*), so these rules
                       don't touch it. */
                /* Shrink the panel base font — most dice-tool sizes are in em */
                '#hud-content > #dt-aio-panel { --dt-font-scale: 0.82 !important; line-height: 1.35 !important; }',
                /* Tab strip: smaller pills */
                '#hud-content > #dt-aio-panel .dt-tab-btn { padding: 6px 4px !important; font-size: 0.78em !important; }',
                '#hud-content > #dt-aio-panel .dt-tab-btn .dt-tab-icon { font-size: 0.95em !important; }',
                /* Cards: tighter padding, smaller margin */
                '#hud-content > #dt-aio-panel .dt-card { padding: 10px 10px 8px !important; margin-bottom: 8px !important; border-width: 1px !important; }',
                '#hud-content > #dt-aio-panel .dt-card-title { top: -9px !important; font-size: 0.82em !important; padding: 0 6px !important; }',
                /* Fields: tighter rows + smaller inputs */
                '#hud-content > #dt-aio-panel .dt-field { margin: 3px 0 !important; gap: 6px !important; }',
                '#hud-content > #dt-aio-panel .dt-field label, #hud-content > #dt-aio-panel .dt-field .dt-label { font-size: 0.85em !important; }',
                '#hud-content > #dt-aio-panel .dt-field input[type="text"], #hud-content > #dt-aio-panel .dt-field input[type="number"], #hud-content > #dt-aio-panel input.dt-text-input { padding: 5px 7px !important; min-width: 70px !important; width: 84px !important; font-size: 0.88em !important; border-radius: 5px !important; }',
                '#hud-content > #dt-aio-panel .dt-help { width: 16px !important; height: 16px !important; font-size: 10px !important; }',
                '#hud-content > #dt-aio-panel .dt-hint { font-size: 0.7em !important; margin: -1px 0 4px !important; }',
                /* Buttons: smaller chrome */
                '#hud-content > #dt-aio-panel .dt-btn { padding: 6px 10px !important; min-height: 32px !important; font-size: 0.82em !important; border-radius: 5px !important; }',
                '#hud-content > #dt-aio-panel .dt-btn-small { padding: 4px 8px !important; min-height: 26px !important; font-size: 0.75em !important; }',
                '#hud-content > #dt-aio-panel .dt-btn-row { gap: 6px !important; margin-top: 6px !important; }',
                '#hud-content > #dt-aio-panel .dt-btn-block { margin-top: 6px !important; }',
                /* Switches: smaller */
                '#hud-content > #dt-aio-panel .dt-switch { transform: scale(0.85); transform-origin: left center; }',
                /* Progress bars: thinner */
                '#hud-content > #dt-aio-panel .dt-progress-wrap { height: 8px !important; margin: 6px 0 3px !important; }',
                /* Hints / inline text: compact */
                '#hud-content > #dt-aio-panel h3, #hud-content > #dt-aio-panel h4 { margin: 6px 0 4px !important; font-size: 0.95em !important; }',
                /* Results table density */
                '#hud-content > #dt-aio-panel table { font-size: 0.82em !important; }',
                '#hud-content > #dt-aio-panel table td, #hud-content > #dt-aio-panel table th { padding: 4px 6px !important; }',
                /* Hidden / placeholder rules — dice tool floating chrome */
                '#dt-aio-panel.dt-bridge-hidden { display: none !important; }',
                '#dt-aio-button.dt-bridge-hidden, #dt-backdrop.dt-bridge-hidden { display: none !important; }',
                /* Hide the floating dice-tool streak counter HUD entirely —
                   the Stats deck section is its full replacement. The
                   underlying #dt-ctr_w / #dt-ctr_l / #dt-ctr_target /
                   #dt-counter_autostop elements stay in DOM (just hidden) so
                   the dice tool's onWinDetected/onLossDetected still update
                   them and the autostop logic keeps working. */
                '#dt-aio-counter.dt-bridge-hidden { display: none !important; }',
                /* Mode-wrap visual guard — IOW/Smart's syncModeButtons()
                   ticker (called from the 500ms buildHUD interval) toggles
                   .active based on its internal ACTIVE_MODE which only knows
                   manual/iow/smart. Without these locks: the prior mode keeps
                   blinking active, and the Tools button keeps blinking
                   inactive every 500ms. We force the right visual on both
                   sides while data-tools-active="1", independent of the
                   .active class state. */
                '#ratchet-master-container[data-tools-active="1"] #mode-manual,',
                '#ratchet-master-container[data-tools-active="1"] #mode-iow,',
                '#ratchet-master-container[data-tools-active="1"] #mode-smart {',
                '  background: #2f4553 !important;',
                '  color: #94a3b8 !important;',
                '  box-shadow: none !important;',
                '}',
                /* Lock Tools button to active look while data-tools-active=1.
                   This is independent of the .active class (which gets
                   stripped every 500ms by syncModeButtons), so no flicker. */
                '#ratchet-master-container[data-tools-active="1"] #mode-dice-tools {',
                '  background: #00ff9d !important;',
                '  color: #0f212e !important;',
                '  box-shadow: 0 0 12px #00ff9d !important;',
                '}',
                /* ---- Stats tab — uses the IOW/Smart .hud-* class hierarchy
                       directly, so the existing HUD CSS in this script paints
                       it identically to the Manual/IOW/Smart mode panels.
                       These rules are just thin shims for the few bits that
                       don't have a 1:1 .hud-* equivalent (the deck-level
                       autostop checkbox cluster, W/L counter chip, the track
                       dropdown, and the Update button colorway). */
                /* Make the dice panel body a flex column so #dt-panel-stats
                   can fill its remaining height. Without this, .hud-shell
                   with flex:1 1 0 collapses to zero height because the
                   default .dt-body is display:block (no free space for
                   flex-grow to consume). Other dice panels are display:none
                   when inactive, so they're unaffected. */
                '#hud-content > #dt-aio-panel .dt-body { display: flex !important; flex-direction: column !important; }',
                '#dt-panel-stats { padding: 10px !important; flex-direction: column !important; gap: 8px !important; }',
                '#dt-panel-stats.active { display: flex !important; flex: 1 1 auto !important; min-height: 0 !important; }',
                '#dt-panel-stats * { box-sizing: border-box; }',
                /* The .hud-shell wrapper inside Stats also needs to grow */
                '#dt-panel-stats > .hud-shell { flex: 1 1 auto !important; min-height: 0 !important; height: 100% !important; }',
                /* Inside .hud-controls-deck inside the Stats tab, lay sections
                   out as a flex row so the deck reads left-to-right like the
                   Smart/IOW/Manual decks do. */
                '#dt-panel-stats .hud-controls-deck { flex-wrap: wrap; }',
                /* Bet Div / Profit Mult / Autostop inputs — shrink so the
                   deck stays single-row on a normal HUD width. */
                '#dt-panel-stats .hud-control-group input[type="number"] { width: 80px !important; }',
                /* W/L counter chip lives in the deck. .hud-meta-chip already
                   gives us the right look; just override the layout to a
                   2-column counter pair with big numbers.
                   The actual #dt-ctr_w / #dt-ctr_l elements (created and
                   updated by the dice tool) are physically moved into the
                   .hud-counter-slot containers at runtime, so we style them
                   here AND through their original .dt-ctr-w / .dt-ctr-l
                   classes — whichever path the dice tool happens to use. */
                '#dt-panel-stats .hud-counter-chip { flex-direction: column; gap: 2px; align-items: center; min-width: 80px; }',
                '#dt-panel-stats .hud-counter-row { display: flex; gap: 14px; }',
                '#dt-panel-stats .hud-counter-row span { font-size: 9px; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; min-width: 22px; text-align: center; }',
                '#dt-panel-stats .hud-counter-vals { display: flex; gap: 14px; align-items: center; }',
                '#dt-panel-stats .hud-counter-slot { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; }',
                /* Direct child styling for the relocated dice counter divs */
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_w,',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l {',
                '  font-size: 18px !important; font-weight: 800 !important;',
                '  font-family: "Roboto Mono", monospace !important;',
                '  min-width: 22px !important; text-align: center !important;',
                '  background: transparent !important; padding: 0 !important;',
                '  border: none !important; box-shadow: none !important;',
                '  line-height: 1 !important;',
                '  transition: transform 0.18s ease, color 0.18s ease;',
                '}',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_w { color: ' + HUD_GREEN + ' !important; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l { color: #94a3b8 !important; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l.has-loss { color: ' + HUD_RED + ' !important; }',
                /* Autostop = checkbox + win-streak target inside a control-group */
                '#dt-panel-stats .hud-autostop-row { display: flex; align-items: center; gap: 6px; }',
                '#dt-panel-stats .hud-autostop-row input[type="checkbox"] {',
                '  appearance: auto !important; -webkit-appearance: auto !important;',
                '  width: 16px !important; height: 16px !important;',
                '  margin: 0 !important; padding: 0 !important;',
                '  position: static !important;',
                '  opacity: 1 !important; visibility: visible !important;',
                '  pointer-events: auto !important;',
                '  accent-color: ' + HUD_GREEN + ';',
                '  cursor: pointer; flex: 0 0 auto !important;',
                '}',
                '#dt-panel-stats .hud-autostop-row input[type="number"] { width: 50px !important; }',
                /* Stretch the deck "banner" — +40 px horizontal (20 each side)
                   and +20 px vertical (10 each side) over the default
                   .hud-controls-deck padding of 10 px. */
                '#dt-panel-stats .hud-controls-deck.hud-panel { padding: 20px 30px !important; }',
                /* Update Strategy button — green primary like an active mode.
                   Sizes itself to match .hud-rapid-btn / .hud-reset-btn from
                   the parent IOW/Smart HUD CSS, so the three buttons (Update
                   Strategy / RESET / START) line up at the same big size. */
                '#dt-panel-stats .hud-update-btn { min-height: 38px; border: none; padding: 8px 14px; border-radius: 9px; cursor: pointer; font-weight: 900; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; background: ' + HUD_GREEN + '; color: ' + HUD_BG + '; box-shadow: 0 0 12px ' + HUD_GREEN + '; transition: background 0.18s, transform 0.18s; line-height: 1.1; flex: 1 1 0; min-width: 108px; }',
                '#dt-panel-stats .hud-update-btn:hover { background: ' + HUD_GREEN_DK + '; transform: translateY(-1px); }',
                /* Switch Over/Under — neutral cyan button so it visually
                   distinguishes from the green Update/Start and red Reset. */
                '#dt-panel-stats .hud-switch-btn { min-height: 38px; border: 1px solid #06b6d4; padding: 8px 14px; border-radius: 9px; cursor: pointer; font-weight: 900; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; background: transparent; color: #06b6d4; transition: background 0.18s, color 0.18s, transform 0.18s; line-height: 1.1; flex: 1 1 0; min-width: 108px; }',
                '#dt-panel-stats .hud-switch-btn:hover { background: #06b6d4; color: ' + HUD_BG + '; transform: translateY(-1px); }',
                '#dt-panel-stats .hud-switch-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
                /* W/L counter chip — content-sized inside the deck */
                '#dt-panel-stats .hud-counter-chip { flex: 0 0 auto !important; flex-direction: column; gap: 2px; min-width: 80px; padding: 6px 10px !important; }',
                '#dt-panel-stats .hud-counter-row { display: flex; gap: 14px; }',
                '#dt-panel-stats .hud-counter-row span { font-size: 9px; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; min-width: 22px; text-align: center; }',
                '#dt-panel-stats .hud-counter-vals { display: flex; gap: 14px; align-items: center; justify-content: space-around; }',
                '#dt-panel-stats .hud-counter-slot { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_w,',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l { font-size: 18px !important; font-weight: 800 !important; font-family: "Roboto Mono", monospace !important; min-width: 22px !important; text-align: center !important; background: transparent !important; padding: 0 !important; border: none !important; box-shadow: none !important; line-height: 1 !important; transition: transform 0.18s ease, color 0.18s ease; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_w { color: ' + HUD_GREEN + ' !important; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l { color: #94a3b8 !important; }',
                '#dt-panel-stats .hud-counter-slot > #dt-ctr_l.has-loss { color: ' + HUD_RED + ' !important; }',
                /* Autostop row inside its control group */
                '#dt-panel-stats .hud-autostop-row { display: flex; flex-direction: row; align-items: center; gap: 6px; }',
                '#dt-panel-stats .hud-autostop-row input[type="checkbox"] { appearance: auto !important; -webkit-appearance: auto !important; width: 16px !important; height: 16px !important; margin: 0 !important; flex: 0 0 auto !important; accent-color: ' + HUD_GREEN + '; cursor: pointer; }',
                '#dt-panel-stats .hud-autostop-row input[type="number"] { width: 60px !important; flex: 0 0 60px !important; text-align: center; }',
                /* Volume slider in the deck */
                '#dt-panel-stats .hud-volume-group { min-width: 140px; max-width: 220px; }',
                '#dt-panel-stats .hud-volume-group label { display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 6px !important; }',
                '#dt-panel-stats .hud-volume-group label > span:last-child { color: ' + HUD_GREEN + '; font-family: "Roboto Mono", monospace; font-weight: 800; }',
                '#dt-panel-stats .hud-volume-group input[type="range"] { width: 100% !important; accent-color: ' + HUD_GREEN + '; cursor: pointer; }',
                /* The Stats tab has a calc-derived block sitting under the main
                   stats grid (Balance Target / Profit Stop / Streak / Mult Perf).
                   Use the same .stats-col-inner card look so it reads as part
                   of the Stats column. */
                '#dt-panel-stats .hud-streaks-row { gap: 8px; }',
                '#dt-panel-stats details.hud-streaks-toggle { flex: 1 1 0; }',
                '#dt-panel-stats details.hud-streaks-toggle summary { list-style: none; padding: 8px 12px; background: ' + HUD_PANEL_BG + '; border: 1px solid ' + HUD_BORDER_X + '; border-radius: 10px; cursor: pointer; font-size: 11px; font-weight: 800; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.4px; display: flex; justify-content: space-between; align-items: center; }',
                '#dt-panel-stats details.hud-streaks-toggle summary::-webkit-details-marker { display: none; }',
                '#dt-panel-stats details.hud-streaks-toggle summary:hover { background: rgba(0,255,157,0.05); }',
                '#dt-panel-stats details.hud-streaks-toggle summary::after { content: "▼"; color: ' + HUD_GREEN + '; font-size: 10px; transition: transform 0.15s; }',
                '#dt-panel-stats details.hud-streaks-toggle[open] summary::after { transform: rotate(180deg); }',
                '#dt-panel-stats .hud-streaks-list { padding: 6px 12px; background: rgba(8,11,18,0.55); border: 1px solid ' + HUD_BORDER_X + '; border-top: none; border-radius: 0 0 10px 10px; font-family: "Roboto Mono", monospace; font-size: 11px; color: ' + HUD_FG + '; line-height: 1.6; }',
                /* ---- Terms tab — glossary panel. Mirrors the original
                       PySide terms_tab.py styling: teal headings (#249f87),
                       white definitions, dark background, generous padding,
                       scrollable content area. */
                '#dt-panel-terms.active { display: flex !important; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 10px !important; }',
                '#dt-panel-terms .dt-terms-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px; background: ' + HUD_PANEL_BG + '; border: 1px solid ' + HUD_BORDER_X + '; border-radius: 12px; color: ' + HUD_FG + '; font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.5; font-size: 12px; }',
                '#dt-panel-terms .dt-terms-scroll::-webkit-scrollbar { width: 8px; }',
                '#dt-panel-terms .dt-terms-scroll::-webkit-scrollbar-thumb { background: ' + HUD_BORDER + '; border-radius: 4px; }',
                '#dt-panel-terms .dt-terms-heading { color: #249f87; font-size: 16px; font-weight: 800; letter-spacing: 0.5px; margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(36, 159, 135, 0.25); }',
                '#dt-panel-terms .dt-terms-heading:first-child { margin-top: 0; }',
                '#dt-panel-terms .dt-terms-subheading { color: #249f87; font-size: 13px; font-weight: 700; letter-spacing: 0.3px; margin: 10px 0 4px; }',
                '#dt-panel-terms .dt-terms-row { margin: 3px 0; padding: 0; }',
                '#dt-panel-terms .dt-terms-label { color: #249f87; font-weight: 700; }',
                '#dt-panel-terms .dt-terms-dash { color: ' + HUD_LABEL + '; }',
                '#dt-panel-terms .dt-terms-def { color: ' + HUD_FG + '; }',
                '#dt-panel-terms .dt-terms-text { margin: 3px 0; color: ' + HUD_FG + '; }',
                '#dt-panel-terms .dt-terms-spacer { height: 6px; }'
            ].join('\n');
            // Guard against re-stitch (SPA navigation rebuilt HUD). The
            // bridge CSS is process-wide so we only need it once.
            if (!document.getElementById('dt-iow-bridge-css')) {
                document.head.appendChild(bridgeCss);
            }

            diceBtn.classList.add('dt-bridge-hidden');
            if (backdrop) backdrop.classList.add('dt-bridge-hidden');
            dicePanel.classList.add('dt-bridge-hidden');
            // Floating streak counter — replaced by the Stats deck section.
            const floatingCounter = document.getElementById('dt-aio-counter');
            if (floatingCounter) floatingCounter.classList.add('dt-bridge-hidden');

            // Bridge CSS now hides the dice tool elements via the
            // dt-bridge-hidden class. Remove the pre-stitch hider so the
            // bridge CSS is the single source of truth — important because
            // the pre-stitch CSS uses #id selectors and would still hide
            // #dt-aio-panel even when the user clicks Advanced IOW (which
            // only removes the dt-bridge-hidden class).
            const preStitchEl = document.getElementById('dt-pre-stitch-css');
            if (preStitchEl) preStitchEl.remove();

            toolsBtn = document.createElement('button');
            toolsBtn.id = 'mode-dice-tools';
            toolsBtn.className = 'mode-btn';
            toolsBtn.textContent = 'Advanced IOW';
            toolsBtn.title = 'Advanced IOW (Calculator / Optimizer / Results / Settings)';
            modeWrap.appendChild(toolsBtn);

            toolsBtn.addEventListener('click', () => {
                if (toolsActive) {
                    const target = lastNonToolsMode || 'manual';
                    const targetBtn = document.getElementById('mode-' + target);
                    if (targetBtn) targetBtn.click();
                } else {
                    activateTools();
                }
            });

            // Click listeners on Manual/IOW/Smart buttons. Guarded so a
            // re-stitch after SPA navigation doesn't pile up duplicate
            // listeners (each would fire deactivateTools, etc.).
            if (!modeBtnListenersAttached) {
                ['mode-manual', 'mode-iow', 'mode-smart'].forEach(id => {
                    const b = document.getElementById(id);
                    if (!b) return;
                    b.addEventListener('click', () => {
                        lastNonToolsMode = id.replace(/^mode-/, '');
                        if (toolsActive) deactivateTools();
                    }, true);
                });
                modeBtnListenersAttached = true;
            }

            // Pin Tools button's active state and keep the other mode buttons
            // visually inactive while Tools is the active mode. IOW/Smart's
            // own syncModeButtons() runs every 500ms and re-derives .active
            // from its internal ACTIVE_MODE (which only knows manual/iow/
            // smart), so without this loop the prior mode would stay lit and
            // Tools would lose its highlight. We run faster than syncModeButtons
            // (200ms < 500ms) so the visual state always settles correctly.
            //
            // The natural #ratchet-master-container .mode-btn.active CSS rule
            // (background: #00ff9d, color: #0f212e, glow) then paints the Tools
            // button identically to Manual/IOW/Smart — no !important overrides
            // needed.
            // Active-state syncer for the toolsBtn. Guarded so a re-stitch
            // after SPA navigation doesn't spawn duplicate intervals.
            if (!toolsSyncerStarted) {
                setInterval(() => {
                    if (!toolsBtn) return;
                    if (toolsActive) {
                        if (!toolsBtn.classList.contains('active')) {
                            toolsBtn.classList.add('active');
                        }
                        ['mode-manual', 'mode-iow', 'mode-smart'].forEach(id => {
                            const b = document.getElementById(id);
                            if (b && b.classList.contains('active')) b.classList.remove('active');
                        });
                    } else {
                        if (toolsBtn.classList.contains('active')) {
                            toolsBtn.classList.remove('active');
                        }
                    }
                }, 200);
                toolsSyncerStarted = true;
            }

            // Insert the Stats tab into the dice tool's panel.
            trySetupStatsTab();
            // Insert the Terms tab as the last tab.
            trySetupTermsTab();

            console.log('%c[Dice/IOW Bridge] Advanced IOW tab integrated.', 'color:#10b981;font-weight:700;');
            return true;
        }

        /* ---- STATS + TERMS TAB SETUP ----
           These tabs are appended to the Dice Tool's tab strip, inserted
           into the dice tool's panel body, and styled by the bridge CSS to
           match the IOW/Smart HUD. */

        let statsSetup    = false;  // true once the Stats tab is in the DOM
        let termsSetup    = false;  // true once the Terms tab is in the DOM
        let statsSyncing  = false;  // re-entrancy guard for two-way input binding

        /** Build the Stats tab (first tab; default-active when Advanced IOW opens). */
        function trySetupStatsTab() {
            if (statsSetup) return true;
            const panel = document.getElementById('dt-aio-panel');
            if (!panel) return false;
            const tabsNav = panel.querySelector('.dt-tabs');
            const body = panel.querySelector('.dt-body');
            if (!tabsNav || !body) return false;
            if (panel.querySelector('#dt-panel-stats')) { statsSetup = true; return true; }

            // Tab button — insert as the FIRST tab so the order is
            // Stats, Calculator, Optimizer, Results, Settings.
            const statsBtn = document.createElement('button');
            statsBtn.className = 'dt-tab-btn';
            statsBtn.dataset.tab = 'stats';
            statsBtn.innerHTML = '<span class="dt-tab-icon">📈</span>Stats';
            const calcBtn = tabsNav.querySelector('[data-tab="calc"]');
            if (calcBtn) tabsNav.insertBefore(statsBtn, calcBtn);
            else tabsNav.insertBefore(statsBtn, tabsNav.firstChild);

            // Panel.
            const statsPanel = document.createElement('section');
            statsPanel.className = 'dt-panel';
            statsPanel.id = 'dt-panel-stats';
            statsPanel.innerHTML =
                /* The Stats tab body uses the IOW/Smart .hud-* class
                   hierarchy directly so the existing HUD CSS paints it
                   identically to the Manual / IOW / Smart panels. */
                '<div class="hud-shell">' +
                  /* ---- Controls deck — same flat layout the Smart/IOW
                       modes use, with a W/L counter chip and a Volume control
                       group dropped in. Big buttons (Update Strategy / Reset /
                       Start) on the right. ---- */
                  '<div class="hud-controls-deck hud-panel">' +
                    '<div class="hud-control-group">' +
                      '<label>Balance Divisor</label>' +
                      '<input id="dt-stats-bet-div" type="number" inputmode="decimal" step="any">' +
                    '</div>' +
                    '<div class="hud-control-group">' +
                      '<label>Profit Multiplier</label>' +
                      '<input id="dt-stats-profit-mult" type="number" inputmode="decimal" step="any">' +
                    '</div>' +
                    '<div class="hud-meta-chip hud-counter-chip">' +
                      '<div class="hud-counter-row"><span>Wins</span><span>Losses</span></div>' +
                      /* Slot containers — the dice tool's actual #dt-ctr_w
                         and #dt-ctr_l divs get moved here at runtime so
                         the dice tool's own update path writes directly to
                         what the user sees. No mirror, no lag. */
                      '<div class="hud-counter-vals">' +
                        '<span class="hud-counter-slot" data-counter-slot="w"></span>' +
                        '<span class="hud-counter-slot" data-counter-slot="l"></span>' +
                      '</div>' +
                    '</div>' +
                    '<div class="hud-control-group">' +
                      '<label>Autostop @ Win Streak</label>' +
                      '<div class="hud-autostop-row">' +
                        '<input type="checkbox" id="dt-stats-autostop">' +
                        '<input type="number" min="0" id="dt-stats-target" value="10">' +
                      '</div>' +
                    '</div>' +
                    '<div class="hud-control-group">' +
                      '<label>Stats Track Per</label>' +
                      '<select id="dt-stats-track-per">' +
                        '<option value="session" selected>Session</option>' +
                        '<option value="cycle">Cycle</option>' +
                      '</select>' +
                    '</div>' +
                    '<div class="hud-control-group hud-volume-group">' +
                      '<label><span>🔊 Volume</span><span id="dt-stats-volume-val">100</span></label>' +
                      '<input type="range" id="dt-stats-volume" min="0" max="100" value="100">' +
                    '</div>' +
                    '<div class="btn-group">' +
                      '<button class="hud-update-btn" id="dt-stats-update">Update Strategy</button>' +
                      '<button id="dt-stats-switch-ou" class="hud-switch-btn">Switch Over/Under</button>' +
                      '<button id="dt-stats-reset" class="hud-reset-btn">RESET</button>' +
                      '<button id="dt-stats-start" class="hud-rapid-btn start" data-running="false">START</button>' +
                    '</div>' +
                  '</div>' +
                  /* ---- Main body: graph + stats columns ---- */
                  '<div class="hud-body">' +
                    '<div class="graph-col">' +
                      '<div class="hud-graph-box">' +
                        '<canvas id="dt-stats-graph"></canvas>' +
                      '</div>' +
                    '</div>' +
                    '<div class="stats-col">' +
                      '<div class="hud-stats-grid">' +
                        '<div class="stats-col-inner">' +
                          '<div class="hud-row" data-stat="startingBalance"><span class="hud-label">Starting Balance</span><span class="hud-val">0.00</span></div>' +
                          '<div class="hud-row" data-stat="totalBets"><span class="hud-label">Total Bets</span><span class="hud-val">0</span></div>' +
                          '<div class="hud-row" data-stat="profit"><span class="hud-label">Profit/Loss</span><span class="hud-val">0.00</span></div>' +
                          '<div class="hud-row" data-stat="totalWagered"><span class="hud-label">Total Wagered</span><span class="hud-val">0.00</span></div>' +
                        '</div>' +
                        '<div class="stats-col-inner">' +
                          '<div class="hud-row" data-stat="sessionPeak"><span class="hud-label">Peak Balance</span><span class="hud-val" style="color:#00ff9d;">0.00</span></div>' +
                          '<div class="hud-row" data-stat="peakProfit"><span class="hud-label">Peak Profit</span><span class="hud-val" style="color:#00ff9d;">0.00</span></div>' +
                          '<div class="hud-row" data-stat="winsLosses"><span class="hud-label">Wins / Losses</span><span class="hud-val">0 / 0</span></div>' +
                          '<div class="hud-row" data-stat="rtp"><span class="hud-label">Session RTP</span><span class="hud-val">100.00%</span></div>' +
                        '</div>' +
                        '<div class="stats-col-inner">' +
                          '<div class="hud-row"><span class="hud-label">Balance Target</span><span class="hud-val" id="dt-stats-bal-target">0.00</span></div>' +
                          '<div class="hud-row"><span class="hud-label">Profit Stop</span><span class="hud-val" id="dt-stats-profit-stop">0.00</span></div>' +
                          '<div class="hud-row" data-stat="streaks"><span class="hud-label">Streak (W|L)</span><span class="hud-val">0/0 | 0/0</span></div>' +
                          '<div class="hud-row" data-stat="multPerf"><span class="hud-label">Multiplier Performance</span><span class="hud-val">1 in 0.00</span></div>' +
                        '</div>' +
                      '</div>' +
                      /* Best/Worst streaks — flat .hud-meta-chip rows that
                         match Smart mode's layout exactly. The inline values
                         get populated by updateStatsTab via the [data-stat]
                         hooks (same as before, just no <details> wrapper). */
                      '<div class="hud-meta-row">' +
                        '<div class="hud-meta-chip">' +
                          '<span class="hud-label">Best Streaks</span>' +
                          '<span class="hud-val" data-stat="bestStreaks" style="color:#00ff9d;">-</span>' +
                        '</div>' +
                        '<div class="hud-meta-chip">' +
                          '<span class="hud-label">Worst Streaks</span>' +
                          '<span class="hud-val" data-stat="worstStreaks" style="color:#f87171;">-</span>' +
                        '</div>' +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                '</div>';
            body.appendChild(statsPanel);

            wireStatsControls();

            // Make Stats the default active tab so that when the user enters
            // Advanced IOW mode they land on Stats instead of Calculator.
            tabsNav.querySelectorAll('.dt-tab-btn').forEach(b => {
                b.classList.toggle('active', b === statsBtn);
            });
            panel.querySelectorAll('.dt-panel').forEach(p => {
                p.classList.toggle('active', p.id === 'dt-panel-stats');
            });

            // Register a per-bet listener — IOW/Smart's processNewBet calls
            // updateUI() synchronously after each settled bet, which calls our
            // publish hook, which calls this callback. That gives the Stats
            // tab the same per-bet refresh cadence as the SMART/IOW/Manual
            // HUDs (which paint inside updateUI directly).
            window.__iow_smart_on_publish__ = updateStatsTab;

            // Move the dice tool's actual #dt-ctr_w / #dt-ctr_l elements
            // into the deck. The dice tool's onWinDetected/onLossDetected
            // path writes textContent directly into these elements via
            // document.getElementById, so the values you see in the deck
            // are always exactly what the dice tool just wrote — same
            // path, same instant as the standalone floating HUD. No mirror,
            // no MutationObserver, no lag. */
            relocateDiceCounter();

            // First render so values aren't blank before the first tick.
            updateStatsTab();

            statsSetup = true;
            return true;
        }

        /**
         * Build the Terms tab — glossary lifted verbatim from the original
         * Dice-Tool PySide terms_tab.py, plus a new STATS TAB section that
         * documents the Advanced IOW Stats panel (deck controls, live stats,
         * streak meta-rows).
         */
        function trySetupTermsTab() {
            if (termsSetup) return true;
            const panel = document.getElementById('dt-aio-panel');
            if (!panel) return false;
            const tabsNav = panel.querySelector('.dt-tabs');
            const body = panel.querySelector('.dt-body');
            if (!tabsNav || !body) return false;
            if (panel.querySelector('#dt-panel-terms')) { termsSetup = true; return true; }

            // Tab button — append last so the order is
            // Stats, Calculator, Optimizer, Results, Settings, Terms.
            const termsBtn = document.createElement('button');
            termsBtn.className = 'dt-tab-btn';
            termsBtn.dataset.tab = 'terms';
            termsBtn.innerHTML = '<span class="dt-tab-icon">📖</span>Terms';
            tabsNav.appendChild(termsBtn);

            // Source content. Mirrors terms_tab.py's TERMS_TEXT layout:
            // SECTION HEADERS (uppercase ending in TAB) → big heading
            // sub-headers (PARAMETERS, BUTTONS, etc.)         → small heading
            // "Label – definition" lines                       → label/def pair
            // The new STATS TAB section is added at the top.
            const TERMS_TEXT =
                'STATS TAB\n' +
                '\n' +
                'CONTROLS DECK\n' +
                'Balance Divisor – Two-way bound to the Calculator. Higher number = smaller starting bet.\n' +
                'Profit Multiplier – Two-way bound to the Calculator. Multiplier applied to the base bet to set the per-cycle profit goal.\n' +
                'Wins / Losses Counter – Live consecutive-streak counter. Wins increment on every win and reset Losses; Losses increment on every loss and reset on the next win.\n' +
                'Autostop @ Win Streak – When checked, auto-stops Stake\'s native auto-bet once the consecutive win count hits the configured target.\n' +
                'Stats Track Per – Switches the stats grid between two scopes: Session is lifetime since page load (Reset clears it). Cycle resets every Start click; useful for measuring per-run performance.\n' +
                'Update Strategy – Pushes the deck\'s Balance Divisor / Profit Multiplier into the Calculator and runs Export Balance & Update Strategy so Balance Target / Profit Stop reflect the new values.\n' +
                'Reset – Clears all session and cycle stats and the W/L counter.\n' +
                'Start – Single click on Stake\'s native Advanced "Start Autoplay" (Advanced IOW mode is intentionally hands-off after Start; the platform drives the auto-loop).\n' +
                '\n' +
                'LIVE STATS\n' +
                'Starting Balance – Balance recorded at session or cycle start, depending on Stats Track Per.\n' +
                'Total Bets – Number of bets settled in the current scope.\n' +
                'Profit/Loss – Current balance minus Starting Balance. Green if positive, red if negative.\n' +
                'Total Wagered – Sum of every bet amount placed.\n' +
                'Peak Balance – Highest balance reached so far.\n' +
                'Wins / Losses – Total wins and total losses in the current scope.\n' +
                'Peak Profit – Largest positive Profit/Loss value seen so far.\n' +
                'Session RTP – (Total Wagered + Profit) / Total Wagered × 100. 100% = breakeven.\n' +
                'Balance Target – Mirror of the Calculator\'s Balance Target output (target balance to end the cycle successfully).\n' +
                'Profit Stop – Mirror of the Calculator\'s Profit Stop output (the per-cycle profit goal in raw amount).\n' +
                'Streak (W|L) – Current and max consecutive win streak | current and max consecutive loss streak.\n' +
                'Multiplier Performance – Empirical 1-in-N success rate measured against the configured target multiplier. Green when meeting or beating the target, red when underperforming.\n' +
                'Best Streaks / Worst Streaks – Top 10 longest win / loss streaks recorded in the current scope (expand to see the full list).\n' +
                '\n' +
                '\n' +
                'CALCULATOR / SIMULATOR TAB\n' +
                '\n' +
                'PARAMETERS\n' +
                'Balance – Your total bankroll for each simulation or calculation.\n' +
                'Win Increase % – The percentage amount the bet increases after every win.\n' +
                'Loss Reset – The number of consecutive losses required before resetting the bet to its base size.\n' +
                'Balance Divisor – A number dividing the balance to determine the starting bet size. (Higher numbers create smaller bet sizes).\n' +
                'Profit Multiplier – The multiplier applied to the base bet that defines the profit stop.\n' +
                'Buffer % – An additional percentage added to the multiplier for extra margin or protection.\n' +
                '\n' +
                'CALCULATED VALUES\n' +
                'Multiplier – The payout odds or target multiplier determined by input parameters.\n' +
                'Bet Size – The first wager placed based on the current balance and balance divisor.\n' +
                'Profit Stop – The profit goal for the current cycle, derived from the bet and multiplier.\n' +
                'Balance Target – The balance amount where the simulation stops a successful cycle.\n' +
                '\n' +
                'SIMULATION CONTROLS\n' +
                'Trials – The number of simulated runs to execute. Higher values improve accuracy but take longer.\n' +
                'Run Simulation – Starts the simulation with the selected settings.\n' +
                'Stop – Cancels an ongoing simulation process.\n' +
                '\n' +
                'SIMULATION RESULTS\n' +
                'Cycle – A completed round reaching the profit target or failing (bust).\n' +
                'Average highest balance – The median of all highest balances reached across all trials.\n' +
                'Std dev (highest) – The standard deviation of highest balances, showing consistency or volatility.\n' +
                'Max highest balance – The single greatest balance achieved in all trials.\n' +
                'Average cycles – The average count of successful profit cycles per trial.\n' +
                'Average rounds – The average number of dice rolls per trial.\n' +
                'Cycle success rate – The percentage of total cycles that reached profit target before failure.\n' +
                'Bust rate – The percentage of trials that failed to meet the first profit stop.\n' +
                '\n' +
                '\n' +
                'OPTIMIZER TAB\n' +
                '\n' +
                'PARAMETER RANGES\n' +
                'Combo – A single set of parameter values tested by the optimizer.\n' +
                'Starting Balance – The initial balance applied to all combos during optimization.\n' +
                'Trials per Combo – The number of simulations run for each parameter combination.\n' +
                'Bet Divisor Range – Range or list of values to test for bet divisors.\n' +
                'Profit Multiplier Range – Range or list of values to test for profit multipliers.\n' +
                'Win Increase % Range – Range or list of win increase percentages to test.\n' +
                'Loss Reset – Range or list of loss reset counts to test.\n' +
                'Buffer % Range – Range or list of buffer percentages to test.\n' +
                '\n' +
                'BUTTONS\n' +
                'Run Optimizer – Begins testing all combinations using the provided ranges.\n' +
                'Clear Results – Removes existing results from the results tab.\n' +
                'Stop – Terminates the optimization process currently running. (Note: If you get the Large Search Warning popup, you won\'t be able to use Stop. Doing so may break the optimizer and you\'ll need to reload the page.)\n' +
                '\n' +
                '\n' +
                'OPTIMIZER RESULTS TAB\n' +
                '\n' +
                'RESULTS DEFINITIONS\n' +
                'BetDiv – Bet divisor used in the tested combo.\n' +
                'ProfitMult – Profit multiplier applied to that combo.\n' +
                'W% – Win increase percentage value.\n' +
                'L – Number of losses before reset.\n' +
                'Buffer% – Additional buffer percentage applied to the multiplier.\n' +
                'AvgHigh – The average of highest balances across trials.\n' +
                'StdDev – The standard deviation of highest balances, measuring risk.\n' +
                'MaxHigh – The maximum balance achieved in any trial.\n' +
                'AvgCycles – Average successful profit cycles achieved per trial.\n' +
                'AvgRounds – Average number of rolls executed per trial.\n' +
                'CycleSuccess% – Percentage of cycles that reached profit targets successfully.\n' +
                'Bust% – Percentage of trials that ended with no successful cycles (busts).\n' +
                'Score – Performance metric calculated as (AvgHigh − Start) / StdDev.\n' +
                '\n' +
                'BUTTONS\n' +
                'Apply Selected to Calculator – Loads parameters from a selected result row into the Calculator tab for testing.\n' +
                'Save to CSV – Exports all result rows into a CSV file for later review.\n';

            // Subheaders (small heading style) — case-sensitive list lifted
            // from the original terms_tab.py plus the new Stats subheaders.
            const SUBHEADERS = new Set([
                'CONTROLS DECK',
                'LIVE STATS',
                'PARAMETERS',
                'CALCULATED VALUES',
                'SIMULATION CONTROLS',
                'SIMULATION RESULTS',
                'PARAMETER RANGES',
                'BUTTONS',
                'RESULTS DEFINITIONS'
            ]);

            // Build the panel HTML. Strings are escaped via a helper to
            // prevent any embedded angle brackets from breaking layout.
            function escapeHtml(s) {
                return String(s).replace(/[&<>"']/g, c => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[c]));
            }
            const lines = [];
            for (const raw of TERMS_TEXT.split('\n')) {
                const stripped = raw.trim();
                if (!stripped) { lines.push('<div class="dt-terms-spacer"></div>'); continue; }
                if (stripped === stripped.toUpperCase() && stripped.endsWith('TAB')) {
                    lines.push('<h3 class="dt-terms-heading">' + escapeHtml(stripped) + '</h3>');
                    continue;
                }
                if (SUBHEADERS.has(stripped)) {
                    lines.push('<h4 class="dt-terms-subheading">' + escapeHtml(stripped) + '</h4>');
                    continue;
                }
                let label = null, def = null;
                if (stripped.indexOf(' – ') !== -1) {
                    [label, def] = stripped.split(/ – (.+)/);
                } else if (stripped.indexOf(' - ') !== -1) {
                    [label, def] = stripped.split(/ - (.+)/);
                }
                if (label && def) {
                    lines.push('<p class="dt-terms-row"><span class="dt-terms-label">' + escapeHtml(label) + '</span><span class="dt-terms-dash"> – </span><span class="dt-terms-def">' + escapeHtml(def) + '</span></p>');
                } else {
                    lines.push('<p class="dt-terms-text">' + escapeHtml(stripped) + '</p>');
                }
            }

            const termsPanel = document.createElement('section');
            termsPanel.className = 'dt-panel';
            termsPanel.id = 'dt-panel-terms';
            termsPanel.innerHTML = '<div class="dt-terms-scroll">' + lines.join('') + '</div>';
            body.appendChild(termsPanel);

            termsSetup = true;
            return true;
        }

        const STATS_TRACK_KEY = '__iow_stats_track_per__';  // localStorage: 'session' | 'cycle'

        /**
         * Move the dice tool's actual W/L counter <div>s out of the floating
         * counter HUD and into the deck slots. The dice tool's own update
         * path keeps working unchanged because it queries the elements by
         * ID — only the parent changes. Re-runnable: if the elements aren't
         * in the deck slots yet (e.g. dice tool mounted late), we try again
         * on the next stitch-tick.
         */
        function relocateDiceCounter() {
            const panel = document.getElementById('dt-panel-stats');
            if (!panel) return;
            const slotW = panel.querySelector('[data-counter-slot="w"]');
            const slotL = panel.querySelector('[data-counter-slot="l"]');
            const ctrW = document.getElementById('dt-ctr_w');
            const ctrL = document.getElementById('dt-ctr_l');
            if (slotW && ctrW && ctrW.parentElement !== slotW) {
                slotW.appendChild(ctrW);
            }
            if (slotL && ctrL && ctrL.parentElement !== slotL) {
                slotL.appendChild(ctrL);
            }
        }

        /**
         * Wire up every input/button in the Stats deck to its dice-tool
         * counterpart with two-way binding. Re-entrancy is guarded by
         * `statsSyncing` so HUD↔Calc updates don't infinite-loop.
         */
        function wireStatsControls() {
            const hudBetDiv = document.getElementById('dt-stats-bet-div');
            const hudProfMult = document.getElementById('dt-stats-profit-mult');
            const calcBetDiv = document.getElementById('dt-bet_div');
            const calcProfMult = document.getElementById('dt-profit_mult');

            // Two-way bind: HUD inputs <-> Calculator inputs.
            function pushFromHud(srcHud, dstCalc) {
                if (statsSyncing || !srcHud || !dstCalc) return;
                statsSyncing = true;
                try {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(dstCalc, srcHud.value);
                    dstCalc.dispatchEvent(new Event('input', { bubbles: true }));
                    dstCalc.dispatchEvent(new Event('change', { bubbles: true }));
                } finally { statsSyncing = false; }
            }
            function pushFromCalc(srcCalc, dstHud) {
                if (statsSyncing || !srcCalc || !dstHud) return;
                statsSyncing = true;
                try { dstHud.value = srcCalc.value; } finally { statsSyncing = false; }
            }

            if (hudBetDiv && calcBetDiv) {
                pushFromCalc(calcBetDiv, hudBetDiv);
                hudBetDiv.addEventListener('input', () => pushFromHud(hudBetDiv, calcBetDiv));
                calcBetDiv.addEventListener('input', () => pushFromCalc(calcBetDiv, hudBetDiv));
            }
            if (hudProfMult && calcProfMult) {
                pushFromCalc(calcProfMult, hudProfMult);
                hudProfMult.addEventListener('input', () => pushFromHud(hudProfMult, calcProfMult));
                calcProfMult.addEventListener('input', () => pushFromCalc(calcProfMult, hudProfMult));
            }

            // Stats Track Per dropdown: persist selection. Session = lifetime
            // (resets only on page refresh or Reset). Cycle = since last Start
            // click (reset baseline each new cycle).
            const trackSel = document.getElementById('dt-stats-track-per');
            if (trackSel) {
                try {
                    const saved = localStorage.getItem(STATS_TRACK_KEY);
                    if (saved === 'session' || saved === 'cycle') trackSel.value = saved;
                } catch {}
                trackSel.addEventListener('change', () => {
                    try { localStorage.setItem(STATS_TRACK_KEY, trackSel.value); } catch {}
                    updateStatsTab();
                });
            }

            // Autostop checkbox + Win Streak target: mirror dice tool's own
            // counter controls (#dt-counter_autostop in Settings, #dt-ctr_target
            // in the floating counter HUD).
            const hudAutostop = document.getElementById('dt-stats-autostop');
            const hudTarget = document.getElementById('dt-stats-target');
            const calcAutostop = document.getElementById('dt-counter_autostop');
            const calcTarget = document.getElementById('dt-ctr_target');
            if (hudAutostop && calcAutostop) {
                hudAutostop.checked = calcAutostop.checked;
                hudAutostop.addEventListener('change', () => {
                    if (statsSyncing) return;
                    statsSyncing = true;
                    try { calcAutostop.checked = hudAutostop.checked; calcAutostop.dispatchEvent(new Event('change', { bubbles: true })); } finally { statsSyncing = false; }
                });
                calcAutostop.addEventListener('change', () => {
                    if (statsSyncing) return;
                    statsSyncing = true;
                    try { hudAutostop.checked = calcAutostop.checked; } finally { statsSyncing = false; }
                });
            }
            if (hudTarget && calcTarget) {
                hudTarget.value = calcTarget.value;
                hudTarget.addEventListener('change', () => {
                    if (statsSyncing) return;
                    statsSyncing = true;
                    try {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(calcTarget, hudTarget.value);
                        calcTarget.dispatchEvent(new Event('change', { bubbles: true }));
                    } finally { statsSyncing = false; }
                });
                calcTarget.addEventListener('change', () => {
                    if (statsSyncing) return;
                    statsSyncing = true;
                    try { hudTarget.value = calcTarget.value; } finally { statsSyncing = false; }
                });
            }

            // Volume slider — two-way bind to the dice tool's #dt-ctr_vol
            // (which the dice tool's playBeep() reads as state.counter_volume
            // on every win). Updating either slider updates the other and
            // dispatches input/change events so playBeep gets the new gain.
            const hudVolume = document.getElementById('dt-stats-volume');
            const hudVolumeVal = document.getElementById('dt-stats-volume-val');
            const calcVolume = document.getElementById('dt-ctr_vol');
            function reflectVolume(v) {
                if (hudVolumeVal) hudVolumeVal.textContent = String(parseInt(v, 10) || 0);
            }
            if (hudVolume && calcVolume) {
                hudVolume.value = calcVolume.value;
                reflectVolume(hudVolume.value);
                hudVolume.addEventListener('input', () => {
                    if (statsSyncing) return;
                    reflectVolume(hudVolume.value);
                    statsSyncing = true;
                    try {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(calcVolume, hudVolume.value);
                        calcVolume.dispatchEvent(new Event('input', { bubbles: true }));
                        calcVolume.dispatchEvent(new Event('change', { bubbles: true }));
                    } finally { statsSyncing = false; }
                });
                calcVolume.addEventListener('input', () => {
                    if (statsSyncing) return;
                    statsSyncing = true;
                    try { hudVolume.value = calcVolume.value; reflectVolume(hudVolume.value); } finally { statsSyncing = false; }
                });
            } else if (hudVolume) {
                // Calc slider isn't ready yet — try to bind on a delay so
                // the deck slider works even if the dice tool mounts late.
                reflectVolume(hudVolume.value);
                hudVolume.addEventListener('input', () => reflectVolume(hudVolume.value));
                let tries = 0;
                const bindLater = setInterval(() => {
                    const cv = document.getElementById('dt-ctr_vol');
                    if (cv) {
                        clearInterval(bindLater);
                        hudVolume.value = cv.value;
                        reflectVolume(hudVolume.value);
                        hudVolume.addEventListener('input', () => {
                            if (statsSyncing) return;
                            statsSyncing = true;
                            try {
                                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                                setter.call(cv, hudVolume.value);
                                cv.dispatchEvent(new Event('input', { bubbles: true }));
                                cv.dispatchEvent(new Event('change', { bubbles: true }));
                            } finally { statsSyncing = false; }
                        });
                    } else if (++tries > 40) {
                        clearInterval(bindLater);
                    }
                }, 250);
            }

            // Update Strategy button: invoke the dice tool's gameSync
            // ("Export Balance & Update Strategy") and then re-render Stats so
            // Balance Target / Profit Stop reflect the new calc outputs.
            const updateBtn = document.getElementById('dt-stats-update');
            if (updateBtn) {
                updateBtn.addEventListener('click', () => {
                    // Push HUD values into calc first.
                    if (hudBetDiv && calcBetDiv) pushFromHud(hudBetDiv, calcBetDiv);
                    if (hudProfMult && calcProfMult) pushFromHud(hudProfMult, calcProfMult);
                    // Click the dice tool's existing "Export Balance & Update Strategy" button.
                    const sync = document.getElementById('dt-game_sync');
                    if (sync) sync.click();
                    updateStatsTab();
                });
            }

            // Reset button: clear all IOW/Smart stats (session + per-run).
            const resetBtn = document.getElementById('dt-stats-reset');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    try {
                        if (typeof window.__iow_smart_reset__ === 'function') window.__iow_smart_reset__();
                    } catch (e) { console.error('[Stats] reset failed:', e); }
                    if (window.__iow_smart_state__) {
                        window.__iow_smart_state__.runBaseline = null;
                        window.__iow_smart_state__.runStats = null;
                    }
                    // Also reset the dice tool's streak counter if available.
                    const ctrReset = document.getElementById('dt-ctr_reset');
                    if (ctrReset) ctrReset.click();
                    updateStatsTab();
                });
            }

            // Start/Stop button: two-way toggle.
            //   START  — clicks Stake's native Advanced "Start Autoplay"
            //            and baselines per-cycle stats.
            //   STOP   — clicks the native button while it's in stop state
            //            (Stake's same button toggles between start/stop).
            // The visual state is driven by syncStartBtn() which polls the
            // native button's data-autobet-status, so our button stays in
            // sync even if autoplay self-terminates (autostop, balance hit).
            const startBtn = document.getElementById('dt-stats-start');
            if (startBtn) {
                startBtn.addEventListener('click', () => {
                    try {
                        const running = startBtn.dataset.running === 'true';
                        if (running) {
                            const stopBtn = findNativeStopButton() || findNativeStartButton();
                            if (stopBtn) stopBtn.click();
                        } else {
                            const native = findNativeStartButton();
                            if (!native) {
                                console.warn('[Stats] native Start button not found');
                                return;
                            }
                            // Snapshot the wager value BEFORE clicking native
                            // Start. Switch Over/Under uses this to restore
                            // the bet after stopping autoplay mid-run.
                            const inp = getWagerInput();
                            if (inp && inp.value) baseBetAtStart = inp.value;
                            native.click();
                            if (typeof window.__iow_smart_baseline_now__ === 'function') {
                                window.__iow_smart_baseline_now__();
                            }
                        }
                        // Re-sync immediately so the visual flips on click.
                        // The 500 ms ticker will continue to authoritative-sync
                        // from the native state.
                        setTimeout(syncStartBtn, 60);
                    } catch (e) { console.error('[Stats] start failed:', e); }
                });
            }

            // ---- Switch Over/Under ----
            // While autoplay is NOT running: one-click toggles native Roll
            // Over/Under direction.
            // While autoplay IS running:
            //   1. Stop native autoplay
            //   2. Restore the wager input to baseBetAtStart (so progression
            //      doesn't keep escalating across the switch)
            //   3. Click the native Roll Over/Under swap
            //   4. Re-start native autoplay
            // baseBetAtStart is captured above when the user clicks START.
            const switchBtn = document.getElementById('dt-stats-switch-ou');
            if (switchBtn) {
                switchBtn.addEventListener('click', async () => {
                    if (switchBtn.disabled) return;
                    switchBtn.disabled = true;
                    try {
                        const stopBtn = findNativeStopButton();
                        const wasRunning = !!stopBtn;
                        const swap = getRollOverUnderSwap();
                        if (!swap) { console.warn('[Switch Over/Under] swap button not found'); return; }

                        if (!wasRunning) {
                            // Idle path: just toggle direction.
                            swap.click();
                            return;
                        }

                        // Running path: stop → restore bet → swap → start.
                        // NOTE: do NOT call __iow_smart_baseline_now__ here —
                        // per-cycle stats must persist across an Over/Under
                        // swap so users can see the full cycle's stats. Only
                        // the deck Start button resets the per-cycle baseline.
                        stopBtn.click();
                        await sleep(120);
                        if (baseBetAtStart != null) writeWagerValue(baseBetAtStart);
                        await sleep(60);
                        swap.click();
                        await sleep(120);
                        const startAgain = findNativeStartButton();
                        if (startAgain && !startAgain.disabled) {
                            startAgain.click();
                        }
                        setTimeout(syncStartBtn, 80);
                    } catch (e) {
                        console.error('[Switch Over/Under] failed:', e);
                    } finally {
                        // Re-arm a moment later so a rapid double-click can't
                        // overlap an in-flight sequence.
                        setTimeout(() => { switchBtn.disabled = false; }, 400);
                    }
                });
            }
        }

        /** Get the wager input — platform-aware. */
        function getWagerInput() {
            return document.querySelector('input[data-testid="bet-amount"]')           // Shuffle
                || document.querySelector('input[data-testid="input-game-amount"]');   // Stake
        }

        /** Get the native Roll Over/Under swap clickable — platform-aware. */
        function getRollOverUnderSwap() {
            return document.querySelector('button[class*="RollOverInput_inputContainer"]')  // Shuffle: whole "Roll Over" label is the toggle button
                || document.querySelector('input[data-testid="reverse-roll"]')              // Stake: reverse-roll input is click-styled as a toggle
                || document.querySelector('[data-testid="reverse-roll"]');                  // Fallback variant
        }

        /** Write a value into the wager input, React-friendly (uses the prototype setter). */
        function writeWagerValue(value) {
            const inp = getWagerInput();
            if (!inp) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(inp, value);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }

        /** Local sleep helper — the dice tool's own sleep lives in a different scope. */
        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        /**
         * Read the strategy editor's Condition 4 and, if it's configured as
         * "Stop autoplay" on "Balance ≥ X", return X. Returns null if Condition
         * 4 doesn't match that pattern, or the editor isn't currently visible.
         *
         * Used by the Stats tab to populate the Balance Target row directly
         * from the strategy the user has loaded — so the displayed target
         * tracks whatever the running strategy will actually stop on, not the
         * Calculator output (which may be a different value if the user
         * manually tweaked Condition 4 after import).
         *
         * Supports both Stake (testid-based DOM) and Shuffle (CSS-module DOM).
         */
        function readCondition4BalanceTarget() {
            // ---- Stake (stake.com / stake.us) ----
            // Strategy editor uses [data-testid="conditional-block-4"] for the
            // Condition 4 panel. When expanded, it contains 3 selects and the
            // amount input, all keyed by data-testid.
            const stakeBlock = document.querySelector('[data-testid="conditional-block-4"]');
            if (stakeBlock) {
                const profitType = stakeBlock.querySelector('select[data-testid="condition-profit-type"]');
                const termType   = stakeBlock.querySelector('select[data-testid="condition-profit-term-type-options"]');
                const action     = stakeBlock.querySelector('select[data-testid="condition-action-options"]');
                const amount     = stakeBlock.querySelector('input[data-testid="condition-profit-amount-input"]');
                if (profitType && termType && action && amount) {
                    const isBalance = profitType.value === 'balance';
                    const isGteOrGt = termType.value === 'greaterThanOrEqualTo' || termType.value === 'greaterThan';
                    // Stake has changed the "stop autoplay" select value over
                    // time — accept both old and new identifiers.
                    const isStop = action.value === 'stop' || action.value === 'stopAutobet' || action.value === 'stopAutoplay';
                    if (isBalance && isGteOrGt && isStop && amount.value) {
                        const n = parseFloat(amount.value);
                        if (!isNaN(n)) return n;
                    }
                }
            }
            // ---- Shuffle ----
            // Strategy editor uses .AdvancedDiceCondition_root__CaIQo for each
            // condition row. Index 3 is Condition 4. Inside: 3 selects + the
            // amount input, in document order.
            const shuffleConds = document.querySelectorAll('.AdvancedDiceCondition_root__CaIQo');
            if (shuffleConds.length >= 4) {
                const cond4 = shuffleConds[3];
                const selects = cond4.querySelectorAll('select');
                const amount  = cond4.querySelector('input[type="number"]');
                if (selects.length >= 3 && amount) {
                    const isBalance = selects[0].value === 'balance';
                    const isGteOrGt = selects[1].value === 'greaterThanOrEqualTo' || selects[1].value === 'greaterThan';
                    const isStop    = selects[2].value === 'stopAutobet' || selects[2].value === 'stop' || selects[2].value === 'stopAutoplay';
                    if (isBalance && isGteOrGt && isStop && amount.value) {
                        const n = parseFloat(amount.value);
                        if (!isNaN(n)) return n;
                    }
                }
            }
            return null;
        }

        /** Poll the strategy editor for Condition 4's Balance Target. Caches
         *  the last valid value so the stat persists when the modal is closed. */
        function refreshCond4BalanceTargetCache() {
            const v = readCondition4BalanceTarget();
            if (v != null) cond4BalanceTarget = v;
        }
        /** Find Stake's native auto-bet "Stop" button (only present while autoplay is running). */
        function findNativeStopButton() {
            // Stake's Advanced auto-bet button signals "running" with
            // data-autobet-status="stop" — clicking it stops autoplay.
            const stopByAttr = document.querySelector('button[data-testid="auto-bet-button"][data-autobet-status="stop"]') ||
                               document.querySelector('button[data-test="auto-bet-button"][data-autobet-status="stop"]') ||
                               document.querySelector('button[data-autobet-status="stop"]');
            if (stopByAttr && !stopByAttr.disabled) return stopByAttr;
            // Fallback: text match
            const buttons = document.querySelectorAll('button');
            for (const b of buttons) {
                const txt = (b.textContent || '').trim().toLowerCase();
                if ((txt === 'stop autoplay' || txt === 'stop auto' || txt === 'stop') && !b.disabled) {
                    return b;
                }
            }
            return null;
        }

        /** Find Stake's native bet/play button (doubles as "Start Autoplay" in Advanced mode). */
        function findNativeStartButton() {
            // Stake's bet button is different per mode:
            //   - Manual mode → button[data-testid="bet-button"]   ("Play")
            //   - Advanced mode → button[data-testid="auto-bet-button"] ("Start Autoplay")
            // Live DOM probe verified both. The Advanced one carries
            // data-autobet-status="start"/"stop" depending on run state —
            // findNativeStopButton uses the "stop" variant of that selector.
            const testIds = [
                'button[data-testid="auto-bet-button"][data-autobet-status="start"]',
                'button[data-testid="auto-bet-button"]',
                'button[data-testid="bet-button"]',
                'button[data-test="bet-button"]',
                '[data-testid="autoplay-button"]',
                '[data-testid="start-autoplay"]',
                '[data-testid="bet-btn"]'
            ];
            for (const sel of testIds) {
                const el = document.querySelector(sel);
                if (el && !isOurInternalEl(el) && !el.disabled) return el;
            }
            // Fallback: text match on buttons outside our injected UIs.
            const buttons = document.querySelectorAll('button');
            for (const b of buttons) {
                if (isOurInternalEl(b)) continue;
                const txt = (b.textContent || '').trim().toLowerCase();
                if (txt === 'start autoplay' || txt === 'start' || txt === 'start auto' || txt === 'play' || txt === 'bet') {
                    if (!b.disabled) return b;
                }
            }
            return null;
        }

        /* ---- STATS RENDERING HELPERS ---- */

        /** Format a number with `dp` decimals (default 2), or em-dash if not finite. */
        function fmt(n, dp) {
            if (typeof n !== 'number' || !isFinite(n)) return '—';
            return n.toFixed(dp == null ? 2 : dp);
        }
        /** Like fmt() but prefixes positive numbers with "+". */
        function fmtSigned(n, dp) {
            if (typeof n !== 'number' || !isFinite(n)) return '—';
            const s = n.toFixed(dp == null ? 2 : dp);
            return n > 0 ? '+' + s : s;
        }

        /**
         * Format a single stat for display.
         * @returns {{text: string, cls: 'pos'|'neg'|'peak'|''}}
         *          cls drives the color cue (green/red/peak-green/default).
         */
        function formatStat(stat, data) {
            if (!data) return { text: '—', cls: '' };
            switch (stat) {
                case 'startingBalance': return { text: fmt(data.startingBalance), cls: '' };
                case 'profit': {
                    const v = data.profit;
                    return { text: fmtSigned(v), cls: typeof v === 'number' ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '' };
                }
                case 'sessionPeak': return { text: fmt(data.sessionPeak), cls: 'peak' };
                case 'peakProfit': return { text: fmtSigned(data.peakProfit), cls: 'peak' };
                case 'totalBets': return { text: String(data.totalBets || 0), cls: '' };
                case 'totalWagered': return { text: fmt(data.totalWagered), cls: '' };
                case 'winsLosses': {
                    const w = data.totalWins || 0;
                    const l = data.totalLosses || 0;
                    return { text: w + ' / ' + l, cls: '' };
                }
                case 'rtp': {
                    const v = data.rtp;
                    return { text: fmt(v) + '%', cls: typeof v === 'number' ? (v >= 100 ? 'pos' : 'neg') : '' };
                }
                case 'streaks':
                    return { text: (data.curWinStreak || 0) + '/' + (data.maxWinStreak || 0) + ' | ' + (data.curLossStreak || 0) + '/' + (data.maxLossStreak || 0), cls: '' };
                case 'multPerf': {
                    const games = data.multGames || 0;
                    const wins = data.multWins || 0;
                    if (wins <= 0) return { text: '1 in 0.00', cls: '' };
                    const ratio = games / wins;
                    const target = data.trackedMultiplier || 0;
                    return { text: '1 in ' + ratio.toFixed(2), cls: target > 0 && ratio <= target ? 'pos' : 'neg' };
                }
            }
            return { text: '—', cls: '' };
        }

        /** Pick the active stats source based on the user's "Stats Track Per" choice. */
        function getActiveStatsSource() {
            const sel = document.getElementById('dt-stats-track-per');
            const mode = sel ? sel.value : 'session';
            const state = window.__iow_smart_state__ || {};
            return mode === 'cycle' ? state.runStats : state.sessionStats;
        }

        /** Refresh every stat row, the Best/Worst streaks, the calc-derived rows, the graph, and the start button. */
        function updateStatsTab() {
            const panel = document.getElementById('dt-panel-stats');
            if (!panel) return;

            // The W/L counters are the dice tool's actual #dt-ctr_w / #dt-ctr_l
            // elements physically relocated into the deck (see
            // relocateDiceCounter). The dice tool keeps writing to them
            // directly — no mirror needed here.

            // Skip heavy rendering when the tab isn't visible.
            const dicePanel = document.getElementById('dt-aio-panel');
            const visible = panel.classList.contains('active') &&
                dicePanel && !dicePanel.classList.contains('dt-bridge-hidden');
            if (!visible) {
                syncStartBtn();
                return;
            }

            const data = getActiveStatsSource();

            // Per-stat rows. The Stats tab uses the IOW/Smart .hud-row /
            // .hud-val class hierarchy directly, so we read .hud-val here.
            panel.querySelectorAll('.hud-row[data-stat]').forEach(row => {
                const stat = row.dataset.stat;
                const valEl = row.querySelector('.hud-val');
                if (!valEl) return;
                const res = formatStat(stat, data);
                valEl.textContent = res.text;
                // Match the Smart panel's color cues: green for pos,
                // soft red for neg, leave unset values default-colored. The
                // Peak Balance / Peak Profit rows already have an inline
                // green color in the markup and we don't override that.
                if (res.cls === 'pos') valEl.style.color = '#00ff9d';
                else if (res.cls === 'neg') valEl.style.color = '#f87171';
                else if (!valEl.style.color || valEl.style.color === 'rgb(0, 255, 157)' || valEl.style.color === 'rgb(248, 113, 113)') {
                    // Don't clobber the inline peak color; only reset if we
                    // were the ones who set it.
                    if (!row.matches('[data-stat="sessionPeak"]') && !row.matches('[data-stat="peakProfit"]')) {
                        valEl.style.color = '';
                    }
                }
            });

            // Best / Worst streaks. Now flat .hud-meta-chip values, no
            // dropdown — rendered as a comma-separated list inline.
            const bestList = panel.querySelector('[data-stat="bestStreaks"]');
            const worstList = panel.querySelector('[data-stat="worstStreaks"]');
            if (bestList) bestList.textContent = (data && data.topWinStreaks && data.topWinStreaks.length) ? data.topWinStreaks.join(', ') : '-';
            if (worstList) worstList.textContent = (data && data.topLossStreaks && data.topLossStreaks.length) ? data.topLossStreaks.join(', ') : '-';

            // Refresh the Condition 4 cache opportunistically — when the
            // Advanced Play modal is open with Condition 4 expanded, this
            // captures the current threshold. Otherwise the cached value
            // (from the last time it was visible) is used.
            refreshCond4BalanceTargetCache();

            // Balance Target — read from the loaded strategy's Condition 4
            // (when it's a "Stop autoplay" on "Balance ≥ X"), falling back to
            // blank if the user has never had a compatible Condition 4 visible
            // since page load. Decoupled from the Calculator output so the
            // displayed target tracks the strategy that will actually run,
            // not whatever value the Calculator most recently computed.
            const balTargetEl = panel.querySelector('#dt-stats-bal-target');
            const profStopEl = panel.querySelector('#dt-stats-profit-stop');
            const calcProfit = document.getElementById('dt-out_profit');
            if (balTargetEl) {
                balTargetEl.textContent = (cond4BalanceTarget != null)
                    ? cond4BalanceTarget.toFixed(2)
                    : '';
            }
            if (profStopEl) profStopEl.textContent = (calcProfit && calcProfit.value) ? calcProfit.value : '0.00';

            syncStartBtn();
            drawStatsGraph(panel, data ? data.profitHistory : []);
        }

        /** Sync the deck Start/Stop button visual state from the native auto-bet status. */
        function syncStartBtn() {
            const startBtn = document.getElementById('dt-stats-start');
            if (!startBtn) return;
            // Detect Stake's Advanced auto-bet running state. When running,
            // the same bet button carries data-autobet-status="stop" (the
            // click stops it). When idle, it doesn't. We mirror that into
            // our deck button so the visual stays in sync even if autoplay
            // self-terminates (autostop on balance, take-profit, etc.).
            const running = !!(
                document.querySelector('button[data-testid="auto-bet-button"][data-autobet-status="stop"]') ||
                document.querySelector('button[data-test="auto-bet-button"][data-autobet-status="stop"]') ||
                document.querySelector('button[data-autobet-status="stop"]')
            );
            startBtn.classList.add('hud-rapid-btn');
            if (running) {
                if (startBtn.dataset.running !== 'true') {
                    startBtn.dataset.running = 'true';
                    startBtn.textContent = 'STOP';
                }
                startBtn.classList.add('stop');
                startBtn.classList.remove('start');
            } else {
                if (startBtn.dataset.running !== 'false') {
                    startBtn.dataset.running = 'false';
                    startBtn.textContent = 'START';
                }
                startBtn.classList.add('start');
                startBtn.classList.remove('stop');
            }
        }

        /** Render the profit-history canvas with green-above / red-below-zero gradient fill. */
        function drawStatsGraph(panel, history) {
            const canvas = panel && panel.querySelector('#dt-stats-graph');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const w = canvas.width = canvas.offsetWidth;
            const h = canvas.height = canvas.offsetHeight;
            ctx.clearRect(0, 0, w, h);
            if (!history || history.length < 2) return;

            let maxVal = Math.max.apply(null, history.concat([0]));
            let minVal = Math.min.apply(null, history.concat([0]));
            const range = (maxVal - minVal) || 1;
            const pad = range * 0.15;
            maxVal += pad; minVal -= pad;
            const totalRange = maxVal - minVal;
            const zeroY = h - ((0 - minVal) / totalRange) * h;
            const zeroPct = Math.max(0, Math.min(1, zeroY / h));

            const lineGrad = ctx.createLinearGradient(0, 0, 0, h);
            lineGrad.addColorStop(0, '#10b981');
            lineGrad.addColorStop(zeroPct, '#10b981');
            lineGrad.addColorStop(zeroPct, '#ef4444');
            lineGrad.addColorStop(1, '#ef4444');

            const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
            fillGrad.addColorStop(0, 'rgba(16, 185, 129, 0.22)');
            fillGrad.addColorStop(zeroPct, 'rgba(16, 185, 129, 0.22)');
            fillGrad.addColorStop(zeroPct, 'rgba(239, 68, 68, 0.22)');
            fillGrad.addColorStop(1, 'rgba(239, 68, 68, 0.22)');

            const stepX = w / (history.length - 1);
            ctx.beginPath();
            for (let i = 0; i < history.length; i++) {
                const x = i * stepX;
                const y = h - ((history[i] - minVal) / totalRange) * h;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = lineGrad;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.stroke();

            ctx.lineTo(w, zeroY); ctx.lineTo(0, zeroY); ctx.closePath();
            ctx.fillStyle = fillGrad;
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(0, zeroY);
            ctx.lineTo(w, zeroY);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        /* ---- ADVANCED IOW MODE TOGGLE ----
           Activating swaps the dice panel into #hud-content; deactivating
           returns it to its original parent and restores the previously
           active Manual / IOW / Smart mode. */

        /** Switch into "Advanced IOW" mode. */
        function activateTools() {
            const hudContent = document.getElementById('hud-content');
            if (!hudContent || !dicePanel) return;
            // Mode isolation: any IOW/Smart/Manual rapid-fire that was running
            // must stop before Advanced IOW takes over the page. The IOW/Smart
            // body exports stopRapidFire as window.__iow_smart_stop__.
            try { if (typeof window.__iow_smart_stop__ === 'function') window.__iow_smart_stop__(); } catch (e) {}
            const activeModeBtn = hud && hud.querySelector('.mode-wrap .mode-btn.active');
            if (activeModeBtn && activeModeBtn.id !== 'mode-dice-tools') {
                lastNonToolsMode = activeModeBtn.id.replace(/^mode-/, '');
            }
            hudContent.innerHTML = '';
            hudContent.appendChild(dicePanel);
            dicePanel.classList.remove('dt-bridge-hidden');
            dicePanel.classList.add('show');
            toolsActive = true;
            if (hud) hud.dataset.toolsActive = '1';
            if (toolsBtn) toolsBtn.classList.add('active');
            // Single, explicit native switch on transition. The ticker won't
            // spam clicks because of the new positive-detection guard.
            forceNativeMode('advanced');
        }

        /** Leave "Advanced IOW" mode — dice panel goes back to its original parent. */
        function deactivateTools() {
            if (!toolsActive) return;
            // Mode isolation: any native autoplay started under Advanced IOW
            // must stop before another mode takes over the page.
            try {
                const stopBtn = findNativeStopButton();
                if (stopBtn) stopBtn.click();
            } catch (e) {}
            if (dicePanel && originalParent) {
                originalParent.appendChild(dicePanel);
                dicePanel.classList.remove('show');
                dicePanel.classList.add('dt-bridge-hidden');
            }
            toolsActive = false;
            if (hud) delete hud.dataset.toolsActive;
            if (toolsBtn) toolsBtn.classList.remove('active');
            forceNativeMode('manual');
        }

        /* ---- MASTER TICKER ----
           Drives stitch attempts, native mode enforcement, Stats tab refresh,
           dice-counter relocation safety, and Terms tab self-heal. One
           interval, 500ms cadence. */

        let stitchAttempts = 0;
        let lastTickedUrl = location.href;
        const MAX_STITCH_ATTEMPTS = 60;  // ~30s at 500ms cadence
        setInterval(() => {
            // URL-change reset — when the user SPA-navs (e.g. limbo → dice),
            // give us a fresh stitch-attempt budget so we can wire up the
            // Advanced IOW button on the new page even if we'd exhausted
            // attempts on the previous one.
            if (location.href !== lastTickedUrl) {
                lastTickedUrl = location.href;
                stitchAttempts = 0;
            }
            // HUD-change detection: if the toolsBtn is missing but the HUD
            // exists (SPA navigation just rebuilt it), re-stitch from scratch
            // with a fresh attempt budget.
            const currentHud = document.getElementById('ratchet-master-container');
            const currentToolsBtn = document.getElementById('mode-dice-tools');
            if (stitched && currentHud && !currentToolsBtn) {
                stitched = false;
                stitchAttempts = 0;
                toolsBtn = null;
            }
            if (!stitched && stitchAttempts < MAX_STITCH_ATTEMPTS) {
                tryStitch();
                stitchAttempts++;
            }
            // Native mode enforcement runs whenever IOW/Smart HUD is present —
            // including limbo (where Dice Tool isn't loaded). Only does anything
            // when the HUD exists.
            enforceNativeMode();
            // Keep the Condition 4 Balance Target cache fresh even when the
            // Stats tab isn't visible — so when the user opens the Stats tab
            // after configuring a strategy, the target appears immediately
            // (vs waiting for the next stats-tab tick).
            try { refreshCond4BalanceTargetCache(); } catch (e) {}
            // Refresh Stats tab (no-ops if not stitched or tab not visible).
            if (statsSetup) updateStatsTab();
            // Safety: re-relocate the dice counter if Stake's React tree
            // re-mounted the floating counter, or if it wasn't ready when
            // the Stats tab first set up. Cheap (no-op when already in slot).
            if (statsSetup) relocateDiceCounter();
            // Self-heal Terms tab if it wasn't ready on first stitch.
            if (!termsSetup) trySetupTermsTab();
        }, 500);
    }

    /* =========================================================
       MOBILE OVERRIDES STYLESHEET (appended last for specificity)
       --------------------------------------------------------
       The desktop unified script's tool HUDs assume a wide
       viewport: the IOW/Smart HUD docks a 300px-wide native
       sidebar slot, the Dice Tool slides in from the right at
       460px, the auto-vault widget sits top-right at 80px,
       etc. On a phone-width viewport (≤980px or coarse-pointer)
       those layouts overflow, sit under the iOS Safari URL bar,
       or land behind the bottom toolbar.

       This stylesheet is appended AFTER every per-tool style
       block so its rules win on specificity (same selectors,
       later in cascade). It does five things:

         1. Stacks the IOW/Smart HUD vertically: the native
            sidebar slot collapses to full width above the
            mode buttons instead of taking a 300px column.
         2. Caps every floating panel at the viewport width,
            anchors them to the bottom edge with safe-area
            insets, and gives them touch-friendly padding.
         3. Bumps tap targets (buttons, switches, inputs) to
            ≥36px and removes :hover rules that misbehave on
            iOS Safari (sticky-hover bug).
         4. Suppresses the blue tap highlight.
         5. Adds 92dvh height caps and grabber-style headers
            for the Dice Tool when it slides in.

       Scoped with @media (max-width: 980px), (pointer: coarse)
       so desktop browsers running this script keep their
       normal layout if the viewport is wide.
       ========================================================= */
    __addStyle(`
    @media (max-width: 980px), (pointer: coarse) {
        /* ===== Global tap polish ===== */
        #ratchet-master-container,
        #ratchet-master-container *,
        #unified-tools-panel,
        #unified-tools-panel *,
        #unified-tools-toggle,
        .uts-quick-toggle,
        #autovault-floaty, #autovault-floaty *,
        #autovault-stealth, #autovault-stealth *,
        #nuts-autovault-floaty, #nuts-autovault-floaty *,
        #nuts-autovault-stealth, #nuts-autovault-stealth *,
        #keno-preset-gui, #keno-preset-gui *,
        #mines-auto-gui, #mines-auto-gui *,
        #dt-aio-panel, #dt-aio-panel *,
        #dt-aio-button {
            -webkit-tap-highlight-color: transparent;
            -webkit-user-select: none;
        }
        /* Allow user-select inside number/text inputs */
        #ratchet-master-container input,
        #unified-tools-panel input,
        #autovault-floaty input,
        #nuts-autovault-floaty input,
        #keno-preset-gui input,
        #mines-auto-gui input,
        #dt-aio-panel input {
            -webkit-user-select: text;
            user-select: text;
        }

        /* ===== IOW/SMART HUD — stack vertically on narrow screens =====
           Set display:flex explicitly (not just flex-direction) in case the
           IOW/Smart body's CSS hasn't injected yet — that CSS only runs on
           dice/limbo URLs, but if mounting races initial paint the column
           reorder still applies. */
        #ratchet-master-container {
            padding: 6px !important;
            font-size: 13px !important;
        }
        #ratchet-master-container .hud-frame {
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot {
            display: flex !important;
            flex-direction: column !important;
            flex: 0 0 auto !important;
            width: 100% !important;
            max-height: 38vh !important;
            order: 99 !important;
            gap: 6px !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot > .game-sidebar {
            min-height: 0 !important;
            max-height: 38vh !important;
            overflow: auto !important;
            -webkit-overflow-scrolling: touch !important;
        }
        #ratchet-master-container .hud-workspace {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            gap: 6px !important;
        }
        /* Mode buttons → full-width row, taller for tap */
        #ratchet-master-container .mode-wrap {
            gap: 6px !important;
        }
        #ratchet-master-container .mode-btn {
            min-height: 42px !important;
            padding: 8px 10px !important;
            font-size: 13px !important;
            font-weight: 700 !important;
        }
        /* Stat-rail + body stack vertically too */
        #ratchet-master-container .hud-split,
        #ratchet-master-container .hud-body {
            flex-direction: column !important;
            gap: 6px !important;
        }
        #ratchet-master-container .hud-pane,
        #ratchet-master-container .hud-pane.primary,
        #ratchet-master-container .hud-pane.secondary,
        #ratchet-master-container .graph-col,
        #ratchet-master-container .stats-col {
            flex: 1 1 auto !important;
            width: 100% !important;
            min-width: 0 !important;
        }
        /* Inputs — iOS keypad + min tap height */
        #ratchet-master-container input[type="number"],
        #ratchet-master-container input[type="text"] {
            min-height: 36px !important;
            font-size: 14px !important;
            padding: 6px 8px !important;
            -webkit-appearance: none !important;
            appearance: none !important;
        }
        /* Disable :hover transforms that stick on touch */
        #ratchet-master-container .mode-btn:hover,
        #ratchet-master-container .quick-btn:hover {
            filter: none !important;
            transform: none !important;
            background: inherit !important;
        }
        #ratchet-master-container .input-row,
        #ratchet-master-container .input-cluster,
        #ratchet-master-container .btn-group {
            flex-wrap: wrap !important;
        }

        /* ===== UNIFIED CONTROL PANEL — stretch + bottom anchor ===== */
        #unified-tools-toggle {
            width: 48px !important;
            height: 48px !important;
            font-size: 22px !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 16px) !important;
            left: 12px !important;
        }
        #unified-tools-toggle:hover {
            transform: none !important;
        }
        #unified-tools-panel {
            width: min(360px, calc(100vw - 16px)) !important;
            max-height: min(70vh, calc(100dvh - 100px)) !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 72px) !important;
            left: 8px !important;
            right: 8px !important;
            font-size: 14px !important;
        }
        #unified-tools-panel .ut-header {
            padding: 12px 14px !important;
            cursor: default !important;
            touch-action: none !important;
        }
        #unified-tools-panel .ut-header:active { cursor: default !important; }
        #unified-tools-panel .ut-tool {
            padding: 12px 14px !important;
        }
        #unified-tools-panel .ut-tool:hover { background: transparent !important; }
        #unified-tools-panel .ut-tool-name { font-size: 14px !important; }
        #unified-tools-panel .ut-tool-desc { font-size: 12px !important; }
        #unified-tools-panel .ut-switch {
            width: 44px !important;
            height: 26px !important;
            border-radius: 13px !important;
        }
        #unified-tools-panel .ut-switch::after {
            width: 22px !important;
            height: 22px !important;
        }
        #unified-tools-panel .ut-switch.on::after {
            transform: translateX(18px) !important;
        }
        #unified-tools-panel .ut-footer-btn {
            min-height: 40px !important;
            font-size: 12px !important;
            padding: 8px 10px !important;
        }
        #unified-tools-panel .ut-header-btn {
            min-width: 36px !important;
            min-height: 36px !important;
            font-size: 22px !important;
            padding: 4px 10px !important;
        }

        /* ===== QUICK-TOGGLE CHIPS ===== */
        .uts-quick-toggle {
            min-width: 44px !important;
            min-height: 44px !important;
            padding: 8px 12px !important;
            font-size: 13px !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 72px) !important;
        }
        .uts-quick-toggle:hover { transform: none !important; }

        /* ===== AUTO-VAULT WIDGETS — stretch + bottom anchor ===== */
        #autovault-floaty,
        #nuts-autovault-floaty {
            width: min(320px, calc(100vw - 20px)) !important;
            max-width: calc(100vw - 20px) !important;
            top: auto !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 132px) !important;
            right: 10px !important;
            left: auto !important;
            font-size: 14px !important;
        }
        #autovault-floaty .av-btn,
        #nuts-autovault-floaty .nv-btn,
        #autovault-floaty button,
        #nuts-autovault-floaty button {
            min-height: 36px !important;
            padding: 8px 12px !important;
            font-size: 12px !important;
        }
        #autovault-floaty input,
        #nuts-autovault-floaty input {
            min-height: 36px !important;
            font-size: 14px !important;
            -webkit-appearance: none !important;
            appearance: none !important;
        }
        #autovault-stealth,
        #nuts-autovault-stealth {
            bottom: calc(env(safe-area-inset-bottom, 0px) + 132px) !important;
            right: 10px !important;
            width: 36px !important; height: 36px !important;
        }

        /* ===== KENO PRESET PANEL ===== */
        #keno-preset-gui {
            width: min(320px, calc(100vw - 20px)) !important;
            max-width: calc(100vw - 20px) !important;
            top: auto !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 132px) !important;
            right: 10px !important;
            left: auto !important;
            max-height: 60vh !important;
            overflow: auto !important;
            -webkit-overflow-scrolling: touch !important;
            font-size: 14px !important;
        }
        #keno-preset-gui .kp-btn,
        #keno-preset-gui button {
            min-height: 36px !important;
            padding: 8px 12px !important;
        }
        #keno-preset-gui .kp-header {
            touch-action: none !important;
            cursor: default !important;
        }

        /* ===== MINES AUTO PANEL ===== */
        #mines-auto-gui {
            position: fixed !important;
            left: 10px !important;
            right: 10px !important;
            top: auto !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 132px) !important;
            width: auto !important;
            max-width: none !important;
            max-height: 55vh !important;
            overflow: auto !important;
            -webkit-overflow-scrolling: touch !important;
            cursor: default !important;
            font-size: 14px !important;
        }
        #mines-auto-gui button {
            min-height: 36px !important;
            padding: 8px 12px !important;
            font-size: 12px !important;
        }
        #mines-auto-gui input,
        #mines-auto-gui select {
            min-height: 36px !important;
            font-size: 14px !important;
            -webkit-appearance: none !important;
            appearance: none !important;
        }

        /* ===== DICE TOOL — bottom sheet on mobile ===== */
        #dt-aio-button {
            width: 52px !important;
            height: 52px !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 132px) !important;
            right: 16px !important;
            top: auto !important;
            font-size: 22px !important;
            touch-action: none !important;
        }
        #dt-aio-button:hover { transform: none !important; }
        #dt-aio-panel {
            left: 0 !important;
            right: 0 !important;
            top: auto !important;
            bottom: 0 !important;
            width: 100vw !important;
            max-width: 100vw !important;
            height: 92vh !important;
            height: 92dvh !important;
            max-height: 92dvh !important;
            border-radius: 18px 18px 0 0 !important;
            padding-bottom: env(safe-area-inset-bottom, 0px) !important;
            transform: none !important;
            font-size: 14px !important;
        }
        #dt-aio-panel .dt-head,
        #dt-aio-panel .dt-header {
            position: sticky !important;
            top: 0 !important;
            z-index: 2 !important;
        }
        #dt-aio-panel button {
            min-height: 36px !important;
        }
        #dt-aio-panel input,
        #dt-aio-panel select {
            min-height: 36px !important;
            font-size: 14px !important;
            -webkit-appearance: none !important;
        }
        /* Floating dice counter chip — keep clear of bottom toolbar */
        #dt-aio-counter {
            bottom: calc(env(safe-area-inset-bottom, 0px) + 192px) !important;
            right: 16px !important;
            top: auto !important;
        }
        #dt-backdrop {
            -webkit-tap-highlight-color: transparent !important;
        }
    }

    /* Very narrow phones (iPhone SE etc.) — collapse rails further */
    @media (max-width: 420px) {
        #ratchet-master-container .hud-stats-grid,
        #ratchet-master-container .hud-stat-rail {
            grid-template-columns: 1fr 1fr !important;
        }
        #ratchet-master-container .hud-header,
        #ratchet-master-container .hud-meta-row {
            flex-wrap: wrap !important;
        }
        #unified-tools-panel .ut-tool-desc {
            display: -webkit-box !important;
            -webkit-line-clamp: 2 !important;
            -webkit-box-orient: vertical !important;
            overflow: hidden !important;
        }
    }

    /* =========================================================
       DICE / LIMBO HUD — AGGRESSIVE MOBILE RECOMPOSE
       --------------------------------------------------------
       Triggered by user testing on iPhone (≤500px). The desktop
       HUD bridges the Dice Tool ("Advanced IOW" tab) into a
       hud-content area sized for ~600px+; on a 340-400px phone
       the inputs squeeze, button text clips, and 3-column native
       bet forms (Multiplier/Roll Over/Chance) overflow.

       Strategy:
         - Force every .dt-field (Dice Tool field) to vertical
           (label above input), input full-width.
         - Make .dt-btn-row + button groups wrap, shrink long
           button text, never let "RESET" become "RESE…".
         - Make tab strips horizontally scrollable so all tabs
           are reachable without crushing labels.
         - Stack the native bet form (Multiplier/Roll Over/
           Chance) to a single column inside the HUD's sidebar
           slot. Targets common Stake/Shuffle parent classes.
         - Allow .mode-wrap (Manual/IOW/Smart/Advanced IOW) to
           wrap to a second row when 4 buttons don't fit.
         - Hide the Dice Tool's heaviest 2-column blocks on
           ≤400px so the Stats tab stays usable.
       ========================================================= */
    @media (max-width: 500px) {
        /* === Universal: force border-box so width:100% inputs don't
              overflow their parents. The desktop iow-smart CSS sets this
              on #ratchet-master-container * already, but the stitched-in
              Dice Tool's #dt-aio-panel sub-tree relies on content-box
              defaults in places, which broke when we set width:100% on
              every input. Force border-box everywhere under the HUD. */
        #ratchet-master-container,
        #ratchet-master-container *,
        #dt-aio-panel,
        #dt-aio-panel * {
            box-sizing: border-box !important;
        }
        /* Cap the stitched panel's outer width to its parent — without
           this, 6px padding pushes #dt-aio-panel beyond #hud-content. */
        #hud-content > #dt-aio-panel,
        #ratchet-master-container #dt-aio-panel {
            width: 100% !important;
            max-width: 100% !important;
        }

        /* === Mode buttons (Manual / IOW / Smart / Advanced IOW) === */
        #ratchet-master-container .mode-wrap {
            flex-wrap: wrap !important;
            gap: 4px !important;
        }
        #ratchet-master-container .mode-btn {
            flex: 1 1 calc(50% - 4px) !important;
            min-width: 0 !important;
            min-height: 38px !important;
            padding: 6px 4px !important;
            font-size: 12px !important;
            letter-spacing: 0 !important;
            text-overflow: ellipsis !important;
            overflow: hidden !important;
        }

        /* === HUD tab + button rows: always wrap; never clip === */
        #ratchet-master-container .hud-top-bar,
        #ratchet-master-container .hud-controls-deck,
        #ratchet-master-container .hud-header,
        #ratchet-master-container .hud-meta-row,
        #ratchet-master-container .input-row,
        #ratchet-master-container .input-cluster,
        #ratchet-master-container .btn-group {
            flex-wrap: wrap !important;
            gap: 4px !important;
            min-width: 0 !important;
        }
        #ratchet-master-container .btn-group > * {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            white-space: normal !important;
            font-size: 11px !important;
            padding: 6px 8px !important;
            line-height: 1.15 !important;
        }
        #ratchet-master-container button {
            white-space: normal !important;
            word-break: break-word !important;
        }
        #ratchet-master-container .hud-switch-ou-btn {
            font-size: 10px !important;
            padding: 6px 6px !important;
            line-height: 1.1 !important;
        }

        /* === Native bet form (Multiplier / Roll Over / Chance) ===
           Inside the HUD's sidebar slot Stake/Shuffle's bet form
           normally lays out as 3 columns. Force the form container
           to 100% width and its rows to wrap so the three fields
           drop to one per line on a 320-430px phone. */
        #ratchet-master-container .hud-native-sidebar-slot .game-sidebar,
        #ratchet-master-container .hud-native-sidebar-slot > * {
            width: 100% !important;
            min-width: 0 !important;
            flex: 1 1 auto !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .game-sidebar > *,
        #ratchet-master-container .hud-native-sidebar-slot [class*="formGroup"],
        #ratchet-master-container .hud-native-sidebar-slot [class*="FormGroup"],
        #ratchet-master-container .hud-native-sidebar-slot [class*="inputGroup"],
        #ratchet-master-container .hud-footer-slot [class*="footer"],
        #ratchet-master-container .hud-footer-slot [class*="Footer"],
        #ratchet-master-container .hud-native-game-footer-slot [class*="footer"] {
            flex-wrap: wrap !important;
            min-width: 0 !important;
        }
        /* When the native form has multiple inputs in a row, force
           them to a single column (label above input, full width).
           Targets both Shuffle's CSS-module wrappers and our own
           harness's .row3 mock. */
        #ratchet-master-container .hud-native-sidebar-slot .row3,
        #ratchet-master-container .hud-native-sidebar-slot [class*="inputRow"],
        #ratchet-master-container .hud-native-sidebar-slot [class*="InputRow"],
        #ratchet-master-container .hud-footer-slot [class*="inputRow"],
        #ratchet-master-container .hud-footer-slot [class*="InputRow"] {
            flex-direction: column !important;
            gap: 6px !important;
            width: 100% !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot .row3 > *,
        #ratchet-master-container .hud-native-sidebar-slot [class*="inputRow"] > *,
        #ratchet-master-container .hud-native-sidebar-slot [class*="InputRow"] > *,
        #ratchet-master-container .hud-footer-slot [class*="inputRow"] > *,
        #ratchet-master-container .hud-footer-slot [class*="InputRow"] > * {
            width: 100% !important;
            min-width: 0 !important;
            flex: 1 1 auto !important;
        }
        #ratchet-master-container .hud-native-sidebar-slot input,
        #ratchet-master-container .hud-footer-slot input,
        #ratchet-master-container .hud-native-game-footer-slot input {
            min-width: 0 !important;
            width: 100% !important;
            box-sizing: border-box !important;
            font-size: 14px !important;
        }
        /* Shuffle dice slider row inside sidebar — let it span full width */
        #ratchet-master-container .hud-native-sidebar-slot [class*="rollingWrapper"],
        #ratchet-master-container .hud-native-sidebar-slot [class*="RollingBar"],
        #ratchet-master-container .hud-native-sidebar-slot [class*="DiceGameRollingBar"] {
            width: 100% !important;
            max-width: 100% !important;
            overflow: visible !important;
        }

        /* === Dice Tool stitched-in panel (#hud-content > #dt-aio-panel) ===
           Force every .dt-field to vertical layout (label above,
           input below, both full-width). Defeat the bridge CSS
           that sets input width:84px — that's what makes the 2nd
           column of "Profit Multiplier" or "Wins/Losses" cram.
           Kept tight to avoid each field becoming a giant row. */
        #hud-content > #dt-aio-panel .dt-field,
        #dt-aio-panel .dt-field {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 2px !important;
            margin: 4px 0 !important;
        }
        #hud-content > #dt-aio-panel .dt-field .dt-label,
        #hud-content > #dt-aio-panel .dt-field label,
        #dt-aio-panel .dt-field .dt-label,
        #dt-aio-panel .dt-field label {
            flex: 0 0 auto !important;
            font-size: 10px !important;
            line-height: 1.2 !important;
            text-align: left !important;
            text-transform: uppercase !important;
        }
        #hud-content > #dt-aio-panel .dt-field input[type="text"],
        #hud-content > #dt-aio-panel .dt-field input[type="number"],
        #hud-content > #dt-aio-panel input.dt-text-input,
        #dt-aio-panel .dt-field input[type="text"],
        #dt-aio-panel .dt-field input[type="number"],
        #dt-aio-panel input.dt-text-input {
            width: 100% !important;
            min-width: 0 !important;
            text-align: left !important;
            font-size: 13px !important;
            padding: 6px 8px !important;
            min-height: 34px !important;
        }
        /* Inline Copy button next to readonly input — keep on same row */
        #hud-content > #dt-aio-panel .dt-field .dt-btn-small,
        #dt-aio-panel .dt-field .dt-btn-small {
            align-self: flex-end !important;
            margin-top: -34px !important;
            margin-right: 4px !important;
            min-height: 28px !important;
            padding: 4px 8px !important;
            font-size: 10px !important;
        }
        /* Wide-field variant is already vertical — just normalize */
        #hud-content > #dt-aio-panel .dt-field-wide input,
        #dt-aio-panel .dt-field-wide input {
            width: 100% !important;
        }
        /* Dice Tool button rows always wrap, full-width children */
        #hud-content > #dt-aio-panel .dt-btn-row,
        #dt-aio-panel .dt-btn-row {
            flex-wrap: wrap !important;
            gap: 6px !important;
        }
        #hud-content > #dt-aio-panel .dt-btn-row .dt-btn,
        #dt-aio-panel .dt-btn-row .dt-btn {
            flex: 1 1 calc(50% - 6px) !important;
            min-width: 0 !important;
            white-space: normal !important;
            word-break: break-word !important;
            font-size: 11px !important;
            padding: 8px 6px !important;
            min-height: 38px !important;
            letter-spacing: 0 !important;
        }
        /* dt-tabs (Stats/Calculator/Optimizer/Results/Settings) →
           horizontal scroll instead of crush. Tab content stays
           readable; users swipe to reveal more tabs. */
        #hud-content > #dt-aio-panel .dt-tabs,
        #dt-aio-panel .dt-tabs {
            overflow-x: auto !important;
            overflow-y: hidden !important;
            -webkit-overflow-scrolling: touch !important;
            flex-wrap: nowrap !important;
            scrollbar-width: none !important;
        }
        #hud-content > #dt-aio-panel .dt-tabs::-webkit-scrollbar,
        #dt-aio-panel .dt-tabs::-webkit-scrollbar { display: none !important; }
        #hud-content > #dt-aio-panel .dt-tab-btn,
        #dt-aio-panel .dt-tab-btn {
            flex: 0 0 auto !important;
            white-space: nowrap !important;
            min-width: 64px !important;
            padding: 8px 10px !important;
            font-size: 11px !important;
        }
        /* Dice Tool cards — tighter padding so two fields per card
           don't push the title off-screen */
        #hud-content > #dt-aio-panel .dt-card,
        #dt-aio-panel .dt-card {
            padding: 8px 8px 6px !important;
            margin-bottom: 8px !important;
        }
        #hud-content > #dt-aio-panel .dt-card-title,
        #dt-aio-panel .dt-card-title {
            font-size: 11px !important;
        }

        /* HUD "controls deck" (Aggression / Lock / Stop Loss row)
           on limbo — wrap each labeled input to its own row so
           the slider gets full width instead of competing with
           the checkbox + input. */
        #ratchet-master-container .hud-controls-deck > * {
            flex: 1 1 100% !important;
            min-width: 0 !important;
        }

        /* Mode buttons inside a control-deck row that aren't in
           the .mode-wrap (e.g. Start / Stop button group) — keep
           in their row but allow text shrink. */
        #ratchet-master-container .btn-group .mode-btn {
            font-size: 12px !important;
            padding: 8px 10px !important;
            min-height: 38px !important;
        }

        /* Number inputs in HUD's controls — full-width inside
           their grid cell, but cap absolute width so they don't
           span the screen and look weird. */
        #ratchet-master-container .hud-risk-container input[type="number"] {
            max-width: none !important;
            width: 100% !important;
        }
    }

    /* === Very tight phones (≤400px): hide the heaviest 2-column
       Dice Tool grids in the Stats tab. Users still get the core
       parameters (Calculator tab) but the dense Stats dashboard
       collapses to keep tappability. === */
    @media (max-width: 400px) {
        #hud-content > #dt-aio-panel .dt-grid-2,
        #dt-aio-panel .dt-grid-2 {
            grid-template-columns: 1fr !important;
        }
    }
    `);

    /* =========================================================
       UNIVERSAL MINIMIZER + DOCK
       --------------------------------------------------------
       Most tools build their own UI inside their tool body, and
       only some sites already have a working "mini" mode:
         - Auto-Vault (Stake/Shuffle/Nuts): already toggles a
           .mini class via its own header button — leave alone.
         - Dice Tool: floating FAB toggles the panel — already a
           minimize pattern.
         - Unified Control Panel: ⚙ toggle — already a minimize.

       The tools that LACK a minimize:
         - Keno preset GUI (#keno-preset-gui): has a "close"
           button that DESTRUCTIVELY removes the widget (and you
           can't get it back without F5). Intercept its onclick
           and convert to a minimize.
         - Mines auto GUI (#mines-auto-gui): no close/minimize
           at all. Inject a minimize button into the header.
         - IOW/Smart HUD (#ratchet-master-container): the dice/
           limbo HUD overlays the game frame and has no escape.
           Inject a minimize button that collapses the HUD's
           tool surface (mode buttons + content panels) while
           keeping the re-parented native game UI visible.

       Minimized widgets show up as chips in a dock pinned to
       bottom-right, above the iOS safe area. Tap a chip to
       restore. State persists in localStorage per-tool.

       Implementation: a MutationObserver-driven scanner runs
       after the script registers tools, watching for the known
       widget IDs to appear. Each widget is enhanced exactly
       once (idempotent via a dataset flag). This avoids
       editing 9+ separate tool body functions.
       ========================================================= */
    __addStyle(`
        /* === Minimize button (injected into headers) === */
        .uts-min-btn {
            position: absolute !important;
            top: 6px !important;
            right: 6px !important;
            width: 30px !important;
            height: 30px !important;
            border-radius: 50% !important;
            background: rgba(0, 0, 0, 0.55) !important;
            color: rgba(255, 255, 255, 0.92) !important;
            border: 1px solid rgba(255, 255, 255, 0.18) !important;
            cursor: pointer !important;
            font-size: 22px !important;
            line-height: 1 !important;
            font-weight: 700 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 0 !important;
            z-index: 2147483640 !important;
            -webkit-tap-highlight-color: transparent !important;
            font-family: inherit !important;
        }
        .uts-min-btn:hover { background: rgba(0, 0, 0, 0.75) !important; }
        .uts-min-btn:active { transform: scale(0.92); }

        /* === Full-collapse state (Keno, Mines): widget hides entirely
              and is represented by a chip in the dock instead. === */
        .uts-mini-full {
            display: none !important;
        }

        /* === Partial-collapse state (IOW HUD): collapses the tool
              surface (mode buttons, content panels) but keeps the
              re-parented native game UI visible so the user can
              still see and place bets through Stake/Shuffle's own
              form. Bottom-right has a restore chip. === */
        #ratchet-master-container.uts-mini-partial .mode-wrap,
        #ratchet-master-container.uts-mini-partial #hud-content,
        #ratchet-master-container.uts-mini-partial .hud-controls-deck,
        #ratchet-master-container.uts-mini-partial .hud-top-bar,
        #ratchet-master-container.uts-mini-partial .hud-body,
        #ratchet-master-container.uts-mini-partial .uts-min-btn {
            display: none !important;
        }
        /* Drop the HUD's own backdrop/border styling while minimized
           so it doesn't visually cover the game underneath. */
        #ratchet-master-container.uts-mini-partial {
            background: transparent !important;
            border: 0 !important;
            box-shadow: none !important;
            padding: 0 !important;
        }

        /* === Dock — column of restore chips, bottom-right corner === */
        #uts-dock {
            position: fixed !important;
            bottom: calc(env(safe-area-inset-bottom, 0px) + 16px) !important;
            right: 12px !important;
            z-index: 2147483645 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
            align-items: flex-end !important;
            pointer-events: none !important;
        }
        #uts-dock:empty { display: none !important; }
        .uts-dock-chip {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            padding: 8px 14px !important;
            background: linear-gradient(135deg, #1f2937, #0f172a) !important;
            color: #e2e8f0 !important;
            border: 1px solid rgba(148, 163, 184, 0.35) !important;
            border-radius: 18px !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            cursor: pointer !important;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5) !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            -webkit-tap-highlight-color: transparent !important;
            min-height: 36px !important;
            pointer-events: auto !important;
            letter-spacing: 0.3px !important;
        }
        .uts-dock-chip:active { transform: scale(0.96); }
        .uts-dock-chip-icon {
            color: #10b981 !important;
            font-size: 10px !important;
            line-height: 1 !important;
        }
    `);

    (function setupUniversalMinimizer() {
        const TOOLS = [
            // [id, label, mode, existingCloseBtnSelector?]
            { id: 'keno-preset-gui',         label: 'Keno',  mode: 'full',    existingClose: '.kp-close, #kp-close' },
            { id: 'mines-auto-gui',          label: 'Mines', mode: 'full',    existingClose: null },
            { id: 'ratchet-master-container', label: 'IOW',  mode: 'partial', existingClose: null }
        ];

        function getDock() {
            let dock = document.getElementById('uts-dock');
            if (!dock) {
                dock = document.createElement('div');
                dock.id = 'uts-dock';
                document.body.appendChild(dock);
            }
            return dock;
        }

        function makeChip(el, label) {
            const dock = getDock();
            const existing = dock.querySelector('[data-for="' + el.id + '"]');
            if (existing) return existing;
            const chip = document.createElement('button');
            chip.className = 'uts-dock-chip';
            chip.dataset.for = el.id;
            chip.innerHTML = '<span class="uts-dock-chip-icon">▲</span><span>' + label + '</span>';
            chip.title = 'Restore ' + label;
            chip.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                el.classList.remove('uts-mini-full', 'uts-mini-partial');
                chip.remove();
                try { localStorage.removeItem('__uts_mini_' + el.id); } catch (e) {}
            });
            dock.appendChild(chip);
            return chip;
        }

        function minimize(el, label, mode) {
            el.classList.add(mode === 'partial' ? 'uts-mini-partial' : 'uts-mini-full');
            makeChip(el, label);
            try { localStorage.setItem('__uts_mini_' + el.id, mode); } catch (e) {}
        }

        function enhance(el, tool) {
            if (el.dataset.utsMinified === '1') return;
            el.dataset.utsMinified = '1';

            // If the widget has an existing destructive close button, hijack
            // its onclick to minimize instead of remove(). We can't just
            // overwrite .onclick because the tool also attaches via
            // addEventListener — so we replace the node with a clone to
            // strip all listeners, then add our own.
            if (tool.existingClose) {
                const closeBtn = el.querySelector(tool.existingClose);
                if (closeBtn) {
                    const clone = closeBtn.cloneNode(true);
                    clone.textContent = '–';   // en-dash for "minimize"
                    clone.title = 'Minimize';
                    clone.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        minimize(el, tool.label, tool.mode);
                    });
                    closeBtn.parentNode.replaceChild(clone, closeBtn);
                    // mark the existing close as handled
                }
            } else {
                // No existing close — inject a fresh minimize button
                const btn = document.createElement('button');
                btn.className = 'uts-min-btn';
                btn.textContent = '–';
                btn.title = 'Minimize ' + tool.label;
                btn.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    minimize(el, tool.label, tool.mode);
                });
                // Ensure positioning context exists; widgets that are
                // position:fixed/absolute already qualify.
                const pos = getComputedStyle(el).position;
                if (pos === 'static') el.style.position = 'relative';
                el.appendChild(btn);
            }

            // Restore minimized state from previous session
            try {
                const saved = localStorage.getItem('__uts_mini_' + el.id);
                if (saved === 'full' || saved === 'partial') {
                    minimize(el, tool.label, saved);
                }
            } catch (e) {}
        }

        function scan() {
            for (const tool of TOOLS) {
                const el = document.getElementById(tool.id);
                if (el) enhance(el, tool);
            }
        }

        function startObserving() {
            scan();
            try {
                new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
            } catch (e) {}
        }

        if (document.body) {
            startObserving();
        } else {
            document.addEventListener('DOMContentLoaded', startObserving);
        }
    })();

    console.log('%c[Unified Mobile] Loaded with ' + TOOLS.length + ' tools. Tap ⚙ in bottom-left to manage.', 'color:#10b981;font-weight:700;');

})();
