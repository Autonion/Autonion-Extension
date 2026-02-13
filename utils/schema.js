// ============================================================
// Autonion — Shared JSON Schema & Safety Validation
// ============================================================

/**
 * Validates a plan against the shared Autonion schema.
 * Expected format:
 * {
 *   "transaction_id": "uuid-string",
 *   "steps": [
 *     { "action": "open_url", "params": { ... }, "safety_check": "passed" }
 *   ]
 * }
 */

const ALLOWED_ACTIONS = [
  'open_url',
  'click_element',
  'type_into',
  'press_key',
  'wait',
  'scroll_to',
  'select_option',
  'read_text',
  'go_back',
  'go_forward',
  'refresh',
  'close_tab',
];

const DESTRUCTIVE_KEYWORDS = [
  'delete', 'remove', 'reset', 'format', 'purchase',
  'buy', 'unsubscribe', 'deactivate', 'terminate',
  'cancel subscription', 'erase',
];

const MAX_STEPS = 10;

/**
 * Validates that a plan object conforms to the shared schema.
 * @param {object} plan - The parsed JSON plan
 * @returns {{ valid: boolean, errors: string[], plan: object|null }}
 */
function validatePlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan is not a valid object'], plan: null };
  }

  // Accept both "steps" and "actions" keys for flexibility
  const steps = plan.steps || plan.actions;
  if (!Array.isArray(steps)) {
    return { valid: false, errors: ['Plan must contain a "steps" array'], plan: null };
  }

  // Normalize to "steps"
  plan.steps = steps;

  // Generate transaction_id if missing
  if (!plan.transaction_id) {
    plan.transaction_id = crypto.randomUUID ? crypto.randomUUID() : `txn-${Date.now()}`;
  }

  // Enforce step limit
  if (steps.length > MAX_STEPS) {
    errors.push(`Plan has ${steps.length} steps, maximum allowed is ${MAX_STEPS}`);
    return { valid: false, errors, plan: null };
  }

  if (steps.length === 0) {
    errors.push('Plan has no steps');
    return { valid: false, errors, plan: null };
  }

  // Validate each step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.action) {
      errors.push(`Step ${i + 1}: missing "action" field`);
      continue;
    }
    if (!ALLOWED_ACTIONS.includes(step.action)) {
      errors.push(`Step ${i + 1}: unknown action "${step.action}"`);
    }
    if (!step.params || typeof step.params !== 'object') {
      errors.push(`Step ${i + 1}: missing or invalid "params" object`);
    }
  }

  return { valid: errors.length === 0, errors, plan: errors.length === 0 ? plan : null };
}

/**
 * Runs the safety layer on a validated plan.
 * @param {object} plan - A validated plan object
 * @returns {{ safe: boolean, violations: string[], plan: object }}
 */
function runSafetyCheck(plan) {
  const violations = [];
  const steps = plan.steps;

  // Collect allowed domains from open_url steps
  const allowedDomains = new Set();
  for (const step of steps) {
    if (step.action === 'open_url' && step.params?.url) {
      try {
        const url = new URL(step.params.url);
        allowedDomains.add(url.hostname);
      } catch (_) { /* invalid URL caught elsewhere */ }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const paramsStr = JSON.stringify(step.params || {}).toLowerCase();

    // Check destructive keywords
    for (const keyword of DESTRUCTIVE_KEYWORDS) {
      if (paramsStr.includes(keyword)) {
        violations.push(`Step ${i + 1}: contains destructive keyword "${keyword}" — BLOCKED`);
        step.safety_check = 'blocked';
      }
    }

    // Origin validation: non-navigation actions should target allowed domains
    // (This is enforced at execution time by the executor)

    if (!step.safety_check || step.safety_check !== 'blocked') {
      step.safety_check = 'passed';
    }
  }

  return {
    safe: violations.length === 0,
    violations,
    plan,
  };
}

/**
 * Masks PII patterns in a string for safe logging.
 * @param {string} text
 * @returns {string}
 */
function maskPII(text) {
  if (!text || typeof text !== 'string') return text;
  // Mask email addresses
  let masked = text.replace(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_MASKED]');
  // Mask phone numbers (basic patterns)
  masked = masked.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE_MASKED]');
  // Mask credit card numbers (basic 16-digit patterns)
  masked = masked.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CC_MASKED]');
  // Mask passwords in JSON-like contexts
  masked = masked.replace(/"password"\s*:\s*"[^"]*"/gi, '"password": "[MASKED]"');
  return masked;
}

/**
 * Extract JSON from a chatbot response string.
 * Handles markdown code fences and raw JSON.
 * @param {string} responseText
 * @returns {object|null}
 */
function extractJSON(responseText) {
  if (!responseText) return null;

  // Try to find JSON in ```json ... ``` blocks
  const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) { /* fallback below */ }
  }

  // Try to find raw JSON object
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) { /* failed */ }
  }

  return null;
}

// Export for use in background.js (ES module)
// In content scripts, these are injected via chrome.scripting so we attach to globalThis
if (typeof globalThis !== 'undefined') {
  globalThis.AutonionSchema = {
    validatePlan,
    runSafetyCheck,
    maskPII,
    extractJSON,
    ALLOWED_ACTIONS,
    MAX_STEPS,
  };
}
