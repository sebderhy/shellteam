// ShellTeam review picker — injected by the API into the owner's OWN view of a
// content-sandboxed HTML file (api/services/report_review.py). Lets the owner
// point at an element in the side panel and either comment on it (the comment
// lands in the cockpit's quote tray, so the coding agent knows exactly which
// part of the document is meant) or edit its text in place (saved by the
// dashboard through a deterministic search/replace on the source file).
//
// The document has an opaque origin (no allow-same-origin), so nothing here can
// reach the dashboard or the file API: the ONLY channel is postMessage to the
// parent frame, and the parent treats every message as untrusted input (it only
// ever puts text in front of the owner or asks the server to replace text the
// owner just saw). Inert when the page is not framed.
//
// Protocol (all messages carry source: 'shellteam-report' / 'shellteam-dashboard'):
//   -> parent  review-ready                    picker loaded, buttons may show
//   <- parent  review-mode {mode}              'off' | 'comment' | 'edit'
//   -> parent  review-pick {selector,text,html}  owner clicked an element (comment mode)
//   -> parent  review-edit {selector,old_html,new_html,old_text,new_text}
//   -> parent  review-mode {mode:'off'}        owner pressed Escape
(() => {
    if (window.parent === window) return;
    const SRC = 'shellteam-report';
    const MARK = 'data-st-review';
    const post = (msg) => window.parent.postMessage({ source: SRC, ...msg }, '*');

    let mode = 'off';
    let candidate = null;      // element under the cursor (or keyboard-adjusted)
    let lockAt = null;         // pointer position when arrows adjusted the candidate
    let editing = null;        // { el, before } while an element is contentEditable

    // --- overlay -------------------------------------------------------------
    const box = document.createElement('div');
    box.setAttribute(MARK, '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;display:none;' +
        'border:2px solid #f0a020;border-radius:3px;box-shadow:0 0 0 2px rgba(240,160,32,.25);' +
        'transition:all .06s ease-out;';
    const tag = document.createElement('div');
    tag.setAttribute(MARK, '');
    tag.style.cssText = 'position:absolute;left:-2px;top:-22px;padding:2px 6px;font:11px/16px ui-monospace,monospace;' +
        'background:#f0a020;color:#1a1200;border-radius:3px 3px 0 0;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;';
    box.appendChild(tag);
    const hint = document.createElement('div');
    hint.setAttribute(MARK, '');
    hint.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483647;display:none;' +
        'padding:6px 12px;font:12px/16px system-ui,sans-serif;background:rgba(20,20,20,.92);color:#fff;border-radius:6px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;';
    const HINTS = {
        comment: 'Click an element to comment on it · ↑ wider · ↓ narrower · Esc done',
        edit: 'Click text to edit it · click elsewhere or Ctrl+Enter saves · Esc cancels',
    };
    function mount() {
        if (!box.isConnected) document.documentElement.appendChild(box);
        if (!hint.isConnected) document.documentElement.appendChild(hint);
    }

    const ours = (el) => !!(el && el.closest && el.closest(`[${MARK}]`));
    const pickable = (el) => el && el !== document.documentElement && el !== document.body && !ours(el);

    function outline(el) {
        if (!el) { box.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = (r.left - 2) + 'px';
        box.style.top = (r.top - 2) + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        tag.textContent = selectorFor(el);
        tag.style.top = r.top < 26 ? 'auto' : '-22px';
        tag.style.bottom = r.top < 26 ? '-22px' : 'auto';
    }
    function setCandidate(el) {
        candidate = pickable(el) ? el : null;
        outline(candidate);
    }

    // --- selector + excerpt --------------------------------------------------
    // A short, human-readable CSS path that the coding agent can grep for. Walk
    // up until an ancestor carries an id (or body), adding :nth-of-type only when
    // a same-tag sibling makes it ambiguous. Trimmed to the last 4 segments.
    function segment(el) {
        let s = el.tagName.toLowerCase();
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return s + '#' + el.id;
        const cls = [...el.classList].find((c) => /^[A-Za-z_][\w-]*$/.test(c));
        if (cls) s += '.' + cls;
        const parent = el.parentElement;
        if (parent) {
            const same = [...parent.children].filter((c) => c.tagName === el.tagName);
            if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
        }
        return s;
    }
    function selectorFor(el) {
        const segs = [];
        for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            segs.unshift(segment(n));
            if (n.id) break;
        }
        return (segs.length > 4 ? '… ' : '') + segs.slice(-4).join(' > ');
    }
    const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
    function excerpt(el) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        // An element without text (an image, a chart canvas) is described by its markup.
        return clip(text || el.outerHTML.replace(/\s+/g, ' ').trim(), 400);
    }

    // --- mode handling -------------------------------------------------------
    function setMode(next) {
        if (editing) finishEdit(true);
        mode = next;
        mount();
        document.documentElement.style.cursor = mode === 'off' ? '' : (mode === 'edit' ? 'text' : 'crosshair');
        hint.textContent = HINTS[mode] || '';
        hint.style.display = mode === 'off' ? 'none' : 'block';
        lockAt = null;
        setCandidate(null);
    }

    function onMove(e) {
        if (mode === 'off' || editing) return;
        if (lockAt && Math.hypot(e.clientX - lockAt.x, e.clientY - lockAt.y) < 24) return;
        lockAt = null;
        setCandidate(editable(document.elementFromPoint(e.clientX, e.clientY)));
    }

    // The unit a text edit works on: the nearest block-level ancestor (a
    // paragraph, heading, list item, cell), so the replaced snippet is long
    // enough to be found once in the source. Comment mode picks the exact element.
    function editable(el) {
        if (mode !== 'edit' || !el) return el;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (ours(n)) return null;
            const d = getComputedStyle(n).display;
            if (d !== 'inline' && d !== 'inline-block' && d !== 'contents') return n;
        }
        return el;
    }

    function onClick(e) {
        if (mode === 'off' || ours(e.target)) return;
        if (editing) {
            if (editing.el.contains(e.target)) return;   // caret moves inside the field
            e.preventDefault(); e.stopPropagation();
            finishEdit(false);
            return;
        }
        e.preventDefault(); e.stopPropagation();
        const el = candidate || editable(e.target);
        if (!pickable(el)) return;
        if (mode === 'comment') {
            post({ kind: 'review-pick', selector: selectorFor(el), text: excerpt(el), html: clip(el.outerHTML, 1500) });
            flash();
        } else {
            beginEdit(el);
        }
    }

    function flash() {
        box.style.borderColor = '#37c26a';
        setTimeout(() => { box.style.borderColor = '#f0a020'; }, 250);
    }

    // --- in-place text editing ----------------------------------------------
    function beginEdit(el) {
        editing = { el, before: el.innerHTML, beforeText: excerpt(el) };
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('spellcheck', 'false');
        el.focus();
        outline(el);
        box.style.borderColor = '#3b82f6';
        hint.textContent = 'Editing · click elsewhere or Ctrl+Enter saves · Esc cancels';
    }
    function finishEdit(cancel) {
        const { el, before, beforeText } = editing;
        editing = null;
        el.removeAttribute('contenteditable');
        el.removeAttribute('spellcheck');
        el.blur();
        box.style.borderColor = '#f0a020';
        hint.textContent = HINTS[mode] || '';
        if (cancel) { el.innerHTML = before; setCandidate(null); return; }
        const after = el.innerHTML;
        if (after !== before) {
            post({
                kind: 'review-edit', selector: selectorFor(el),
                old_html: before, new_html: after, old_text: beforeText, new_text: excerpt(el),
            });
            flash();
        }
        setCandidate(null);
    }

    // --- keyboard ------------------------------------------------------------
    // Capturing on window: we run before any handler the document itself
    // installed (slide decks flip pages on letters and arrows), so keys typed
    // into an edit field never leak into the page.
    function onKey(e) {
        if (mode === 'off') return;
        if (editing) {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); }
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishEdit(false); }
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMode('off'); post({ kind: 'review-mode', mode: 'off' }); return; }
        if (!candidate) return;
        if (e.key === 'ArrowUp' && pickable(candidate.parentElement)) {
            e.preventDefault(); e.stopPropagation();
            lockAt = lastPointer; setCandidate(candidate.parentElement);
        } else if (e.key === 'ArrowDown' && candidate.firstElementChild && !ours(candidate.firstElementChild)) {
            e.preventDefault(); e.stopPropagation();
            lockAt = lastPointer; setCandidate(candidate.firstElementChild);
        }
    }
    let lastPointer = { x: 0, y: 0 };
    document.addEventListener('mousemove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; onMove(e); }, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', (e) => { if (mode !== 'off' && !editing && !ours(e.target)) e.preventDefault(); }, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', (e) => { if (editing) e.stopPropagation(); }, true);
    window.addEventListener('keypress', (e) => { if (editing) e.stopPropagation(); }, true);
    window.addEventListener('scroll', () => { if (candidate) outline(candidate); }, true);
    window.addEventListener('resize', () => { if (candidate) outline(candidate); });

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (e.source !== window.parent || !d || d.source !== 'shellteam-dashboard') return;
        if (d.kind === 'review-mode') setMode(d.mode === 'comment' || d.mode === 'edit' ? d.mode : 'off');
    });

    post({ kind: 'review-ready' });
})();
