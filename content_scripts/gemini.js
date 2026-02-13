// ============================================================
// Autonion — Google Gemini Content Script Adapter
// Injected into gemini.google.com
// ============================================================

(function () {
    if (window.__autonion_gemini_loaded) return;
    window.__autonion_gemini_loaded = true;

    console.log('[Autonion] Gemini content script loaded');

    let pendingTransactionId = null;
    let isWaitingForResponse = false;

    // ── Message Listener ───────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'INJECT_PROMPT') {
            console.log('[Autonion] Received INJECT_PROMPT for Gemini');
            pendingTransactionId = message.transactionId;
            injectPrompt(message.prompt);
            sendResponse({ ok: true });
        }
        return false;
    });

    // ── Inject Prompt Into Gemini ──────────────────────────────
    async function injectPrompt(prompt) {
        try {
            // Gemini uses a rich text editor area
            const inputArea = await waitForElement(
                () => {
                    // Gemini's main input (contenteditable or textarea)
                    return document.querySelector('.ql-editor[contenteditable="true"]') ||
                        document.querySelector('div[contenteditable="true"][aria-label*="prompt" i]') ||
                        document.querySelector('div[contenteditable="true"][aria-label*="Enter" i]') ||
                        document.querySelector('rich-textarea [contenteditable="true"]') ||
                        document.querySelector('.text-input-field textarea') ||
                        document.querySelector('textarea[aria-label*="prompt" i]') ||
                        document.querySelector('[contenteditable="true"]');
                },
                10000,
                'Gemini input area'
            );

            if (!inputArea) {
                reportError('Could not find Gemini input area');
                return;
            }

            // Focus and clear existing text
            inputArea.focus();
            await sleep(200);

            if (inputArea.tagName === 'TEXTAREA') {
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeSetter.call(inputArea, prompt);
                inputArea.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // Contenteditable div
                inputArea.innerHTML = '';
                const p = document.createElement('p');
                p.textContent = prompt;
                inputArea.appendChild(p);
                inputArea.dispatchEvent(new Event('input', { bubbles: true }));

                // Also try setting via innerText for Quill editor
                if (inputArea.classList.contains('ql-editor')) {
                    inputArea.innerText = prompt;
                    inputArea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            await sleep(500);

            // Find and click the send button
            const sendBtn = findSendButton();
            if (sendBtn) {
                sendBtn.click();
                console.log('[Autonion] Prompt sent to Gemini');
                isWaitingForResponse = true;
                await waitForResponse();
            } else {
                // Fallback: press Enter
                inputArea.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
                }));
                console.log('[Autonion] Sent via Enter key (Gemini)');
                isWaitingForResponse = true;
                await waitForResponse();
            }

        } catch (e) {
            console.error('[Autonion] Error injecting prompt into Gemini:', e);
            reportError(e.message);
        }
    }

    // ── Find the Send Button ───────────────────────────────────
    function findSendButton() {
        const selectors = [
            'button[aria-label="Send message"]',
            'button[aria-label="Submit"]',
            'button[aria-label="Send"]',
            '.send-button',
            'button.send-button',
            'mat-icon-button[aria-label*="send" i]',
        ];

        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) return btn;
        }

        // Fallback: look for icon-button with send arrow
        const buttons = document.querySelectorAll('button, mat-icon-button');
        for (const btn of buttons) {
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (ariaLabel.includes('send') || ariaLabel.includes('submit')) {
                if (!btn.disabled) return btn;
            }
        }

        // Last fallback: find button with paper plane / send icon near the input
        const allBtns = document.querySelectorAll('button:not([disabled])');
        for (const btn of allBtns) {
            const svg = btn.querySelector('svg, mat-icon');
            if (svg) {
                const text = svg.textContent?.toLowerCase() || '';
                if (text.includes('send') || text.includes('arrow')) return btn;
            }
        }

        return null;
    }

    // ── Wait for Gemini Response ───────────────────────────────
    async function waitForResponse() {
        console.log('[Autonion] Waiting for Gemini response...');

        const maxWait = 120000; // 2 minutes
        const pollInterval = 1500;
        let elapsed = 0;

        // Wait for response to start
        await sleep(3000);

        while (elapsed < maxWait) {
            const isStreaming = isStillStreaming();

            if (!isStreaming && elapsed > 5000) {
                await sleep(1000);
                const responseText = extractResponse();
                if (responseText) {
                    console.log('[Autonion] Gemini response extracted:', responseText.slice(0, 100));
                    sendResponseToBackground(responseText);
                    isWaitingForResponse = false;
                    return;
                }
            }

            await sleep(pollInterval);
            elapsed += pollInterval;
        }

        reportError('Timed out waiting for Gemini response');
        isWaitingForResponse = false;
    }

    // ── Check if Gemini is Still Streaming ─────────────────────
    function isStillStreaming() {
        // Gemini shows a loading indicator while generating
        const loadingIndicators = document.querySelectorAll(
            '.loading-indicator, .response-streaming, [data-is-streaming="true"], .generating'
        );
        if (loadingIndicators.length > 0) return true;

        // Check for the stop button
        const stopBtn = document.querySelector(
            'button[aria-label="Stop"],' +
            'button[aria-label="Stop generating"],' +
            'button.stop-button'
        );
        if (stopBtn && stopBtn.offsetParent !== null) return true;

        // Check for thinking/loading animation
        const thinking = document.querySelector('.thinking-indicator, .loading-spinner');
        if (thinking && thinking.offsetParent !== null) return true;

        return false;
    }

    // ── Extract the Latest Response ────────────────────────────
    function extractResponse() {
        // Gemini renders responses in message-content containers
        const responseContainers = document.querySelectorAll(
            'model-response, .model-response-text, .response-container-content, message-content'
        );

        if (responseContainers.length === 0) {
            // Broader fallback
            const allMessages = document.querySelectorAll('.conversation-container > div, .chat-message');
            if (allMessages.length > 0) {
                const last = allMessages[allMessages.length - 1];
                return last.textContent?.trim();
            }
            return null;
        }

        // Get the last response
        const lastResponse = responseContainers[responseContainers.length - 1];

        // Look for code blocks first (JSON is likely there)
        const codeBlocks = lastResponse.querySelectorAll('pre code, code-block, .code-block code, code');
        for (const code of codeBlocks) {
            const text = code.textContent?.trim();
            if (text && text.startsWith('{')) return text;
        }

        // Try the markdown rendered content
        const markdown = lastResponse.querySelector('.markdown-main-panel, .markdown, .prose');
        if (markdown) return markdown.textContent?.trim();

        // Fallback to full text
        return lastResponse.textContent?.trim();
    }

    // ── Send Response Back to Background ───────────────────────
    function sendResponseToBackground(responseText) {
        chrome.runtime.sendMessage({
            type: 'chatbot_response',
            response: responseText,
            transactionId: pendingTransactionId,
            platform: 'gemini',
        });
    }

    // ── Error Reporting ────────────────────────────────────────
    function reportError(error) {
        chrome.runtime.sendMessage({
            type: 'chatbot_response',
            response: null,
            error: error,
            transactionId: pendingTransactionId,
            platform: 'gemini',
        });
    }

    // ── Utilities ──────────────────────────────────────────────
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function waitForElement(finder, timeoutMs, description) {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const el = finder();
                if (el) {
                    clearInterval(interval);
                    resolve(el);
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    console.warn(`[Autonion] Timeout waiting for: ${description}`);
                    resolve(null);
                }
            }, 300);
        });
    }
})();
