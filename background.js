// ============================================================
// Autonion — Background Service Worker (Central Orchestrator)
// ============================================================

importScripts('utils/schema.js');

// ── State ────────────────────────────────────────────────────
let ws = null;
let wsConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
const BASE_RECONNECT_DELAY = 2000;
const PING_INTERVAL = 20000;
let pingTimer = null;
let currentExecution = null; // tracks running execution
let killSwitchActive = false;

// ── Trigger Rules State ──────────────────────────────────────
let registeredRules = [];     // Rules from Android via Flutter
// Map: ruleId -> { active: bool, lastTriggered: timestamp }
let triggeredRulesState = {};
const RULE_COOLDOWN_MS = 30000; // 30 seconds cooldown after leaving a matched site

// Configurable desktop agent endpoint
const DEFAULT_WS_URL = 'ws://localhost:4545/automation';

// ── URL Category Map ─────────────────────────────────────────
const URL_CATEGORIES = {
    meeting: [
        'meet.google.com', 'zoom.us', 'zoom.com', 'teams.microsoft.com',
        'teams.live.com', 'webex.com', 'gotomeeting.com',
        'whereby.com', 'discord.com',
    ],
    social: [
        'youtube.com', 'instagram.com', 'twitter.com', 'x.com',
        'facebook.com', 'reddit.com', 'tiktok.com', 'linkedin.com',
    ],
    productivity: [
        'gmail.com', 'mail.google.com', 'drive.google.com',
        'docs.google.com', 'sheets.google.com', 'slides.google.com',
        'notion.so', 'trello.com', 'slack.com',
    ],
    ai: [
        'chatgpt.com', 'chat.openai.com', 'gemini.google.com',
        'claude.ai', 'copilot.microsoft.com', 'poe.com',
    ],
};

function categorizeUrl(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        for (const [category, domains] of Object.entries(URL_CATEGORIES)) {
            if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
                return category;
            }
        }
    } catch (_) { }
    return 'other';
}


// ══════════════════════════════════════════════════════════════
// 1. WebSocket Client — connects to Flutter Desktop Agent
// ══════════════════════════════════════════════════════════════

async function getWsUrl() {
    const result = await chrome.storage.local.get('wsUrl');
    return result.wsUrl || DEFAULT_WS_URL;
}

