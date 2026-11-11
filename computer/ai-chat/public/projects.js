/**
 * projects.js — the projects column (SHE-168).
 *
 * Replaces the row of tabs with a column that groups agents by the project
 * (folder) they work in. Each agent shows what it is doing; chats in the home
 * folder sit under "Not in a project" and can be moved into one, keeping their
 * history. The column is on only when the page is opened with
 * ?layout=projects (the dashboard adds it from the Settings switch); without
 * it nothing here renders and the tab row is untouched.
 *
 * Slots stay owned by app.js. This file only draws them another way and adds
 * the project actions. Loaded after app.js; reads its globals.
 */
const Projects = (() => {
    const ON = document.documentElement.classList.contains('layout-projects');
    const EMBEDDED = window.parent && window.parent !== window;
    const OLD_AFTER_MS = 7 * 24 * 3600 * 1000;   // an untouched chat folds away after a week
    const FOLD_MIN = 2;                           // never fold a single chat
    const TOOLS = [['terminal', 'Terminal'], ['apps', 'Apps'], ['browser', 'Browser'], ['settings', 'Settings']];
    const PANELS = [['knowledge', 'Knowledge'], ['files', 'Files'], ['reports', 'Reports']];

    let projects = [];                 // [{ path, name, label }] in the owner's order
    let shell = { tab: 'agents', caps: {}, restartNeeded: false };   // what the dashboard tells us
    let openPanel = null;              // 'knowledge' | 'files' | 'reports' shown beside the chat
    let openPanelUrl = null;
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
    };
    const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
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

    /** What an agent is doing, in the column's four words. */
    function stateOf(slot) {
        const working = slot.isGenerating || slot.pendingSend;
        if (working && slot.asking) return { kind: 'ask', text: 'Has a question' };
        if (working) {
            const since = slot.turnStartedAt ? spanText(Date.now() - slot.turnStartedAt) : '';
            return { kind: 'work', text: since ? `Working ${since}` : 'Working' };
        }
        if (slotUnread(slot)) {
            const ago = slot.answeredAt ? spanText(Date.now() - slot.answeredAt) : '';
            return { kind: 'new', text: ago ? `Done ${ago}` : 'Done' };
        }
        if (!slot.sessionId) return { kind: '', text: 'New' };
        return { kind: '', text: slot.lastUsedAt ? (spanText(Date.now() - slot.lastUsedAt) || 'now') : '' };
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
        if (!ON) return null;
        return groups().flatMap(g => (g.project && collapsed.has(g.key)) ? [] : g.shown);
    }

    /** Agents that need the owner, most urgent first: a question, then the oldest answer. */
    function waiting() {
        const asks = sessionSlots.filter(s => stateOf(s).kind === 'ask' && s.id !== activeSlotId);
        const done = sessionSlots.filter(s => stateOf(s).kind === 'new').sort((a, b) => (a.answeredAt || 0) - (b.answeredAt || 0));
        return [...asks, ...done];
    }

    // ── Column ──────────────────────────────────────────────────────────────

    function agentRow(slot) {
        const st = stateOf(slot);
        const active = slot.id === activeSlotId && shell.tab === 'agents';
        const name = escHtml(slotDisplayLabel(slot));
        return `<div class="pj-ag ${st.kind}${active ? ' on' : ''}" data-slot="${slot.id}" draggable="true" role="listitem">
            <button class="pj-ag-open" type="button" title="${escHtml(slotMetaSummary(slot))}" aria-current="${active}">
                <i class="pj-dot ${st.kind}"></i><span class="pj-ag-name">${name}</span><span class="pj-ag-state">${escHtml(st.text)}</span>
            </button>
            <button class="pj-ag-more" type="button" aria-label="Actions for ${name}" title="Rename, move, close">${icon('more')}</button>
        </div>`;
    }

    function groupHtml(g) {
        const rows = g.shown.map(agentRow).join('');
        const older = g.hidden
            ? `<button class="pj-older" type="button" data-older="${escHtml(g.key)}">${g.hidden} older</button>`
            : (g.foldable && showOlder.has(g.key) ? `<button class="pj-older" type="button" data-older="${escHtml(g.key)}">Hide older</button>` : '');
        if (!g.project) {
            const label = projects.length ? 'Not in a project' : 'Chats';
            return `<section class="pj-group pj-loose" data-group="">
                <div class="pj-loose-head"><span>${label}</span><button class="pj-icon" type="button" data-new="" title="New chat, not in a project" aria-label="New chat, not in a project">${icon('plus')}</button></div>
                <div role="list">${rows}</div>${older}</section>`;
        }
        const p = g.project;
        const shut = collapsed.has(p.path);
        const work = g.slots.filter(s => stateOf(s).kind === 'work').length;
        const wait = g.slots.filter(s => ['new', 'ask'].includes(stateOf(s).kind)).length;
        const summary = shut
            ? `<span class="pj-sum">${work ? `<i class="pj-dot work"></i>${work}` : ''}${wait ? `<i class="pj-dot new"></i>${wait}` : ''}${!work && !wait ? g.slots.length : ''}</span>`
            : '';
        return `<section class="pj-group${shut ? ' shut' : ''}" data-group="${escHtml(p.path)}">
            <div class="pj-head" data-project="${escHtml(p.path)}">
                <button class="pj-fold" type="button" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} the agents of ${escHtml(p.name)}">${icon('chev')}</button>
                <span class="pj-name" title="Double-click to rename">${escHtml(p.name)}</span>
                <span class="pj-path" title="${escHtml(p.label)}">${escHtml(p.label)}</span>
                ${summary}
                <button class="pj-icon" type="button" data-new="${escHtml(p.path)}" title="New agent in ${escHtml(p.name)}" aria-label="New agent in ${escHtml(p.name)}">${icon('plus')}</button>
                <button class="pj-icon pj-head-more" type="button" aria-label="Actions for ${escHtml(p.name)}" title="Rename, reorder, remove">${icon('more')}</button>
            </div>
            ${shut ? '' : `<div role="list">${rows || '<div class="pj-none">No agent here yet</div>'}</div>${older}`}
        </section>`;
    }

    function render() {
        if (!ON || renamingProject || _renamingSlotId !== null) return;
        const side = document.getElementById('pjSide');
        const work = sessionSlots.filter(s => ['work'].includes(stateOf(s).kind)).length;
        const wait = sessionSlots.filter(s => ['new', 'ask'].includes(stateOf(s).kind)).length;
        document.getElementById('pjPulse').innerHTML =
            (work ? `<span class="pj-chip"><i class="pj-dot work"></i>${work} working</span>` : '')
            + (wait ? `<button class="pj-chip wait" type="button" id="pjNextWaiting" title="Go to the next agent waiting for you (Alt+W)"><i class="pj-dot new"></i>${wait} waiting for you</button>` : '');
        const list = document.getElementById('pjList');
        const scroll = list.scrollTop;
        list.innerHTML = groups().map(groupHtml).join('')
            + (S.workspaceLock ? '' : `<button class="pj-add" type="button" id="pjAddProject">${icon('plus')}Add a project</button>`)
            // With every chat in a project there is no "Not in a project" row to start a loose one from.
            + (projects.length && sessionSlots.every(projectOf) ? `<button class="pj-add" type="button" data-new="">${icon('chat')}New chat, not in a project</button>` : '');
        list.scrollTop = scroll;

        document.getElementById('pjRestart').hidden = !shell.restartNeeded;
        document.getElementById('pjFoot').innerHTML = EMBEDDED ? TOOLS
            .filter(([tab]) => tab !== 'browser' || shell.caps.browser)
            .map(([tab, label]) => `<button class="pj-tool${shell.tab === tab ? ' on' : ''}" type="button" data-tool="${tab}" aria-pressed="${shell.tab === tab}">${icon(tab)}${label}</button>`).join('') : '';
        side.classList.toggle('no-foot', !EMBEDDED);
        renderHeader();
        renderFirstRun();
        reportWidth();
    }

    function renderHeader() {
        const slot = slotById(activeSlotId);
        const crumb = document.getElementById('pjCrumb');
        if (!slot) return;
        const p = projectOf(slot);
        crumb.innerHTML = `${p ? `<span class="pj-crumb-proj">${escHtml(p.name)}</span><span class="pj-crumb-sep">/</span>` : ''}<span class="pj-crumb-agent" title="Double-click to rename">${escHtml(slotDisplayLabel(slot))}</span>`;
        // The three project buttons open in the dashboard's panel beside the chat.
        const tools = document.getElementById('pjTools');
        tools.hidden = !EMBEDDED;
        tools.innerHTML = PANELS
            .filter(([k]) => k !== 'knowledge' || shell.caps.knowledge)
            .map(([k, label]) => `<button class="pj-panel-btn${openPanel === k ? ' on' : ''}" type="button" data-panel="${k}" aria-pressed="${openPanel === k}" title="${label} of ${escHtml(p ? p.name : 'everything on this computer')}">${icon(k)}<span>${label}</span></button>`).join('');
        const waitingElsewhere = waiting().filter(s => s.id !== activeSlotId).length;
        const badge = document.getElementById('pjBackBadge');
        badge.hidden = !waitingElsewhere;
        badge.textContent = waitingElsewhere;
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
        if (kind === 'files') return `${base}/_editor/${rel ? encodeRelPath(rel) + '/?dir=1' : ''}`;
        if (kind === 'reports') return `${base}/reports?panel=1${p ? '&workspace=' + encodeURIComponent(top) : ''}`;
        return `${base}/knowledge?panel=1${p ? '&project=' + encodeURIComponent(top) : ''}`;
    }

    function togglePanel(kind) {
        if (openPanel === kind) { openPanel = null; post('report-close'); renderHeader(); return; }
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
        return p ? `${label} · ${p.name}` : label;
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

    /** "Add a project": a new folder, a folder that exists, or a GitHub repository. */
    function openAddDialog(startMode = 'new') {
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
            items.push({ kind: st.kind, label: slotDisplayLabel(slot), sub: g.project ? g.project.name : 'Not in a project', tag: st.text, run: () => openAgent(slot.id) });
        }
        for (const p of projects) items.push({ icon: 'plus', label: `New agent in ${p.name}`, sub: p.label, run: () => newAgentIn(p.path) });
        if (!S.workspaceLock) items.push({ icon: 'plus', label: 'Add a project', sub: 'New, existing folder or GitHub', run: () => openAddDialog() });
        if (EMBEDDED) {
            for (const [tab, label] of TOOLS) if (tab !== 'browser' || shell.caps.browser) items.push({ icon: tab, label, sub: 'Tool', run: () => openTool(tab) });
            for (const r of reportsCache || []) items.push({ icon: 'reports', label: r.title || r.name, sub: r.workspace ? `Report · ${r.workspace}` : 'Report', run: () => ReportPanel.show(`${fileBaseUrl()}/${encodeRelPath(r.path)}`, r.title || r.name) });
        }
        return items;
    }

    function openJump() {
        if (EMBEDDED && !reportsCache) post('reports-list');
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

    function setProjects(list) { projects = list; if (dialogEl?.firstElementChild._drawFolders) dialogEl.firstElementChild._drawFolders(); render(); }

    // A question lights up, and clears, the moment it happens: status broadcasts
    // (which carry `asking`) are not sent on every event.
    function note(msg, slotId) {
        if (!ON) return;
        const slot = slotById(slotId);
        if (!slot) return;
        if (msg.type === 'ask_user') { slot.asking = true; render(); }
        else if (['turn_done', 'text_delta', 'tool_start'].includes(msg.type) && slot.asking) { slot.asking = false; render(); }
        if (msg.type === 'workspaces_list' && dialogEl?.firstElementChild._drawFolders) setTimeout(() => dialogEl?.firstElementChild._drawFolders?.(), 0);
    }

    function onDashboardMessage(d) {
        if (!ON) return;
        if (d.kind === 'shell-state') { shell = { tab: d.tab, caps: d.caps || {}, restartNeeded: !!d.restartNeeded }; if (d.panelOpen === false) openPanel = null; render(); }
        else if (d.kind === 'panel-closed') { openPanel = null; renderHeader(); }
        else if (d.kind === 'reports-list') { reportsCache = d.reports || []; dialogEl?.firstElementChild._redraw?.(); }
    }

    function init() {
        if (!ON) return;
        const side = document.getElementById('pjSide');
        side.hidden = false;
        if (localStorage.getItem('pjSideShut') === '1') document.documentElement.classList.add('pj-side-shut');

        side.addEventListener('click', (e) => {
            const t = e.target;
            if (t.closest('#pjCollapse')) return toggleSide();
            if (t.closest('#pjFeedback')) return post('feedback-open');
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
        document.getElementById('pjCrumb').addEventListener('dblclick', (e) => {
            const a = e.target.closest('.pj-crumb-agent');
            if (a) beginRenameOn(a, activeSlotId);
        });
        document.getElementById('pjBack').addEventListener('click', () => {
            if (isPhone()) document.documentElement.classList.add('pj-list-open');
            else toggleSide();
        });
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
    return { render, setProjects, note, onDashboardMessage, onProjectAdded, visibleOrder, openMoveDialog, projectOf };
})();
window.Projects = Projects;
