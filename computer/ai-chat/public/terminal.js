// --- Console Mode (Terminal) ---
// Toggles between beautified chat UI and raw CLI TUI.
// Both modes share the same session via --resume <sessionId>.
window.TerminalMode = {
    terminal: null,
    fitAddon: null,
    ws: null,
    initialized: false,

    init() {
        if (this.initialized) return;
        this.initialized = true;

        this.terminal = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
            fontSize: 14,
            lineHeight: 1.3,
            theme: {
                background: '#0a0a0a',
                foreground: '#f5f5f5',
                cursor: '#f59e0b',
                cursorAccent: '#0a0a0a',
                selectionBackground: 'rgba(245, 158, 11, 0.3)',
                black: '#0a0a0a',
                brightBlack: '#737373',
                white: '#f5f5f5',
                brightWhite: '#ffffff',
                yellow: '#f59e0b',
                brightYellow: '#fbbf24',
                green: '#22c55e',
                brightGreen: '#4ade80',
                red: '#ef4444',
                brightRed: '#f87171',
                blue: '#3b82f6',
                brightBlue: '#60a5fa',
                cyan: '#06b6d4',
                brightCyan: '#22d3ee',
                magenta: '#a855f7',
                brightMagenta: '#c084fc',
            },
        });

        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon.WebLinksAddon());

        const wrapper = document.getElementById('terminalWrapper');
        this.terminal.open(wrapper);
        this.fitAddon.fit();

        // Send key data to server
        this.terminal.onData((data) => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send(JSON.stringify({ type: 'terminal_data', data }));
            }
        });

        // Handle resize
        this.resizeObserver = new ResizeObserver(() => {
            if (this.fitAddon) {
                this.fitAddon.fit();
                if (this.ws && this.ws.readyState === 1) {
                    this.ws.send(JSON.stringify({
                        type: 'terminal_resize',
                        cols: this.terminal.cols,
                        rows: this.terminal.rows,
                    }));
                }
            }
        });
        this.resizeObserver.observe(wrapper);
    },

    connect() {
        const wsUrl = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws/terminal`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            if (this.terminal) {
                this.ws.send(JSON.stringify({
                    type: 'terminal_resize',
                    cols: this.terminal.cols,
                    rows: this.terminal.rows,
                }));
            }
        };

        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'terminal_data' && this.terminal) {
                this.terminal.write(msg.data);
            } else if (msg.type === 'terminal_exit') {
                this.terminal.writeln('\r\n\x1b[33m[Terminal process exited. Returning to chat...]\x1b[0m');
                // Auto-exit console mode when CLI exits
                setTimeout(() => { if (App.state.terminalMode) this.toggle(); }, 1500);
            } else if (msg.type === 'terminal_error') {
                this.terminal.writeln(`\r\n\x1b[31m${msg.error}\x1b[0m`);
            }
        };

        this.ws.onclose = () => {
            if (App.state.terminalMode) {
                setTimeout(() => this.connect(), 2000);
            }
        };
    },

    /**
     * Toggle between beautified chat UI and console (raw CLI TUI).
     * Uses the main chat WS to send toggle_console, which:
     *   - Entering: stops the chat agent, spawns PTY with --resume <sessionId>
     *   - Exiting: kills PTY, reloads session history from disk
     */
    toggle() {
        const app = document.querySelector('.app');
        App.state.terminalMode = !App.state.terminalMode;

        if (App.state.terminalMode) {
            // Tell backend to switch to console mode (stops agent, spawns PTY with --resume)
            App.state.ws?.send(JSON.stringify({
                type: 'toggle_console',
                enable: true,
                slot: typeof activeSlotId !== 'undefined' ? activeSlotId : 0,
            }));

            app.classList.add('terminal-mode');
            this.init();
            this.connect();
            // Clear terminal buffer for fresh session
            if (this.terminal) this.terminal.clear();
            setTimeout(() => {
                this.fitAddon?.fit();
                this.terminal?.focus();
            }, 100);
        } else {
            // Tell backend to exit console mode (kills PTY, reloads history)
            App.state.ws?.send(JSON.stringify({
                type: 'toggle_console',
                enable: false,
                slot: typeof activeSlotId !== 'undefined' ? activeSlotId : 0,
            }));

            app.classList.remove('terminal-mode');
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
        }
        if (typeof ActionsMenu !== 'undefined') ActionsMenu.hide();
    },

    /** Called by app.js when server sends console_mode message */
    handleServerMessage(msg) {
        if (msg.enabled) {
            // Server confirmed console mode — already handled in toggle()
        } else {
            // Server confirmed exit from console mode — history will arrive as a separate message
            App.state.terminalMode = false;
            document.querySelector('.app')?.classList.remove('terminal-mode');
        }
    },
};