async function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const url = await getWsUrl();
    console.log(`[Autonion] Connecting to ${url}...`);
    broadcastToPopup({ type: 'status', status: 'connecting', url });

    try {
        ws = new WebSocket(url);

        ws.onopen = () => {
            wsConnected = true;
            reconnectAttempts = 0;
            console.log('[Autonion] Connected to Desktop Agent');
            broadcastToPopup({ type: 'status', status: 'connected', url });
            addLog('Connected to Desktop Agent');
            startPingLoop();
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleDesktopMessage(data);
            } catch (e) {
                console.error('[Autonion] Failed to parse message:', e);
            }
        };

        ws.onclose = () => {
            wsConnected = false;
            ws = null;
            stopPingLoop();
            console.log('[Autonion] Disconnected');
            broadcastToPopup({ type: 'status', status: 'disconnected' });
            addLog('Disconnected from Desktop Agent');
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[Autonion] WebSocket error:', err);
            ws?.close();
        };

    } catch (e) {
        console.error('[Autonion] Connection failed:', e);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        addLog('Max reconnect attempts reached. Use popup to retry.');
        return;
    }
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), 30000);
    reconnectAttempts++;
    console.log(`[Autonion] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    // Use chrome.alarms for MV3 persistence
    chrome.alarms.create('reconnect', { delayInMinutes: delay / 60000 });
}

function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', source: 'extension' }));
        }
    }, PING_INTERVAL);
}

function stopPingLoop() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

function sendToDesktop(message) {
    if (ws?.readyState === WebSocket.OPEN) {
        const payload = typeof message === 'string' ? message : JSON.stringify(message);
        ws.send(payload);
        return true;
    }
    addLog('Cannot send: not connected to Desktop Agent');
    return false;
}


// ══════════════════════════════════════════════════════════════
// 2. URL Monitor — watches tab changes for trigger categorization
// ══════════════════════════════════════════════════════════════

let lastReportedUrl = '';

function handleUrlChange(tabId, url) {
    if (!url || url === lastReportedUrl || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
    lastReportedUrl = url;

    const category = categorizeUrl(url);
    console.log(`[Autonion] URL change: ${url} → ${category}`);

    const trigger = {
        type: 'url_trigger',
        source: 'extension',
        payload: {
            url: url,
            domain: new URL(url).hostname,
            category: category,
            timestamp: new Date().toISOString(),
        },
    };

    sendToDesktop(trigger);
    broadcastToPopup({ type: 'url_trigger', ...trigger.payload });
    addLog(`URL trigger: ${new URL(url).hostname} → ${category}`);

    // Check registered rules against this URL
    checkRulesAgainstUrl(url, category);
}

// Listen for tab URL updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        handleUrlChange(tabId, changeInfo.url);
    }
});

// Listen for active tab switches
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url) handleUrlChange(activeInfo.tabId, tab.url);
    } catch (_) { }
});


// ══════════════════════════════════════════════════════════════
// 2b. Trigger Rules — match URLs against Android-registered rules
// ══════════════════════════════════════════════════════════════

function handleRegisterTriggers(payload) {
    const rules = payload.rules;
    if (!Array.isArray(rules)) {
        addLog('register_triggers: invalid or missing rules array');
        return;
    }

    registeredRules = rules;
    // Reset debounce state for new rule set
    triggeredRulesState = {};
    addLog(`Registered ${rules.length} trigger rule(s):`);
    rules.forEach(r => {
        addLog(`  Rule ${r.id}: ${r.criteria?.type} = ${r.criteria?.value}`);
    });
}

/**
 * Check all registered rules against the current URL.
 * Smart debounce:
 * - Don't re-trigger while user is still on a matching site (active = true)
 * - Mark inactive when URL no longer matches
 * - Only re-trigger if user returns after 30s cooldown
 */
function checkRulesAgainstUrl(url, category) {
    if (registeredRules.length === 0) return;

    const now = Date.now();
    const matchedRuleIds = new Set();

    for (const rule of registeredRules) {
        const { id, criteria } = rule;
        if (!id || !criteria) continue;

        let matches = false;

        if (criteria.type === 'category') {
            matches = category === criteria.value;
        } else if (criteria.type === 'url_contains') {
            matches = url.toLowerCase().includes(criteria.value.toLowerCase());
        }

        if (matches) {
            matchedRuleIds.add(id);
            const state = triggeredRulesState[id];

            if (!state) {
                // First time match — trigger!
                triggeredRulesState[id] = { active: true, lastTriggered: now };
                fireRuleTrigger(id);
            } else if (state.active) {
                // Still on the same matching site — skip (don't re-trigger)
            } else {
                // Returning to the site — check cooldown
                if (now - state.lastTriggered >= RULE_COOLDOWN_MS) {
                    state.active = true;
                    state.lastTriggered = now;
                    fireRuleTrigger(id);
                } else {
                    // Within cooldown — skip
                    addLog(`Rule ${id}: within cooldown, skipping`);
                }
            }
        }
    }

    // Mark rules that are NO LONGER matching as inactive
    for (const ruleId of Object.keys(triggeredRulesState)) {
        if (!matchedRuleIds.has(ruleId) && triggeredRulesState[ruleId].active) {
            triggeredRulesState[ruleId].active = false;
            addLog(`Rule ${ruleId}: user left matching site, marked inactive`);
        }
    }
}

function fireRuleTrigger(ruleId) {
    addLog(`Rule triggered: ${ruleId} — sending to desktop`);
    sendToDesktop({
        type: 'rule_triggered',
        source: 'extension',
        payload: { rule_id: ruleId },
        timestamp: Date.now(),
    });
}

// ══════════════════════════════════════════════════════════════
// 3. Message Handlers — from Desktop Agent and Popup
// ══════════════════════════════════════════════════════════════

function handleDesktopMessage(data) {
    const type = data.type;
    console.log(`[Autonion] Desktop message: ${type}`);

    switch (type) {
        case 'connection_ack':
            addLog(`Agent acknowledged: ${data.agent || 'unknown'}`);
            break;

        case 'pong':
            // Heartbeat response, no action needed
            break;

        case 'execute_prompt':
            // Android sent a natural language prompt to plan and execute
            handlePromptExecution(data.payload || data);
            break;

        case 'register_triggers':
            handleRegisterTriggers(data.payload || data);
            break;

        case 'kill_switch':
            handleKillSwitch();
            break;

        default:
            addLog(`Unknown desktop message type: ${type}`);
    }
}

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'get_status':
            sendResponse({ connected: wsConnected, killSwitch: killSwitchActive });
            break;

        case 'connect':
            connectWebSocket();
            sendResponse({ ok: true });
            break;

        case 'disconnect':
            ws?.close();
            sendResponse({ ok: true });
            break;

        case 'execute_prompt':
            handlePromptExecution(message.payload);
            sendResponse({ ok: true });
            break;

        case 'kill_switch':
            handleKillSwitch();
            sendResponse({ ok: true });
            break;

        case 'get_logs':
            chrome.storage.local.get('logs', (result) => {
                sendResponse({ logs: result.logs || [] });
            });
            return true; // async response

        case 'chatbot_response':
            // Content script sent back the chatbot's raw response
            handleChatbotResponse(message.response, message.transactionId);
            sendResponse({ ok: true });
            break;

        case 'update_settings':
            chrome.storage.local.set(message.settings);
            sendResponse({ ok: true });
            break;

        default:
            sendResponse({ error: 'Unknown message type' });
    }
    return false;
});


// ══════════════════════════════════════════════════════════════
// 4. Prompt Execution Pipeline
// ══════════════════════════════════════════════════════════════

// De-duplication set for transaction IDs
const processedTxIds = new Set();

async function handlePromptExecution(payload) {
    if (killSwitchActive) {
        addLog('BLOCKED: Kill switch is active. Reset before executing.');
        return;
    }

    const userPrompt = payload?.prompt || payload?.text || '';
    if (!userPrompt) {
        addLog('No prompt provided in execute_prompt');
        return;
    }

    // Generate or use existing transactionId
    const transactionId = payload?.transaction_id || payload?.transactionId || crypto.randomUUID();

    if (processedTxIds.has(transactionId)) {
        addLog(`Ignoring duplicate transaction: ${transactionId}`);
        return;
    }
    processedTxIds.add(transactionId);
    if (processedTxIds.size > 50) processedTxIds.delete(processedTxIds.values().next().value);

    addLog(`Prompt received [${transactionId.slice(0, 8)}]: "${userPrompt.slice(0, 60)}..."`);
    broadcastToPopup({ type: 'execution_start', transactionId, prompt: userPrompt });

    // Report to desktop
    sendToDesktop({
        type: 'execution_status',
        source: 'extension',
        transaction_id: transactionId,
        status: 'planning',
        message: 'Sending prompt to AI chatbot for planning...',
    });

    // Get selected AI platform
    const settings = await chrome.storage.local.get(['aiPlatform']);
    const platform = settings.aiPlatform || 'chatgpt';

    // Build the augmented prompt for the AI chatbot
    const augmentedPrompt = buildAugmentedPrompt(userPrompt);
    addLog(`Using AI platform: ${platform}`);

    // Inject prompt into the selected chatbot
    try {
        await injectPromptIntoChatbot(platform, augmentedPrompt, transactionId);
    } catch (e) {
        addLog(`Error injecting prompt: ${e.message}`);
        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'error',
            message: `Failed to inject prompt into ${platform}: ${e.message}`,
        });
    }
}

function buildAugmentedPrompt(userPrompt) {
    return `${userPrompt}

IMPORTANT INSTRUCTION: From the above prompt, generate a JSON execution plan ONLY. Do not include any explanation, markdown, or additional text outside the JSON. Use this exact schema:

{
  "transaction_id": "auto-generated",
  "steps": [
    {
      "action": "ACTION_NAME",
      "params": { "key": "value" },
      "safety_check": "pending"
    }
  ]
}

Available actions:
- "open_url" with params: { "url": "https://..." }
- "click_element" with params: { "target": "Button Text or Label", "type": "text|role|label|selector", "index": 0 }
  - Use "index" (0-based) to click the Nth matching element. Example: first search result = index 0
- "type_into" with params: { "target": "Input label or placeholder", "text": "text to type", "type": "label|placeholder|selector", "pressEnter": true/false }
- "press_key" with params: { "key": "Enter|Tab|Escape|ArrowDown|ArrowUp|Space|Backspace", "target": "optional element label" }
- "wait" with params: { "ms": 1000 }
- "scroll_to" with params: { "target": "element text", "type": "text" }
- "select_option" with params: { "target": "dropdown label or visible text", "value": "option text to select" }
  - Works for both native <select> elements AND custom dropdowns (clicks trigger, then clicks option)

RULES:
- Maximum 10 steps
- Only generate browser-level actions (opening URLs, clicking, typing)
- Always start with "open_url" if a new site needs to be opened
- Use descriptive visible text for element targets, not CSS selectors
- IMPORTANT: When typing into a search bar, ALWAYS set "pressEnter": true to submit the search
- Use "press_key" with "Enter" to submit forms or confirm actions after typing
- For "select first result" or "click Nth item", use click_element with "index": 0 (for first), 1 (for second), etc.
- For sorting/filtering dropdowns, use select_option — it handles both native and custom dropdowns
- When clicking search results or listed items (e.g. videos, products, links), prefer "type": "text" and set "target" to a partial text you expect in the item title. For YouTube videos after a search, use "type": "label" with "target" set to the search term, or use "type": "selector" with "target": "#video-title" and "index": 0
- NEVER use vague targets like "video title" or "result" — always use something that matches real visible text, aria-label, or a known CSS selector
- Output ONLY the JSON, nothing else`;
}

async function injectPromptIntoChatbot(platform, prompt, transactionId) {
    let targetUrl, matchPattern;

    switch (platform) {
        case 'chatgpt':
            // Use temporary-chat=true to force a fresh, history-free session
            targetUrl = 'https://chatgpt.com/?temporary-chat=true';
            matchPattern = /chatgpt\.com|chat\.openai\.com/;
            break;
        case 'gemini':
            targetUrl = 'https://gemini.google.com/app';
            matchPattern = /gemini\.google\.com/;
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }

    // Find existing chatbot tab
    const tabs = await chrome.tabs.query({});
    let chatTab = tabs.find(t => t.url && matchPattern.test(t.url));

    try {
        if (chatTab) {
            addLog(`Reusing existing ${platform} tab (ID: ${chatTab.id})...`);

            // Bring to front first
            await chrome.tabs.update(chatTab.id, { active: true });
            await chrome.windows.update(chatTab.windowId, { focused: true });

            // Navigate or Reload
            // usage of includes matches if we are already on the temporary-chat URL
            if (chatTab.url.includes('temporary-chat=true') || chatTab.url === targetUrl) {
                addLog('Reloading tab for fresh context...');
                await chrome.tabs.reload(chatTab.id);
            } else {
                addLog(`Navigating to ${targetUrl}...`);
                await chrome.tabs.update(chatTab.id, { url: targetUrl });
            }

            await waitForTabLoad(chatTab.id, 15000);
            await sleep(3000);
        } else {
            // Case: No existing tab found
            throw new Error('No existing tab'); // Trigger fallback
        }
    } catch (err) {
        // Fallback: Create new tab
        addLog(`Opening new ${platform} tab (Reuse failed: ${err.message})...`);
        chatTab = await chrome.tabs.create({ url: targetUrl, active: true });
        await chrome.windows.update(chatTab.windowId, { focused: true });
        await waitForTabLoad(chatTab.id, 15000);
        await sleep(3000);
    }

    addLog(`Injecting prompt into ${platform}...`);

    // Send the prompt to the content script
    try {
        await chrome.tabs.sendMessage(chatTab.id, {
            type: 'INJECT_PROMPT',
            prompt: prompt,
            transactionId: transactionId,
        });
    } catch (e) {
        // Content script may not be loaded yet, try programmatic injection
        addLog(`Content script not ready, injecting programmatically...`);
        const scriptFile = platform === 'chatgpt' ? 'content_scripts/chatgpt.js' : 'content_scripts/gemini.js';
        await chrome.scripting.executeScript({
            target: { tabId: chatTab.id },
            files: [scriptFile],
        });
        await sleep(1000);
        await chrome.tabs.sendMessage(chatTab.id, {
            type: 'INJECT_PROMPT',
            prompt: prompt,
            transactionId: transactionId,
        });
    }
}


// ══════════════════════════════════════════════════════════════
// 5. Chatbot Response Handling & Execution
// ══════════════════════════════════════════════════════════════

async function handleChatbotResponse(responseText, transactionId) {
    addLog(`Chatbot response received [${transactionId?.slice(0, 8)}]`);
    broadcastToPopup({ type: 'chatbot_raw', response: responseText?.slice(0, 200) });

    // Extract JSON from the response
    const parsed = AutonionSchema.extractJSON(responseText);
    if (!parsed) {
        addLog('ERROR: Could not extract JSON from chatbot response');
        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'error',
            message: 'Failed to parse JSON from AI response',
        });
        broadcastToPopup({ type: 'execution_error', error: 'Failed to parse JSON from AI response' });
        return;
    }

    // Validate against schema
    parsed.transaction_id = transactionId || parsed.transaction_id;
    const validation = AutonionSchema.validatePlan(parsed);
    if (!validation.valid) {
        const errorMsg = `Validation errors: ${validation.errors.join('; ')}`;
        addLog(`ERROR: ${errorMsg}`);
        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'error',
            message: errorMsg,
        });
        broadcastToPopup({ type: 'execution_error', error: errorMsg });
        return;
    }

    // Run safety checks
    const safetyResult = AutonionSchema.runSafetyCheck(validation.plan);
    if (!safetyResult.safe) {
        const violationMsg = `Safety violations: ${safetyResult.violations.join('; ')}`;
        addLog(`BLOCKED: ${violationMsg}`);
        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'blocked',
            message: violationMsg,
        });
        broadcastToPopup({ type: 'execution_blocked', violations: safetyResult.violations });
        return;
    }

    addLog(`Plan validated: ${safetyResult.plan.steps.length} steps`);
    broadcastToPopup({ type: 'plan_validated', plan: safetyResult.plan });

    // Separate browser vs desktop actions
    const browserActions = ['open_url', 'click_element', 'type_into', 'press_key', 'wait', 'scroll_to', 'select_option', 'read_text', 'go_back', 'go_forward', 'refresh', 'close_tab'];
    const browserSteps = safetyResult.plan.steps.filter(s => browserActions.includes(s.action));
    const desktopSteps = safetyResult.plan.steps.filter(s => !browserActions.includes(s.action));

    if (desktopSteps.length > 0) {
        addLog(`Sending ${desktopSteps.length} desktop-level steps to agent`);
        sendToDesktop({
            type: 'execute_desktop_actions',
            source: 'extension',
            transaction_id: transactionId,
            steps: desktopSteps,
        });
    }

    if (browserSteps.length > 0) {
        addLog(`Executing ${browserSteps.length} browser-level steps...`);
        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'executing',
            message: `Executing ${browserSteps.length} browser actions...`,
        });
        await executeBrowserPlan(transactionId, browserSteps);
    }
}


// ══════════════════════════════════════════════════════════════
// 6. Browser Action Executor
// ══════════════════════════════════════════════════════════════

async function executeBrowserPlan(transactionId, steps) {
    currentExecution = { transactionId, steps, currentStep: 0 };
    let activeTabId = null;

    for (let i = 0; i < steps.length; i++) {
        if (killSwitchActive) {
            addLog('Execution halted by kill switch');
            sendToDesktop({
                type: 'execution_status',
                source: 'extension',
                transaction_id: transactionId,
                status: 'killed',
                message: `Execution stopped at step ${i + 1}/${steps.length}`,
            });
            broadcastToPopup({ type: 'execution_killed', step: i });
            currentExecution = null;
            return;
        }

        const step = steps[i];
        currentExecution.currentStep = i;
        const stepLabel = `Step ${i + 1}/${steps.length}: ${step.action}`;
        addLog(stepLabel);
        broadcastToPopup({ type: 'step_executing', step: i, total: steps.length, action: step.action, params: step.params });

        sendToDesktop({
            type: 'execution_status',
            source: 'extension',
            transaction_id: transactionId,
            status: 'step',
            step: i + 1,
            total: steps.length,
            action: step.action,
            message: stepLabel,
        });

        try {
            switch (step.action) {
                case 'open_url': {
                    const url = step.params?.url;
                    if (!url) throw new Error('Missing url param');
                    const tab = await chrome.tabs.create({ url, active: true });
                    activeTabId = tab.id;
                    await waitForTabLoad(activeTabId, 15000);
                    await sleep(1500); // Let page stabilize
                    break;
                }

                case 'click_element': {
                    if (!activeTabId) activeTabId = await getActiveTabId();
                    const clickIndex = step.params.index ?? 0; // default first match
                    const result = await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: executeDOMClick,
                        args: [step.params.target, step.params.type || 'text', clickIndex],
                    });
                    if (result[0]?.result?.error) throw new Error(result[0].result.error);
                    await sleep(1000);
                    // If a new page was navigated to, update activeTabId and wait for load
                    try {
                        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (activeTab) activeTabId = activeTab.id;
                        await sleep(1500);
                    } catch (_) { }
                    break;
                }

                case 'type_into': {
                    if (!activeTabId) activeTabId = await getActiveTabId();
                    // Pass pressEnter so Enter key is dispatched in the SAME execution context
                    const shouldEnter = !!step.params.pressEnter;
                    const result = await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: executeDOMType,
                        args: [step.params.target, step.params.text, step.params.type || 'label', shouldEnter],
                    });
                    if (result[0]?.result?.error) throw new Error(result[0].result.error);
                    addLog(`Type result: tag=${result[0]?.result?.tag}, isSearchField=${result[0]?.result?.isSearchField}, enterPressed=${result[0]?.result?.enterPressed}`);

                    // If Enter was pressed (or auto-detected), wait longer for navigation
                    if (result[0]?.result?.enterPressed) {
                        addLog('Enter was pressed — waiting for page load...');
                        await sleep(2000);
                    } else {
                        await sleep(500);
                    }
                    break;
                }

                case 'press_key': {
                    if (!activeTabId) activeTabId = await getActiveTabId();
                    const key = step.params?.key || 'Enter';
                    const keyTarget = step.params?.target || null;
                    const keyType = step.params?.type || 'label';
                    addLog(`Pressing key: ${key}`);
                    await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: executeDOMPressKey,
                        args: [key, keyTarget, keyType],
                    });
                    await sleep(1500);
                    break;
                }

                case 'wait': {
                    const ms = step.params?.ms || 1000;
                    await sleep(Math.min(ms, 10000)); // Cap at 10s
                    break;
                }

                case 'scroll_to': {
                    if (!activeTabId) activeTabId = await getActiveTabId();
                    await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: executeDOMScroll,
                        args: [step.params.target, step.params.type || 'text'],
                    });
                    await sleep(500);
                    break;
                }

                case 'select_option': {
                    if (!activeTabId) activeTabId = await getActiveTabId();
                    // executeDOMSelect may return a Promise (for custom dropdowns),
                    // so we wrap it in an async IIFE for chrome.scripting to await
                    const selResult = await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: async (t, v) => {
                            // --- inlined executeDOMSelect logic ---
                            const lowerTarget = t.toLowerCase().trim();
                            const lowerValue = v.toLowerCase().trim();

                            // Strategy 1: Native <select>
                            const select = document.querySelector(`select[name*="${t}" i]`) ||
                                document.querySelector(`select[aria-label*="${t}" i]`) ||
                                document.querySelector(`select[id*="${lowerTarget.replace(/\s+/g, '')}" i]`);

                            if (select) {
                                const options = [...select.options];
                                const matched = options.find(o => o.textContent.toLowerCase().trim().includes(lowerValue)) ||
                                    options.find(o => o.value.toLowerCase().includes(lowerValue));
                                if (matched) {
                                    const ns = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
                                    if (ns) ns.call(select, matched.value); else select.value = matched.value;
                                    select.dispatchEvent(new Event('change', { bubbles: true }));
                                    select.dispatchEvent(new Event('input', { bubbles: true }));
                                    return { success: true, strategy: 'native_select', selected: matched.textContent.trim() };
                                }
                            }

                            // Strategy 2: Custom dropdown (click trigger → wait → click option)
                            let trigger = null;

                            // Search for dropdown trigger
                            const triggerSelectors = [
                                `[aria-label*="${t}" i]`,
                                `[data-action*="sort" i]`,
                            ];
                            for (const sel of triggerSelectors) {
                                try {
                                    const els = document.querySelectorAll(sel);
                                    for (const el of els) {
                                        if (el.textContent.toLowerCase().includes(lowerTarget) && el.offsetParent !== null) {
                                            trigger = el; break;
                                        }
                                    }
                                } catch (_) { }
                                if (trigger) break;
                            }

                            // Broader text search
                            if (!trigger) {
                                const clickables = document.querySelectorAll('button, a, [role="button"], [role="listbox"], [role="combobox"], [aria-haspopup], span[tabindex], div[tabindex], [class*="dropdown" i], [class*="sort" i], [class*="select" i]');
                                for (const el of clickables) {
                                    const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
                                    if (text.includes(lowerTarget) && el.offsetParent !== null) { trigger = el; break; }
                                }
                            }

                            // XPath last resort
                            if (!trigger) {
                                const xpath = `//*[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerTarget}')]`;
                                const xr = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
                                let n;
                                while ((n = xr.iterateNext())) {
                                    if (n.offsetParent !== null) {
                                        const c = n.closest('button, a, [role="button"], [aria-haspopup], [tabindex]');
                                        trigger = c || n; break;
                                    }
                                }
                            }

                            if (!trigger) return { error: `Dropdown trigger not found: "${t}"` };

                            trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            trigger.click();

                            // Wait for dropdown to open
                            await new Promise(r => setTimeout(r, 1000));

                            // Find and click the option
                            const optSelectors = [
                                '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
                                'li', '.a-dropdown-item', '.dropdown-item',
                                'a', 'button', 'div[data-value]', 'span',
                            ];
                            let optionEl = null;
                            for (const sel of optSelectors) {
                                const candidates = document.querySelectorAll(sel);
                                for (const c of candidates) {
                                    const text = c.textContent?.toLowerCase().trim() || '';
                                    if (text.includes(lowerValue) && c.offsetParent !== null) { optionEl = c; break; }
                                }
                                if (optionEl) break;
                            }
                            // XPath fallback
                            if (!optionEl) {
                                const xpath = `//*[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerValue}')]`;
                                const xr = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
                                let n;
                                while ((n = xr.iterateNext())) {
                                    if (n.offsetParent !== null && n !== trigger) { optionEl = n; break; }
                                }
                            }
                            if (!optionEl) return { error: `Option "${v}" not found in dropdown "${t}"` };

                            optionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            optionEl.click();
                            return { success: true, strategy: 'custom_dropdown', option: optionEl.textContent?.trim().slice(0, 50) };
                        },
                        args: [step.params.target, step.params.value],
                    });
                    if (selResult[0]?.result?.error) throw new Error(selResult[0].result.error);
                    addLog(`Selected: ${selResult[0]?.result?.option || selResult[0]?.result?.selected || step.params.value}`);
                    // Wait for page to potentially reload after selection
                    await sleep(3000);
                    // Update tab ref in case page reloaded
                    try {
                        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (activeTab) activeTabId = activeTab.id;
                    } catch (_) { }
                    break;
                }

                case 'go_back':
                    if (activeTabId) await chrome.tabs.goBack(activeTabId);
                    await sleep(1500);
                    break;

                case 'go_forward':
                    if (activeTabId) await chrome.tabs.goForward(activeTabId);
                    await sleep(1500);
                    break;

                case 'refresh':
                    if (activeTabId) await chrome.tabs.reload(activeTabId);
                    await waitForTabLoad(activeTabId, 10000);
                    break;

                case 'close_tab':
                    if (activeTabId) {
                        await chrome.tabs.remove(activeTabId);
                        activeTabId = null;
                    }
                    break;

                default:
                    addLog(`Unknown action: ${step.action}, skipping`);
            }

            broadcastToPopup({ type: 'step_complete', step: i, success: true });

        } catch (e) {
            addLog(`Step ${i + 1} failed: ${e.message}`);
            broadcastToPopup({ type: 'step_complete', step: i, success: false, error: e.message });
            // Continue to next step on non-fatal errors
        }
    }

    // Execution complete — send confirmation
    const resultMsg = `All ${steps.length} steps executed successfully`;
    addLog(resultMsg);
    sendToDesktop({
        type: 'execution_result',
        source: 'extension',
        transaction_id: transactionId,
        status: 'completed',
        message: resultMsg,
        steps_executed: steps.length,
    });
    broadcastToPopup({ type: 'execution_complete', transactionId });
    currentExecution = null;
}


