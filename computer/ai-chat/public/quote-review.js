// Quote-to-comment — select text in an agent reply, attach a comment, and send
// a batch of quote+comment pairs as one message. Replaces the manual
// select→copy→paste→"…" --> comment loop.
//
// The assembled message uses the owner's existing convention verbatim:
//     > quoted text
//     --> the comment
// so the agent sees no new syntax; this is pure input acceleration.
//
// State is per-conversation-slot: app.js saves/restores getQuotes()/setQuotes()
// across switchSessionTab, exactly like the composer draft. Highlights of the
// source text live in the message DOM (class `qc-src`, keyed by data-qid) so
// they survive the innerHTML snapshot/restore that tab-switching does.
window.QuoteReview = (() => {
    let quotes = [];          // [{ id, text, comment }]
    let nextId = 1;
    let pendingRange = null;   // Range captured when the selection pill is shown
    let tray, pill, messages;

    const esc = (s) => s.replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    function init() {
        messages = document.getElementById('messages');
        tray = document.getElementById('quoteTray');
        pill = document.getElementById('quoteSelPill');
        if (!messages || !tray || !pill) return;

        // Show the pill after a selection settles inside an agent reply. mouseup
        // (desktop) and touchend (mobile) both fire after the selection exists.
        const onSelectEnd = () => setTimeout(showPillForSelection, 0);
        messages.addEventListener('mouseup', onSelectEnd);
        messages.addEventListener('touchend', onSelectEnd);

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

        // A scroll or resize invalidates the pill's fixed position — just hide it.
        window.addEventListener('scroll', hidePill, true);
        window.addEventListener('resize', hidePill);
    }

    function isEditable(el) {
        return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    }

    function showPillForSelection() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return hidePill();
        const text = sel.toString().trim();
        if (!text) return hidePill();
        // Only offer commenting on rendered agent replies.
        const inContent = (n) => n && n.parentElement && n.parentElement.closest('.msg-assistant .content');
        if (!inContent(sel.anchorNode) || !inContent(sel.focusNode)) return hidePill();

        pendingRange = sel.getRangeAt(0);
        const r = pendingRange.getBoundingClientRect();
        pill.style.left = (r.left + r.width / 2) + 'px';
        pill.style.top = r.top + 'px';
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
        tray.innerHTML =
            `<div class="qc-head"><span class="qc-count">${quotes.length}</span> ` +
            `${quotes.length === 1 ? 'comment' : 'comments'} on this reply</div>` +
            quotes.map((q, i) => `
                <div class="qc" data-cid="${q.id}">
                    <div class="qc-quote">
                        <span class="qc-num">${i + 1}</span>
                        <span class="qc-text">"${esc(q.text)}"</span>
                        <button class="qc-x" title="Remove" data-x="${q.id}">&times;</button>
                    </div>
                    <textarea class="qc-comment" data-c="${q.id}" rows="1"
                        placeholder="Your reaction to this…">${esc(q.comment)}</textarea>
                </div>`).join('');

        tray.querySelectorAll('.qc-comment').forEach((ta) => {
            autosize(ta);
            ta.addEventListener('input', () => {
                const q = quotes.find((x) => x.id == ta.dataset.c);
                if (q) q.comment = ta.value;
                autosize(ta);
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
        // Hover a chip → flash + scroll its source into view in the transcript.
        tray.querySelectorAll('.qc').forEach((el) => {
            const id = el.dataset.cid;
            el.addEventListener('mouseenter', () => {
                const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
                if (span) {
                    span.classList.add('flash');
                    span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            });
            el.addEventListener('mouseleave', () => {
                const span = messages.querySelector(`.qc-src[data-qid="${id}"]`);
                if (span) span.classList.remove('flash');
            });
        });
    }

    function autosize(ta) {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    }

    // Assemble the pending quotes into the owner's "> quote / --> comment" format,
    // preserving tray order. Quotes left without a comment go through as pure
    // block-quotes so nothing selected is silently dropped.
    function assemble() {
        return quotes.map((q) => (
            q.comment.trim() ? `> ${q.text}\n--> ${q.comment.trim()}` : `> ${q.text}`
        )).join('\n\n');
    }

    const hasContent = () => quotes.length > 0;

    // Per-slot persistence. Store plain data (not DOM refs) so it survives the
    // innerHTML snapshot/restore; highlights are re-linked by data-qid in the
    // restored markup.
    function getQuotes() {
        return quotes.map((q) => ({ id: q.id, text: q.text, comment: q.comment }));
    }
    function setQuotes(arr) {
        quotes = (arr || []).map((q) => ({ id: q.id, text: q.text, comment: q.comment }));
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

    return { init, assemble, hasContent, getQuotes, setQuotes, clear };
})();
