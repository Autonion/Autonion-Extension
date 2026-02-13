// ============================================================
// Autonion — DOM Action Helpers (Semantic Element Interaction)
// ============================================================

/**
 * Finds an element by its visible text content.
 * Uses TreeWalker for deep traversal including nested elements.
 * @param {string} text - The text to search for
 * @param {string} [tagFilter] - Optional tag name filter (e.g., 'button', 'a')
 * @returns {Element|null}
 */
function findElementByText(text, tagFilter) {
    const lowerText = text.toLowerCase().trim();

    // Strategy 1: Direct query via XPath (fastest for exact text)
    try {
        const xpath = `//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerText.replace(/'/g, "\\'")}')]`;
        const result = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        let node;
        const candidates = [];
        while ((node = result.iterateNext())) {
            if (tagFilter && node.tagName.toLowerCase() !== tagFilter.toLowerCase()) continue;
            if (node.offsetParent !== null || node.tagName === 'BODY') {
                candidates.push(node);
            }
        }
        // Prefer the most specific (deepest nested) match
        if (candidates.length > 0) {
            candidates.sort((a, b) => getDepth(b) - getDepth(a));
            return candidates[0];
        }
    } catch (_) { /* fallback below */ }

    // Strategy 2: TreeWalker for partial matches
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode(node) {
                const innerText = (node.innerText || node.textContent || '').toLowerCase().trim();
                if (innerText.includes(lowerText)) {
                    if (tagFilter && node.tagName.toLowerCase() !== tagFilter.toLowerCase()) {
                        return NodeFilter.FILTER_SKIP;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_SKIP;
            }
        }
    );

    const results = [];
    let current;
    while ((current = walker.nextNode())) {
        if (current.offsetParent !== null || current.tagName === 'BODY') {
            results.push(current);
        }
    }

    // Sort by depth (deepest first = most specific match)
    results.sort((a, b) => getDepth(b) - getDepth(a));
    return results[0] || null;
}

/**
 * Finds an element by ARIA role and accessible name.
 * @param {string} role - ARIA role (e.g., 'button', 'link', 'textbox')
 * @param {string} [name] - Accessible name (aria-label, title, or text content)
 * @returns {Element|null}
 */
function findElementByRole(role, name) {
    const elements = document.querySelectorAll(`[role="${role}"]`);
    if (!name) return elements[0] || null;

    const lowerName = name.toLowerCase();
    for (const el of elements) {
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const text = (el.textContent || '').toLowerCase().trim();
        if (ariaLabel.includes(lowerName) || title.includes(lowerName) || text.includes(lowerName)) {
            return el;
        }
    }

    // Also check native semantic elements that map to this role
    const roleToTag = {
        'button': 'button',
        'link': 'a',
        'textbox': 'input[type="text"], input:not([type]), textarea',
        'checkbox': 'input[type="checkbox"]',
        'radio': 'input[type="radio"]',
        'heading': 'h1, h2, h3, h4, h5, h6',
        'listbox': 'select',
        'option': 'option',
        'searchbox': 'input[type="search"]',
    };

    if (roleToTag[role]) {
        const nativeElements = document.querySelectorAll(roleToTag[role]);
        for (const el of nativeElements) {
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            const text = (el.textContent || '').toLowerCase().trim();
            if (ariaLabel.includes(lowerName) || placeholder.includes(lowerName) || text.includes(lowerName)) {
                return el;
            }
        }
    }

    return null;
}

/**
 * Finds an element by its associated label.
 * @param {string} label - The label text
 * @returns {Element|null}
 */
function findElementByLabel(label) {
    const lowerLabel = label.toLowerCase().trim();

    // Strategy 1: Find <label> element and use its `for` attribute
    const labels = document.querySelectorAll('label');
    for (const labelEl of labels) {
        if ((labelEl.textContent || '').toLowerCase().trim().includes(lowerLabel)) {
            const forId = labelEl.getAttribute('for');
            if (forId) {
                const target = document.getElementById(forId);
                if (target) return target;
            }
            // If no for attribute, check for nested input
            const nested = labelEl.querySelector('input, textarea, select');
            if (nested) return nested;
        }
    }

    // Strategy 2: aria-label
    const ariaElements = document.querySelectorAll(`[aria-label]`);
    for (const el of ariaElements) {
        if (el.getAttribute('aria-label').toLowerCase().includes(lowerLabel)) {
            return el;
        }
    }

    // Strategy 3: placeholder
    const placeholderElements = document.querySelectorAll('[placeholder]');
    for (const el of placeholderElements) {
        if (el.getAttribute('placeholder').toLowerCase().includes(lowerLabel)) {
            return el;
        }
    }

    return null;
}

/**
 * Finds an element by CSS selector.
 * @param {string} selector
 * @returns {Element|null}
 */
function findElementBySelector(selector) {
    try {
        return document.querySelector(selector);
    } catch (_) {
        return null;
    }
}

/**
 * Scrolls an element into view and clicks it.
 * @param {Element} element
 * @returns {Promise<boolean>}
 */
async function scrollIntoViewAndClick(element) {
    if (!element) return false;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);

    // Try native click
    element.click();
    return true;
}

/**
 * Simulates typing into an input element character by character.
 * @param {Element} element
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function simulateTyping(element, text) {
    if (!element) return false;

    element.focus();
    await sleep(100);

    // Clear existing value
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50);

    // Type character by character for natural simulation
    for (const char of text) {
        element.value += char;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        await sleep(30 + Math.random() * 20); // Natural typing speed
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/**
 * Gets the depth of an element in the DOM tree.
 * @param {Element} el
 * @returns {number}
 */
function getDepth(el) {
    let depth = 0;
    let node = el;
    while (node.parentElement) {
        depth++;
        node = node.parentElement;
    }
    return depth;
}

/**
 * Sleep utility.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Export
if (typeof globalThis !== 'undefined') {
    globalThis.AutonionDOM = {
        findElementByText,
        findElementByRole,
        findElementByLabel,
        findElementBySelector,
        scrollIntoViewAndClick,
        simulateTyping,
        sleep,
    };
}
