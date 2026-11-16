/**
 * projects.js — the projects column and the chat header (SHE-168, SHE-188).
 *
 * The cockpit's one layout: a column that groups agents by the project
 * (folder) they work in, each with what it is doing in a word, and a header
 * whose chat title is the chat's menu. Chats in the home folder sit under
 * "General ~" and can be moved into a project, keeping their history.
 *
 * Where each control lives follows how often it is used: see
 * docs/plans/active/cockpit-map/prd.md before moving one, and
 * `bin/shellteam-usage` for what the owner really uses.
 *
 * Slots stay owned by app.js. This file draws them and adds the project
 * actions. Loaded after app.js; reads its globals.
 */
const Projects = (() => {
    const EMBEDDED = window.parent && window.parent !== window;
    const OLD_AFTER_MS = 7 * 24 * 3600 * 1000;   // an untouched chat folds away after a week
    const FOLD_MIN = 2;                           // never fold a single chat
    const TOOLS = [['terminal', 'Terminal'], ['apps', 'Apps'], ['browser', 'Browser'], ['settings', 'Settings']];
    const PANELS = [['knowledge', 'Knowledge'], ['files', 'Files'], ['reports', 'Reports'], ['browser', 'Browser']];

    let projects = [];                 // [{ path, name, label }] in the owner's order
    let shell = { tab: 'agents', caps: {}, restartNeeded: false };   // what the dashboard tells us
    let openPanel = null;              // 'knowledge' | 'files' | 'reports' shown beside the chat
    let openPanelUrl = null;
    // The box's browser (SHE-170): who has it, as the server says. null = no browser on this box.
    let browser = null;                // { control: 'agent' | 'owner', holder: chat id | null }
    const browserShown = new Set();    // chats whose browsing already opened the panel once
    const browserClosed = new Set();   // chats where the owner closed it: it stays closed
    let renamingProject = null;
    let dragSlot = null;
    let reportsCache = null;           // for the jump box, fetched by the dashboard
    const pendingAdds = new Map();     // nonce -> callback(project_added message)
    const showOlder = new Set();       // group keys whose older chats are unfolded
    const collapsed = new Set(JSON.parse(localStorage.getItem('pjCollapsed') || '[]'));

    const ICON = {
        terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
        files: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        reports: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
        browser: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
        knowledge: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
        apps: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
        chev: '<path d="m6 9 6 6 6-6"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
        side: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
        bug: '<path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
        restart: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
        git: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12M18 15V9a3 3 0 0 0-3-3h-3"/>',
        chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        back: '<path d="m15 18-6-6 6-6"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        pen: '<path d="M12 20h9"/><path d="M16.4 3.6a2 2 0 0 1 2.8 2.8L7 18.6 3 20l1.4-4z"/>',
        move: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M9 13h6M12.5 10.5 15 13l-2.5 2.5"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        fork: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V8M12 14v2"/>',
        rewind: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
        compact: '<line x1="4" y1="4" x2="20" y2="4"/><polyline points="9 8 12 11 15 8"/><polyline points="9 16 12 13 15 16"/><line x1="4" y1="20" x2="20" y2="20"/>',
        model: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
        unread: '<circle cx="12" cy="12" r="4"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
        key: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        keys: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
    /** The home folder's chats: not a project, so the name is fixed. */
    const GENERAL = 'General';
    const send = (obj) => S.ws?.send(JSON.stringify(obj));
    const post = (kind, extra = {}) => { if (EMBEDDED) window.parent.postMessage({ source: 'shellteam-cockpit', kind, ...extra }, '*'); };
    const slotById = (id) => sessionSlots.find(s => s.id === id);
    const isPhone = () => matchMedia('(max-width: 720px)').matches;

    // ── Data ────────────────────────────────────────────────────────────────

    /** The project a chat belongs to (the deepest one containing its folder), or null. */
    function projectOf(slot) {
        const cwd = slot.config?.cwd || '';
        let best = null;
        for (const p of projects) {
            if ((cwd === p.path || cwd.startsWith(p.path + '/')) && (!best || p.path.length > best.path.length)) best = p;
        }
        return best;
    }

    function spanText(ms) {
        const min = Math.floor(ms / 60000);
        if (min < 1) return '';
        if (min < 60) return `${min} min`;
        if (min < 60 * 24) return `${Math.floor(min / 60)} h`;
        return `${Math.floor(min / 1440)} d`;
    }

    /** What an agent is doing, in one of the column's words (rule 4 of the map):
     *  Needs you, Working, Waiting (on work it left running), Done, or how long ago. */
    function stateOf(slot) {
        const working = slot.isGenerating || slot.pendingSend;
        // It asked for the owner's turn in the browser and stopped: nothing moves until they act.
        if (slot.needsOwner && !working) return { kind: 'ask', text: 'Needs you' };
        if (working && slot.asking) return { kind: 'ask', text: 'Needs you' };
        if (working) {
            const since = slot.turnStartedAt ? spanText(Date.now() - slot.turnStartedAt) : '';
            return { kind: 'work', text: since ? `Working ${since}` : 'Working' };
        }
        // Its turn ended but work it started is still running: not finished (SHE-115).
        if (slot.waitingOn) {
            const since = slot.waitingSince ? spanText(Date.now() - slot.waitingSince) : '';
            return { kind: 'wait', text: since ? `Waiting ${since}` : 'Waiting' };
        }
        if (slotUnread(slot)) {
            const ago = slot.answeredAt ? spanText(Date.now() - slot.answeredAt) : '';
            return { kind: 'new', text: ago ? `Done ${ago}` : 'Done' };
        }
        if (!slot.sessionId) return { kind: '', text: 'New' };
        return { kind: '', text: slot.lastUsedAt ? (spanText(Date.now() - slot.lastUsedAt) || 'now') : '' };
    }

    /** "Waiting on 2 background tasks · 4 min", for the line above the composer. */
    function waitingLine(slot) {
        if (!slot?.waitingOn || slot.isGenerating || slot.pendingSend) return '';
        const since = slot.waitingSince ? spanText(Date.now() - slot.waitingSince) : '';
        return `Waiting on ${slot.waitingOn} background task${slot.waitingOn === 1 ? '' : 's'}${since ? ` · ${since}` : ''}`;
    }

    function isOld(slot) {
        if (slot.id === activeSlotId || !slot.sessionId || stateOf(slot).kind) return false;
        return !!slot.lastUsedAt && Date.now() - slot.lastUsedAt > OLD_AFTER_MS;
    }

    /** [{ key, project|null, slots, shown, hidden }] in display order. */
    function groups() {
        const byPath = new Map(projects.map(p => [p.path, []]));
        const loose = [];
        for (const slot of sessionSlots) {
            const p = projectOf(slot);
            (p ? byPath.get(p.path) : loose).push(slot);
        }
        const fold = (key, slots) => {
            const old = slots.filter(isOld);
            const folded = old.length >= FOLD_MIN && !showOlder.has(key);
            return { shown: folded ? slots.filter(s => !isOld(s)) : slots, hidden: folded ? old.length : 0, foldable: old.length >= FOLD_MIN };
        };
        const out = projects.map(p => ({ key: p.path, project: p, slots: byPath.get(p.path), ...fold(p.path, byPath.get(p.path)) }));
        if (loose.length || !projects.length) out.push({ key: '', project: null, slots: loose, ...fold('', loose) });
        return out;
    }

    /** Chats in the order the column shows them (Alt+Up/Down follow it). */
    function visibleOrder() {
        return groups().flatMap(g => (g.project && collapsed.has(g.key)) ? [] : g.shown);
    }

    /** Agents that need the owner, most urgent first: a question, then the oldest answer. */
    function waiting() {
        const asks = sessionSlots.filter(s => stateOf(s).kind === 'ask' && s.id !== activeSlotId);
        const done = sessionSlots.filter(s => stateOf(s).kind === 'new').sort((a, b) => (a.answeredAt || 0) - (b.answeredAt || 0));
        return [...asks, ...done];
    }
    /** How many agents are in each state: { work, wait, ask, new }. */
    function tally(slots, { elsewhere = false } = {}) {
        const n = { work: 0, wait: 0, ask: 0, new: 0 };
        for (const s of slots) {
            const k = stateOf(s).kind;
            if (k && !(elsewhere && s.id === activeSlotId)) n[k]++;
        }
        return n;
    }
    /** "2 need you" beats "1 done": a question blocks an agent, an answer does not. */
    function needsText(n) {
        if (n.ask) return { kind: 'ask', count: n.ask, words: `need${n.ask === 1 ? 's' : ''} you`, text: `${n.ask} need${n.ask === 1 ? 's' : ''} you` };
        if (n.new) return { kind: 'new', count: n.new, words: 'done', text: `${n.new} done` };
        return null;
    }

    // ── Column ──────────────────────────────────────────────────────────────

    function agentRow(slot) {
        const st = stateOf(slot);
        const active = slot.id === activeSlotId && shell.tab === 'agents';
        const name = escHtml(slotDisplayLabel(slot));
        return `<div class="pj-ag ${st.kind}${active ? ' on' : ''}" data-slot="${slot.id}" draggable="true" role="listitem">
            <button class="pj-ag-open" type="button" data-use="chat.open" title="${escHtml(slotMetaSummary(slot))}" aria-current="${active}">
                <i class="pj-dot ${st.kind}"></i><span class="pj-ag-name">${name}</span><span class="pj-ag-state">${escHtml(st.text)}</span>
            </button>
            <button class="pj-ag-more" type="button" data-use="chat.row-menu" aria-label="Actions for ${name}" title="Rename, move, close">${icon('more')}</button>
        </div>`;
    }

    function groupHtml(g) {
        const rows = g.shown.map(agentRow).join('');
        const older = g.hidden
            ? `<button class="pj-older" type="button" data-older="${escHtml(g.key)}">${g.hidden} older</button>`
            : (g.foldable && showOlder.has(g.key) ? `<button class="pj-older" type="button" data-older="${escHtml(g.key)}">Hide older</button>` : '');
        // Starting an agent is a daily action: a line of its own under each
        // project, always in sight, never a small plus that shows on hover.
        const newLine = (path, label) => S.workspaceLock && !path ? ''
            : `<button class="pj-new" type="button" data-new="${escHtml(path)}" data-use="${path ? 'agent.new' : 'chat.new-general'}">${icon('plus')}${label}</button>`;
        if (!g.project) {
            return `<section class="pj-group pj-loose" data-group="">
                <div class="pj-loose-head"><span class="pj-name">${GENERAL}</span><span class="pj-path" title="Chats in your home folder, not in a project">~</span></div>
                <div role="list">${rows}</div>${older}${newLine('', 'New chat')}</section>`;
        }
        const p = g.project;
        const shut = collapsed.has(p.path);
        const n = tally(g.slots);
        const summary = shut
            ? `<span class="pj-sum">${['ask', 'work', 'wait', 'new'].map(k => n[k] ? `<i class="pj-dot ${k}"></i>${n[k]}` : '').join('')}${Object.values(n).some(Boolean) ? '' : g.slots.length}</span>`
            : '';
        return `<section class="pj-group${shut ? ' shut' : ''}" data-group="${escHtml(p.path)}">
            <div class="pj-head" data-project="${escHtml(p.path)}" data-use="project.fold">
                <button class="pj-fold" type="button" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} the agents of ${escHtml(p.name)}">${icon('chev')}</button>
                <span class="pj-name" title="Double-click to rename">${escHtml(p.name)}</span>
                <span class="pj-path" title="${escHtml(p.label)}">${escHtml(p.label)}</span>
                ${summary}
                <button class="pj-icon pj-head-more" type="button" data-use="project.menu" aria-label="Actions for ${escHtml(p.name)}" title="Rename, reorder, remove">${icon('more')}</button>
            </div>
            ${shut ? '' : `<div role="list">${rows}</div>${older}${newLine(p.path, 'New agent')}`}
        </section>`;
    }

    function render() {
        if (renamingProject || _renamingSlotId !== null) return;
        const side = document.getElementById('pjSide');
        const n = tally(sessionSlots);
        const needs = needsText(n);
        document.getElementById('pjPulse').innerHTML =
            (n.work ? `<span class="pj-chip"><i class="pj-dot work"></i>${n.work} working</span>` : '')
            + (n.wait ? `<span class="pj-chip" title="Their turn ended, but work they started is still running"><i class="pj-dot wait"></i>${n.wait} waiting</span>` : '')
            + (needs ? `<button class="pj-chip ${needs.kind}" type="button" id="pjNextWaiting" data-use="needs-you.column" title="Go to the next agent that needs you (Alt+W)"><i class="pj-dot ${needs.kind}"></i>${needs.text}</button>` : '');
        const list = document.getElementById('pjList');
        const scroll = list.scrollTop;
        list.innerHTML = groups().map(groupHtml).join('')
            + (S.workspaceLock ? '' : `<button class="pj-add" type="button" id="pjAddProject" data-use="project.add">${icon('files')}Open a folder or start a project</button>`)
            // With every chat in a project there is no "General" row to start a loose one from.
            + (projects.length && sessionSlots.every(projectOf) ? `<button class="pj-add" type="button" data-new="" data-use="chat.new-general">${icon('chat')}New chat in ${GENERAL} (~)</button>` : '');
        list.scrollTop = scroll;

        document.getElementById('pjRestart').hidden = !shell.restartNeeded;
        // Tools used weekly: a row at the bottom, where a thumb rests on a
        // phone. Reporting a bug joins it there (on desktop it is by the logo).
        document.getElementById('pjFoot').innerHTML = EMBEDDED ? TOOLS
            .filter(([tab]) => tab !== 'browser' || shell.caps.browser)
            .map(([tab, label]) => `<button class="pj-tool${shell.tab === tab ? ' on' : ''}" type="button" data-tool="${tab}" data-use="tool.${tab}" aria-pressed="${shell.tab === tab}">${icon(tab)}${label}</button>`).join('')
            + `<button class="pj-tool pj-tool-bug" type="button" id="pjFootBug" data-use="feedback.open">${icon('bug')}Report</button>` : '';
        side.classList.toggle('no-foot', !EMBEDDED);
        renderHeader();
        renderFirstRun();
        reportWidth();
    }

    function renderHeader() {
        const slot = slotById(activeSlotId);
        if (!slot) return;
        const p = projectOf(slot);
        // Project, then the chat. While its name is being edited, leave it alone.
        document.getElementById('pjCrumb').textContent = p ? p.name : GENERAL;
        if (_renamingSlotId === null) document.getElementById('pjAgent').textContent = slotDisplayLabel(slot);
        document.getElementById('pjTitle').title = isPhone()
            ? 'Tap for your chats. Hold for this chat\'s menu.'
            : `${p ? p.label : 'Home folder, not in a project'}. Click for this chat's menu: rename, move, fork, rewind, compact, info.`;
        // The three project buttons open in the dashboard's panel beside the chat.
        const tools = document.getElementById('pjTools');
        tools.hidden = !EMBEDDED;
        tools.innerHTML = panelsHere()
            .map(([k, label]) => `<button class="pj-panel-btn${openPanel === k ? ' on' : ''}" type="button" data-panel="${k}" data-use="project.${k}" aria-pressed="${openPanel === k}" title="${label} of ${escHtml(p ? p.name : 'everything on this computer')}">${icon(k)}<span>${label}</span></button>`).join('');
        // Agents that need the owner elsewhere: in words in the header, so
        // going back to the list to check is never needed.
        const n = tally(sessionSlots, { elsewhere: true });
        const needs = needsText(n);
        const chip = document.getElementById('pjNeeds');
        chip.hidden = !needs;
        if (needs) {
            chip.className = `pj-needs ${needs.kind}`;
            // On the narrowest phones the words give way to the model's name: the count stays.
            chip.innerHTML = `<i class="pj-dot ${needs.kind}"></i>${needs.count}<span class="pj-needs-words">&nbsp;${needs.words}</span>`;
            chip.title = `${needs.text}. Go to the next one (Alt+W)`;
            chip.setAttribute('aria-label', chip.title);
        }
        const badge = document.getElementById('pjBackBadge');
        badge.hidden = !needs;
        badge.textContent = n.ask + n.new;
        // The agent stopped for the owner's turn in the browser: said above the
        // composer with the one button that gives them the browser.
        const need = document.getElementById('pjNeedsOwner');
        need.hidden = !slot.needsOwner;
        need.querySelector('span').textContent = slot.needsOwner ? `Needs you in the browser: ${slot.needsOwner}` : '';
        need.querySelector('button').textContent = browser?.control === 'owner' ? 'Hand back' : 'Take control';
        const line = waitingLine(slot);
        const waitEl = document.getElementById('pjWaiting');
        waitEl.hidden = !line;
        waitEl.querySelector('span').textContent = line;
    }
    const panelsHere = () => PANELS.filter(([k]) => (k !== 'knowledge' || shell.caps.knowledge) && (k !== 'browser' || (shell.caps.browser && browser)));

    // ── The chat menu: everything about this chat, behind its title ─────────

    /** Rows of the chat menu. `key` is its letter once the menu is open (also after "/"). */
    function chatMenuRows() {
        const slot = slotById(activeSlotId);
        if (!slot) return [];
        const unread = slot.markedUnread || slotUnread(slot);
        const reports = ReportPanel.listIn(E.messages).length;
        const row = (use, key, ic, label, run, extra = {}) => ({ use, key, ic, label, run, ...extra });
        return [
            row('chat.rename', 'e', 'pen', 'Rename', () => beginRenameOn(document.getElementById('pjAgent'), activeSlotId)),
            S.workspaceLock ? null : row('chat.move', 'v', 'move', projectOf(slot) ? 'Move to another project...' : 'Move to a project...', () => openMoveDialog(activeSlotId)),
            row('chat.unread', 'u', 'unread', unread ? 'Mark as read' : 'Mark as unread', () => setTabUnread(activeSlotId, !unread)),
            'sep',
            row('model.open.menu', 'm', 'model', 'Model', openModelPicker, { value: modelDisplayName(S.currentModel) }),
            row('chat.compact', 'c', 'compact', 'Compact', compactSession),
            row('chat.rewind', 'r', 'rewind', 'Rewind', rewindSession),
            row('chat.fork', 'f', 'fork', 'Fork', forkSession),
            row('chat.new', 'n', 'plus', 'New chat here', newSession, { title: 'Starts over in this place. The conversation stays in Resume.' }),
            row('chat.resume', 's', 'clock', 'Resume a past session', showSessionPicker),
            sessionSlots.length > 1 ? row('chat.close', 'o', 'close', 'Close this chat', () => closeSessionTab(activeSlotId)) : null,
            'sep',
            // On a phone the header has no room for these: they live here.
            reports ? row('reports.open.menu', 'p', 'doc', 'Reports in this chat', () => Menus.toggle('reportsMenu'), { value: String(reports), phone: true }) : null,
            ...(EMBEDDED ? panelsHere().map(([k, label]) => row(`project.${k}.menu`, '', k, `${label} of the project`, () => togglePanel(k), { phone: true })) : []),
            'sep',
            row('chat.info', 'i', 'info', 'Info', () => Menus.toggle('infoPanel')),
        ].filter(Boolean);
    }

    function renderChatMenu() {
        const rows = chatMenuRows();
        const menu = document.getElementById('chatMenu');
        let lastSep = true;
        menu.innerHTML = rows.map((r, i) => {
            if (r === 'sep') { if (lastSep) return ''; lastSep = true; return '<div class="actions-sep" role="separator"></div>'; }
            if (r.phone && !isPhone()) return '';
            lastSep = false;
            const label = r.key && r.label.toLowerCase().includes(r.key)
                ? (() => { const at = r.label.toLowerCase().indexOf(r.key); return `${escHtml(r.label.slice(0, at))}<span class="actions-mn">${escHtml(r.label[at])}</span>${escHtml(r.label.slice(at + 1))}`; })()
                : escHtml(r.label);
            return `<button class="actions-item" type="button" role="menuitem" tabindex="-1" data-row="${i}" data-use="${r.use}"${r.key ? ` data-key="${r.key}"` : ''}${r.title ? ` title="${escHtml(r.title)}"` : ''}>
                ${icon(r.ic)}<span class="actions-label">${label}</span>${r.value ? `<span class="actions-value">${escHtml(r.value)}</span>` : ''}</button>`;
        }).join('');
        menu.onclick = (e) => {
            const item = e.target.closest('[data-row]');
            if (!item) return;
            Menus.hide(false);
            rows[Number(item.dataset.row)].run();
        };
    }

    // The dashboard lays its other screens (Terminal, Settings) next to the
    // column, so it needs the column's width.
    let lastWidth = -1;
    function reportWidth() {
        const side = document.getElementById('pjSide');
        const width = isPhone() ? 0 : side.getBoundingClientRect().width;
        if (width !== lastWidth) { lastWidth = width; post('side', { width }); }
    }

    // ── Project panel beside the chat ───────────────────────────────────────

    function panelUrl(kind) {
        const p = projectOf(slotById(activeSlotId) || {});
        const base = fileBaseUrl();
        const rel = p ? p.path.slice(BOX.home.length + 1) : '';
        // The Reports and Knowledge pages group by the first folder under home.
        const top = rel.split('/')[0];
        if (kind === 'browser') return `${base}/browser?panel=1`;
        if (kind === 'files') return `${base}/_editor/${rel ? encodeRelPath(rel) + '/?dir=1' : ''}`;
        if (kind === 'reports') return `${base}/reports?panel=1${p ? '&workspace=' + encodeURIComponent(top) : ''}`;
        // The open chat too: the Knowledge page shows what it was told (K16).
        const chat = activeSlotId != null ? '&chat=' + encodeURIComponent(activeSlotId) : '';
        return `${base}/knowledge?panel=1${p ? '&project=' + encodeURIComponent(top) : ''}${chat}`;
    }

    function togglePanel(kind) {
        if (openPanel === kind) {
            if (kind === 'browser') browserClosed.add(activeSlotId);
            openPanel = null; post('report-close'); renderHeader(); return;
        }
        showPanel(kind);
        renderHeader();
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    function openAgent(id) {
        if (shell.tab !== 'agents') { shell.tab = 'agents'; post('tool-close'); }
        document.documentElement.classList.remove('pj-list-open');
        if (id !== activeSlotId) switchSessionTab(id);
        else render();
        // A project panel shows one project: follow the agent just opened.
        if (openPanel && panelUrl(openPanel) !== openPanelUrl) showPanel(openPanel);
    }
    function showPanel(kind) {
        openPanel = kind;
        openPanelUrl = panelUrl(kind);
        post('report-open', { url: openPanelUrl, title: panelTitle(kind), tool: true });
    }
    function panelTitle(kind) {
        const p = projectOf(slotById(activeSlotId) || {});
        const label = PANELS.find(([k]) => k === kind)[1];
        // One browser for the whole computer: it belongs to no project.
        return p && kind !== 'browser' ? `${label} · ${p.name}` : label;
    }

    function newAgentIn(path) {
        if (collapsed.delete(path)) saveCollapsed();
        if (shell.tab !== 'agents') { shell.tab = 'agents'; post('tool-close'); }
        document.documentElement.classList.remove('pj-list-open');
        addSessionTab({ cwd: path || BOX.home });
        E.input.focus();
    }

    function nextWaiting() {
        const next = waiting().find(s => s.id !== activeSlotId) || waiting()[0];
        if (next) openAgent(next.id);
        else showInfoToast('No agent is waiting for you');
    }

    function saveCollapsed() { localStorage.setItem('pjCollapsed', JSON.stringify([...collapsed])); }

    function beginRenameProject(path) {
        const span = document.querySelector(`.pj-head[data-project="${CSS.escape(path)}"] .pj-name`);
        const p = projects.find(x => x.path === path);
        if (!span || !p) return;
        renamingProject = path;
        span.contentEditable = 'true';
        span.classList.add('renaming');
        getSelection().selectAllChildren(span);
        span.focus();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const name = span.textContent.trim().slice(0, 40);
            renamingProject = null;
            if (commit && name && name !== p.name) { p.name = name; send({ type: 'rename_project', path, name }); }
            render();
        };
        span.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        span.addEventListener('blur', () => finish(true));
    }

    function moveProject(path, delta) {
        const paths = projects.map(p => p.path);
        const i = paths.indexOf(path), j = i + delta;
        if (i < 0 || j < 0 || j >= paths.length) return;
        [paths[i], paths[j]] = [paths[j], paths[i]];
        projects.sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path));
        send({ type: 'reorder_projects', paths });
        render();
    }

    // One popup menu for agents and projects. It reuses the tab menu's element
    // and global so the existing click-away, Escape and arrow handling apply.
    function popMenu(items, x, y) {
        closeTabMenu();
        const menu = document.createElement('div');
        menu.className = 'actions-menu visible tab-context-menu';
        menu.setAttribute('role', 'menu');
        for (const [label, run, disabledWhy] of items) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'actions-item';
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            if (disabledWhy) { item.disabled = true; item.title = disabledWhy; }
            item.onclick = () => { closeTabMenu(); run(); };
            menu.appendChild(item);
        }
        document.body.appendChild(menu);
        const box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
        _tabMenu = menu;
        menu.querySelector('button:not(:disabled)')?.focus();
    }

    function agentMenu(slotId, x, y) {
        const slot = slotById(slotId);
        if (!slot) return;
        const unread = slot.markedUnread || slotUnread(slot);
        const here = projectOf(slot);
        const siblings = sessionSlots.filter(s => s.id !== slotId && projectOf(s) === here);
        const items = [
            ['Rename', () => { const span = document.querySelector(`.pj-ag[data-slot="${slotId}"] .pj-ag-name`); if (span) beginRenameOn(span, slotId); }],
            [here ? 'Move to another project...' : 'Move to a project...', () => openMoveDialog(slotId)],
            [unread ? 'Mark as read' : 'Mark as unread', () => setTabUnread(slotId, !unread)],
            ['Fork', () => forkTab(slotId)],
        ];
        for (const other of siblings.slice(0, 6)) items.push([`Merge into "${slotDisplayLabel(other)}"`, () => mergeTabs(slotId, other.id)]);
        if (sessionSlots.length > 1) items.push(['Close', () => closeSessionTab(slotId)]);
        popMenu(items, x, y);
    }

    function projectMenu(path, x, y) {
        const p = projects.find(q => q.path === path);
        if (!p) return;
        const i = projects.indexOf(p);
        const busy = sessionSlots.some(s => projectOf(s) === p);
        popMenu([
            ['New agent here', () => newAgentIn(path)],
            ['Rename', () => beginRenameProject(path)],
            ['Move up', () => moveProject(path, -1), i === 0 ? 'Already first' : ''],
            ['Move down', () => moveProject(path, 1), i === projects.length - 1 ? 'Already last' : ''],
            ['Remove from this list', () => send({ type: 'remove_project', path }),
                busy ? 'Close or move its agents first. The folder itself is never deleted.' : ''],
        ], x, y);
    }

    // ── Dialogs ─────────────────────────────────────────────────────────────

    let dialogEl = null;
    function closeDialog() { dialogEl?.remove(); dialogEl = null; }
    function openDialog(html, { wide = false } = {}) {
        closeDialog();
        closeTabMenu();
        const wrap = document.createElement('div');
        wrap.className = 'pj-dialog-wrap';
        wrap.innerHTML = `<div class="pj-dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) closeDialog(); });
        // Capture phase: Escape closes the dialog only, never also stops a running agent.
        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); }
            if (e.key === 'Tab') {
                const f = [...wrap.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }, true);
        document.body.appendChild(wrap);
        dialogEl = wrap;
        return wrap.firstElementChild;
    }
    const dialogError = (box, text) => { const e = box.querySelector('.pj-err'); e.textContent = text || ''; e.hidden = !text; };

    function addProject(payload, done) {
        const nonce = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        pendingAdds.set(nonce, done);
        send({ type: 'add_project', nonce, ...payload });
    }
    function onProjectAdded(msg) {
        const done = pendingAdds.get(msg.nonce);
        pendingAdds.delete(msg.nonce);
        done?.(msg);
    }

    // Folders in home that could become a project (not one already).
    function freeFolders() {
        const taken = new Set(projects.map(p => p.path));
        return _workspaces.filter(w => w.path !== BOX.home && !taken.has(w.path));
    }

    /** "Add a project": a new folder, a folder that exists, or a GitHub repository.
     *  Past the first project, the usual wish is a folder already on the box (SHE-184). */
    function openAddDialog(startMode = projects.length && freeFolders().length ? 'open' : 'new') {
        send({ type: 'list_workspaces' });
        const box = openDialog(`
            <h2>Add a project</h2>
            <p class="pj-sub">A project is a folder on this computer. Agents you start in it work there and share what they learn.</p>
            <div class="pj-seg" role="tablist">
                <button type="button" role="tab" data-mode="new">New</button>
                <button type="button" role="tab" data-mode="open">Existing folder</button>
                <button type="button" role="tab" data-mode="clone">From GitHub</button>
            </div>
            <div class="pj-mode" data-for="new">
                <label for="pjNewName">Name</label>
                <input id="pjNewName" type="text" maxlength="40" placeholder="My project" autocomplete="off">
                <p class="pj-hint" id="pjNewHint">Creates a folder in your home folder.</p>
            </div>
            <div class="pj-mode" data-for="open">
                <label for="pjOpenFilter">Folder</label>
                <input id="pjOpenFilter" type="text" placeholder="Filter, or type a path like ~/work/shop" autocomplete="off">
                <div class="pj-folders" id="pjFolders" role="listbox"></div>
            </div>
            <div class="pj-mode" data-for="clone">
                <label for="pjRepo">Repository</label>
                <input id="pjRepo" type="text" placeholder="owner/name or a github.com address" autocomplete="off">
                <p class="pj-hint">Cloned into your home folder. Private repositories need GitHub connected on this computer.</p>
            </div>
            <p class="pj-err" hidden role="alert"></p>
            <div class="pj-actions"><button type="button" class="pj-btn" data-act="cancel">Cancel</button><button type="button" class="pj-btn primary" data-act="go">Add project</button></div>`);
        let mode = startMode, picked = null;
        const go = box.querySelector('[data-act="go"]');
        const folderSlug = (name) => name.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const drawFolders = () => {
            const q = box.querySelector('#pjOpenFilter').value.trim().toLowerCase();
            const rows = freeFolders().filter(w => !q || w.label.toLowerCase().includes(q)).slice(0, 80);
            box.querySelector('#pjFolders').innerHTML = rows.length
                ? rows.map(w => `<button type="button" role="option" class="pj-folder${picked === w.path ? ' on' : ''}" data-path="${escHtml(w.path)}" aria-selected="${picked === w.path}">${escHtml(w.label)}</button>`).join('')
                : `<div class="pj-none">${q ? 'No folder matches. Press Enter to use what you typed as a path.' : 'Every folder in your home is already a project.'}</div>`;
        };
        const setMode = (m) => {
            mode = m;
            box.querySelectorAll('.pj-seg button').forEach(b => { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-selected', String(b.dataset.mode === m)); });
            box.querySelectorAll('.pj-mode').forEach(d => { d.hidden = d.dataset.for !== m; });
            go.textContent = m === 'clone' ? 'Clone and add' : 'Add project';
            dialogError(box, '');
            if (m === 'open') drawFolders();
            box.querySelector(`.pj-mode[data-for="${m}"] input`).focus();
        };
        const submit = () => {
            const payload = mode === 'new' ? { how: 'new', name: box.querySelector('#pjNewName').value }
                : mode === 'open' ? { how: 'open', path: picked || box.querySelector('#pjOpenFilter').value }
                : { how: 'clone', repo: box.querySelector('#pjRepo').value };
            if (!Object.values(payload)[1]?.trim()) { dialogError(box, mode === 'open' ? 'Pick a folder.' : 'Type a name first.'); return; }
            go.disabled = true;
            go.textContent = mode === 'clone' ? 'Cloning...' : 'Adding...';
            addProject(payload, (msg) => {
                if (msg.error) { go.disabled = false; go.textContent = mode === 'clone' ? 'Clone and add' : 'Add project'; dialogError(box, msg.error); return; }
                closeDialog();
                localStorage.setItem('pjFirstDone', '1');
                startIn(msg.path);
            });
        };
        box.querySelector('.pj-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
        box.querySelector('#pjNewName').addEventListener('input', (e) => {
            const slug = folderSlug(e.target.value);
            box.querySelector('#pjNewHint').textContent = slug ? `Creates the folder ~/${slug}` : 'Creates a folder in your home folder.';
        });
        box.querySelector('#pjOpenFilter').addEventListener('input', () => { picked = null; drawFolders(); });
        box.querySelector('#pjFolders').addEventListener('click', (e) => { const b = e.target.closest('.pj-folder'); if (b) { picked = b.dataset.path; drawFolders(); } });
        box.querySelector('#pjFolders').addEventListener('dblclick', (e) => { if (e.target.closest('.pj-folder')) submit(); });
        box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
        box.querySelector('[data-act="cancel"]').onclick = closeDialog;
        go.onclick = submit;
        box._drawFolders = drawFolders;
        setMode(mode);
    }

    /** Start working in a project: reuse the untouched chat we are on, else open a new one. */
    function startIn(path) {
        const here = slotById(activeSlotId);
        const pristine = here && !here.sessionId && !projectOf(here) && !E.messages.children.length;
        if (pristine) { here.config.cwd = path; send({ type: 'move_slot', slot: here.id, cwd: path }); E.input.focus(); }
        else newAgentIn(path);
    }

    /** "Move to a project": pick it (or create it); the conversation comes along. */
    function openMoveDialog(slotId) {
        const slot = slotById(slotId);
        if (!slot) return;
        const here = projectOf(slot);
        const targets = projects.filter(p => p !== here);
        const name = escHtml(slotDisplayLabel(slot));
        const busy = slot.isGenerating || slot.pendingSend;
        const hasHistory = !!slot.sessionId;
        const box = openDialog(`
            <h2>Move "${name}" to</h2>
            <div class="pj-targets" role="radiogroup">
                ${targets.map((p, i) => `<button type="button" role="radio" class="pj-target${i === 0 ? ' on' : ''}" aria-checked="${i === 0}" data-path="${escHtml(p.path)}"><b>${escHtml(p.name)}</b><code>${escHtml(p.label)}</code></button>`).join('')}
                <button type="button" role="radio" class="pj-target pj-target-new${targets.length ? '' : ' on'}" aria-checked="${!targets.length}" data-path="">${icon('plus')}<span>New project</span></button>
            </div>
            <div class="pj-newname" hidden>
                <input id="pjMoveNew" type="text" maxlength="40" placeholder="Name of the new project" autocomplete="off">
                <p class="pj-hint" id="pjMoveHint">Creates a folder in your home folder.</p>
            </div>
            <label class="pj-check"><input type="checkbox" id="pjMoveIn" ${hasHistory ? 'checked' : 'disabled'}><span><b>The agent moves in</b>It brings the files it created into the project and writes the project's first notes, so the next agent there knows the story.</span></label>
            <label class="pj-check" id="pjRepoRow" hidden><input type="checkbox" id="pjMoveRepo"><span><b>Put it on GitHub, private</b>The agent creates a private repository for the project and pushes it.</span></label>
            <p class="pj-note">${busy ? 'This agent is working. You can move it when it finishes.' : hasHistory ? 'The whole conversation comes along.' : 'This chat is empty, so it simply starts in the project.'}</p>
            <p class="pj-err" hidden role="alert"></p>
            <div class="pj-actions"><button type="button" class="pj-btn" data-act="cancel">Cancel</button><button type="button" class="pj-btn primary" data-act="go" ${busy ? 'disabled' : ''}>Move</button></div>`);
        let target = targets[0]?.path ?? '';
        const go = box.querySelector('[data-act="go"]');
        const moveIn = box.querySelector('#pjMoveIn'), repo = box.querySelector('#pjMoveRepo');
        const sync = () => {
            box.querySelectorAll('.pj-target').forEach(b => { const on = b.dataset.path === target; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
            const fresh = target === '';
            box.querySelector('.pj-newname').hidden = !fresh;
            // A private repository is offered for a brand-new project only: an
            // existing folder keeps whatever git setup it has.
            box.querySelector('#pjRepoRow').hidden = !(fresh && hasHistory && moveIn.checked);
            if (fresh) box.querySelector('#pjMoveNew').focus();
        };
        const fail = (text) => { go.disabled = false; go.textContent = 'Move'; dialogError(box, text); };
        const move = (path, createRepo) => {
            // The server answers with slot_moved (success) or an error for this slot.
            send({ type: 'move_slot', slot: slotId, cwd: path, moveIn: moveIn.checked, createRepo });
            closeDialog();
            if (collapsed.delete(path)) saveCollapsed();
        };
        const submit = () => {
            if (go.disabled) return;
            if (target) return move(target, false);
            const newName = box.querySelector('#pjMoveNew').value.trim();
            if (!newName) return dialogError(box, 'Give the new project a name.');
            go.disabled = true; go.textContent = 'Creating...';
            addProject({ how: 'new', name: newName }, (msg) => msg.error ? fail(msg.error) : move(msg.path, repo.checked && !box.querySelector('#pjRepoRow').hidden));
        };
        box.querySelector('.pj-targets').addEventListener('click', (e) => { const b = e.target.closest('.pj-target'); if (b) { target = b.dataset.path; sync(); } });
        box.querySelector('.pj-targets').addEventListener('dblclick', (e) => { if (e.target.closest('.pj-target')?.dataset.path) submit(); });
        box.querySelector('#pjMoveNew').addEventListener('input', (e) => {
            const slug = e.target.value.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            box.querySelector('#pjMoveHint').textContent = slug ? `Creates the folder ~/${slug}` : 'Creates a folder in your home folder.';
        });
        moveIn.addEventListener('change', sync);
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.type !== 'checkbox') { e.preventDefault(); submit(); }
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.pj-targets')) {
                e.preventDefault();
                const all = [...box.querySelectorAll('.pj-target')];
                const next = all[(all.indexOf(e.target.closest('.pj-target')) + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
                target = next.dataset.path; sync(); next.focus();
            }
        });
        box.querySelector('[data-act="cancel"]').onclick = closeDialog;
        go.onclick = submit;
        sync();
        // GitHub connected? Then a new project goes to a private repository by default.
        fetch('/api/github/status').then(r => r.ok ? r.json() : null).then(s => { if (s?.authenticated && dialogEl) { repo.checked = true; } }).catch(() => {});
        (box.querySelector('.pj-target.on') || go).focus();
    }

    // ── Jump box (Ctrl+K) ───────────────────────────────────────────────────

    function jumpItems() {
        const items = [];
        for (const g of groups()) for (const slot of g.slots) {
            const st = stateOf(slot);
            items.push({ kind: st.kind, label: slotDisplayLabel(slot), sub: g.project ? g.project.name : `${GENERAL} ~`, tag: st.text, run: () => openAgent(slot.id) });
        }
        for (const p of projects) items.push({ icon: 'plus', label: `New agent in ${p.name}`, sub: p.label, run: () => newAgentIn(p.path) });
        // A folder with no agent yet is one step away: it becomes a project and the agent starts there (SHE-184).
        if (!S.workspaceLock) for (const w of freeFolders()) items.push({ icon: 'plus', label: `Start an agent in ${w.label}`, sub: 'Folder, added as a project', run: () => openFolder(w.path) });
        if (!S.workspaceLock) items.push({ icon: 'plus', label: 'Add a project', sub: 'New, existing folder or GitHub', run: () => openAddDialog() });
        // Rare actions that used to sit behind a gear in every chat header.
        items.push({ icon: 'key', label: 'Agent sign-in', sub: 'Connect Claude, Codex, Antigravity or Pi', run: openAIConfig });
        items.push({ icon: 'terminal', label: 'Console mode', sub: 'This agent as a raw terminal', run: () => TerminalMode.toggle() });
        items.push({ icon: 'keys', label: 'Keyboard shortcuts', sub: 'Press ? anywhere', run: showShortcutsHelp });
        if (EMBEDDED) {
            for (const [tab, label] of TOOLS) if (tab !== 'browser' || shell.caps.browser) items.push({ icon: tab, label, sub: 'Tool', run: () => openTool(tab) });
            for (const r of reportsCache || []) items.push({ icon: 'reports', label: r.title || r.name, sub: r.workspace ? `Report · ${r.workspace}` : 'Report', run: () => ReportPanel.show(`${fileBaseUrl()}/${encodeRelPath(r.path)}`, r.title || r.name) });
        }
        return items;
    }

    function openFolder(path) {
        addProject({ how: 'open', path }, (msg) => {
            // Said where the owner can pick another folder, never dropped.
            if (msg.error) { openAddDialog('open'); dialogError(dialogEl.firstElementChild, msg.error); return; }
            startIn(msg.path);
        });
    }

    function openJump() {
        if (EMBEDDED && !reportsCache) post('reports-list');
        if (!S.workspaceLock) send({ type: 'list_workspaces' });
        const box = openDialog(`
            <div class="pj-jump-in">${icon('search')}<input id="pjJumpInput" type="text" placeholder="Jump to an agent, a project or a report" autocomplete="off" aria-label="Jump to" aria-controls="pjJumpList"></div>
            <div class="pj-jump-list" id="pjJumpList" role="listbox"></div>`, { wide: true });
        box.classList.add('pj-jump');
        const input = box.querySelector('input'), list = box.querySelector('#pjJumpList');
        let shown = [], at = 0;
        const draw = () => {
            const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
            shown = jumpItems().filter(it => words.every(w => `${it.label} ${it.sub}`.toLowerCase().includes(w))).slice(0, 60);
            at = Math.min(at, Math.max(0, shown.length - 1));
            list.innerHTML = shown.length ? shown.map((it, i) => `<button type="button" role="option" class="pj-jump-item${i === at ? ' on' : ''}" data-i="${i}" aria-selected="${i === at}">
                ${it.icon ? icon(it.icon) : `<i class="pj-dot ${it.kind}"></i>`}<span class="pj-jump-label">${escHtml(it.label)}</span><span class="pj-jump-sub">${escHtml(it.sub)}</span>${it.tag ? `<span class="pj-ag-state ${it.kind}">${escHtml(it.tag)}</span>` : ''}</button>`).join('')
                : '<div class="pj-none">Nothing matches</div>';
            list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
        };
        const run = (i) => { const it = shown[i]; if (!it) return; closeDialog(); it.run(); };
        input.addEventListener('input', () => { at = 0; draw(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % (shown.length || 1); draw(); }
            else if (e.key === 'Enter') { e.preventDefault(); run(at); }
        });
        list.addEventListener('click', (e) => { const b = e.target.closest('.pj-jump-item'); if (b) run(Number(b.dataset.i)); });
        box._redraw = draw;
        draw();
        input.focus();
    }

    function openTool(tab) {
        const next = shell.tab === tab ? 'agents' : tab;
        shell.tab = next;
        post(next === 'agents' ? 'tool-close' : 'tool-open', { tab: next });
        render();
    }

    // ── First screen ────────────────────────────────────────────────────────

    function renderFirstRun() {
        const el = document.getElementById('pjFirst');
        const show = !S.workspaceLock && !projects.length && !localStorage.getItem('pjFirstDone')
            && sessionSlots.every(s => !s.sessionId) && !E.messages.children.length && isAuthed();
        el.hidden = !show;
        E.emptyState.classList.toggle('pj-covered', show);
    }

    // ── Wiring ──────────────────────────────────────────────────────────────

    // ── The browser beside the chat (SHE-170) ───────────────────────────────

    /** What the live view's bar shows, sent to the dashboard which passes it on. */
    function tellBrowserState() {
        const holder = browser?.holder != null ? slotById(Number(browser.holder)) : null;
        const asker = sessionSlots.find(s => s.needsOwner);
        post('browser-state', {
            control: browser?.control || 'agent',
            holder: holder ? slotDisplayLabel(holder) : (browser?.holder === 'terminal' ? 'An agent in the terminal' : ''),
            ask: asker ? { chat: slotDisplayLabel(asker), what: asker.needsOwner } : null,
        });
    }
    function setBrowser(state) { browser = state; tellBrowserState(); render(); }
    function setControl(take) { Use.count(take ? 'browser.take-control' : 'browser.hand-back'); send({ type: 'browser_control', take }); }

    /** This chat's agent started browsing: the browser opens beside the chat,
     *  the first time. Closed by the owner, it stays closed for this chat. */
    function showBrowserFor(chat, { force = false } = {}) {
        if (!EMBEDDED || !shell.caps.browser || chat !== activeSlotId) return;
        if (!force && (browserShown.has(chat) || browserClosed.has(chat) || shell.tab !== 'agents')) return;
        browserShown.add(chat);
        // A report or a project view is already open: do not take it away.
        if (!force && openPanel && openPanel !== 'browser') return;
        showPanel('browser');
        renderHeader();
    }

    function setProjects(list) { projects = list; if (dialogEl?.firstElementChild._drawFolders) dialogEl.firstElementChild._drawFolders(); render(); }

    // A question lights up, and clears, the moment it happens: status broadcasts
    // (which carry `asking`) are not sent on every event.
    function note(msg, slotId) {
        const slot = slotById(slotId);
        if (!slot) return;
        if (msg.type === 'browser_event') {
            if (msg.event === 'browsing' || msg.event === 'ask') showBrowserFor(msg.chat);
            return;
        }
        if (msg.type === 'waiting_on') { slot.waitingOn = msg.waitingOn || 0; slot.waitingSince = msg.waitingSince || 0; render(); }
        else if (msg.type === 'ask_user') { slot.asking = true; render(); }
        else if (['turn_done', 'text_delta', 'tool_start'].includes(msg.type) && slot.asking) { slot.asking = false; render(); }
        if (msg.type === 'workspaces_list') setTimeout(() => { dialogEl?.firstElementChild._drawFolders?.(); dialogEl?.firstElementChild._redraw?.(); }, 0);
    }

    function onDashboardMessage(d) {
        if (d.kind === 'shell-state') { shell = { tab: d.tab, caps: d.caps || {}, restartNeeded: !!d.restartNeeded }; if (d.panelOpen === false) openPanel = null; render(); }
        else if (d.kind === 'panel-closed') { if (openPanel === 'browser') browserClosed.add(activeSlotId); openPanel = null; renderHeader(); }
        // The live view's bar: the owner takes the browser or hands it back.
        else if (d.kind === 'browser-control') setControl(d.take === true);
        else if (d.kind === 'browser-hello') tellBrowserState();
        else if (d.kind === 'cockpit-action') {
            // Settings holds what the header gear used to: it asks us to run it.
            const run = { 'sign-in': openAIConfig, 'console': () => TerminalMode.toggle(), 'shortcuts': showShortcutsHelp }[d.action];
            if (run) { shell.tab = 'agents'; render(); run(); }
        }
        else if (d.kind === 'reports-list') { reportsCache = d.reports || []; dialogEl?.firstElementChild._redraw?.(); }
    }

    function init() {
        const side = document.getElementById('pjSide');
        side.hidden = false;
        if (localStorage.getItem('pjSideShut') === '1') document.documentElement.classList.add('pj-side-shut');

        side.addEventListener('click', (e) => {
            const t = e.target;
            if (t.closest('#pjCollapse')) return toggleSide();
            if (t.closest('#pjFeedback, #pjFootBug')) return post('feedback-open');
            if (t.closest('#pjJump')) return openJump();
            if (t.closest('#pjNextWaiting')) return nextWaiting();
            if (t.closest('#pjAddProject')) return openAddDialog();
            if (t.closest('#pjRestart')) { t.closest('#pjRestart').querySelector('span').textContent = 'Restarting...'; return post('restart-click'); }
            const tool = t.closest('[data-tool]');
            if (tool) return openTool(tool.dataset.tool);
            const older = t.closest('[data-older]');
            if (older) { const k = older.dataset.older; showOlder.has(k) ? showOlder.delete(k) : showOlder.add(k); return render(); }
            const add = t.closest('[data-new]');
            if (add) return newAgentIn(add.dataset.new);
            const more = t.closest('.pj-ag-more');
            if (more) { const r = more.getBoundingClientRect(); return agentMenu(Number(more.closest('.pj-ag').dataset.slot), r.left, r.bottom + 4); }
            const headMore = t.closest('.pj-head-more');
            if (headMore) { const r = headMore.getBoundingClientRect(); return projectMenu(headMore.closest('.pj-head').dataset.project, r.left, r.bottom + 4); }
            const ag = t.closest('.pj-ag');
            if (ag) { if (_renamingSlotId === null) openAgent(Number(ag.dataset.slot)); return; }
            const head = t.closest('.pj-head');
            // The name itself is for renaming (double-click); the rest of the row folds.
            if (head && !renamingProject && !t.closest('.pj-name')) {
                const path = head.dataset.project;
                collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path);
                saveCollapsed();
                render();
            }
        });
        side.addEventListener('dblclick', (e) => {
            const name = e.target.closest('.pj-name');
            if (name) return beginRenameProject(name.closest('.pj-head').dataset.project);
            const agName = e.target.closest('.pj-ag-name');
            if (agName) beginRenameOn(agName, Number(agName.closest('.pj-ag').dataset.slot));
        });
        side.addEventListener('contextmenu', (e) => {
            const ag = e.target.closest('.pj-ag'), head = e.target.closest('.pj-head');
            if (!ag && !head) return;
            e.preventDefault();
            const at = e.clientX || e.clientY ? { left: e.clientX, bottom: e.clientY } : (ag || head).getBoundingClientRect();
            if (ag) agentMenu(Number(ag.dataset.slot), at.left, at.bottom);
            else projectMenu(head.dataset.project, at.left, at.bottom);
        });

        // Drag an agent: onto another agent of the same group to reorder, onto
        // a project (or its agents) to move it there.
        side.addEventListener('dragstart', (e) => {
            const ag = e.target.closest('.pj-ag');
            if (!ag) return;
            dragSlot = Number(ag.dataset.slot);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(dragSlot));
            ag.classList.add('dragging');
        });
        const clearDrop = () => side.querySelectorAll('.drop, .drop-before, .drop-after').forEach(n => n.classList.remove('drop', 'drop-before', 'drop-after'));
        side.addEventListener('dragover', (e) => {
            if (dragSlot === null) return;
            const group = e.target.closest('.pj-group');
            if (!group) return;
            e.preventDefault();
            clearDrop();
            const from = projectOf(slotById(dragSlot) || {});
            const same = (from?.path || '') === group.dataset.group;
            const ag = e.target.closest('.pj-ag');
            if (same && ag && Number(ag.dataset.slot) !== dragSlot) {
                const r = ag.getBoundingClientRect();
                ag.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
            } else if (!same && group.dataset.group) {
                group.classList.add('drop');
            }
        });
        side.addEventListener('drop', (e) => {
            if (dragSlot === null) return;
            e.preventDefault();
            const before = side.querySelector('.drop-before'), after = side.querySelector('.drop-after'), group = side.querySelector('.pj-group.drop');
            const id = dragSlot;
            if (before || after) commitTabReorder(id, Number((before || after).dataset.slot), !!before);
            else if (group) {
                const slot = slotById(id);
                if (slot && !slot.sessionId) send({ type: 'move_slot', slot: id, cwd: group.dataset.group });
                else openMoveDialogTo(id, group.dataset.group);
            }
        });
        side.addEventListener('dragend', () => { dragSlot = null; clearDrop(); side.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging')); });

        document.getElementById('pjTools').addEventListener('click', (e) => { const b = e.target.closest('[data-panel]'); if (b) togglePanel(b.dataset.panel); });
        document.getElementById('pjBack').addEventListener('click', () => {
            if (isPhone()) showList(true);
            else toggleSide();
        });
        document.getElementById('pjNeeds').addEventListener('click', nextWaiting);
        document.getElementById('pjNeedsOwner').querySelector('button').addEventListener('click', () => {
            if (browser?.control === 'owner') return setControl(false);
            showBrowserFor(activeSlotId, { force: true });
            setControl(true);
        });
        wireTitle(document.getElementById('pjTitle'));
        onSwipe(document.querySelector('.chat-main'), 'right', () => isPhone() && showList(true));
        onSwipe(side, 'left', () => isPhone() && showList(false));
        document.getElementById('pjFirst').addEventListener('click', (e) => {
            const b = e.target.closest('[data-first]');
            if (!b) return;
            if (b.dataset.first === 'chat') { localStorage.setItem('pjFirstDone', '1'); render(); E.input.focus(); }
            else openAddDialog(b.dataset.first);
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); dialogEl?.querySelector('.pj-jump') ? closeDialog() : openJump(); }
            else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW') { e.preventDefault(); nextWaiting(); }
        }, true);
        addEventListener('resize', reportWidth);
        // "Working 4 min" and "3 h" move on by themselves.
        setInterval(() => { if (!document.hidden && !dialogEl) render(); }, 30000);
        post('side-ready');
        render();
    }

    function showList(open) { document.documentElement.classList.toggle('pj-list-open', open); }

    /** The chat title. Desktop: a click opens the chat menu. Phone: a tap goes
     *  back to the chats (far more frequent than forking) and a long press
     *  opens the menu; the first tap says so, once. */
    function wireTitle(title) {
        const HOLD_MS = 450;
        let hold = null, held = false;
        const openMenu = () => { if (_renamingSlotId === null) Menus.toggle('chatMenu'); };
        title.addEventListener('touchstart', () => {
            held = false;
            clearTimeout(hold);
            hold = setTimeout(() => { held = true; Use.count('chat.menu.hold'); navigator.vibrate?.(10); openMenu(); }, HOLD_MS);
        }, { passive: true });
        // Lifting the finger after a long press makes a click, which lands on
        // the menu's backdrop (now under the finger) and would close the menu
        // at once: that one click is swallowed.
        title.addEventListener('touchend', () => {
            clearTimeout(hold);
            if (!held) return;
            held = false;
            const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
            document.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 700);
        }, { passive: true });
        for (const ev of ['touchmove', 'touchcancel']) title.addEventListener(ev, () => clearTimeout(hold), { passive: true });
        // A long press also raises the browser's own menu on Android: ours is the answer.
        title.addEventListener('contextmenu', (e) => e.preventDefault());
        title.addEventListener('click', (e) => {
            if (_renamingSlotId !== null) return;
            if (!isPhone()) return openMenu();
            showList(true);
            if (!localStorage.getItem('pjHoldHintSeen')) {
                localStorage.setItem('pjHoldHintSeen', '1');
                showInfoToast('Hold the title for this chat\'s menu: rename, fork, rewind, compact');
            }
        });
        title.addEventListener('keydown', (e) => {
            if (e.target !== title || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            openMenu();
        });
    }

    /** A deliberate horizontal swipe: mostly sideways, long enough, and not one
     *  that scrolls something wide (a code block, a table) or edits text. */
    function onSwipe(el, dir, run) {
        let x0 = null, y0 = 0;
        el.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            const inScroller = e.target.closest('pre, table, textarea, input, [contenteditable], .pj-dialog');
            x0 = e.touches.length === 1 && !inScroller && !dialogEl ? t.clientX : null;
            y0 = t.clientY;
        }, { passive: true });
        el.addEventListener('touchend', (e) => {
            if (x0 === null) return;
            const t = e.changedTouches[0], dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
            x0 = null;
            if ((dir === 'right' ? dx : -dx) > 70 && dy < Math.abs(dx) / 2) run();
        }, { passive: true });
    }

    function openMoveDialogTo(slotId, path) {
        openMoveDialog(slotId);
        dialogEl?.querySelector(`.pj-target[data-path="${CSS.escape(path)}"]`)?.click();
    }

    function toggleSide() {
        const shut = document.documentElement.classList.toggle('pj-side-shut');
        localStorage.setItem('pjSideShut', shut ? '1' : '0');
        reportWidth();
    }

    init();
    return { render, renderChatMenu, setProjects, setBrowser, note, onDashboardMessage, onProjectAdded, visibleOrder, openMoveDialog, projectOf, dragging: () => dragSlot !== null,
        // What the owner sees for a chat, for tests and for the dashboard.
        stateOf, waitingLine, chatMenuRows };
})();
window.Projects = Projects;