// ── DOM Execution Functions (injected into pages) ────────────

function executeDOMClick(target, type, index) {
    const lowerTarget = target.toLowerCase().trim();
    const matchIndex = index || 0;
    let matches = [];

    if (type === 'text') {
        // XPath text search — collect ALL matches
        const xpath = `//*[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerTarget.replace(/'/g, "\\'")}')]`;
        const result = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        let node;
        while ((node = result.iterateNext())) {
            if (node.offsetParent !== null) matches.push(node);
        }
        // Sort by depth (deepest = most specific)
        matches.sort((a, b) => {
            let dA = 0, pA = a; while (pA.parentElement) { dA++; pA = pA.parentElement; }
            let dB = 0, pB = b; while (pB.parentElement) { dB++; pB = pB.parentElement; }
            return dB - dA;
        });
    } else if (type === 'role') {
        matches = [...document.querySelectorAll(`[role="${target}"]`)].filter(el => el.offsetParent !== null);
    } else if (type === 'label') {
        matches = [...document.querySelectorAll(`[aria-label*="${target}" i], [title*="${target}" i]`)].filter(el => el.offsetParent !== null);
    } else if (type === 'selector') {
        try { matches = [...document.querySelectorAll(target)].filter(el => el.offsetParent !== null); } catch (_) { }
    }

    if (matches.length === 0) {
        // Fallback 1: match by element id (e.g. "video title" -> id="video-title")
        const idTarget = lowerTarget.replace(/\s+/g, '-');
        const idMatches = [...document.querySelectorAll(`[id*="${idTarget}" i]`)].filter(el => el.offsetParent !== null);
        if (idMatches.length > 0) {
            matches = idMatches;
        }
    }

    if (matches.length === 0) {
        // Fallback 2: broader clickable element search by text/label
        const allEls = document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick], [data-action]');
        for (const candidate of allEls) {
            const text = (candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').toLowerCase().trim();
            if (text.includes(lowerTarget) && candidate.offsetParent !== null) {
                matches.push(candidate);
            }
        }
    }

    if (matches.length === 0) return { error: `Element not found: "${target}" (type: ${type})` };

    // Use the Nth match (clamped to range)
    const el = matches[Math.min(matchIndex, matches.length - 1)];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.click();
    return { success: true, tag: el.tagName, text: el.textContent?.slice(0, 50), matchCount: matches.length, usedIndex: Math.min(matchIndex, matches.length - 1) };
}

