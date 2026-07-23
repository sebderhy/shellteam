// --- Header menus (AI / Info / System) ---
// One controller for every grouped header menu: a single menu open at a time,
// one shared backdrop, Escape-to-close. Each menu is an .actions-menu block
// toggled with .visible — an anchored dropdown on desktop, a bottom sheet
// ≤480px (pure CSS, see styles.css).
//
// Keyboard-first: an open menu is fully drivable without the mouse —
//   ↑/↓        move the highlight (wraps); Home/End jump to first/last
//   Enter      activate the highlighted row
//   <letter>   jump straight to the row whose data-key matches (mnemonic)
//   Esc        close
// The highlight (.kbd-active) and the mouse (:hover) stay in sync so there's
// only ever one focused row.
window.Menus = {
    _openId: null,
    _items: [],   // navigable .actions-item rows in the open menu
    _active: -1,  // index into _items, or -1 for none
    _returnFocus: null,
    _trigger: null,

    toggle(id) {
        if (this._openId === id) { this.hide(); return; }
        this.hide(false);
        // Panels with dynamic content render on open (defined in app.js, which
        // loads after this file — hence the typeof guards).
        if (id === 'infoPanel' && typeof renderInfoPanel === 'function') renderInfoPanel();
        if (id === 'quotaPanel' && typeof renderQuotaPanel === 'function') renderQuotaPanel();
        if (id === 'aiMenu' && typeof renderAIMenuValues === 'function') renderAIMenuValues();
        const menu = document.getElementById(id);
        menu?.classList.add('visible');
        menu?.setAttribute('aria-hidden', 'false');
        document.getElementById('actionsBackdrop')?.classList.add('visible');
        this._returnFocus = document.activeElement;
        this._trigger = document.querySelector(`[aria-controls="${id}"]`);
        this._trigger?.setAttribute('aria-expanded', 'true');
        this._openId = id;
        this._syncItems(menu);
        this._setActive(0, true); // land on the first row so Enter works immediately
    },

    isOpen(id) { return this._openId === id; },

    hide(restoreFocus = true) {
        if (this._openId) {
            this._clearActive();
            const menu = document.getElementById(this._openId);
            menu?.classList.remove('visible');
            menu?.setAttribute('aria-hidden', 'true');
        }
        document.getElementById('actionsBackdrop')?.classList.remove('visible');
        this._trigger?.setAttribute('aria-expanded', 'false');
        if (restoreFocus && this._returnFocus?.isConnected) this._returnFocus.focus();
        this._openId = null;
        this._items = [];
        this._active = -1;
        this._trigger = null;
        this._returnFocus = null;
    },

    // Collect the currently-visible rows (skips separators and hidden items like
    // a locked-workspace row) and let the mouse take over the highlight on hover.
    _syncItems(menu) {
        this._items = menu
            ? [...menu.querySelectorAll('[role="menuitem"]')].filter((el) => el.offsetParent !== null)
            : [];
        this._items.forEach((el, i) => {
            el.tabIndex = -1;
            el.onmouseenter = () => this._setActive(i, false);
        });
    },

    _clearActive() {
        this._items.forEach((el) => {
            el.classList.remove('kbd-active');
            el.tabIndex = -1;
        });
    },

    _setActive(i, focus = false) {
        if (!this._items.length) { this._active = -1; return; }
        this._clearActive();
        this._active = (i + this._items.length) % this._items.length;
        const el = this._items[this._active];
        el.classList.add('kbd-active');
        el.tabIndex = 0;
        if (focus) el.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'nearest' });
    },

    _move(delta) {
        if (!this._items.length) return;
        this._setActive(this._active < 0 ? (delta > 0 ? 0 : -1) : this._active + delta, true);
    },

    init() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { this.hide(); return; }
            if (!this._openId) return;

            // Arrow / Home / End / Enter navigation over the open menu.
            if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); return; }
            if (e.key === 'ArrowUp')   { e.preventDefault(); this._move(-1); return; }
            if (e.key === 'Home')      { e.preventDefault(); this._setActive(0, true); return; }
            if (e.key === 'End')       { e.preventDefault(); this._setActive(-1, true); return; }
            if (e.key === 'Enter') {
                const el = this._items[this._active];
                if (el) { e.preventDefault(); this.hide(); el.click(); }
                return;
            }

            // Bare-letter mnemonics (e.g. "r" → Rewind). Ignore modifier combos so
            // browser/OS shortcuts still work.
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;
            const menu = document.getElementById(this._openId);
            const item = menu?.querySelector(`.actions-item[data-key="${e.key.toLowerCase()}"]`);
            if (item) {
                e.preventDefault();
                this.hide();
                item.click();
            }
        });
    },
};

Menus.init();

// Back-compat shim: session actions (newSession, compactSession, terminal.js's
// TerminalMode.toggle, …) close whatever menu launched them via ActionsMenu.hide().
window.ActionsMenu = {
    hide: () => Menus.hide(),
    toggle: () => Menus.toggle('aiMenu'),
};
