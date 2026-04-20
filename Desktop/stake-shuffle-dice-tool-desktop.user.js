// ==UserScript==
// @name Dice Tool
// @namespace http://tampermonkey.net/
// @version 1
// @description On-site dice helper for Stake and Shuffle: win/loss counter, autoplay stopper on streak, balance export, and one-tap advanced strategy import.
// @author .
// @match https://stake.com/casino/games/primedice
// @match https://stake.us/casino/games/primedice
// @match https://shuffle.us/games/originals/dice
// @match https://stake.us/casino/games/dice
// @match https://stake.com/casino/games/dice
// @grant GM_xmlhttpRequest
// @run-at document-end
// ==/UserScript==

(function () {
    'use strict';
    // ←←←←←←←←←←←←←←←← SHUFFLE.US ←←←←←←←←←←←←←←←←
    if (location.hostname.includes('shuffle.us')) {
        (function () {
            'use strict';
            const sleep = ms => new Promise(res => setTimeout(res, ms));
            const waitFor = async (selector, timeout = 15000) => {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const el = document.querySelector(selector);
                    if (el) return el;
                    await sleep(250);
                }
                throw new Error(`Timeout waiting for selector: ${selector}`);
            };
            const waitForText = async (tag, text, timeout = 10000) => {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const els = Array.from(document.querySelectorAll(tag));
                    const found = els.find(el => el.textContent.trim().toLowerCase().includes(text.toLowerCase()));
                    if (found) return found;
                    await sleep(250);
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
            const getValues = async () => {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: "http://localhost:8000/get_values",
                        onload: r => r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject("Server error / tool not running")
                    });
                });
            };
            function sanitizeBalance(rawText) {
                if (!rawText) return null;
                let cleaned = rawText.replace(/,/g, '');
                cleaned = cleaned.replace(/[^0-9.]/g, '');
                const parts = cleaned.split('.');
                if (parts.length > 2) {
                    cleaned = parts.shift() + '.' + parts.join('');
                }
                if (!cleaned || isNaN(cleaned)) return null;
                return Number(cleaned).toFixed(8);
            }
            // ── Export Balance ─────────────────────
            async function exportBalance() {
                const activeBtn = document.querySelector('button.TabView_active__G842W p');
                if (!activeBtn || !activeBtn.textContent.trim()) {
                    alert('Active balance element not found');
                    return;
                }
                const raw = activeBtn.textContent.trim();
                let cleaned = raw.replace(/,/g, '');
                cleaned = cleaned.replace(/[^0-9.]/g, '');
                const parts = cleaned.split('.');
                if (parts.length > 2) {
                    cleaned = parts.shift() + '.' + parts.join('');
                }
                if (!cleaned || isNaN(cleaned)) {
                    alert('Invalid balance after cleaning:\n' + raw);
                    return;
                }
                const balance = Number(cleaned);
                GM_xmlhttpRequest({
                    method: "POST",
                    url: "http://localhost:8000/set_balance",
                    data: JSON.stringify({ balance }),
                    headers: { "Content-Type": "application/json" },
                    onload: r => {
                        if (r.status === 200) {
                            alert(`Balance exported: ${balance}`);
                        } else {
                            alert('Failed – is the tool running?');
                        }
                    }
                });
            }
            function getValuesFromServer(callback) {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: "http://localhost:8000/get_values",
                    onload: function(response) {
                        if (response.status === 200) {
                            const values = JSON.parse(response.responseText);
                            callback(values);
                        } else {
                            alert('Failed to get values: ' + response.status);
                        }
                    },
                    onerror: function() {
                        alert('Error connecting to local server.');
                    }
                });
            }
            // ── Update Existing Strategy ─────────────────────
            function updateExistingStrategy() {
                getValuesFromServer(async function(values) {
                    const betSize = values.bet_size;
                    const profitStop = values.profit_stop;
                    if (!betSize || !profitStop) {
                        alert('Missing bet_size or profit_stop.');
                        return;
                    }
                    const betInput = document.querySelector('input[data-testid="bet-amount"]');
                    if (betInput) setNativeValue(betInput, betSize);
                    const editBtn = await waitForText('button', 'Edit');
                    if (!editBtn) return alert('Edit button not found');
                    editBtn.click();
                    await sleep(1000);
                    const headers = document.querySelectorAll('.AdvancedDiceCondition_header__jDZzw');
                    const cond4 = Array.from(headers).find(h => h.textContent.includes('Condition 4'));
                    if (!cond4) return alert('Condition 4 not found.');
                    cond4.click();
                    setTimeout(() => {
                        const conditionDiv = cond4.closest('.AdvancedDiceCondition_root__CaIQo');
                        const profitInput = conditionDiv.querySelector('input.CurrencyInputElement_root__3QQ68');
                        if (profitInput) {
                            setNativeValue(profitInput, profitStop);
                        }
                        alert('Strategy updated (bet size + profit stop).');
                    }, 600);
                });
            }
            // ── Import NEW Strategy ───────────────────
            async function importNewStrategy() {
                try {
                    const v = await getValues();
                    const { bet_size, profit_stop, multiplier, win_increase, loss_reset } = v;
                    const advancedTab = document.getElementById('advanced-bet');
                    if (advancedTab && !advancedTab.classList.contains('TabView_active__G842W')) {
                        advancedTab.click();
                        await sleep(800);
                    }
                    const betInfoInputs = document.querySelectorAll('input#betInfo');
                    if (betInfoInputs.length < 2) throw "betInfo inputs not found";
                    setNativeValue(betInfoInputs[0], multiplier);
                    await sleep(600);
                    const winChance = betInfoInputs[1].value;
                    const betInput = document.querySelector('input[data-testid="bet-amount"]');
                    if (betInput) setNativeValue(betInput, bet_size);
                    const createBtn = await waitForText('button', 'Create strategy');
                    if (!createBtn) throw "Create strategy button not found";
                    createBtn.click();
                    await sleep(800);
                    const labels = Array.from(document.querySelectorAll('label'));
                    const nameLabel = labels.find(l => l.textContent.includes('Strategy name'));
                    let nameInput = null;
                    if (nameLabel) {
                        const container = nameLabel.closest('div.TextInput_formControlWrapper__iBF1i') || nameLabel.parentElement.parentElement;
                        nameInput = container.querySelector('input');
                    }
                    if (!nameInput) {
                        nameInput = document.querySelector('.ModalContent_modalContent__rbnMN input[type="text"]') || document.querySelector('.ModalContent_modalContent__rbnMN input:not([type="hidden"])');
                    }
                    if (!nameInput) throw "Could not locate Strategy Name input field.";
                    nameInput.focus();
                    setNativeValue(nameInput, `${multiplier}x`);
                    await sleep(300);
                    if (nameInput.value !== `${multiplier}x`) {
                        console.log("Value didn't stick, retrying...");
                        setNativeValue(nameInput, `${multiplier}x`);
                        await sleep(300);
                    }
                    const getStartedBtn = await waitForText('button', 'Get Started');
                    if (!getStartedBtn) throw "Get Started button not found";
                    getStartedBtn.click();
                    const addBtn = await waitForText('button', 'Add new condition block', 10000);
                    if (!addBtn) throw "Add condition block button not found (Strategy creation likely failed at name step)";
                    for (let i = 0; i < 4; i++) {
                        addBtn.click();
                        await sleep(500);
                    }
                    await sleep(1000);
                    const headers = document.querySelectorAll('.AdvancedDiceCondition_header__jDZzw');
                    if (headers.length < 4) throw `Only ${headers.length} conditions created.`;
                    for (let i = 0; i < 4; i++) {
                        headers[i].click();
                        await sleep(500);
                        const conditionDiv = headers[i].closest('.AdvancedDiceCondition_root__CaIQo');
                        const radioLabels = conditionDiv.querySelectorAll('.AdvancedDiceCondition_customRadio__H__kC');
                        let targetRadioIndex = (i === 0 || i === 3) ? 1 : 0;
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
                    alert(`SUCCESS! "${multiplier}x" strategy created.\n\nPlease click "Save Strategy" to finish.`);
                } catch (err) {
                    alert('Import failed: ' + err);
                    console.error(err);
                }
            }
            // ── GUI ───────────────────────────────────────
            const gui = document.createElement('div');
            Object.assign(gui.style, {
                position: 'fixed',
                top: '80px',
                right: '10px',
                zIndex: 99999,
                background: '#1a1a1a',
                padding: '8px 10px',
                borderRadius: '8px',
                border: '2px solid #7717ff',
                boxShadow: '0 0 12px rgba(119,23,255,0.6)',
                color: '#fff',
                width: '195px',
                fontFamily: 'Segoe UI,Arial,sans-serif'
            });
            let offsetX = 0, offsetY = 0;
            const title = document.createElement('div');
            title.textContent = 'Shuffle Dice Tool';
            Object.assign(title.style, {
                textAlign: 'center',
                fontWeight: 'bold',
                marginBottom: '6px',
                color: '#7717ff',
                fontSize: '15px',
                cursor: 'move',
                userSelect: 'none'
            });
            title.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const rect = gui.getBoundingClientRect();
                offsetX = e.clientX - rect.left;
                offsetY = e.clientY - rect.top;
                const onMouseMove = (e) => {
                    gui.style.left = `${e.clientX - offsetX}px`;
                    gui.style.top = `${e.clientY - offsetY}px`;
                    gui.style.right = 'auto';
                };
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
            console.log('Script loaded');
            const counterContainer = document.createElement('div');
            counterContainer.id = 'draggable-counter';
            Object.assign(counterContainer.style, {
                fontSize: '25px',
                backgroundColor: '#1a1a1a',
                color: '#FFFFFF',
                border: '2px solid #7717ff',
                padding: '5px',
                userSelect: 'none',
                textAlign: 'center'
            });
            let counter = 0;
            let target = 10;
            let lossCounter = 0;
            let volume = 1.0;
            const counterSpan = document.createElement('span');
            counterSpan.innerText = `${counter}`;
            counterSpan.style.transition = 'transform 0.3s';
            counterContainer.appendChild(counterSpan);
            const controlsDiv = document.createElement('div');
            Object.assign(controlsDiv.style, {
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: '5px'
            });
            counterContainer.appendChild(controlsDiv);
            // Add label
            const label = document.createElement('span');
            label.textContent = 'Stop after streak of ';
            label.style.fontSize = '12px';
            label.style.marginRight = '5px';
            controlsDiv.appendChild(label);
            const targetInput = document.createElement('input');
            targetInput.type = 'number';
            targetInput.min = '0';
            targetInput.value = target;
            targetInput.style.fontSize = '10px';
            targetInput.style.width = '30px';
            targetInput.style.backgroundColor = '#1a1a1a';
            targetInput.style.color = '#FFFFFF';
            targetInput.style.border = '1px solid #7717ff';
            controlsDiv.appendChild(targetInput);
            const resetButton = document.createElement('button');
            resetButton.innerText = 'Reset';
            resetButton.style.fontSize = '10px';
            resetButton.style.marginLeft = '5px';
            resetButton.style.backgroundColor = '#7717ff';
            resetButton.style.color = '#FFFFFF';
            resetButton.style.border = 'none';
            resetButton.style.borderRadius = '3px';
            resetButton.style.cursor = 'pointer';
            resetButton.style.padding = '2px 5px';
            resetButton.onmouseover = () => { resetButton.style.backgroundColor = '#a166ff'; };
            resetButton.onmouseout = () => { resetButton.style.backgroundColor = '#7717ff'; };
            controlsDiv.appendChild(resetButton);
            const lossDiv = document.createElement('div');
            lossDiv.style.fontSize = '15px';
            lossDiv.style.marginTop = '5px';
            lossDiv.style.textAlign = 'center';
            lossDiv.textContent = 'Loss streak: ';
            const lossSpan = document.createElement('span');
            lossSpan.innerText = '0';
            lossSpan.style.transition = 'transform 0.3s, color 0.3s';
            lossDiv.appendChild(lossSpan);
            counterContainer.appendChild(lossDiv);
            const volumeDiv = document.createElement('div');
            Object.assign(volumeDiv.style, {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '5px'
            });
            const volumeIcon = document.createElement('span');
            volumeIcon.textContent = '🔊';
            volumeIcon.style.marginRight = '5px';
            volumeIcon.style.fontSize = '16px';
            const volumeSlider = document.createElement('input');
            volumeSlider.type = 'range';
            volumeSlider.min = '0';
            volumeSlider.max = '100';
            volumeSlider.value = '100';
            volumeSlider.style.width = '80px';
            volumeSlider.style.accentColor = '#7717ff';
            volumeDiv.appendChild(volumeIcon);
            volumeDiv.appendChild(volumeSlider);
            counterContainer.appendChild(volumeDiv);
            targetInput.addEventListener('change', () => {
                target = parseInt(targetInput.value) || 0;
                console.log(`Target updated to ${target}`);
            });
            resetButton.addEventListener('click', () => {
                counter = 0;
                lossCounter = 0;
                updateCounter();
                updateLoss();
                console.log('Counter manually reset to 0');
            });
            volumeSlider.addEventListener('input', () => {
                volume = parseInt(volumeSlider.value) / 100;
                if (volume === 0) {
                    volumeIcon.textContent = '🔇';
                } else if (volume < 0.33) {
                    volumeIcon.textContent = '🔈';
                } else if (volume < 0.66) {
                    volumeIcon.textContent = '🔉';
                } else {
                    volumeIcon.textContent = '🔊';
                }
            });
            function updateCounter() {
                counterSpan.innerText = `${counter}`;
            }
            function updateLoss() {
                lossSpan.innerText = `${lossCounter}`;
                lossSpan.style.color = lossCounter > 0 ? 'red' : 'inherit';
            }
            function animateSpan(span) {
                span.style.transform = 'scale(1.2)';
                setTimeout(() => { span.style.transform = 'scale(1)'; }, 300);
            }
            updateCounter();
            updateLoss();
            function playBeep() {
                if (volume === 0) return;
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                gainNode.gain.value = volume;
                oscillator.start();
                setTimeout(() => oscillator.stop(), 200);
            }
            function stopAutoplay() {
                const stopButton = document.querySelector('button[data-testid="bet-button"] span.ButtonVariants_buttonContent__mRPrs');
                if (stopButton && stopButton.innerText.includes('Stop Autoplay') && !stopButton.closest('button').disabled) {
                    stopButton.closest('button').click();
                    console.log('Autoplay stopped as counter reached target');
                } else {
                    console.log('Stop button not found, text does not match, or button is disabled');
                }
            }
            let prev3Active = false;
            let lastSeenText = '';
            function initCounter() {
                const conditionContainer = document.querySelector('.AdvancedDiceBet_conditionContainer__6o_z9');
                const resultsWrapper = document.querySelector('.OriginalGameRecentResult_originalGameResultsWrapper__aCNPr');
                if (!conditionContainer || !resultsWrapper) {
                    console.log('Containers not found yet');
                    return false; // Not found yet
                }
                console.log('Containers found');
                const initialNewest = resultsWrapper.children[0];
                if (initialNewest) {
                    const initialButton = initialNewest.querySelector('button');
                    if (initialButton) {
                        lastSeenText = initialButton.innerText;
                    }
                }
                function checkCondition3() {
                    const buttons = conditionContainer.querySelectorAll('button.AdvancedDiceConditionTag_condition__8L8IB');
                    let condition3Button = null;
                    buttons.forEach((button) => {
                        if (button.innerText.trim() === '3') {
                            condition3Button = button;
                        }
                    });
                    if (!condition3Button) return;
                    const tagDiv = condition3Button.querySelector('div.AdvancedDiceConditionTag_tag__gdVMG');
                    if (!tagDiv) return;
                    const current3Active = tagDiv.classList.contains('AdvancedDiceConditionTag_active__7Rex1');
                    if (current3Active && !prev3Active) {
                        counter = 0;
                        updateCounter();
                        console.log('Condition 3 active detected, counter reset to 0');
                    }
                    prev3Active = current3Active;
                }
                const resultsObserver = new MutationObserver(() => {
                    const newest = resultsWrapper.children[0];
                    if (!newest) return;
                    const button = newest.querySelector('button');
                    if (!button) return;
                    const currentText = button.innerText;
                    if (currentText !== lastSeenText) {
                        lastSeenText = currentText;
                        const isWin = button.style.backgroundColor === 'rgb(61, 209, 121)';
                        if (isWin) {
                            counter++;
                            updateCounter();
                            animateSpan(counterSpan);
                            playBeep();
                            lossCounter = 0;
                            updateLoss();
                            console.log('Win detected, counter incremented');
                            if (counter >= target) {
                                stopAutoplay();
                            }
                        } else {
                            lossCounter++;
                            updateLoss();
                            animateSpan(lossSpan);
                        }
                    }
                });
                resultsObserver.observe(resultsWrapper, { childList: true, subtree: true, attributes: true });
                const conditionObserver = new MutationObserver(() => {
                    checkCondition3();
                });
                conditionObserver.observe(conditionContainer, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
                checkCondition3();
                return true;
            }
            if (!initCounter()) {
                const pollInterval = setInterval(() => {
                    if (initCounter()) {
                        clearInterval(pollInterval);
                    }
                }, 500);
            }
            gui.prepend(counterContainer);
            gui.appendChild(title);
            document.body.appendChild(gui);
            const actions = [
                { text: 'Export Balance', fn: exportBalance },
                { text: 'Update Existing', fn: updateExistingStrategy },
                { text: 'Import New Strategy', fn: importNewStrategy }
            ];
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.textContent = action.text;
                Object.assign(btn.style, {
                    width: '100%',
                    margin: '4px 0',
                    padding: '8px',
                    background: '#7717ff',
                    border: 'none',
                    borderRadius: '6px',
                    color: 'white',
                    fontWeight: 'bold',
                    fontSize: '13.5px',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                });
                btn.onmouseover = () => { btn.style.background = '#a166ff'; };
                btn.onmouseout = () => { btn.style.background = '#7717ff'; };
                btn.onclick = action.fn;
                gui.appendChild(btn);
            });
        })();
    }
    // ←←←←←←←←←←←←←←←← STAKE.US / STAKE.COM ←←←←←←←←←←←←←←←←
    if (location.hostname.includes('stake.us') || location.hostname.includes('stake.com')) {
        (function () {
            'use strict';
            const sleep = ms => new Promise(res => setTimeout(res, ms));
            const waitFor = async (selector, timeout = 15000) => {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const el = document.querySelector(selector);
                    if (el) return el;
                    await sleep(150);
                }
                throw new Error(`Timeout waiting for: ${selector}`);
            };
            const trigger = el => {
                ['input', 'change', 'blur'].forEach(type => {
                    el.dispatchEvent(new Event(type, { bubbles: true }));
                });
            };
            const getValues = async () => {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: "http://localhost:8000/get_values",
                        onload: r => r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject("Server error / tool not running")
                    });
                });
            };
            // ── Export Balance ─────────────────────
            async function exportBalance() {
                const el = document.querySelector('span.ds-body-md-strong[data-ds-text="true"][style*="max-width: 16ch"]') ||
                      document.querySelector('span.ds-body-md-strong[data-ds-text="true"]');
                if (!el) return alert('Balance element not found');

                const rawText = el.textContent.trim();

                // Remove commas and everything except digits and decimal points
                let cleaned = rawText.replace(/,/g, '').replace(/[^\d.]/g, '');

                // Protect against multiple decimal points (malformed input)
                const parts = cleaned.split('.');
                if (parts.length > 2) {
                    cleaned = parts.shift() + '.' + parts.join('');
                }

                const balance = parseFloat(cleaned);
                if (isNaN(balance)) {
                    return alert('Invalid balance format after cleaning: ' + rawText);
                }

                GM_xmlhttpRequest({
                    method: "POST",
                    url: "http://localhost:8000/set_balance",
                    data: JSON.stringify({ balance }),
                    headers: { "Content-Type": "application/json" },
                    onload: r => alert(r.status === 200 ? `Balance exported: ${balance}` : 'Failed – is the tool running?')
                });
            }
            // ── Update Existing Strategy ─────────────────────
            function getValuesFromServer(callback) {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: "http://localhost:8000/get_values",
                    onload: function(response) {
                        if (response.status === 200) {
                            const values = JSON.parse(response.responseText);
                            callback(values);
                        } else {
                            alert('Failed to get values: ' + response.status);
                        }
                    },
                    onerror: function() {
                        alert('Error connecting to local server.');
                    }
                });
            }
            async function updateExistingStrategy() {
                try {
                    const v = await getValues();
                    const betSize = v.bet_size;
                    const profitStop = v.profit_stop;

                    if (!betSize || !profitStop) {
                        alert('Missing bet_size or profit_stop.');
                        return;
                    }

                    // === Set main bet amount ===
                    const betInput = await waitFor('input[data-testid="input-game-amount"]');
                    betInput.value = betSize;
                    trigger(betInput);

                    // === Open Condition 4 ===
                    const cond4BlockBtn = await waitFor('button[data-testid="block-condition-4"]');
                    cond4BlockBtn.click();
                    await sleep(600);

                    // === Click edit pencil if present ===
                    const editBtn = document.querySelector('button[data-testid="conditional-block-edit-condition-4"]');
                    if (editBtn) {
                        editBtn.click();
                        await sleep(600);
                    }

                    // === Set profit stop amount ===
                    const profitInput = await waitFor('input[data-testid="condition-profit-amount-input"]');
                    profitInput.value = profitStop;
                    trigger(profitInput);

                    alert('Existing strategy updated (bet size + profit stop).');
                } catch (err) {
                    alert('Update failed: ' + err);
                    console.error(err);
                }
            }
            async function importNewStrategy() {
                try {
                    const v = await getValues();
                    const { bet_size, profit_stop, multiplier, win_increase, loss_reset } = v;
                    const payoutInput = await waitFor('input[data-testid="payout"]');
                    payoutInput.value = multiplier;
                    trigger(payoutInput);
                    await sleep(600);
                    const chanceEl = await waitFor('input[data-testid="chance"]');
                    const winChance = chanceEl.value;
                    const betInput = document.querySelector('input[data-testid="input-game-amount"]');
                    if (betInput) {
                        betInput.value = bet_size;
                        trigger(betInput);
                    }
                    const advBtn = await waitFor('svg[data-ds-icon="BetAdvanced"]');
                    advBtn.closest('button').click();
                    await sleep(800);
                    const createBtn = await waitFor('button[data-testid="create-strategy-button"]');
                    createBtn.click();
                    await sleep(800);
                    const nameInput = await waitFor('input[data-testid="strategy-name-input"]');
                    nameInput.value = `${multiplier}x`;
                    trigger(nameInput);
                    const getStartedBtn = Array.from(document.querySelectorAll('div, button')).find(el => el.textContent.trim() === 'Get Started' || el.textContent.trim() === 'Get started' );
                    if (!getStartedBtn) throw "Get Started button not found";
                    getStartedBtn.click();
                    await sleep(1500);
                    const addBtn = await waitFor('button[data-testid="conditional-block-add"]');
                    for (let i = 0; i < 4; i++) {
                        addBtn.click();
                        await sleep(800);
                    }
                    await sleep(1000);
                    let editPencils = document.querySelectorAll('svg[data-ds-icon="Edit"]');
                    if (editPencils.length < 4) throw `Only ${editPencils.length} conditions created`;
                    editPencils[0].closest('button').click();
                    await sleep(600);
                    const profitRadio1 = await waitFor('label[data-testid="condition-type-radio-profit"]');
                    profitRadio1.click();
                    await sleep(300);
                    let sel = await waitFor('select[data-testid="condition-profit-type"]');
                    sel.value = 'balance';
                    trigger(sel);
                    sel = await waitFor('select[data-testid="condition-profit-term-type-options"]');
                    sel.value = 'greaterThanOrEqualTo';
                    trigger(sel);
                    let inp = await waitFor('input[data-testid="condition-profit-amount-input"]');
                    inp.value = '0.00';
                    trigger(inp);
                    sel = await waitFor('select[data-testid="condition-action-options"]');
                    sel.value = 'setWinChance';
                    trigger(sel);
                    inp = await waitFor('input[data-testid="condition-action-percentage-input"]');
                    inp.value = winChance;
                    trigger(inp);
                    await sleep(500);
                    editPencils[1].closest('button').click();
                    await sleep(600);
                    sel = await waitFor('select[data-testid="condition-term-options"]');
                    sel.value = 'every';
                    trigger(sel);
                    inp = await waitFor('input[data-testid="condition-count-input"]');
                    inp.value = '1';
                    trigger(inp);
                    sel = await waitFor('select[data-testid="condition-bet-type-options"]');
                    sel.value = 'win';
                    trigger(sel);
                    sel = await waitFor('select[data-testid="condition-action-options"]');
                    sel.value = 'increaseByPercentage';
                    trigger(sel);
                    inp = await waitFor('input[data-testid="condition-action-percentage-input"]');
                    inp.value = win_increase;
                    trigger(inp);
                    await sleep(500);
                    editPencils[2].closest('button').click();
                    await sleep(600);
                    sel = await waitFor('select[data-testid="condition-term-options"]');
                    sel.value = 'everyStreakOf';
                    trigger(sel);
                    inp = await waitFor('input[data-testid="condition-count-input"]');
                    inp.value = loss_reset;
                    trigger(inp);
                    sel = await waitFor('select[data-testid="condition-bet-type-options"]');
                    sel.value = 'lose';
                    trigger(sel);
                    sel = await waitFor('select[data-testid="condition-action-options"]');
                    sel.value = 'resetAmount';
                    trigger(sel);
                    await sleep(500);
                    editPencils[3].closest('button').click();
                    await sleep(600);
                    const profitRadio4 = await waitFor('label[data-testid="condition-type-radio-profit"]');
                    profitRadio4.click();
                    await sleep(300);
                    sel = await waitFor('select[data-testid="condition-profit-type"]');
                    sel.value = 'profit';
                    trigger(sel);
                    sel = await waitFor('select[data-testid="condition-profit-term-type-options"]');
                    sel.value = 'greaterThanOrEqualTo';
                    trigger(sel);
                    inp = await waitFor('input[data-testid="condition-profit-amount-input"]');
                    inp.value = profit_stop;
                    trigger(inp);
                    sel = await waitFor('select[data-testid="condition-action-options"]');
                    sel.value = 'stop';
                    trigger(sel);
                    alert(`SUCCESS! "${multiplier}x" strategy created.\nClick "Save Strategy" when ready.`);
                } catch (err) {
                    alert('Import failed: ' + err);
                    console.error(err);
                }
            }
            // GUI ───────────────────────────────────────
            const gui = document.createElement('div');
            Object.assign(gui.style, {
                position: 'fixed',
                top: '80px',
                right: '10px',
                zIndex: 99999,
                background: '#071824',
                padding: '8px 10px',
                borderRadius: '8px',
                border: '2px solid #162a35',
                boxShadow: '0 0 12px rgba(36,159,135,0.6)',
                fontFamily: 'Segoe UI,Arial,sans-serif',
                color: '#1a2c38',
                width: '195px',
                boxSizing: 'border-box'
            });
            let offsetX = 0, offsetY = 0;
            const title = document.createElement('div');
            title.textContent = 'Dice Tool';
            Object.assign(title.style, {
                textAlign: 'center',
                fontWeight: 'bold',
                marginBottom: '6px',
                color: '#249f87',
                fontSize: '15px',
                cursor: 'move',
                userSelect: 'none'
            });
            title.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const rect = gui.getBoundingClientRect();
                gui.style.left = `${rect.left}px`;
                gui.style.top = `${rect.top}px`;
                gui.style.right = 'auto';
                offsetX = e.clientX - rect.left;
                offsetY = e.clientY - rect.top;
                const onMouseMove = (e) => {
                    gui.style.left = `${e.clientX - offsetX}px`;
                    gui.style.top = `${e.clientY - offsetY}px`;
                };
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
            console.log('Script loaded');
            const counterContainer = document.createElement('div');
            counterContainer.id = 'draggable-counter';
            Object.assign(counterContainer.style, {
                fontSize: '25px',
                backgroundColor: '#071824',
                color: '#FFFFFF',
                border: '2px solid #162a35',
                padding: '5px',
                userSelect: 'none',
                textAlign: 'center'
            });
            // Counter logic
            let counter = 0;
            let target = 10;
            let lossCounter = 0;
            let volume = 1.0;
            const counterSpan = document.createElement('span');
            counterSpan.innerText = `${counter}`;
            counterSpan.style.transition = 'transform 0.3s';
            counterContainer.appendChild(counterSpan);
            // Controls row
            const controlsDiv = document.createElement('div');
            Object.assign(controlsDiv.style, {
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: '5px'
            });
            counterContainer.appendChild(controlsDiv);
            // Add label
            const label = document.createElement('span');
            label.textContent = 'Stop after streak of ';
            label.style.fontSize = '12px';
            label.style.marginRight = '5px';
            controlsDiv.appendChild(label);
            const targetInput = document.createElement('input');
            targetInput.type = 'number';
            targetInput.min = '0';
            targetInput.value = target;
            targetInput.style.fontSize = '10px';
            targetInput.style.width = '30px';
            targetInput.style.backgroundColor = '#071824';
            targetInput.style.color = '#FFFFFF';
            targetInput.style.border = '1px solid #162a35';
            controlsDiv.appendChild(targetInput);
            const resetButton = document.createElement('button');
            resetButton.innerText = 'Reset';
            resetButton.style.fontSize = '10px';
            resetButton.style.marginLeft = '5px';
            resetButton.style.backgroundColor = '#249f87';
            resetButton.style.color = '#FFFFFF';
            resetButton.style.border = 'none';
            resetButton.style.borderRadius = '3px';
            resetButton.style.cursor = 'pointer';
            resetButton.style.padding = '2px 5px';
            resetButton.onmouseover = () => { resetButton.style.backgroundColor = '#30d4b3'; };
            resetButton.onmouseout = () => { resetButton.style.backgroundColor = '#249f87'; };
            controlsDiv.appendChild(resetButton);
            const lossDiv = document.createElement('div');
            lossDiv.style.fontSize = '15px';
            lossDiv.style.marginTop = '5px';
            lossDiv.style.textAlign = 'center';
            lossDiv.textContent = 'Loss streak: ';
            const lossSpan = document.createElement('span');
            lossSpan.innerText = '0';
            lossSpan.style.transition = 'transform 0.3s, color 0.3s';
            lossDiv.appendChild(lossSpan);
            counterContainer.appendChild(lossDiv);
            const volumeDiv = document.createElement('div');
            Object.assign(volumeDiv.style, {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '5px'
            });
            const volumeIcon = document.createElement('span');
            volumeIcon.textContent = '🔊';
            volumeIcon.style.marginRight = '5px';
            volumeIcon.style.fontSize = '16px';
            const volumeSlider = document.createElement('input');
            volumeSlider.type = 'range';
            volumeSlider.min = '0';
            volumeSlider.max = '100';
            volumeSlider.value = '100';
            volumeSlider.style.width = '80px';
            volumeSlider.style.accentColor = '#249f87';
            volumeDiv.appendChild(volumeIcon);
            volumeDiv.appendChild(volumeSlider);
            counterContainer.appendChild(volumeDiv);
            targetInput.addEventListener('change', () => {
                target = parseInt(targetInput.value) || 0;
                console.log(`Target updated to ${target}`);
            });
            resetButton.addEventListener('click', () => {
                counter = 0;
                lossCounter = 0;
                updateCounter();
                updateLoss();
                console.log('Counter manually reset to 0');
            });
            volumeSlider.addEventListener('input', () => {
                volume = parseInt(volumeSlider.value) / 100;
                if (volume === 0) {
                    volumeIcon.textContent = '🔇';
                } else if (volume < 0.33) {
                    volumeIcon.textContent = '🔈';
                } else if (volume < 0.66) {
                    volumeIcon.textContent = '🔉';
                } else {
                    volumeIcon.textContent = '🔊';
                }
            });
            function updateCounter() {
                counterSpan.innerText = `${counter}`;
            }
            function updateLoss() {
                lossSpan.innerText = `${lossCounter}`;
                lossSpan.style.color = lossCounter > 0 ? 'red' : 'inherit';
            }
            function animateSpan(span) {
                span.style.transform = 'scale(1.2)';
                setTimeout(() => { span.style.transform = 'scale(1)'; }, 300);
            }
            updateCounter();
            updateLoss();
            function playBeep() {
                if (volume === 0) return;
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                gainNode.gain.value = volume;
                oscillator.start();
                setTimeout(() => oscillator.stop(), 200);
            }
            function stopAutoplay() {
                const stopButton = document.querySelector('button[data-testid="auto-bet-button"][data-autobet-status="stop"]');
                if (stopButton && !stopButton.disabled) {
                    stopButton.click();
                    console.log('Autoplay stopped as counter reached target');
                } else {
                    console.log('Stop button not found or disabled');
                }
            }
            let prev3Success = false;
            let lastSeenBetId = null;
            function initCounter() {
                const container = document.querySelector('div[class*="condition-list-wrap"]');
                const pastBets = document.querySelector('.past-bets');
                if (!container || !pastBets) {
                    console.log('Container not found yet');
                    return false; // Not found yet
                }
                console.log('Container found');
                function checkButton3() {
                    const smallBlocks = container.querySelectorAll('div[class*="small-block"]');
                    let button3Div = null;
                    smallBlocks.forEach((div) => {
                        const button = div.querySelector('button');
                        if (button && button.innerText.trim() === '3') {
                            button3Div = div;
                        }
                    });
                    if (!button3Div) return;
                    const current3Success = button3Div.classList.contains('success');
                    if (current3Success && !prev3Success) {
                        counter = 0;
                        updateCounter();
                        console.log('Button 3 success detected, counter reset to 0');
                    }
                    prev3Success = current3Success;
                }
                const betObserver = new MutationObserver(() => {
                    const newest = pastBets.querySelector('button[data-last-bet-index="0"]');
                    if (!newest) return;
                    const betId = newest.getAttribute('data-past-bet-id');
                    if (betId === lastSeenBetId) return;
                    lastSeenBetId = betId;
                    const isWin = newest.classList.contains('variant-positive');
                    if (isWin) {
                        counter++;
                        updateCounter();
                        animateSpan(counterSpan);
                        playBeep();
                        lossCounter = 0;
                        updateLoss();
                        if (counter >= target) {
                            stopAutoplay();
                        }
                    } else {
                        lossCounter++;
                        updateLoss();
                        animateSpan(lossSpan);
                    }
                });
                betObserver.observe(pastBets, { childList: true, subtree: true });
                const observer = new MutationObserver(() => {
                    checkButton3();
                });
                observer.observe(container, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
                checkButton3();
                return true;
            }
            if (!initCounter()) {
                const pollInterval = setInterval(() => {
                    if (initCounter()) {
                        clearInterval(pollInterval);
                    }
                }, 100);
            }
            gui.prepend(counterContainer);
            gui.appendChild(title);
            document.body.appendChild(gui);
            const actions = [
                { text: 'Export Balance', fn: exportBalance },
                { text: 'Update Existing', fn: updateExistingStrategy },
                { text: 'Import New Strategy', fn: importNewStrategy }
            ];
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.textContent = action.text;
                Object.assign(btn.style, {
                    width: '100%',
                    margin: '4px 0',
                    padding: '8px',
                    background: '#249f87',
                    border: 'none',
                    borderRadius: '6px',
                    color: 'white',
                    fontWeight: 'bold',
                    fontSize: '13.5px',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                });
                btn.onmouseover = () => { btn.style.background = '#30d4b3'; };
                btn.onmouseout = () => { btn.style.background = '#249f87'; };
                btn.onclick = action.fn;
                gui.appendChild(btn);
            });
        })();
    }
})();