function executeDOMType(target, text, type, pressEnter) {
    const lowerTarget = target.toLowerCase().trim();
    let el = null;

    // Helper to find input with various selectors
    const findInput = (selector) => {
        try {
            return document.querySelector(selector);
        } catch (_) { return null; }
    };

    if (type === 'label' || type === 'placeholder') {
        // Priority: exact label/placeholder match -> fuzzy match
        el = findInput(`input[aria-label*="${target}" i]`) ||
            findInput(`input[placeholder*="${target}" i]`) ||
            findInput(`input[name*="${target}" i]`) ||
            findInput(`input[id*="${lowerTarget.replace(/\s+/g, '')}" i]`) || // ID check
            findInput(`textarea[aria-label*="${target}" i]`) ||
            findInput(`textarea[placeholder*="${target}" i]`) ||
            findInput(`[contenteditable][aria-label*="${target}" i]`);

        if (!el) {
            // Check <label> tags
            const labels = document.querySelectorAll('label');
            for (const label of labels) {
                if (label.textContent.toLowerCase().includes(lowerTarget)) {
                    const forId = label.getAttribute('for');
                    if (forId) { el = document.getElementById(forId); break; }
                    el = label.querySelector('input, textarea');
                    if (el) break;
                }
            }
        }
    } else if (type === 'selector') {
        el = findInput(target);
    }

    if (!el) {
        // Broad search fallback: check attributes of all inputs
        const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]');
        for (const input of inputs) {
            const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
            const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
            const name = (input.getAttribute('name') || '').toLowerCase();
            const id = (input.id || '').toLowerCase();

            if (placeholder.includes(lowerTarget) || ariaLabel.includes(lowerTarget) || name.includes(lowerTarget) || id.includes(lowerTarget)) {
                el = input;
                break;
            }
        }
    }

    if (!el) return { error: `Input "${target}" not found` };

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    if (el.getAttribute('contenteditable') === 'true') {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        // Use native setter to trigger React/Angular/Vue change detection
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(el, text);
        } else {
            el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Auto-detect if this is a search field
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();
    const elId = (el.id || '').toLowerCase();
    const isSearchField = inputType === 'search' ||
        role === 'searchbox' || role === 'combobox' ||
        ariaLabel.includes('search') ||
        name.includes('search') || name.includes('query') || name === 'q' ||
        elId.includes('search') || elId === 'q' ||
        el.closest('form[role="search"]') !== null;

    // Press Enter INLINE (same context, element still focused)
    let enterPressed = false;
    if (pressEnter || isSearchField) {
        enterPressed = true;

        // Small delay to let input events settle
        // (YouTube's autocomplete needs a moment)

        // Dispatch full keyboard event sequence for Enter
        const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
        });
        const prevented = !el.dispatchEvent(enterDown);

        if (!prevented) {
            el.dispatchEvent(new KeyboardEvent('keypress', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
            }));
        }

        el.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true,
        }));

        // Fallback: submit the form directly
        const form = el.closest('form');
        if (form) {
            try { form.requestSubmit(); } catch (_) { form.submit(); }
        }
    }

    return { success: true, tag: el.tagName, isSearchField, enterPressed };
}

