// Quote-to-comment — select text in an agent reply, attach a comment, and send
// a batch of quote+comment pairs as one message. Replaces the manual
// select→copy→paste→"…" --> comment loop.
//
// The assembled message uses the owner's existing convention verbatim:
//     > quoted text
//     --> the comment
// so the agent sees no new syntax; this is pure input acceleration.
//
// The same tray also takes pointers from the report side panel (the dashboard
// relays the owner's click on an element of a served HTML file — see
// frontend/review-picker.js): such a quote carries a `ref` {path, selector} and
// is sent as
//     > reports/deck.html › section#pricing > p.lead
//     > "quoted text"
//     --> the comment
// so the agent knows which file and which element the remark is about.
//
// State is per-conversation-slot: app.js saves/restores getQuotes()/setQuotes()
// across switchSessionTab, exactly like the composer draft. Highlights of the
// source text live in the message DOM (class `qc-src`, keyed by data-qid) so
// they survive the innerHTML snapshot/restore that tab-switching does.
window.QuoteReview = (() => {
    let quotes = [];          // [{ id, text, comment, ref? }]  ref = { path, selector } for report picks
    let nextId = 1;
    let pendingRange = null;   // Range captured when the selection pill is shown
    let tray, pill, messages;

    // Short label for a pointer's source: a file's name, or an app page's last
    // path segment (its host for the site root, e.g. `home.example.com`).
    const refLabel = (p) => p.replace(/\/+$/, '').split('/').pop();
    const esc = (s) => s.replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    function init() {
        messages = document.getElementById('messages');
        tray = document.getElementById('quoteTray');
        pill = document.getElementById('quoteSelPill');
        if (!messages || !tray || !pill) return;

        // Show the pill after a selection settles inside an agent reply: on
        // mouseup with a mouse. On a touch screen the selection is made and
        // adjusted with the phone's own handles, which fire no touchend on the
        // page, so follow selectionchange instead (SHE-120).
        const onSelectEnd = () => setTimeout(showPillForSelection, 0);
        messages.addEventListener('mouseup', onSelectEnd);
        let settle = null;
        document.addEventListener('selectionchange', () => {
            if (!touchScreen()) return;
            clearTimeout(settle);
            settle = setTimeout(showPillForSelection, 250);
        });

        // Prevent the pill's own mousedown from clearing the selection before we
        // read it; the click handler then captures the (still-live) range.
        pill.addEventListener('mousedown', (e) => e.preventDefault());
        pill.addEventListener('click', addFromSelection);

        // "c" while text is selected (and not typing) is a fast path to comment.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { hidePill(); return; }
            if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey &&
                pill.classList.contains('show') && !isEditable(document.activeElement)) {
                e.preventDefault();
                addFromSelection();
            }
        });

        // A scroll or resize invalidates the pill's position next to the
        // selection, so hide it. On a touch screen it is pinned under the
        // header and stays put.
        const hideIfFloating = () => { if (!touchScreen()) hidePill(); };
        window.addEventListener('scroll', hideIfFloating, true);
        window.addEventListener('resize', hideIfFloating);
    }

    // Phones draw their own selection toolbar right above the selection (Copy,
    // Share…) and a search sheet at the bottom of the screen: a pill floating
    // at the selection sits under the toolbar. There it is pinned just under
    // the cockpit header instead, a spot neither covers (SHE-120).
    const touchScreen = () => matchMedia('(pointer: coarse)').matches;
    const TOOLBAR_ROOM = 140;  // px under the header a phone toolbar can take
    const HANDLE_ROOM = 56;    // px the selection handles hang below the text

    // The agent reply a selection end belongs to, whether the end is a text
    // node or an element (a triple-click ends on an element).
    const replyOf = (n) => (n?.nodeType === Node.ELEMENT_NODE ? n : n?.parentElement)?.closest('.msg-assistant .content');

    // The selected range, limited to agent replies. A triple-click on a
    // reply's last paragraph ends the selection at the start of whatever
    // follows the reply (SHE-121): end it at the end of that reply instead.
    function replyRange(sel) {
        const range = sel.getRangeAt(0).cloneRange();
        const first = replyOf(range.startContainer);
        if (!first) return null;
        if (!replyOf(range.endContainer)) range.setEnd(first, first.childNodes.length);
        return range;
    }

    function isEditable(el) {
        return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    }

    function showPillForSelection() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return hidePill();
        // Only offer commenting on rendered agent replies.
        const range = replyRange(sel);
        if (!range || !range.toString().trim()) return hidePill();

        pendingRange = range;
        if (touchScreen()) {
            // Under the header, unless the selection is up there too: then the
            // phone's toolbar is above it and the pill goes below its handles.
            const area = messages.getBoundingClientRect();
            const r = range.getBoundingClientRect();
            const top = r.top < area.top + TOOLBAR_ROOM ? Math.min(r.bottom + HANDLE_ROOM, area.bottom - 60) : area.top + 10;
            pill.style.left = '50%';
            pill.style.top = top + 'px';
            pill.classList.add('pinned');
        } else {
            const r = range.getBoundingClientRect();
            pill.style.left = (r.left + r.width / 2) + 'px';
            pill.style.top = r.top + 'px';
            pill.classList.remove('pinned');
        }
        pill.classList.add('show');
    }

    function hidePill() {
        pill.classList.remove('show');
        pendingRange = null;
    }

    function addFromSelection() {
        if (!pendingRange) return;
        const text = pendingRange.toString().trim();
        if (!text) return hidePill();
        const id = nextId++;

        // Best-effort highlight of the source span. surroundContents throws when
        // the range crosses element boundaries (e.g. spanning a <code>); the quote
        // is still captured — we just skip the visual highlight in that case.
        try {
            const span = document.createElement('span');
            span.className = 'qc-src';
            span.dataset.qid = String(id);
            pendingRange.surroundContents(span);
        } catch (_) { /* highlight skipped; quote text already captured */ }

        quotes.push({ id, text, comment: '' });
        window.getSelection().removeAllRanges();
        hidePill();
        render();
        const ta = tray.querySelector(`[data-cid="${id}"] .qc-comment`);
        if (ta) ta.focus();
        notifyChange();
    }

    // A pointer relayed from the report side panel (dashboard postMessage). The
    // text is what the owner saw in the document; nothing here is trusted beyond
    // being shown back to them in the tray before they send it.
    function addFromReport({ path, selector, text, comment }) {
        if (typeof path !== 'string' || typeof selector !== 'string') return;
        const id = nextId++;
        quotes.push({
            id, text: String(text || '').trim(), comment: String(comment || ''),
            ref: { path, selector },
        });
        render();
        const ta = tray.querySelector(`[data-cid="${id}"] .qc-comment`);
        if (ta) ta.focus();
        notifyChange();
    }

    function removeQuote(id) {
        unhighlight(id);
        quotes = quotes.filter((q) => q.id !== id);
        render();
        notifyChange();
    }

    function unhighlight(id) {
        const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
        if (!span) return;
        const parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parent.normalize();
    }

    function render() {
        if (quotes.length === 0) {
            tray.innerHTML = '';
            tray.classList.add('hidden');
            return;
        }
        tray.classList.remove('hidden');
        const refs = quotes.filter((q) => q.ref).length;
        const on = refs === 0 ? 'on this reply' : refs === quotes.length ? 'on the document' : 'pending';
        tray.innerHTML =
            `<div class="qc-head"><span class="qc-count">${quotes.length}</span> ` +
            `${quotes.length === 1 ? 'comment' : 'comments'} ${on}</div>` +
            quotes.map((q, i) => `
                <div class="qc" data-cid="${q.id}">
                    <div class="qc-quote">
                        <span class="qc-num">${i + 1}</span>
                        <span class="qc-body">${q.ref ? `<span class="qc-ref" title="${esc(q.ref.path)} › ${esc(q.ref.selector)}">${esc(refLabel(q.ref.path))} › ${esc(q.ref.selector)}</span>` : ''}<span class="qc-text">"${esc(q.text)}"</span></span>
                        <button class="qc-x" title="Remove" data-x="${q.id}">&times;</button>
                    </div>
                    <div class="qc-grow" data-rep="${esc(q.comment)}">
                        <textarea class="qc-comment" data-c="${q.id}" rows="1"
                            placeholder="Your reaction to this…">${esc(q.comment)}</textarea>
                    </div>
                </div>`).join('');

        tray.querySelectorAll('.qc-comment').forEach((ta) => {
            ta.addEventListener('input', () => {
                const q = quotes.find((x) => x.id == ta.dataset.c);
                if (q) q.comment = ta.value;
                // The .qc-grow wrapper's ::after mirrors the value and sets the
                // height in pure CSS — no scrollHeight measurement, so a tray
                // rendered before layout (tab restore) can't collapse a filled
                // comment to a clipped single line (SHE-96).
                ta.parentElement.dataset.rep = ta.value;
                notifyChange();
            });
            // Cmd/Ctrl+Enter sends from inside a comment field.
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (typeof window.handleSend === 'function') window.handleSend();
                } else if (e.key === 'Escape') {
                    ta.blur();
                }
            });
        });
        tray.querySelectorAll('.qc-x').forEach((b) => {
            b.addEventListener('click', () => removeQuote(Number(b.dataset.x)));
        });
        // Hover a chip → flash its source in the transcript. Hover must NEVER
        // scroll: the tray sits where the cursor naturally travels while the
        // user scrolls the transcript, so a hover-triggered scrollIntoView
        // yanks the view away mid-scroll (SHE-103). Scrolling to the source is
        // an explicit act: click the quote row.
        tray.querySelectorAll('.qc').forEach((el) => {
            const id = el.dataset.cid;
            el.addEventListener('mouseenter', () => {
                const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
                if (span) span.classList.add('flash');
            });
            el.addEventListener('mouseleave', () => {
                const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
                if (span) span.classList.remove('flash');
            });
            el.querySelector('.qc-quote')?.addEventListener('click', (e) => {
                if (e.target.closest('.qc-x')) return;
                const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
                if (span) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        });
    }

    // Assemble the pending quotes into the owner's "> quote / --> comment" format,
    // preserving tray order. Quotes left without a comment go through as pure
    // block-quotes so nothing selected is silently dropped.
    function assemble() {
        return quotes.map((q) => {
            const quote = q.ref ? `> ${q.ref.path} › ${q.ref.selector}\n> "${q.text}"` : `> ${q.text}`;
            return q.comment.trim() ? `${quote}\n--> ${q.comment.trim()}` : quote;
        }).join('\n\n');
    }

    const hasContent = () => quotes.length > 0;

    // Per-slot persistence. Store plain data (not DOM refs) so it survives the
    // innerHTML snapshot/restore; highlights are re-linked by data-qid in the
    // restored markup.
    const plain = (q) => ({ id: q.id, text: q.text, comment: q.comment, ...(q.ref ? { ref: { ...q.ref } } : {}) });
    function getQuotes() {
        return quotes.map(plain);
    }
    function setQuotes(arr) {
        quotes = (arr || []).map(plain);
        for (const q of quotes) if (q.id >= nextId) nextId = q.id + 1;
        render();
    }

    // Clear everything for the active conversation: drop quotes and strip every
    // highlight currently in view. Called after send and on session reset.
    function clear() {
        messages.querySelectorAll('.qc-src').forEach((span) => {
            const parent = span.parentNode;
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            parent.removeChild(span);
            parent.normalize();
        });
        quotes = [];
        render();
        hidePill();
    }

    // Let app.js keep the send button's enabled state in sync when quotes change
    // even though the composer textarea is empty.
    function notifyChange() {
        if (typeof window.onQuoteReviewChange === 'function') window.onQuoteReviewChange();
    }

    return { init, addFromReport, assemble, hasContent, getQuotes, setQuotes, clear };
})();
