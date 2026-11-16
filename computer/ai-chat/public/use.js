/**
 * use.js — counts which controls the owner uses (SHE-204).
 *
 * Where a control lives should follow how often it is used; this is how the
 * cockpit knows. Every click on a control, and every keyboard shortcut, adds
 * one to that control's NAME, a fixed identifier from this page's code
 * (data-use, else the element's id, else its first class). Nothing the owner
 * wrote is read: no message, no chat title, no file or project name. The
 * counts go to this box's own cockpit server (lib/ui-use.mjs), which keeps
 * them in one file; nothing leaves the box. `bin/shellteam-usage` prints them.
 */
const Use = (() => {
    const pending = { desktop: {}, phone: {} };
    const screen = () => (matchMedia('(max-width: 720px)').matches ? 'phone' : 'desktop');
    const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

    function count(name) {
        const bucket = pending[screen()];
        bucket[name] = (bucket[name] || 0) + 1;
    }

    /** The name of the control under a click, or null when it is not one. */
    function nameOf(target) {
        const named = target.closest?.('[data-use]');
        if (named) return named.dataset.use;
        const el = target.closest?.('button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="radio"]');
        if (!el) return null;
        if (el.id) return `id.${kebab(el.id)}`;
        const cls = [...el.classList].find((c) => /^[a-z]/.test(c));
        return cls ? `class.${kebab(cls)}` : null;
    }

    function flush() {
        if (typeof S === 'undefined' || S.ws?.readyState !== 1) return;
        for (const [where, counts] of Object.entries(pending)) {
            if (!Object.keys(counts).length) continue;
            S.ws.send(JSON.stringify({ type: 'ui_use', screen: where, counts }));
            pending[where] = {};
        }
    }

    document.addEventListener('click', (e) => { const name = nameOf(e.target); if (name) count(name); }, true);
    // Shortcuts: only combinations with Ctrl, Alt or Cmd, which never type text.
    document.addEventListener('keydown', (e) => {
        if (e.repeat || !(e.ctrlKey || e.altKey || e.metaKey)) return;
        const key = /^(?:Key([A-Z])|Digit(\d)|(Arrow(?:Up|Down)|Enter))$/.exec(e.code);
        if (!key) return;
        const mods = [e.ctrlKey || e.metaKey ? 'ctrl' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : ''].filter(Boolean).join('-');
        count(`key.${mods}-${kebab(key[1] || key[2] || key[3])}`);
    }, true);
    setInterval(flush, 20000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    addEventListener('pagehide', flush);

    return { count, flush, nameOf };
})();
window.Use = Use;