function executeDOMPressKey(key, target, type) {
    // Key map MUST be inside this function — it runs in page context via chrome.scripting.executeScript,
    // so module-level variables from background.js are NOT accessible.
    const KEY_MAP = {
        'Enter': { code: 'Enter', keyCode: 13 },
        'Tab': { code: 'Tab', keyCode: 9 },
        'Escape': { code: 'Escape', keyCode: 27 },
        'Backspace': { code: 'Backspace', keyCode: 8 },
        'Space': { code: 'Space', keyCode: 32, key: ' ' },
        'ArrowUp': { code: 'ArrowUp', keyCode: 38 },
        'ArrowDown': { code: 'ArrowDown', keyCode: 40 },
        'ArrowLeft': { code: 'ArrowLeft', keyCode: 37 },
        'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
        'Delete': { code: 'Delete', keyCode: 46 },
        'Home': { code: 'Home', keyCode: 36 },
        'End': { code: 'End', keyCode: 35 },
        'PageUp': { code: 'PageUp', keyCode: 33 },
        'PageDown': { code: 'PageDown', keyCode: 34 },
    };

    // Find the target element or fallback to active element
    let el = document.activeElement;

    if (target) {
        const found = document.querySelector(`[aria-label*="${target}" i]`) ||
            document.querySelector(`[placeholder*="${target}" i]`) ||
            document.querySelector(`[name*="${target}" i]`) ||
            document.querySelector(`[id*="${target}" i]`) ||
            document.querySelector(`input[type="search"]`) ||
            document.querySelector(`textarea`);
        if (found) el = found;
    }

    if (!el || el === document.body) {
        el = document.querySelector('input:focus, textarea:focus, [contenteditable]:focus') ||
            document.querySelector('input:not([type="hidden"]), textarea') ||
            document.body;
    }

    const keyInfo = KEY_MAP[key] || { code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };
    const keyValue = keyInfo.key || key;

    // Dispatch full keyboard event sequence
    const downEvent = new KeyboardEvent('keydown', {
        key: keyValue, code: keyInfo.code, keyCode: keyInfo.keyCode,
        which: keyInfo.keyCode, bubbles: true, cancelable: true,
    });
    const prevented = !el.dispatchEvent(downEvent);

    if (!prevented) {
        el.dispatchEvent(new KeyboardEvent('keypress', {
            key: keyValue, code: keyInfo.code, keyCode: keyInfo.keyCode,
            which: keyInfo.keyCode, bubbles: true, cancelable: true,
        }));
    }

    el.dispatchEvent(new KeyboardEvent('keyup', {
        key: keyValue, code: keyInfo.code, keyCode: keyInfo.keyCode,
        which: keyInfo.keyCode, bubbles: true,
    }));

    // For Enter: also try form submission as fallback
    if (key === 'Enter') {
        const form = el.closest('form');
        if (form) {
            // Use requestSubmit for proper validation, fallback to submit
            try { form.requestSubmit(); } catch (_) { form.submit(); }
        }
    }

    return { success: true, key, element: el.tagName };
}

