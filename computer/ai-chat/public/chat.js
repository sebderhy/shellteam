// --- Chat Module ---
// Protocol-driven message rendering. Each protocol message type maps to one rendering action.
window.Chat = {
    // Streaming state
    currentAssistantEl: null,
    currentTextEl: null,
    streamingText: '',
    // Tool block tracking: tool_use_id -> DOM element
    toolBlocks: new Map(),
    // Subagent tracking: parent_tool_use_id -> { el, steps }
    subagentBlocks: new Map(),

    clearMessages() {
        App.el.messages.innerHTML = '';
        this.currentAssistantEl = null;
        this.currentTextEl = null;
        this.streamingText = '';
        this.toolBlocks.clear();
        this.subagentBlocks.clear();
    },

    resetChatState() {
        this.clearMessages();
        App.state.totalCost = 0;
        setGenerating(false);
        setStatus('idle', 'Idle');
        if (typeof updateEmptyState === 'function') updateEmptyState();
    },

    // =============================================================
    // Protocol message handler — the single entry point
    // =============================================================

    handle(msg, isReplay) {
        switch (msg.type) {
            case 'text_delta':
                this._handleTextDelta(msg);
                break;
            case 'text_done':
                this._handleTextDone(msg);
                break;
            case 'tool_start':
                this._handleToolStart(msg);
                break;
            case 'tool_input':
                this._handleToolInput(msg);
                break;
            case 'tool_result':
                this._handleToolResult(msg);
                break;
            case 'ask_user':
                this._handleAskUser(msg, isReplay);
                break;
            case 'plan_start':
                PlanMode.enter();
                break;
            case 'plan_done':
                PlanMode.renderCard(this.currentAssistantEl, msg.plan);
                break;
            case 'subagent_progress':
                this._handleSubagentProgress(msg);
                break;
            case 'subagent_done':
                this._handleSubagentDone(msg);
                break;
            case 'turn_done':
                this._handleTurnDone(msg);
                break;
            case 'error':
                this.addSystemMessage(msg.message, true);
                break;
            case 'user_message':
                // Injected turns (task notifications, delegated tasks, command
                // echoes) are tagged internal by the server — render them as a
                // collapsed system note, never as the user's own bubble (SHE-65).
                if (msg.internal) this.addInternalMessage(msg.content);
                else this.addUserMessage(msg.content);
                break;
            case 'session_event':
                this._handleSessionEvent(msg);
                break;
            case 'streaming_catchup':
                this._handleStreamingCatchup(msg);
                break;
        }
    },

    // =============================================================
    // History Replay — reuse the same handle() method
    // =============================================================

    replayHistory(messages) {
        App.state.isReplayingHistory = true;
        this.clearMessages();

        let hasContent = false;
        for (const msg of messages) {
            this.handle(msg, true);
            if (msg.type !== 'session_event') hasContent = true;
        }

        if (hasContent && isAuthed()) showChat();
        App.state.isReplayingHistory = false;
        scrollToBottom(true);
    },

    // =============================================================
    // Protocol handlers
    // =============================================================

    _handleTextDelta(msg) {
        if (!App.state.isReplayingHistory) setGenerating(true);
        this.streamingText += msg.text;
        this.ensureAssistantEl();
        this.ensureTextEl();
        this.currentTextEl.innerHTML = marked.parse(this.streamingText);
        scrollToBottom();
    },

    _handleTextDone(msg) {
        this.ensureAssistantEl();
        // If we were streaming, finalize; otherwise create a new content block
        if (this.currentTextEl && this.streamingText) {
            this.currentTextEl.innerHTML = marked.parse(msg.text || this.streamingText);
        } else {
            const div = document.createElement('div');
            div.className = 'content';
            div.innerHTML = marked.parse(msg.text || '');
            this.currentAssistantEl.appendChild(div);
        }
        this.currentTextEl = null;
        this.streamingText = '';
        // Surface any report links: wire them to the panel + auto-open the newest
        // (but not while replaying history — that would pop the panel on load).
        if (typeof ReportPanel !== 'undefined') {
            ReportPanel.scanMessage(this.currentAssistantEl, { autoOpen: !App.state.isReplayingHistory });
        } else {
            console.warn('[chat] ReportPanel missing — stale cached bundle? Report links will open in a new tab.');
        }
        scrollToBottom();
    },

    _handleToolStart(msg) {
        if (!App.state.isReplayingHistory) setGenerating(true);
        // Finalize any streaming text first
        this._finalizeText();
        this.ensureAssistantEl();

        const block = document.createElement('div');
        block.className = 'tool-block';
        block.dataset.toolId = msg.id;

        const header = document.createElement('div');
        header.className = 'tool-header';
        // Expand/collapse is handled by a delegated listener on #messages
        // (see app.js) — a per-element .onclick here would be silently dropped
        // when a tab switch restores the message DOM via innerHTML.
        header.innerHTML = `
            <span class="tool-chevron">&#9654;</span>
            <span class="tool-name">${escHtml(msg.name)}</span>
            <span class="tool-preview" data-tool-preview></span>
            <span class="tool-spinner"></span>
        `;

        const detail = document.createElement('div');
        detail.className = 'tool-detail';
        const inputDiv = document.createElement('div');
        inputDiv.className = 'tool-input';
        detail.appendChild(inputDiv);

        block.appendChild(header);
        block.appendChild(detail);
        this.currentAssistantEl.appendChild(block);
        this.toolBlocks.set(msg.id, block);

        // Track Task/Agent blocks for subagent progress
        if (msg.name === 'Task' || msg.name === 'Agent') {
            this.subagentBlocks.set(msg.id, { el: block, steps: 0 });
        }

        scrollToBottom();
    },

    _handleToolInput(msg) {
        const block = this.toolBlocks.get(msg.id);
        if (!block) return;

        const input = msg.input || {};
        const name = block.querySelector('.tool-name')?.textContent || '';

        const preview = this._getToolPreview(name, input);
        const previewEl = block.querySelector('[data-tool-preview]');
        if (previewEl) previewEl.textContent = preview;

        const inputEl = block.querySelector('.tool-input');
        if (inputEl) inputEl.textContent = this._formatToolInput(name, input);
    },

    _handleToolResult(msg) {
        let toolEl = this.toolBlocks.get(msg.id);
        if (!toolEl) toolEl = App.el.messages.querySelector(`.tool-block[data-tool-id="${msg.id}"]`);
        if (!toolEl) return;

        // Remove spinner
        const spinner = toolEl.querySelector('.tool-spinner');
        if (spinner) spinner.remove();

        const detail = toolEl.querySelector('.tool-detail');
        if (!detail) return;

        let outputText = '';
        const imageBlocks = [];
        if (typeof msg.content === 'string') {
            outputText = msg.content;
        } else if (Array.isArray(msg.content)) {
            outputText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            for (const b of msg.content) {
                if (b.type === 'image' && b.source?.type === 'base64') {
                    imageBlocks.push(b);
                }
            }
        }
        if (outputText) {
            const outputEl = document.createElement('div');
            outputEl.className = 'tool-output' + (msg.is_error ? ' error' : '');
            outputEl.textContent = truncate(outputText, 2000);
            detail.appendChild(outputEl);
        }
        if (imageBlocks.length > 0) {
            const parent = toolEl.parentElement;
            for (const img of imageBlocks) {
                const wrapper = document.createElement('div');
                wrapper.className = 'content';
                const imgEl = document.createElement('img');
                imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
                wrapper.appendChild(imgEl);
                if (parent) parent.insertBefore(wrapper, toolEl.nextSibling);
            }
        }
        scrollToBottom();
    },

    _handleAskUser(msg, isReplay) {
        this.ensureAssistantEl();
        const questions = msg.questions || [];
        if (questions.length === 0) return;

        // De-duplicate: remove unanswered ask-user blocks
        const allExisting = App.el.messages.querySelectorAll('.ask-user-block');
        for (const el of allExisting) {
            const hasDisabled = el.querySelector('.ask-user-option[disabled]');
            if (!hasDisabled) el.remove();
        }

        const container = document.createElement('div');
        container.className = 'ask-user-block';
        container.dataset.toolId = msg.id;

        for (let qi = 0; qi < questions.length; qi++) {
            const q = questions[qi];
            if (q.header) {
                const headerEl = document.createElement('div');
                headerEl.className = 'ask-user-header';
                headerEl.textContent = q.header;
                container.appendChild(headerEl);
            }
            const questionEl = document.createElement('div');
            questionEl.className = 'ask-user-question';
            questionEl.textContent = q.question;
            container.appendChild(questionEl);

            const optionsEl = document.createElement('div');
            optionsEl.className = 'ask-user-options';
            const selectedLabels = [];

            for (const opt of (q.options || [])) {
                const btn = document.createElement('button');
                btn.className = 'ask-user-option';
                btn.textContent = opt.label;
                if (opt.description) btn.title = opt.description;

                if (isReplay) {
                    btn.disabled = true;
                } else if (q.multiSelect) {
                    btn.onclick = () => {
                        btn.classList.toggle('selected');
                        const idx = selectedLabels.indexOf(opt.label);
                        if (idx >= 0) selectedLabels.splice(idx, 1);
                        else selectedLabels.push(opt.label);
                        const submitBtn = container.querySelector('.ask-user-submit');
                        if (submitBtn) submitBtn.style.display = selectedLabels.length > 0 ? 'inline-block' : 'none';
                    };
                } else {
                    btn.onclick = () => {
                        for (const b of optionsEl.querySelectorAll('.ask-user-option')) b.disabled = true;
                        btn.classList.add('selected');
                        sendAskUserResponse(opt.label);
                    };
                }
                optionsEl.appendChild(btn);
            }
            container.appendChild(optionsEl);

            if (q.multiSelect && !isReplay) {
                const submitBtn = document.createElement('button');
                submitBtn.className = 'ask-user-submit';
                submitBtn.textContent = 'Submit';
                submitBtn.onclick = () => {
                    if (selectedLabels.length === 0) return;
                    for (const b of optionsEl.querySelectorAll('.ask-user-option')) b.disabled = true;
                    submitBtn.disabled = true;
                    submitBtn.style.opacity = '0.5';
                    sendAskUserResponse(selectedLabels.join(', '));
                };
                container.appendChild(submitBtn);
            }
        }

        this.currentAssistantEl.appendChild(container);
        scrollToBottom();
    },

    _handleSubagentProgress(msg) {
        const tracked = this.subagentBlocks.get(msg.parent_id);
        if (!tracked) return;
        tracked.steps = msg.step || (tracked.steps + 1);
        const previewEl = tracked.el.querySelector('[data-tool-preview]');
        if (previewEl) previewEl.textContent = `Agent working... step ${tracked.steps}`;
    },

    _handleSubagentDone(msg) {
        const tracked = this.subagentBlocks.get(msg.parent_id);
        if (!tracked) return;
        const spinner = tracked.el.querySelector('.tool-spinner');
        if (spinner) spinner.remove();
        const previewEl = tracked.el.querySelector('[data-tool-preview]');
        if (previewEl) previewEl.textContent = `Agent done (${msg.steps || tracked.steps} steps)`;
        this.subagentBlocks.delete(msg.parent_id);
    },

    _handleTurnDone(msg) {
        setGenerating(false);
        if (msg.cost !== undefined) App.state.totalCost = msg.cost;
        if (msg.usage && typeof updateContextMeter === 'function') updateContextMeter(msg.usage, msg.context_window);
        // An interrupted/stopped turn (Stop button, Esc, or the agent being killed
        // mid-mobile-reconnect) is intentional, not a failure — but the CLI reports the
        // SIGINT/SIGTERM exit as is_error with a raw "CLI exited … signal=SIGINT" string.
        // Suppress that noise and surface one clear notice instead. Without this the turn
        // otherwise ends as a silent blank, leaving the user staring at their own message.
        // watchdog_timeout self-heals (auto-restart + resend), so it's deliberately excluded.
        const interrupted = msg.subtype === 'interrupted' || msg.subtype === 'stopped';
        if (msg.is_error && msg.errors && !interrupted) {
            for (const err of msg.errors) {
                this.addSystemMessage(err, true);
            }
        }
        this._finalizeText();
        this.commitAssistantEl();
        // Safety net: remove lingering tool spinners
        for (const s of App.el.messages.querySelectorAll('.tool-spinner')) s.remove();
        if (interrupted) {
            this.addInterruptedNotice(msg.subtype);
        }
        setStatus('idle', 'Idle');
    },

    _handleSessionEvent(msg) {
        if (msg.event === 'compacted') {
            // Remove compact spinner if any
            const spinner = document.getElementById('compactSpinner');
            if (spinner) spinner.remove();
            // Insert compact marker
            const marker = document.createElement('div');
            marker.className = 'compact-marker';
            marker.textContent = 'Context compacted — earlier messages were summarized';
            App.el.messages.appendChild(marker);
            setStatus('idle', 'Idle');
            scrollToBottom();
        } else if (msg.event === 'handoff') {
            this.renderHandoffMarker(msg);
        } else if (msg.event === 'fork') {
            this.renderForkMarker(msg);
        } else if (msg.event === 'truncated') {
            // Replay cap marker (SHE-73): the middle of a very long transcript
            // is elided for rendering speed; the full history is on disk.
            const marker = document.createElement('div');
            marker.className = 'compact-marker';
            marker.textContent = `… ${msg.count} earlier messages not shown (long conversation) …`;
            App.el.messages.appendChild(marker);
        } else if (msg.event === 'resumed') {
            this.addSystemMessage('Session resumed.');
        } else if (msg.event === 'rewound') {
            this.prefillComposer(msg.userText || '');
            setStatus('idle', 'Idle');
        }
    },

    // Portable-sessions marker: the visible beat when a conversation crosses
    // agent families. Rendered both live (from model_changed.handoff) and on
    // history replay (session_event event:"handoff"). No invisible magic.
    renderHandoffMarker(msg) {
        const FAMILY_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' };
        const to = FAMILY_LABEL[msg.toFamily] || msg.toFamily || 'another agent';
        const model = msg.toModel ? ` (${msg.toModel})` : '';
        const marker = document.createElement('div');
        marker.className = 'compact-marker handoff-marker';
        marker.textContent = `⇄ Switched to ${to}${model} — context carried over natively`;
        App.el.messages.appendChild(marker);
        scrollToBottom();
    },

    // Fork marker: the branch point of a forked conversation. Everything above
    // it is the shared history copied from the source tab; everything below is
    // this fork's own path. Rendered on history replay (session_event:"fork").
    renderForkMarker(msg) {
        const FAMILY_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' };
        const marker = document.createElement('div');
        marker.className = 'compact-marker fork-marker';
        marker.textContent = msg.crossFamily
            ? `⑃ Forked from here — now on ${FAMILY_LABEL[msg.toFamily] || msg.toFamily}${msg.toModel ? ` (${msg.toModel})` : ''}`
            : '⑃ Forked from here — this is a new branch of the conversation';
        App.el.messages.appendChild(marker);
        scrollToBottom();
    },

    _handleStreamingCatchup(msg) {
        if (msg.text) {
            this.ensureAssistantEl();
            this.ensureTextEl();
            this.streamingText = msg.text;
            this.currentTextEl.innerHTML = marked.parse(this.streamingText);
            setGenerating(true);
            scrollToBottom(true);
        }
    },

    // =============================================================
    // Compact handling
    // =============================================================

    handleCompactStarted() {
        this.ensureAssistantEl();
        const compactMsg = document.createElement('div');
        compactMsg.className = 'content';
        compactMsg.id = 'compactSpinner';
        compactMsg.innerHTML = '<span class="tool-spinner" style="margin-right:8px"></span> Compacting conversation...';
        compactMsg.style.color = 'var(--text-dim)';
        this.currentAssistantEl.appendChild(compactMsg);
        this.commitAssistantEl();
        scrollToBottom();
    },

    // --- Rewind helper ---
    prefillComposer(userText) {
        if (userText) {
            App.el.input.value = userText;
            App.el.input.style.height = 'auto';
            App.el.input.style.height = Math.min(App.el.input.scrollHeight, 200) + 'px';
            App.el.input.focus();
        }
    },

    // =============================================================
    // Tool helpers
    // =============================================================

    _getToolPreview(name, input) {
        const n = name.toLowerCase();
        if (n === 'bash' || n === 'execute') return input.command || input.cmd || '';
        if (n === 'read' || n === 'write' || n === 'edit') return input.file_path || input.path || '';
        if (n === 'grep' || n === 'glob') return input.pattern || '';
        if (n === 'webfetch') return input.url || '';
        if (n === 'websearch') return input.query || '';
        if (n === 'task' || n === 'agent') return input.description || '';
        return Object.values(input).find(v => typeof v === 'string')?.slice(0, 80) || '';
    },

    _formatToolInput(name, input) {
        const n = name.toLowerCase();
        if (n === 'bash' || n === 'execute') return input.command || input.cmd || JSON.stringify(input, null, 2);
        if (n === 'write') return `${input.file_path || ''}\n\n${(input.content || '').slice(0, 1000)}`;
        if (n === 'edit') return `${input.file_path || ''}\n\n- ${(input.old_string || '').slice(0, 200)}\n+ ${(input.new_string || '').slice(0, 200)}`;
        return JSON.stringify(input, null, 2);
    },

    // =============================================================
    // DOM helpers
    // =============================================================

    _finalizeText() {
        if (this.currentTextEl && this.streamingText) {
            this.currentTextEl.innerHTML = marked.parse(this.streamingText);
        }
        this.streamingText = '';
        this.currentTextEl = null;
    },

    ensureAssistantEl() {
        if (!this.currentAssistantEl) {
            this.currentAssistantEl = document.createElement('div');
            this.currentAssistantEl.className = 'msg-assistant';
            App.el.messages.appendChild(this.currentAssistantEl);
        }
    },

    ensureTextEl() {
        this.ensureAssistantEl();
        if (!this.currentTextEl) {
            this.currentTextEl = document.createElement('div');
            this.currentTextEl.className = 'content';
            this.currentAssistantEl.appendChild(this.currentTextEl);
        }
    },

    commitAssistantEl() {
        this.currentAssistantEl = null;
        this.currentTextEl = null;
        this.streamingText = '';
        this.toolBlocks.clear();
        scrollToBottom();
    },

    addUserMessage(text, imageUrls) {
        this.commitAssistantEl();
        if (typeof updateEmptyState === 'function') {
            App.el.emptyState.classList.add('hidden');
            App.el.messages.classList.remove('hidden');
        }
        const div = document.createElement('div');
        div.className = 'msg-user';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        if (imageUrls?.length) {
            const imgRow = document.createElement('div');
            imgRow.className = 'msg-images';
            for (const url of imageUrls) {
                const img = document.createElement('img');
                img.src = url;
                imgRow.appendChild(img);
            }
            bubble.appendChild(imgRow);
        }
        if (text) {
            const span = document.createElement('span');
            span.textContent = text;
            bubble.appendChild(span);
        }
        div.appendChild(bubble);
        App.el.messages.appendChild(div);
        scrollToBottom();
    },

    // A collapsed, muted block for internal/injected turns (task notifications,
    // delegated tasks). Content stays inspectable behind a click — same
    // expand/collapse pattern as tool blocks (delegated header click handler in
    // app.js works on .tool-header regardless of which block type owns it).
    addInternalMessage(text) {
        this.commitAssistantEl();
        const block = document.createElement('div');
        block.className = 'tool-block internal-note';
        const header = document.createElement('div');
        header.className = 'tool-header';
        header.innerHTML = `
            <span class="tool-chevron">&#9654;</span>
            <span class="tool-name">background update</span>
            <span class="tool-preview">${escHtml(String(text).slice(0, 80))}</span>`;
        const detail = document.createElement('div');
        detail.className = 'tool-detail';
        const pre = document.createElement('pre');
        pre.className = 'internal-note-body';
        pre.textContent = text;
        detail.appendChild(pre);
        block.appendChild(header);
        block.appendChild(detail);
        App.el.messages.appendChild(block);
        scrollToBottom();
    },

    addSystemMessage(text, isError) {
        const div = document.createElement('div');
        div.className = 'msg-assistant';
        const content = document.createElement('div');
        content.className = 'content';
        content.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
        content.textContent = text;
        div.appendChild(content);
        App.el.messages.appendChild(div);
        scrollToBottom();
    },

    // Text of the most recent user message currently in the DOM. Captured at render
    // time so a Retry button reflects the message that belongs to *this* turn (during
    // history replay the DOM only holds messages up to the interrupted turn_done).
    _lastUserMessageText() {
        const spans = App.el.messages.querySelectorAll('.msg-user .bubble span');
        const last = spans[spans.length - 1];
        return last ? last.textContent : '';
    },

    addInterruptedNotice(subtype) {
        // A single interruption can surface as a short cascade of turn_done events
        // (interrupt() + the CLI's partial-flush on SIGINT). Collapse them: if the
        // most recent message is already an interrupted notice, don't stack another.
        const last = App.el.messages.lastElementChild;
        if (last && last.classList.contains('msg-interrupted')) return;
        const lastUserText = this._lastUserMessageText();
        const div = document.createElement('div');
        div.className = 'msg-interrupted';
        const label = subtype === 'stopped' ? 'stopped' : 'interrupted';
        const content = document.createElement('div');
        content.className = 'content';
        content.textContent = `⚠ Response ${label} — your message was sent, but the agent was stopped before replying.`;
        div.appendChild(content);
        if (lastUserText) {
            const retry = document.createElement('button');
            retry.className = 'retry-btn';
            retry.textContent = 'Retry';
            retry.onclick = () => this.prefillComposer(lastUserText);
            div.appendChild(retry);
        }
        App.el.messages.appendChild(div);
        scrollToBottom();
    },
};

function sendAskUserResponse(text) {
    App.el.input.value = text;
    handleSend();
}
