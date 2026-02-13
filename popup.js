// ============================================================
// Autonion — Popup Controller
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    // ── DOM References ───────────────────────────────────────
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const wsUrlInput = document.getElementById('wsUrl');
    const aiPlatformSelect = document.getElementById('aiPlatform');
    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const btnSaveSettings = document.getElementById('btnSaveSettings');
    const btnExecute = document.getElementById('btnExecute');
    const btnKillSwitch = document.getElementById('btnKillSwitch');
    const btnClearLogs = document.getElementById('btnClearLogs');
    const promptInput = document.getElementById('promptInput');
    const logContainer = document.getElementById('logContainer');
    const executionPanel = document.getElementById('executionPanel');
    const progressBar = document.getElementById('progressBar');
    const stepInfo = document.getElementById('stepInfo');
    const execBadge = document.getElementById('execBadge');

    // ── Load Settings ────────────────────────────────────────
    const settings = await chrome.storage.local.get(['wsUrl', 'aiPlatform']);
    wsUrlInput.value = settings.wsUrl || 'ws://localhost:4545/automation';
    aiPlatformSelect.value = settings.aiPlatform || 'chatgpt';

    // ── Load Logs ────────────────────────────────────────────
    const logResult = await chrome.storage.local.get('logs');
    const logs = logResult.logs || [];
    renderLogs(logs);

    // ── Get Initial Status ───────────────────────────────────
    chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
        if (response) {
            updateConnectionUI(response.connected ? 'connected' : 'disconnected');
            if (response.killSwitch) {
                btnKillSwitch.textContent = '🔄 Reset Kill Switch';
                btnKillSwitch.classList.add('active');
            }
        }
    });

    // ── Button Handlers ──────────────────────────────────────

    btnConnect.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'connect' });
        updateConnectionUI('connecting');
    });

    btnDisconnect.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'disconnect' });
        updateConnectionUI('disconnected');
    });

    btnSaveSettings.addEventListener('click', async () => {
        const newSettings = {
            wsUrl: wsUrlInput.value.trim(),
            aiPlatform: aiPlatformSelect.value,
        };
        await chrome.storage.local.set(newSettings);
        chrome.runtime.sendMessage({ type: 'update_settings', settings: newSettings });

        // Flash success feedback
        btnSaveSettings.textContent = '✅ Saved!';
        setTimeout(() => {
            btnSaveSettings.innerHTML = '<span class="btn-icon">💾</span> Save';
        }, 1500);
    });

    btnExecute.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) return;

        chrome.runtime.sendMessage({
            type: 'execute_prompt',
            payload: { prompt, source: 'manual' },
        });

        // Show execution panel
        executionPanel.style.display = 'block';
        execBadge.textContent = 'Planning...';
        stepInfo.textContent = 'Sending prompt to AI chatbot...';
        progressBar.style.width = '5%';

        // Visual feedback
        btnExecute.disabled = true;
        setTimeout(() => { btnExecute.disabled = false; }, 3000);
    });

    btnKillSwitch.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'kill_switch' });
        btnKillSwitch.innerHTML = '<span class="btn-icon">🔄</span> Reset Kill Switch';
        btnKillSwitch.classList.add('active');
        execBadge.textContent = 'KILLED';
        stepInfo.textContent = 'Execution halted by kill switch';
        progressBar.style.width = '0%';
    });

    btnClearLogs.addEventListener('click', async () => {
        await chrome.storage.local.set({ logs: [] });
        logContainer.innerHTML = '<div class="log-empty">No activity yet</div>';
    });

    // ── Listen for Real-Time Updates ─────────────────────────

    chrome.runtime.onMessage.addListener((message) => {
        switch (message.type) {
            case 'status':
                updateConnectionUI(message.status);
                break;

            case 'log':
                appendLog(message.message);
                break;

            case 'execution_start':
                executionPanel.style.display = 'block';
                execBadge.textContent = 'Planning';
                stepInfo.textContent = `Prompt: "${message.prompt?.slice(0, 50)}..."`;
                progressBar.style.width = '10%';
                break;

            case 'plan_validated':
                execBadge.textContent = 'Executing';
                stepInfo.textContent = `Plan validated: ${message.plan?.steps?.length || '?'} steps`;
                progressBar.style.width = '15%';
                break;

            case 'step_executing':
                const pct = 15 + ((message.step / message.total) * 80);
                progressBar.style.width = `${pct}%`;
                stepInfo.textContent = `Step ${message.step + 1}/${message.total}: ${message.action} — ${JSON.stringify(message.params || {}).slice(0, 60)}`;
                execBadge.textContent = `${message.step + 1}/${message.total}`;
                break;

            case 'step_complete':
                if (!message.success) {
                    appendLog(`❌ Step ${message.step + 1} failed: ${message.error}`, 'error');
                }
                break;

            case 'execution_complete':
                progressBar.style.width = '100%';
                execBadge.textContent = 'Done ✅';
                stepInfo.textContent = 'All steps completed successfully!';
                break;

            case 'execution_error':
            case 'execution_blocked':
                execBadge.textContent = 'Failed';
                stepInfo.textContent = message.error || message.violations?.join('; ') || 'Execution failed';
                progressBar.style.width = '0%';
                break;

            case 'execution_killed':
                execBadge.textContent = 'KILLED';
                stepInfo.textContent = `Stopped at step ${message.step + 1}`;
                progressBar.style.width = '0%';
                break;

            case 'url_trigger':
                appendLog(`🌐 URL: ${message.domain} → ${message.category}`);
                break;

            case 'kill_switch':
                if (message.active) {
                    btnKillSwitch.innerHTML = '<span class="btn-icon">🔄</span> Reset Kill Switch';
                }
                break;
        }
    });

    // ── Helper Functions ─────────────────────────────────────

    function updateConnectionUI(status) {
        statusDot.className = 'status-dot ' + status;
        btnConnect.disabled = status === 'connected';
        btnDisconnect.disabled = status !== 'connected';

        switch (status) {
            case 'connected':
                statusText.textContent = 'Connected';
                break;
            case 'disconnected':
                statusText.textContent = 'Disconnected';
                break;
            case 'connecting':
                statusText.textContent = 'Connecting...';
                break;
        }
    }

    function renderLogs(entries) {
        if (entries.length === 0) {
            logContainer.innerHTML = '<div class="log-empty">No activity yet</div>';
            return;
        }
        logContainer.innerHTML = '';
        // Show last 50
        const recent = entries.slice(-50);
        for (const entry of recent) {
            const div = document.createElement('div');
            div.className = 'log-entry' + getLogClass(entry);
            div.textContent = entry;
            logContainer.appendChild(div);
        }
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function appendLog(message, className) {
        const empty = logContainer.querySelector('.log-empty');
        if (empty) empty.remove();

        const div = document.createElement('div');
        div.className = 'log-entry' + (className ? ` ${className}` : getLogClass(message));
        div.textContent = message;
        logContainer.appendChild(div);

        // Keep max 50 visible
        while (logContainer.children.length > 50) {
            logContainer.removeChild(logContainer.firstChild);
        }
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function getLogClass(text) {
        if (text.includes('ERROR') || text.includes('BLOCKED') || text.includes('❌') || text.includes('failed')) return ' error';
        if (text.includes('Connected') || text.includes('✅') || text.includes('success') || text.includes('completed')) return ' success';
        if (text.includes('WARNING') || text.includes('⚠') || text.includes('Kill')) return ' warning';
        return '';
    }
});