function executeDOMScroll(target, type) {
    if (type === 'text') {
        const xpath = `//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${target.toLowerCase()}')]`;
        const result = document.evaluate(xpath, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) {
            result.singleNodeValue.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return { success: true };
        }
    }
    return { error: `Scroll target not found: "${target}"` };
}

function executeDOMSelect(target, value) {
    const lowerTarget = target.toLowerCase().trim();
    const lowerValue = value.toLowerCase().trim();

    // ── Strategy 1: Native <select> element ──
    const select = document.querySelector(`select[name*="${target}" i]`) ||
        document.querySelector(`select[aria-label*="${target}" i]`) ||
        document.querySelector(`select[id*="${lowerTarget.replace(/\s+/g, '')}" i]`);

    if (select) {
        // Find matching option by text (case-insensitive partial match)
        const options = [...select.options];
        const matchedOption = options.find(o => o.textContent.toLowerCase().trim().includes(lowerValue)) ||
            options.find(o => o.value.toLowerCase().includes(lowerValue));

        if (matchedOption) {
            // Use native setter for React/framework compatibility
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(select, matchedOption.value);
            } else {
                select.value = matchedOption.value;
            }
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true, strategy: 'native_select', selected: matchedOption.textContent.trim() };
        }
    }

    // ── Strategy 2: Custom dropdown (click trigger, then click option) ──
    // Find the dropdown trigger button/element by its label text
    let trigger = null;

    // Look for common dropdown patterns
    const dropdownSelectors = [
        // Amazon-style: span/button with "Sort by" text
        `[aria-label*="${target}" i]`,
        `[data-action*="sort" i]`,
        `button:has(span)`, // handled below with text check
    ];

    for (const sel of dropdownSelectors) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el.textContent.toLowerCase().includes(lowerTarget) && el.offsetParent !== null) {
                    trigger = el;
                    break;
                }
            }
        } catch (_) { }
        if (trigger) break;
    }

    // Text-based search for the trigger
    if (!trigger) {
        const allClickables = document.querySelectorAll('button, a, [role="button"], [role="listbox"], [role="combobox"], [aria-haspopup], span[tabindex], div[tabindex], [class*="dropdown" i], [class*="sort" i], [class*="select" i]');
        for (const el of allClickables) {
            const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
            if (text.includes(lowerTarget) && el.offsetParent !== null) {
                trigger = el;
                break;
            }
        }
    }

    // Even broader: any element containing the target text
    if (!trigger) {
        const xpath = `//*[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerTarget}')]`;
        const xResult = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        let node;
        while ((node = xResult.iterateNext())) {
            if (node.offsetParent !== null) {
                // Prefer clickable elements
                const clickable = node.closest('button, a, [role="button"], [aria-haspopup], [tabindex]');
                trigger = clickable || node;
                break;
            }
        }
    }

    if (!trigger) return { error: `Dropdown trigger not found: "${target}"` };

    // Click the trigger to open the dropdown
    trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    trigger.click();

    // Wait for dropdown to open, then find and click the option
    return new Promise((resolve) => {
        setTimeout(() => {
            // Look for the option text in newly visible elements
            // Check for listbox, menu, popover, dropdown-menu patterns
            const optionSelectors = [
                '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
                'li', '.a-dropdown-item', '.dropdown-item',
                'a', 'button', 'div[data-value]', 'span',
            ];

            let optionEl = null;

            for (const sel of optionSelectors) {
                const candidates = document.querySelectorAll(sel);
                for (const c of candidates) {
                    const text = c.textContent?.toLowerCase().trim() || '';
                    if (text.includes(lowerValue) && c.offsetParent !== null) {
                        optionEl = c;
                        break;
                    }
                }
                if (optionEl) break;
            }

            // XPath fallback for option text
            if (!optionEl) {
                const xpath = `//*[contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerValue}')]`;
                const xResult = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
                let node;
                while ((node = xResult.iterateNext())) {
                    if (node.offsetParent !== null && node !== trigger) {
                        optionEl = node;
                        break;
                    }
                }
            }

            if (!optionEl) {
                resolve({ error: `Option "${value}" not found in dropdown "${target}"` });
                return;
            }

            optionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            optionEl.click();

            resolve({
                success: true,
                strategy: 'custom_dropdown',
                trigger: trigger.tagName,
                option: optionEl.textContent?.trim().slice(0, 50),
            });
        }, 800); // Wait 800ms for dropdown animation
    });
}


