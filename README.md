# Autonion Extension

Cross-device AI-powered browser automation — plan with AI, execute in the DOM.

## Overview
Autonion Extension is a browser extension that enables seamless cross-device browser automation powered by AI. It connects with local LLM servers and the Autonion ecosystem to provide reliable web automation, integrating with language models to plan and execute operations directly in the browser's Document Object Model (DOM).

## Features
- **AI-Powered Execution**: Interprets AI-generated plans to execute precise DOM interactions (clicks, text entry, navigation).
- **Cross-Device Integration**: Syncs seamlessly with the Autonion ecosystem (Desktop Agent and Android Companion).
- **ChatGPT & Gemini Support**: Includes dedicated content scripts to enhance interactions with OpenAI's ChatGPT and Google's Gemini.
- **Robust Automation Routing**: Differentiates browser operations from standard desktop automation tasks to ensure higher reliability and fault tolerance.

## Installation
1. Clone or download this repository.
2. Open your Chromium-based browser (Chrome, Edge, Brave, etc.) and navigate to `chrome://extensions/` (or equivalent).
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `Autonion-Extension` folder.

## Permissions
The extension requests the following permissions to function:
- `activeTab` & `tabs`: For observing and interacting with current browser tabs.
- `scripting`: For injecting content scripts to execute DOM manipulations.
- `debugger`: Required for advanced browser automation tasks.
- `storage`: For saving configuration and states.
- `alarms`: For scheduling background synchronization tasks.
