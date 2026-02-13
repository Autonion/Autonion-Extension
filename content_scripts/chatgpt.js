// ============================================================
// Autonion — ChatGPT Content Script Adapter
// Injected into chatgpt.com / chat.openai.com
// ============================================================

(function () {
    if (window.__autonion_chatgpt_loaded) return;
    window.__autonion_chatgpt_loaded = true;

    console.log('[Autonion] ChatGPT content script loaded');

    let pendingTransactionId = null;
    let isWaitingForResponse = false;

    // ── Message Listener ───────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'INJECT_PROMPT') {
            console.log('[Autonion] Received INJECT_PROMPT');
            pendingTransactionId = message.transactionId;
            injectPrompt(message.prompt);
            sendResponse({ ok: true });
        }
        return false;
    });

    // ── Inject Prompt Into ChatGPT ─────────────────────────────
    async function injectPrompt(prompt) {
        try {
            // Find the prompt textarea / contenteditable area
            const textarea = await waitForElement(
                // ChatGPT uses a contenteditable div with id="prompt-textarea" or similar
                () => {
                    return document.querySelector('#prompt-textarea') ||
                        document.querySelector('textarea[data-id="root"]') ||
                        document.querySelector('div[contenteditable="true"][data-placeholder]') ||
                        document.querySelector('textarea') ||
                        document.querySelector('[contenteditable="true"]');
                },
                10000,
                'ChatGPT input area'
            );

            if (!textarea) {
                reportError('Could not find ChatGPT input area');
                return;
            }

            // Focus and type the prompt
            textarea.focus();
            await sleep(200);

            if (textarea.tagName === 'TEXTAREA') {
                // Standard textarea
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeSetter.call(textarea, prompt);
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // Contenteditable div (modern ChatGPT uses <p> tags inside)
                textarea.innerHTML = '';
                const p = document.createElement('p');
                p.textContent = prompt;
                textarea.appendChild(p);
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }

            await sleep(500);

            // Find and click the send button
            const sendBtn = findSendButton();
            if (sendBtn) {
                sendBtn.click();
                console.log('[Autonion] Prompt sent to ChatGPT');
                isWaitingForResponse = true;
                await waitForResponse();
            } else {
                // Try pressing Enter as fallback
                textarea.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
                }));
                console.log('[Autonion] Sent via Enter key');
                isWaitingForResponse = true;
                await waitForResponse();
            }

        } catch (e) {
            console.error('[Autonion] Error injecting prompt:', e);
            reportError(e.message);
        }
    }

    // ── Find the Send Button ───────────────────────────────────
    function findSendButton() {
        // Try multiple selectors for different ChatGPT versions
        const selectors = [
            'button[data-testid="send-button"]',
            'button[aria-label="Send prompt"]',
            'button[aria-label="Send"]',
            'form button[type="submit"]',
        ];

        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) return btn;
        }

        // Fallback: find send icon button (SVG with path resembling arrow)
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.querySelector('svg') && !btn.disabled) {
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (ariaLabel.includes('send')) return btn;
            }
        }

        // Last resort: the last enabled button near the textarea
        const form = document.querySelector('form');
        if (form) {
            const formBtns = form.querySelectorAll('button:not([disabled])');
            if (formBtns.length > 0) return formBtns[formBtns.length - 1];
        }

        return null;
    }

    // ── Wait for ChatGPT Response ──────────────────────────────
    async function waitForResponse() {
        console.log('[Autonion] Waiting for ChatGPT response...');

        // Wait for the streaming response to appear and complete
        // ChatGPT shows a "stop generating" button while streaming
        const maxWait = 120000; // 2 minutes max
        const pollInterval = 1500;
        let elapsed = 0;

        // First, wait for the response to start appearing
        await sleep(3000);

        while (elapsed < maxWait) {
            // Check if ChatGPT is still generating (look for stop button or streaming indicator)
            const isStreaming = isStillStreaming();

            if (!isStreaming && elapsed > 5000) {
                // Response finished, extract it
                await sleep(1000); // Small buffer after streaming stops
                const responseText = extractResponse();
                if (responseText) {
                    console.log('[Autonion] Response extracted:', responseText.slice(0, 100));
                    sendResponseToBackground(responseText);
                    isWaitingForResponse = false;
                    return;
                }
            }

            await sleep(pollInterval);
            elapsed += pollInterval;
        }

        reportError('Timed out waiting for ChatGPT response');
        isWaitingForResponse = false;
    }

    // ── Check if ChatGPT is still streaming ────────────────────
    function isStillStreaming() {
        // Look for the "Stop generating" button
        const stopBtn = document.querySelector('button[aria-label="Stop generating"]') ||
            document.querySelector('button[aria-label="Stop streaming"]');
        if (stopBtn) return true;

        // Check for streaming animation classes
        const resultIndicator = document.querySelector('.result-streaming');
        if (resultIndicator) return true;

        // Check for the typing animation cursor
        const typingCursor = document.querySelector('.typing-cursor, .blinking-cursor');
        if (typingCursor) return true;

        return false;
    }

    // ── Extract the Latest Response ────────────────────────────
    function extractResponse() {
        // ChatGPT renders responses in message containers
        // Find the last assistant message
        const messageContainers = document.querySelectorAll(
            '[data-message-author-role="assistant"], .markdown.prose, .message-content'
        );

        if (messageContainers.length === 0) {
            // Fallback: get last message group
            const groups = document.querySelectorAll('[data-testid^="conversation-turn-"]');
            if (groups.length > 0) {
                const last = groups[groups.length - 1];
                const markdown = last.querySelector('.markdown, .prose');
                if (markdown) return markdown.textContent?.trim();
                return last.textContent?.trim();
            }
            return null;
        }

        // Get the last one
        const lastMsg = messageContainers[messageContainers.length - 1];

        // Try to get code block content first (JSON is likely in a code block)
        const codeBlocks = lastMsg.querySelectorAll('pre code, code');
        for (const code of codeBlocks) {
            const text = code.textContent?.trim();
            if (text && text.startsWith('{')) return text;
        }

        // Fallback to full text content
        return lastMsg.textContent?.trim();
    }

    // ── Send Response Back to Background ───────────────────────
    function sendResponseToBackground(responseText) {
        chrome.runtime.sendMessage({
            type: 'chatbot_response',
            response: responseText,
            transactionId: pendingTransactionId,
            platform: 'chatgpt',
        });
    }

    // ── Error Reporting ────────────────────────────────────────
    function reportError(error) {
        chrome.runtime.sendMessage({
            type: 'chatbot_response',
            response: null,
            error: error,
            transactionId: pendingTransactionId,
            platform: 'chatgpt',
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