// ══════════════════════════════════════════════════════════════
// 7. Kill Switch
// ══════════════════════════════════════════════════════════════

function handleKillSwitch() {
    killSwitchActive = true;
    addLog('🛑 KILL SWITCH ACTIVATED — all executions halted');
    broadcastToPopup({ type: 'kill_switch', active: true });
    sendToDesktop({
        type: 'kill_switch_ack',
        source: 'extension',
        message: 'Kill switch activated on extension',
    });
}


// ══════════════════════════════════════════════════════════════
// 8. Utility Functions
// ══════════════════════════════════════════════════════════════

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
    return new Promise(async (resolve) => {
        // Check current status first
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.status === 'complete') {
                resolve();
                return;
            }
        } catch (_) { }

        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(); // Resolve even on timeout to keep flow moving
        }, timeoutMs);

        function listener(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

// Logging to storage (persisted for popup)
async function addLog(message) {
    const masked = AutonionSchema.maskPII(message);
    const entry = `[${new Date().toLocaleTimeString()}] ${masked}`;
    console.log(`[Autonion] ${masked}`);

    // Remote logging (direct send to avoid recursion loop with sendToDesktop default logging)
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'log',
                source: 'extension',
                message: masked,
                timestamp: new Date().toISOString()
            }));
        }
    } catch (_) { }

    try {
        const result = await chrome.storage.local.get('logs');
        const logs = result.logs || [];
        logs.push(entry);
        // Keep last 100 entries
        if (logs.length > 100) logs.splice(0, logs.length - 100);
        await chrome.storage.local.set({ logs });
    } catch (_) { }

    broadcastToPopup({ type: 'log', message: entry });
}

// Broadcast to popup (may not be open)
function broadcastToPopup(message) {
    try {
        chrome.runtime.sendMessage(message).catch(() => { });
    } catch (_) { }
}


// ══════════════════════════════════════════════════════════════
// 9. Lifecycle & Alarms
// ══════════════════════════════════════════════════════════════

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'reconnect') {
        connectWebSocket();
    }
});

// Auto-connect on startup
connectWebSocket();
