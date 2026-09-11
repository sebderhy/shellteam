// --- Config ---
const wsUrl = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`;

// --- Empty state (module-aware) ---
// The copy must never promise a capability this install doesn't have: browser
// and app connections are opt-in modules (BOX.modules, from layer.json) — on a
// pure-core install we only claim terminal + files + live URLs.
function initUseCaseSuggestions() {
    const container = document.getElementById('emptySuggestions');
    if (!container) return;
    const mods = BOX.modules || [];
    const prompts = [
        '"What can you do? Show me around"',
        '"Build me something cool"',
        mods.includes('composio') ? '"Help me connect my apps"'
                                  : '"Build a web page and give me its live URL"',
    ];
    container.innerHTML = prompts.map(p =>
        `<button class="empty-chip" onclick="fillSuggestion(this)">${p}</button>`
    ).join('');
    const subtitle = document.getElementById('emptySubtitle');
    if (subtitle) {
        const gear = mods.includes('browser') ? 'a browser, terminal, and file system'
                                              : 'a terminal and file system';
        const apps = mods.includes('composio') ? ' I can also connect to your apps.' : '';
        subtitle.textContent = `I have my own computer with ${gear}. Every file I write gets a live URL.${apps}`;
    }
}

// --- Global State ---
window.App = {
    state: {
        ws: null,
        sessionId: null,
        isGenerating: false,
        currentModel: 'claude-opus-5',
        totalCost: 0,
        hasApiKey: false,
        hasOpenAIKey: false,
        hasOAuth: false,
        hasCodexOAuth: false,
        hasAntigravityOAuth: false,
        // OpenCode (Fireworks) is a server-side fallback, but it only actually
        // works when the box has a FIREWORKS_API_KEY. The server reports this in
        // status; until we hear otherwise, assume it's unavailable so we never
        // silently route a no-credentials user into a broken OpenCode chat.
        hasOpenCode: false,
        // Voice input (STT) needs an ElevenLabs key on the control plane. null =
        // unknown / older server (keep the mic visible); false = server said no
        // key (hide the mic and point at Settings → Feature keys).
        sttAvailable: null,
        // Spoken replies (TTS) need the same key AND the master AI token, so a
        // guest cockpit with only a scoped voice-input token reads false here.
        // null = unknown; the button stays hidden until the server says true,
        // because a speak button that 502s is worse than no button.
        ttsAvailable: null,
        // Whether replies should be spoken. Sticky across reloads (hydrated in
        // loadAudioReplyPreference, not here — this table stays declarative):
        // it is a way of working (cooking, walking, driving), not a per-message
        // choice.
        audioReply: false,
        // Which agent CLIs exist on the box's PATH, from status ({ claude: true,
        // codex: true, antigravity: false, … }). Families that aren't installed
        // are hidden from the setup tabs and the model picker — the employee
        // container ships only claude + codex. Null until first status: treat
        // unknown as installed so nothing flickers away on a slow connect.
        installedAgents: null,
        apiKeySource: null,
        // Per-family billing mode from /api/status: { claude, codex, antigravity,
        // opencode } each "subscription" | "apikey" | "included" | "none". Drives
        // the billing badge next to the model picker. Null until first status.
        authMode: null,
        // Per-family OAuth health, independent from billing mode. "expired"
        // can coexist with "apikey" when a metered key took over.
        subscriptionStatus: null,
        // Models offered on this box's own key, by family ({ codex: [ids] }),
        // from INCLUDED_MODELS. A family listed here bills "included": the
        // setup screen asks for the user's own plan first and offers these
        // "on us"; the picker lists only them until a plan is connected.
        includedModels: {},
        // Provider-normalized subscription quota data. The cockpit refreshes this
        // in the background and the server caches provider checks, so the compact
        // header monitor remains current without repeatedly opening provider TUIs.
        providerUsage: null,
        quotaLoading: false,
        quotaRequest: null,
        quotaCheckedAt: 0,
        quotaError: null,
        isReplayingHistory: false,
        reconnectDelay: 1000,
        pendingImages: [],
        pendingFiles: [],
        generatingTimer: null,
        generatingStart: 0,
        terminalMode: false,
        // Model catalog (config/models.json), fetched from /api/models at boot.
        // Drives the model dropdown + model->agent routing. Null until loaded.
        catalog: null,
    },
    el: {
        messages: document.getElementById('messages'),
        input: document.getElementById('input'),
        btnSend: document.getElementById('btnSend'),
        statusDot: document.getElementById('statusDot'),
        statusLabel: document.getElementById('statusLabel'),
        streamingIndicator: document.getElementById('streamingIndicator'),
        streamingLabel: document.getElementById('streamingLabel'),
        setupScreen: document.getElementById('setupScreen'),
        composer: document.getElementById('composer'),
        errorToast: document.getElementById('errorToast'),
        emptyState: document.getElementById('emptyState'),
    },
    MAX_IMAGES: 4,
    MAX_FILE_SIZE: 200 * 1024 * 1024,
    MAX_FILES: 10,
};

const S = App.state;
const E = App.el;

const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_UNAVAILABLE_RETRY_MS = 60 * 60 * 1000;
let quotaPollTimer = null;

// --- Session Tabs ---
// Backstop against runaway tab creation, not a real resource limit — slots are
// idle unless generating, so parallel work is bounded by the box, not the UI.
// Raised from an arbitrary 8 after it blocked real use (SHE-61).
const MAX_SESSION_TABS = 20;
const sessionSlots = [];
let activeSlotId = 0;
let nextSlotId = 1;
// The header's workspace display (full path), kept by setWorkspaceDisplay.
// Declared before the first makeSlot() call below — defaultSlotConfig reads it
// as the cwd fallback for a slot created before the server reports one.
let _displayedCwd = null;

function defaultSlotConfig() {
    const activeSlot = sessionSlots.find(s => s.id === activeSlotId);
    return {
        model: S.currentModel,
        cwd: activeSlot?.config.cwd || _displayedCwd || null,
    };
}

function makeSlot(id, label) {
    return {
        id,
        label: label || '',
        sessionId: null,
        isGenerating: false,
        // Optimistic "sent, awaiting the agent's first event" flag. The server's
        // isGenerating only flips true on the first init/text_delta/tool_start,
        // so a status broadcast in that gap would otherwise report the slot idle
        // and tear down the live Stop button + running dot (SHE-90/88/89).
        pendingSend: false,
        domSnapshot: null,
        pendingMessages: [],
        totalCost: 0,
        draft: '',
        quotes: [],
        contextTokens: null,
        config: defaultSlotConfig(),
    };
}

sessionSlots.push(makeSlot(0));

// Fresh-create acks (SHE-52): the server allocates the canonical slot id; a
// nonce maps its ack back to the optimistic local tab, so an id collision
// (another device raced the same next id) renames the local tab instead of
// silently merging two users' conversations into one server slot.
let _createNonceCounter = 0;
const _pendingCreates = new Map(); // nonce -> optimistic local slot id
function newCreateNonce(localId) {
    const nonce = `c${Date.now().toString(36)}-${++_createNonceCounter}`;
    _pendingCreates.set(nonce, localId);
    return nonce;
}

function renameLocalSlot(fromId, toId) {
    if (fromId === toId) return;
    const slot = sessionSlots.find(s => s.id === fromId);
    if (!slot || sessionSlots.some(s => s.id === toId)) return;
    slot.id = toId;
    if (activeSlotId === fromId) {
        activeSlotId = toId;
        localStorage.setItem('activeSlotId', String(toId));
    }
    if (toId >= nextSlotId) nextSlotId = toId + 1;
    renderSessionTabs();
}

// --- Box identity (real $HOME + where files get URLs) ---
// Served by /api/box. HOME holds a placeholder for the few ms until the boot
// fetch lands (it resolves before the socket connects — see the Boot section).
// File URLs live on the dashboard origin, which serves ~/<path> directly
// (main-domain file URLs).
let BOX = { home: '/home/user', appDomain: null, apiPort: 8000 };

async function loadBoxInfo() {
    const r = await fetch('/api/box');
    if (!r.ok) throw new Error(`/api/box returned ${r.status}`);
    BOX = await r.json();
}

function fileBaseUrl() {
    if (BOX.appDomain && BOX.appDomain !== 'localhost') return `https://${BOX.appDomain}`;
    // Sibling-ports mode (localhost / bare IP): files are served by the control
    // plane on its own port, same hostname as the cockpit.
    return `${location.protocol}//${location.hostname}:${BOX.apiPort}`;
}

function encodeRelPath(rel) {
    return rel.split('/').map(encodeURIComponent).join('/');
}

// --- Markdown ---
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|webm|flac|aac)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

// Resolve an image reference (markdown ![](…) href, or a backtick file path an
// agent wrote) to a servable URL so screenshots/diagrams the agent produces show
// inline instead of as dead text (SHE-49). http(s) URLs pass through; home/cwd-
// relative paths resolve via the file server; anything unservable or unsafe → null.
function resolveImageUrl(ref) {
    const s = (ref || '').trim();
    const lower = s.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) return s;
    if (/^(javascript|vbscript|data):/.test(lower)) return null;
    const rel = editorRelPath(s);
    if (!rel || !IMAGE_EXT_RE.test(rel)) return null;
    return `${fileBaseUrl()}/${encodeRelPath(rel)}`;
}
// Backtick spans that look like a source/doc file are linked to the in-container editor.
const FILE_PATH_RE = /^(?:~\/|\.\/|\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:md|markdown|mdx|txt|rst|py|js|mjs|cjs|ts|tsx|jsx|json|jsonc|ya?ml|toml|html?|css|scss|sass|less|sh|bash|zsh|sql|go|rs|rb|java|kt|c|h|cpp|hpp|cc|php|xml|ini|cfg|conf|env|lock|vue|svelte|astro|svg|csv|tsv|log|dockerfile)$/i;
// Extensions whose final form is the rendered file (open directly), not source.
const VIEW_EXT_RE = /\.(html?|pdf|png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|mp3|wav|m4a|ogg|flac|aac)$/i;

function currentCwd() {
    return sessionSlots.find(s => s.id === activeSlotId)?.config.cwd || BOX.home;
}

// Resolve a file reference to a path relative to $HOME, or null if it can't be served.
function editorRelPath(text) {
    let p = text.trim();
    if (p.startsWith('~/')) p = p.slice(2);
    else if (p.startsWith(BOX.home + '/')) p = p.slice(BOX.home.length + 1);
    else if (p.startsWith('/')) return null;            // absolute path outside home — not servable here
    else {
        const cwd = currentCwd();
        if (cwd !== BOX.home && !cwd.startsWith(BOX.home + '/')) return null;
        const cwdRel = cwd.slice(BOX.home.length).replace(/^\/+|\/+$/g, '');
        p = cwdRel ? cwdRel + '/' + p : p;              // relative refs resolve against the slot's cwd
    }
    p = p.replace(/\/+$/, '');
    return p || null;
}

// URL for a home-relative path: rendered form (images/HTML/PDF/media) opens the
// file itself; source files open in the editor. Mirrors the persona's URL rules,
// so pure-core agents (no persona) lose nothing — plain paths become links here.
function fileUrl(rel) {
    return VIEW_EXT_RE.test(rel)
        ? `${fileBaseUrl()}/${encodeRelPath(rel)}`
        : `${fileBaseUrl()}/_editor/${encodeRelPath(rel)}`;
}

function editorLink(text) {
    if (/\s/.test(text) || !FILE_PATH_RE.test(text)) return null;
    // Avoid turning casual basename mentions like `models.json` into dead
    // editor links. Require an explicit path marker or at least one directory
    // segment so the author is actually pointing at a file path.
    if (!text.startsWith('~/') && !text.startsWith('./') && !text.startsWith('/') && !text.includes('/')) {
        return null;
    }
    const rel = editorRelPath(text);
    if (!rel) return null;
    return `${fileBaseUrl()}/_editor/${encodeRelPath(rel)}`;
}

// --- Path → URL linkification (marked postprocess) ---
// Rewrites absolute (~/… or $HOME/…) file paths in agent PROSE into links on the
// dashboard origin. Runs on marked's final HTML via a DOM walk — never inside
// existing links or code blocks (codespans have their own editorLink handling).
const PROSE_PATH_RE = /(~\/|\/home\/[A-Za-z0-9._-]+\/)[^\s)\]}'"`,;!?<>*|]+/g;

function linkifyPathsHtml(html) {
    if (!html || (html.indexOf('/home/') === -1 && html.indexOf('~/') === -1)) return html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            for (let el = n.parentElement; el; el = el.parentElement) {
                const t = el.tagName;
                if (t === 'A' || t === 'CODE' || t === 'PRE') return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const text = node.nodeValue;
        PROSE_PATH_RE.lastIndex = 0;
        let m, last = 0, frag = null;
        while ((m = PROSE_PATH_RE.exec(text))) {
            const raw = m[0].replace(/[.,:]+$/, '');    // sentence punctuation isn't part of the path
            const rel = editorRelPath(raw);
            if (!rel) continue;
            frag = frag || doc.createDocumentFragment();
            frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
            const a = doc.createElement('a');
            a.href = fileUrl(rel);
            a.target = '_blank';
            a.rel = 'noopener';
            a.className = 'file-link';
            a.textContent = raw;
            frag.appendChild(a);
            last = m.index + raw.length;
        }
        if (!frag) continue;
        frag.appendChild(doc.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
    return doc.body.innerHTML;
}

// --- Malformed agent URL repair (marked postprocess) ---
// Agents sometimes hallucinate file URLs (SHE-64: Codex emitted
// https://owner-3456.owner.example.com/home/owner/…/file.md:1 — port subdomain,
// doubled host, raw /home path, terminal-style :N suffix). Any anchor on a
// box-family host whose path is an absolute /home/<user>/ path is rebuilt to
// the canonical form (fileUrl, or /_editor/…?line=N when a :N suffix names a
// line). Render-time safety net for every agent; the layer-side fix teaches
// Codex the rules so these shouldn't be produced in the first place.
function repairAgentUrlsHtml(html) {
    if (!html || html.indexOf('/home/') === -1 || !BOX.home) return html;
    if (!BOX.appDomain || BOX.appDomain === 'localhost') return html;
    const base = BOX.appDomain.includes('.') ? BOX.appDomain.split('.').slice(1).join('.') : BOX.appDomain;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let changed = false;
    for (const a of doc.querySelectorAll('a[href]')) {
        let u;
        try { u = new URL(a.getAttribute('href')); } catch { continue; }
        const h = u.hostname;
        const boxHost = h === BOX.appDomain || h.endsWith('.' + BOX.appDomain) ||
            h === base || h.endsWith('.' + base);
        if (!boxHost || !u.pathname.startsWith(BOX.home + '/')) continue;
        let rel = decodeURIComponent(u.pathname.slice(BOX.home.length + 1));
        const lineMatch = /:(\d+)$/.exec(rel);
        if (lineMatch) rel = rel.slice(0, -lineMatch[0].length);
        if (!rel) continue;
        const fixed = lineMatch
            ? `${fileBaseUrl()}/_editor/${encodeRelPath(rel)}?line=${lineMatch[1]}`
            : fileUrl(rel);
        if (a.textContent.trim() === a.getAttribute('href')) a.textContent = fixed;
        a.setAttribute('href', fixed);
        changed = true;
    }
    return changed ? doc.body.innerHTML : html;
}

marked.use({
    breaks: true,
    gfm: true,
    hooks: {
        postprocess(html) { return linkifyPathsHtml(repairAgentUrlsHtml(html)); },
    },
    tokenizer: {
        // Require ~~double~~ tildes for strikethrough. marked's GFM default also
        // strikes a SINGLE ~…~, which mangled ordinary agent prose — "~80 lines"
        // through "~/.shellteam/" rendered as one struck-out run (SHE-51). `~`
        // shows up constantly in home paths and approximations, so single-tilde
        // del is far more often wrong than right.
        del(src) {
            const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
            if (!m) return;
            return { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        },
    },
    renderer: {
        // NB: marked 15 passes token fields (codespan text, image/link href, title)
        // RAW — nothing is pre-escaped. Every interpolation into HTML text or an
        // attribute must go through escHtml, or agent output like `<img
        // onerror=…>` (code span) or ![](http://x"onerror=…) executes as script
        // in the cockpit origin. `<img>`s that 404 hide themselves so a mere
        // filename mention doesn't leave a broken-image icon (SHE-49).
        codespan({ text }) {
            const code = `<code>${escHtml(text)}</code>`;
            if (AUDIO_EXT_RE.test(text)) {
                const rel = editorRelPath(text);
                if (rel) {
                    const url = escHtml(`${fileBaseUrl()}/${encodeRelPath(rel)}`);
                    return `${code}<audio controls preload="metadata" src="${url}"></audio>`;
                }
            }
            // A backticked image path (e.g. a screenshot the agent just saved)
            // renders the thumbnail inline under the path, mirroring audio (SHE-49).
            if (IMAGE_EXT_RE.test(text) && !/\s/.test(text)) {
                const url = resolveImageUrl(text);
                if (url) {
                    const u = escHtml(url);
                    return `<a href="${u}" target="_blank" rel="noopener" class="file-link">${code}</a>`
                        + `<img class="agent-shot" src="${u}" alt="${escHtml(text)}" loading="lazy" onerror="this.style.display='none'">`;
                }
            }
            const url = editorLink(text);
            if (url) return `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="file-link">${code}</a>`;
            return code;
        },
        // Fenced code gets a copy button (SHE-108): agents put posts, commands
        // and snippets in ``` fences, and hand-selecting a <pre> on a phone is
        // hopeless. Same <pre><code class="language-…"> marked emits, wrapped.
        code({ text, lang }) {
            const language = (lang || '').trim().split(/\s+/)[0];
            const cls = language ? ` class="language-${escHtml(language)}"` : '';
            return '<div class="code-block">'
                + '<button type="button" class="code-copy" aria-label="Copy code">Copy</button>'
                + `<pre><code${cls}>${escHtml(text)}\n</code></pre></div>`;
        },
        image({ href, title, text }) {
            // Markdown image syntax — resolve home/cwd-relative sources to file
            // URLs so ![](./shot.png) actually shows (SHE-49). Unservable → alt text.
            const url = resolveImageUrl(href);
            const alt = text ? escHtml(text) : '';
            if (!url) return alt || (href ? escHtml(href) : '');
            const titleAttr = title ? ` title="${escHtml(title)}"` : '';
            return `<img class="agent-shot" src="${escHtml(url)}" alt="${alt}"${titleAttr} loading="lazy" onerror="this.style.display='none'">`;
        },
        link({ href, title, tokens }) {
            const text = this.parser.parseInline(tokens);
            const lower = (href || '').toLowerCase().trim();
            if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
                return `<code>${text}</code>`;
            }
            const titleAttr = title ? ` title="${escHtml(title)}"` : '';
            return `<a href="${escHtml(href)}" target="_blank" rel="noopener"${titleAttr}>${text}</a>`;
        }
    }
});

// --- Helpers ---
function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// For a value interpolated into a single-quoted JS string inside an inline
// handler (onclick="pickWorkspace('…')"). escHtml alone is NOT enough there:
// the browser decodes &#39; back to a raw ' before the JS parser sees the
// attribute, so a path containing ' would still terminate the string. JS-escape
// first, then HTML-escape the result.
function jsArg(s) {
    return escHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

function truncate(s, max) {
    return s.length > max ? s.slice(0, max) + '\n... (truncated)' : s;
}

function scrollToBottom(force) {
    requestAnimationFrame(() => {
        const el = E.messages;
        const isNearBottom = force || el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        if (isNearBottom) el.scrollTop = el.scrollHeight;
    });
}

function showError(text) {
    E.errorToast.classList.remove('info');
    E.errorToast.textContent = text;
    E.errorToast.classList.add('visible');
    setTimeout(() => E.errorToast.classList.remove('visible'), 4000);
}

// Neutral (non-error) variant of the toast — same element, muted styling.
function showInfoToast(text) {
    E.errorToast.classList.add('info');
    E.errorToast.textContent = text;
    E.errorToast.classList.add('visible');
    setTimeout(() => E.errorToast.classList.remove('visible'), 4000);
}

// --- Report panel ---
// Renders an agent-produced HTML report in the right-side pane. Reports are
// private by default (owner-only, like the rest of $HOME); a toggle publishes
// them via /api/report/publish (control-plane allowlist — same URL either way),
// and Share (Web Share sheet / copy-link) lights up only once public.
// The report PANEL lives one level up, in the dashboard shell (so it spans the
// full height, reaching the tab row). The cockpit only DETECTS report links and
// asks the parent to open them via postMessage. See dashboard.html's report panel.
const ReportPanel = {
    // A link is a "report" if it points at an HTML file served by THIS box's FILE
    // server — the owner file-host (e.g. owner.example.com), a sibling of the
    // cockpit's own host (owner-3456…). We require an absolute URL on the same
    // registrable domain (or the localhost/loopback dev family) and EXCLUDE the
    // cockpit's own origin — the cockpit doesn't serve $HOME, so a same-origin
    // (or relative) .html link would just load the cockpit app in the iframe.
    isBoxReport(href) {
        let u;
        try { u = new URL(href, location.href); } catch { return false; }
        if (u.origin === location.origin) return false;
        const here = location.hostname;
        const h = u.hostname;
        if (this.isBoxApp(u, here)) return true;
        if (!/\.html?$/i.test(u.pathname)) return false;
        if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1') return true;
        const base = (host) => host.split('.').slice(-2).join('.');
        return here.includes('.') && base(h) === base(here);
    },

    // An app the agent serves on this box: `<name>.<APP_DOMAIN>` or
    // `<owner>-<port>.<APP_DOMAIN>`, i.e. a sibling of the cockpit's own host
    // (`<owner>-3456.<APP_DOMAIN>`), at its root or an extension-less route. The
    // page a visitor would open on a phone is what the panel should show, not
    // only files named *.html. Assets (png, json, css) are not pages.
    isBoxApp(u, here) {
        const labels = here.split('.');
        const appDomain = labels.length >= 3 ? labels.slice(1).join('.') : here;
        const h = u.hostname;
        if (h === appDomain || !h.endsWith('.' + appDomain)) return false;
        const last = u.pathname.split('/').pop();
        return !last || !last.includes('.') || /\.html?$/i.test(last);
    },

    // Ask the dashboard shell to open the report. Standalone (no parent frame):
    // fall back to a new tab.
    show(url, title) {
        let abs;
        try { abs = new URL(url, location.href).href; } catch { return; }
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                source: 'shellteam-cockpit', kind: 'report-open',
                url: abs, title: title || decodeURIComponent(abs.split('/').pop() || new URL(abs).hostname),
            }, '*');
        } else {
            window.open(abs, '_blank', 'noopener');
        }
    },

    // Scan a just-rendered assistant message for report links: mark them (for
    // styling) and auto-open the newest (only for live turns, not history). The
    // click itself is handled by a delegated listener on #messages (below), NOT a
    // per-link listener — a per-link listener does not survive switchSessionTab's
    // innerHTML DOM restore, which made restored reports open in a new window
    // instead of the side panel (SHE-53).
    scanMessage(el, { autoOpen = false } = {}) {
        if (!el) return;
        const links = [...el.querySelectorAll('a[href]')].filter(a => this.isBoxReport(a.href));
        if (!links.length) return;
        for (const a of links) {
            if (a.dataset.reportBound) continue;
            a.dataset.reportBound = '1';
            a.classList.add('report-link');
        }
        if (autoOpen) this.show(links[links.length - 1].href);
    },
};

function setStatus(state, label) {
    E.statusDot.className = 'status-dot ' + state;
    E.statusLabel.textContent = label;
    refreshInfoPanelIfOpen();
}

function setGenerating(active) {
    S.isGenerating = active;
    if (active) {
        setStatus('generating', 'Working...');
        E.streamingIndicator.classList.add('visible');
        S.generatingStart = Date.now();
        clearInterval(S.generatingTimer);
        S.generatingTimer = setInterval(() => {
            const secs = Math.floor((Date.now() - S.generatingStart) / 1000);
            E.streamingLabel.textContent = `Working... ${secs}s`;
        }, 1000);
    } else {
        E.streamingIndicator.classList.remove('visible');
        clearInterval(S.generatingTimer);
    }
}

// --- Model catalog + routing ---
// The catalog (config/models.json) is the single source of truth; served at
// /api/models. Routing mirrors lib/model-catalog.mjs's agentIdForModel exactly:
// exact membership, then match.prefixes, then the first agent (Claude).
function catalogAgents() {
    return (S.catalog && S.catalog.agents) || [];
}

function agentIdForModel(model) {
    const list = catalogAgents();
    if (!model || !list.length) return list[0] ? list[0].id : 'claude';
    for (const a of list) if ((a.models || []).some(m => m.id === model)) return a.id;
    for (const a of list) if (((a.match && a.match.prefixes) || []).some(p => model.startsWith(p))) return a.id;
    return list[0].id;
}

function opencodeDefaultModel() {
    const a = catalogAgents().find(x => x.id === 'opencode');
    if (!a) return '';
    return a.default || (a.models && a.models[0] && a.models[0].id) || '';
}

// Human name for a model id, from the catalog (falls back to a shortened id
// before the catalog loads).
function modelDisplayName(id) {
    for (const a of catalogAgents()) {
        const m = (a.models || []).find(x => x.id === id);
        if (m) return m.name || m.id;
    }
    return shortModel(id) || 'AI';
}

// The AI button doubles as the model indicator (there is no inline <select>
// anymore) — keep its label and the AI menu's Model row in sync everywhere the
// old code assigned modelSelect.value.
function setModelDisplay(model) {
    const name = modelDisplayName(model);
    const btn = document.getElementById('btnAIModel');
    if (btn) { btn.textContent = name; btn.title = name; }
    const row = document.getElementById('aiMenuModel');
    if (row) row.textContent = name;
}

async function loadModelCatalog() {
    const resp = await fetch('/api/models');
    if (!resp.ok) throw new Error(`/api/models returned ${resp.status}`);
    S.catalog = await resp.json();
    setModelDisplay(S.currentModel);
}

// --- Model picker (second level behind the AI menu) -----------------------
// Replaces the old inline <select>: same list, grouped by agent, with the
// family's billing mode shown per group so "which of these costs me per token"
// is visible at the moment of choice.
function openModelPicker() {
    Menus.hide();
    const picker = document.getElementById('modelPicker');
    let html = `<div class="session-picker-header">
        <div class="session-picker-title">Model</div>
    </div><div class="session-list">`;
    for (const a of catalogAgents()) {
        if (!agentInstalled(a.id)) continue;  // no CLI on this box — don't offer its models
        const badge = billingBadgeForFamily(a.id);
        html += `<div class="picker-group-label">${escHtml(a.label || a.id)}
            ${badge ? `<span class="auth-badge ${badge.cls}" title="${escHtml(badge.title)}">${badge.label}</span>` : ''}
        </div>`;
        // On an included key the family offers only its INCLUDED_MODELS; the
        // rest come back the moment the user connects their own plan.
        const models = (a.models || []).filter(m => modelPermittedHere(m.id));
        for (const m of models) {
            const current = m.id === S.currentModel;
            html += `<div class="session-item model-item${current ? ' active' : ''}" onclick="pickModel('${jsArg(m.id)}')">
                <span class="model-item-name">${escHtml(m.name || m.id)}</span>
                ${current ? '<span class="model-item-check">&#10003;</span>' : ''}
            </div>`;
        }
    }
    html += '</div>';
    picker.innerHTML = html;
    picker.classList.add('visible');
    document.getElementById('modelBackdrop').classList.add('visible');
}

function hideModelPicker() {
    document.getElementById('modelPicker').classList.remove('visible');
    document.getElementById('modelBackdrop').classList.remove('visible');
}

function pickModel(id) {
    hideModelPicker();
    if (id !== S.currentModel) changeModel(id);
}

// --- Workspace picker (second level behind the AI menu) -------------------
// The inline cwd combobox is desktop-only; this modal is how every width —
// mobile included, for the first time — changes the working directory.
// Live directory matches for whatever path is typed in the picker — merged with
// the curated workspace list so a plain folder that isn't a git repo or under
// ~/projects (e.g. ~/avsv) still shows up and is one click to switch to (SHE-55).
let _pickerDirs = [];

function openWorkspacePicker() {
    Menus.hide();
    _pickerDirs = [];
    // Refresh is best-effort: send() throws on a non-OPEN socket, and the
    // picker must still open (with the cached list) while disconnected.
    if (S.ws?.readyState === WebSocket.OPEN) {
        S.ws.send(JSON.stringify({ type: 'list_workspaces' }));
    }
    renderWorkspacePicker();
    document.getElementById('workspacePicker').classList.add('visible');
    document.getElementById('workspaceBackdrop').classList.add('visible');
    document.getElementById('workspacePickerInput')?.focus();
}

// The header (with its input) is rendered once; only the list repaints as the
// user types or results arrive, so the input keeps focus and caret position.
function renderWorkspacePicker() {
    const picker = document.getElementById('workspacePicker');
    picker.innerHTML = `<div class="session-picker-header">
        <div class="session-picker-title">Workspace</div>
        <input type="text" class="session-search" id="workspacePickerInput"
               placeholder="Search folders or type a path (~/projects/app)…" autocomplete="off"
               spellcheck="false"
               oninput="onWorkspacePickerInput(this.value)"
               onkeydown="if (event.key === 'Enter') pickWorkspacePath(this.value)">
    </div><div class="session-list" id="workspacePickerList"></div>`;
    renderWorkspacePickerList();
}

function renderWorkspacePickerList() {
    const list = document.getElementById('workspacePickerList');
    if (!list) return;
    const cur = currentCwd();
    const q = (document.getElementById('workspacePickerInput')?.value || '').trim();

    const byPath = new Map();
    for (const w of _workspaces) byPath.set(w.path, { path: w.path, label: w.label || shortPath(w.path) });
    for (const d of _pickerDirs) if (!byPath.has(d.path)) byPath.set(d.path, { path: d.path, label: shortPath(d.path) });
    let items = [...byPath.values()];
    if (q) {
        const nl = q.toLowerCase();
        const el = expandPath(q).toLowerCase();
        items = items.filter(w => w.label.toLowerCase().includes(nl) || w.path.toLowerCase().includes(el));
    }

    let html = '';
    // Always let the user switch to exactly what they typed, even if it matches
    // nothing in the list yet — the discoverable equivalent of pressing Enter.
    const typed = q ? expandPath(q) : null;
    if (typed && typed !== cur && !byPath.has(typed)) {
        html += `<div class="session-item model-item" onclick="pickWorkspace('${jsArg(typed)}')">
            <span class="model-item-name info-mono">Switch to ${escHtml(shortPath(typed))}</span>
        </div>`;
    }
    for (const w of items) {
        const current = w.path === cur;
        html += `<div class="session-item model-item${current ? ' active' : ''}" onclick="pickWorkspace('${jsArg(w.path)}')">
            <span class="model-item-name info-mono">${escHtml(w.label)}</span>
            ${current ? '<span class="model-item-check">&#10003;</span>' : ''}
        </div>`;
    }
    if (!html) html = `<div class="session-empty">${_workspaces.length ? 'No matching folder' : 'Loading workspaces…'}</div>`;
    list.innerHTML = html;
}

function onWorkspacePickerInput(val) {
    // Search real directories under the typed path's parent so folders that aren't
    // git repos / under ~/projects surface as you type (SHE-55). list_directories
    // lists a dir's children, so to see siblings of "~/av" we list its parent
    // (~/) and filter by the typed text in renderWorkspacePickerList.
    const v = (val || '').trim();
    if (v && (v.startsWith('/') || v.startsWith('~')) && S.ws?.readyState === WebSocket.OPEN) {
        const parent = expandPath(v).replace(/\/[^/]*$/, '') || BOX.home;
        S.ws.send(JSON.stringify({ type: 'list_directories', prefix: parent }));
    }
    renderWorkspacePickerList();
}

function hideWorkspacePicker() {
    document.getElementById('workspacePicker').classList.remove('visible');
    document.getElementById('workspaceBackdrop').classList.remove('visible');
}

function pickWorkspace(path) {
    hideWorkspacePicker();
    if (path === currentCwd()) return;
    setWorkspaceDisplay(path);
    changeWorkspace(path);
}

function pickWorkspacePath(raw) {
    const val = (raw || '').trim();
    if (!val) return;
    pickWorkspace(expandPath(val));
}

// Escape closes whichever modal picker is open (model / workspace / session /
// rewind). The header menus close via Menus' own Escape handler in dropdown.js.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideModelPicker();
    hideWorkspacePicker();
    hideSessionPicker();
    hideRewindPicker();
});


// --- Context-budget meter (SHE-40) ---------------------------------------
// Adapters forward per-turn `usage` (input + cache tokens) in turn_done; that
// sum is what occupies the model's context window right now.

function contextWindowForModel(model) {
    for (const agent of (S.catalog?.agents || [])) {
        for (const m of (agent.models || [])) {
            // Match by id OR cli value so a stale/cli-form id (e.g. "gpt-5.6-sol",
            // whose catalog id is "gpt-5.6-sol-max") still resolves to its real
            // window instead of falling back. Mirrors contextLimitForId in
            // lib/model-catalog.mjs so the meter and auto-compact threshold agree.
            if ((m.id === model || m.cli === model) && m.limit?.context) return m.limit.context;
        }
    }
    // Fallback for models missing from the catalog: 200k standard, 1M for
    // long-context variants tagged "[1m]". (Catalog entries all carry
    // limit.context since SHE-92 — this only guards uncatalogued ids.)
    if (/\[1m\]/i.test(model)) return 1_000_000;
    return 200_000;
}

function updateContextMeter(usage, contextWindow) {
    if (!usage) return;
    const tokens = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
    if (!tokens) return;
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    if (slot) {
        slot.contextTokens = tokens;
        // The agent's own operative window beats the catalog's marketed one
        // (gpt-5.6: 258400 operative vs 400k marketed — SHE-66/SHE-68).
        if (contextWindow) slot.contextWindow = contextWindow;
    }
    renderContextMeter();
}

function contextWindowForSlot(slot) {
    return slot?.contextWindow || contextWindowForModel(S.currentModel);
}

function clearContextMeter(slotId) {
    const slot = sessionSlots.find(s => s.id === slotId);
    // Clear the per-model operative window too, not just the token count: it is
    // model-scoped state (Codex reports 258400) and must not survive into a new
    // model on this slot (SHE-92).
    if (slot) { slot.contextTokens = null; slot.contextWindow = null; }
    if (slotId === activeSlotId) renderContextMeter();
}

function renderContextMeter() {
    const el = document.getElementById('contextMeter');
    if (!el) return;
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    const tokens = slot?.contextTokens;
    if (!tokens) { el.hidden = true; updateInfoWarning(); refreshInfoPanelIfOpen(); return; }
    const windowSize = contextWindowForSlot(slot);
    const pct = Math.min(100, Math.round((tokens / windowSize) * 100));
    el.textContent = `${Math.round(tokens / 1000)}k · ${pct}%`;
    el.title = `Context used: ~${tokens.toLocaleString()} of ${windowSize.toLocaleString()} tokens`;
    el.classList.toggle('api', pct >= 80);  // reuse the badge's warning styling
    el.hidden = false;
    updateInfoWarning();
    refreshInfoPanelIfOpen();
}

// --- Auth ---
function isCodexModel(model)       { return agentIdForModel(model) === 'codex'; }
function isOpenCodeModel(model)    { return agentIdForModel(model) === 'opencode'; }
function isAntigravityModel(model) { return agentIdForModel(model) === 'antigravity'; }

// Whether a family's CLI binary exists on the box (server probes PATH). Unknown
// (pre-status) counts as installed so the UI doesn't hide everything at boot.
function agentInstalled(famId) {
    return !S.installedAgents || S.installedAgents[famId] !== false;
}

function familyHasAuth(family) {
    const mode = S.authMode?.[family];
    if (mode) return mode !== 'none';
    if (family === 'claude') return S.hasApiKey || S.hasOAuth || (S.apiKeySource && S.apiKeySource !== 'none');
    if (family === 'codex') return S.hasOpenAIKey || S.hasCodexOAuth;
    if (family === 'antigravity') return S.hasAntigravityOAuth;
    return false;
}

function hasAuthForModel(model) {
    const family = agentIdForModel(model);
    if (!agentInstalled(family)) return false;  // no CLI, so credentials are moot
    if (isOpenCodeModel(model)) return S.hasOpenCode;  // only when a server-side Fireworks key exists
    return familyHasAuth(family) && modelPermittedHere(model);
}

// Included-key gating (mirrors modelPermitted in lib/session.mjs): when a
// family runs on the box's own key, only its INCLUDED_MODELS may be picked.
function includedModelsFor(family) {
    return (S.includedModels && S.includedModels[family]) || [];
}
function familyIsIncluded(family) {
    return S.authMode?.[family] === 'included' && includedModelsFor(family).length > 0;
}
function modelPermittedHere(model) {
    const family = agentIdForModel(model);
    return !familyIsIncluded(family) || includedModelsFor(family).includes(model);
}
// The family's own credentials (subscription or the user's key) — an included
// box key is the operator's courtesy, not something the user connected.
function familyHasOwnAuth(family) {
    const mode = S.authMode?.[family];
    return mode === 'subscription' || mode === 'apikey';
}
// Where a fresh tab lands for a family: its included model on an included key,
// else the family's usual default.
function preferredModelFor(family, fallback) {
    return familyIsIncluded(family) ? includedModelsFor(family)[0] : fallback;
}

// The setup tab that connects the credentials a model needs.
function setupTabForModel(model) {
    if (isCodexModel(model)) return 'cdx';
    if (isAntigravityModel(model)) return 'agy';
    return 'cc';
}

// --- Billing badge: subscription vs pay-per-token API key --------------------
// Returns "subscription" | "apikey" | "included" | "none" for a model's family.
// authMode is the single source of truth — derived from the same authModeFor()
// that governs getCliEnv(), so the badge and what actually runs are always aligned.
// We do NOT use S.apiKeySource as an override here: it's a global that persists
// across session restarts and can carry stale values from before a credential
// change, causing the badge to flicker incorrectly.
function billingModeForModel(model) {
    const fam = agentIdForModel(model);
    return (S.authMode && S.authMode[fam]) || null;
}

const BILLING_BADGE = {
    subscription: { label: 'Subscription', cls: 'sub', title: 'Runs on your subscription — no per-token API charges.' },
    apikey:       { label: 'API · metered', cls: 'api', title: 'Billed per token via your API key — far more expensive than a subscription. Connect a subscription in AI settings to switch.' },
    included:     { label: 'Included', cls: 'inc', title: 'Runs on the API key configured on this box, not on your subscription. Nothing to connect.' },
    none:         { label: 'Not connected', cls: 'off', title: 'No credentials for this model yet — open AI settings to connect.' },
};

const EXPIRED_BILLING_BADGE = {
    apikey: { label: 'Sub expired · API', cls: 'api', title: 'Your subscription sign-in expired. This model is now billed per token via your API key. Reconnect in Settings.' },
    none: { label: 'Sign-in expired', cls: 'off', title: 'Your subscription sign-in expired. Reconnect in Settings to use this model.' },
};

function subscriptionHealthForFamily(family) {
    return (S.subscriptionStatus && S.subscriptionStatus[family]) || null;
}

function billingBadgeForFamily(family) {
    const mode = (S.authMode && S.authMode[family]) || null;
    if (subscriptionHealthForFamily(family) === 'expired' && EXPIRED_BILLING_BADGE[mode]) {
        return EXPIRED_BILLING_BADGE[mode];
    }
    return BILLING_BADGE[mode];
}

function billingBadgeForModel(model) {
    return billingBadgeForFamily(agentIdForModel(model));
}

const SUBSCRIPTION_RECOVERY = {
    claude: { label: 'Claude', tab: 'cc', keyLabel: 'Anthropic API key' },
    codex: { label: 'OpenAI', tab: 'cdx', keyLabel: 'OpenAI API key' },
    antigravity: { label: 'Google', tab: 'agy' },
};
let subscriptionWarningSignature = null;

function openSubscriptionSettings(family) {
    const provider = SUBSCRIPTION_RECOVERY[family];
    if (!provider) return;
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({
            source: 'shellteam-cockpit',
            kind: 'provider-settings',
            provider: family === 'codex' ? 'openai' : family,
        }, '*');
        return;
    }
    openAIConfig();
    switchSetupTab(provider.tab);
}

function renderSubscriptionWarning() {
    const banner = document.getElementById('subscriptionWarning');
    const title = document.getElementById('subscriptionWarningTitle');
    const detail = document.getElementById('subscriptionWarningDetail');
    const actions = document.getElementById('subscriptionWarningActions');
    if (!banner || !title || !detail || !actions) return;

    const expired = Object.keys(SUBSCRIPTION_RECOVERY)
        .filter((family) => subscriptionHealthForFamily(family) === 'expired');
    const signature = JSON.stringify(expired.map((family) => [family, S.authMode?.[family] || null]));
    if (signature === subscriptionWarningSignature) return;
    subscriptionWarningSignature = signature;
    banner.hidden = expired.length === 0;
    if (!expired.length) {
        actions.innerHTML = '';
        return;
    }

    title.textContent = expired.length === 1
        ? `${SUBSCRIPTION_RECOVERY[expired[0]].label} subscription expired`
        : `${expired.length} subscriptions need attention`;
    detail.textContent = expired.map((family) => {
        const provider = SUBSCRIPTION_RECOVERY[family];
        const mode = S.authMode?.[family];
        if (mode === 'apikey') return `${provider.label} is using your metered ${provider.keyLabel}.`;
        return `${provider.label} is unavailable until you reconnect.`;
    }).join(' ');
    actions.innerHTML = expired.map((family) =>
        `<button class="subscription-warning-action" type="button" data-family="${family}">Reconnect ${SUBSCRIPTION_RECOVERY[family].label}</button>`
    ).join('');
    actions.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', () => openSubscriptionSettings(button.dataset.family));
    });
}

function quotaProviderForCurrentModel() {
    const family = agentIdForModel(S.currentModel);
    return S.providerUsage?.providers?.[family] || null;
}

function quotaWindows(provider) {
    return (provider?.windows || []).filter((window) =>
        window && window.used_percent !== null && window.used_percent !== undefined
        && Number.isFinite(Number(window.used_percent))
    );
}

function shortQuotaReset(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return `Resets ${value}`;
    return `Resets ${new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date)}`;
}

// A provider-neutral summary for the narrow header and the fuller Info panel.
// When a provider exposes several windows, use the most constrained one inline:
// it is the answer to "what could stop this session first?".
function quotaSummary() {
    const family = agentIdForModel(S.currentModel);
    const billing = billingModeForModel(S.currentModel);
    if (billing !== 'subscription') {
        return { visible: false, family, percent: null, action: 'none' };
    }

    const provider = quotaProviderForCurrentModel();
    if (!provider) {
        return {
            visible: true,
            family,
            label: 'Quota',
            value: S.quotaLoading ? 'Checking…' : 'Not checked',
            detail: S.quotaError || 'Checking provider limits…',
            percent: null,
            tone: S.quotaError ? 'unavailable' : 'indeterminate',
            action: 'refresh',
        };
    }

    const windows = quotaWindows(provider);
    if (windows.length) {
        const window = [...windows].sort((a, b) => Number(b.used_percent) - Number(a.used_percent))[0];
        const percent = Math.max(0, Math.min(100, Math.round(Number(window.used_percent))));
        return {
            visible: true,
            family,
            provider,
            label: window.name || 'Quota',
            value: `${percent}% used`,
            detail: shortQuotaReset(window.resets_at) || 'Provider-reported limit',
            percent,
            tone: percent >= 85 ? 'critical' : percent >= 65 ? 'warn' : 'normal',
            action: 'refresh',
        };
    }

    if (provider.status === 'setup_required') {
        return {
            visible: true,
            family,
            provider,
            label: 'Quota',
            value: 'Finish sign-in',
            detail: 'Open AI settings',
            percent: null,
            tone: 'unavailable',
            action: 'setup-antigravity',
        };
    }

    if (provider.credits_remaining !== null && provider.credits_remaining !== undefined) {
        return {
            visible: true,
            family,
            provider,
            label: 'Credits',
            value: `${provider.credits_remaining} left`,
            detail: provider.plan_tier ? `${provider.plan_tier} plan` : 'Provider-reported balance',
            percent: null,
            tone: 'indeterminate',
            action: 'refresh',
        };
    }

    if (provider.resets_available !== null && provider.resets_available !== undefined) {
        const count = Number(provider.resets_available);
        return {
            visible: true,
            family,
            provider,
            label: 'Quota status',
            value: `${Number.isFinite(count) ? count : provider.resets_available} resets`,
            detail: provider.plan_tier ? `${provider.plan_tier} plan` : 'No percentage reported',
            percent: null,
            tone: 'indeterminate',
            action: 'refresh',
        };
    }

    return {
        visible: true,
        family,
        provider,
        label: 'Quota',
        value: S.quotaLoading ? 'Checking…' : 'Not reported',
        detail: provider.error || 'Click to check again',
        percent: null,
        tone: S.quotaLoading ? 'indeterminate' : 'unavailable',
        action: 'refresh',
    };
}

const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

// Top bar: just the billing badge + (on a subscription) a compact usage bar.
// No numbers/labels/reset text up here — those live in the tap-to-open panel.
function renderQuotaMeter() {
    const monitor = document.getElementById('subscriptionMonitor');
    const meter = document.getElementById('quotaMeter');
    const track = document.getElementById('quotaMeterTrack');
    const fill = document.getElementById('quotaMeterFill');
    const statusBar = document.querySelector('.status-bar');
    if (!monitor || !meter || !track || !fill) return;

    const billing = billingModeForModel(S.currentModel);
    const spec = billingBadgeForModel(S.currentModel);
    monitor.hidden = !spec;
    const isSubscription = billing === 'subscription';
    statusBar?.classList.toggle('quota-active', isSubscription);
    meter.classList.toggle('interactive', isSubscription);
    meter.setAttribute('aria-haspopup', isSubscription ? 'dialog' : 'false');
    track.hidden = !isSubscription;

    if (!isSubscription) {
        // The badge alone is the billing indicator (API-metered / not connected);
        // there is no quota to expand, so the button stays inert.
        meter.removeAttribute('aria-busy');
        meter.setAttribute('aria-expanded', 'false');
        meter.title = spec ? spec.title : '';
        meter.setAttribute('aria-label', spec ? spec.label : 'Billing');
        return;
    }

    const summary = quotaSummary();
    meter.setAttribute('aria-busy', String(S.quotaLoading));
    meter.setAttribute('aria-expanded', String(!!(window.Menus && Menus.isOpen('quotaPanel'))));
    const providerName = summary.provider?.label || PROVIDER_LABEL[summary.family] || 'Claude';
    const desc = summary.percent === null
        ? `${providerName} subscription usage — ${String(summary.value).toLowerCase()}. Tap for details.`
        : `${providerName} subscription: ${summary.value}${summary.detail ? `, ${summary.detail}` : ''}. Tap for details.`;
    meter.title = desc;
    meter.setAttribute('aria-label', desc);

    track.className = `quota-meter-track${summary.tone === 'indeterminate' ? ' indeterminate' : ''}`;
    fill.className = `quota-meter-fill${summary.tone === 'warn' ? ' warn' : summary.tone === 'critical' ? ' critical' : summary.tone === 'unavailable' ? ' unavailable' : ''}`;
    fill.style.width = summary.percent === null ? '' : `${summary.percent}%`;

    if (window.Menus && Menus.isOpen('quotaPanel')) renderQuotaPanel();
}

function quotaCheckedAgoText() {
    if (S.quotaLoading) return 'Checking…';
    if (!S.quotaCheckedAt) return 'Not checked yet';
    const secs = Math.max(0, Math.round((Date.now() - S.quotaCheckedAt) / 1000));
    if (secs < 45) return 'Checked just now';
    const mins = Math.round(secs / 60);
    return mins <= 1 ? 'Checked 1 min ago' : `Checked ${mins} min ago`;
}

// The tap-to-open breakdown: every window's %, reset time, credits/plan, or the
// explicit unavailable/sign-in state — reusing the Info panel's .info-bar meter.
function renderQuotaPanel() {
    const el = document.getElementById('quotaPanel');
    if (!el) return;
    const summary = quotaSummary();
    const family = agentIdForModel(S.currentModel);
    const provider = summary.provider;
    const providerName = provider?.label || PROVIDER_LABEL[family] || 'Claude';

    let body;
    if (!summary.visible) {
        body = '<div class="quota-row"><span class="info-dim">Not a subscription-backed model.</span></div>';
    } else {
        const windows = provider ? quotaWindows(provider) : [];
        if (windows.length) {
            body = windows.map((w) => {
                const pct = Math.max(0, Math.min(100, Math.round(Number(w.used_percent))));
                const tone = pct >= 85 ? ' critical' : pct >= 65 ? ' warn' : '';
                const reset = shortQuotaReset(w.resets_at);
                return `<div class="quota-row">
                    <div class="quota-row-head">
                        <span class="quota-row-name">${escHtml(w.name || 'Quota')}</span>
                        <span class="quota-row-pct">${pct}<span class="quota-row-pct-sub">% used</span></span>
                    </div>
                    <span class="info-bar"><span class="info-bar-fill${tone}" style="width:${pct}%"></span></span>
                    ${reset ? `<span class="quota-row-reset">${escHtml(reset)}</span>` : ''}
                </div>`;
            }).join('');
        } else if (provider && provider.status === 'setup_required') {
            body = '<div class="quota-row"><span class="info-dim">Finish Antigravity sign-in to see quota.</span></div>'
                + '<button class="quota-action" type="button" onclick="quotaOpenSetup()">Open AI settings</button>';
        } else if (provider && provider.credits_remaining !== null && provider.credits_remaining !== undefined) {
            body = `<div class="info-row"><span class="info-key">Credits</span><span class="info-val">${escHtml(String(provider.credits_remaining))} left</span></div>`;
        } else if (provider && provider.resets_available !== null && provider.resets_available !== undefined) {
            body = `<div class="info-row"><span class="info-key">Resets available</span><span class="info-val">${escHtml(String(provider.resets_available))}</span></div>`;
        } else {
            const err = (provider && provider.error) || S.quotaError || 'No quota reported yet.';
            body = `<div class="quota-row"><span class="info-dim">${escHtml(err)}</span></div>`;
        }
        if (provider && provider.plan_tier) {
            body += `<div class="info-row"><span class="info-key">Plan</span><span class="info-val">${escHtml(provider.plan_tier)}</span></div>`;
        }
    }

    const tail = provider && provider.source ? ` · ${escHtml(provider.source)}` : '';
    el.innerHTML = `
        <div class="quota-panel-head">
            <span class="quota-panel-title">${escHtml(providerName)} usage</span>
            <button class="quota-refresh" type="button" ${S.quotaLoading ? 'disabled' : ''}
                    onclick="quotaRefreshFromPanel(event)" title="Refresh now" aria-label="Refresh subscription usage">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
        </div>
        <div class="quota-panel-body">${body}</div>
        <div class="quota-panel-foot">${escHtml(quotaCheckedAgoText())}${tail}</div>`;
}

function quotaRefreshFromPanel(event) {
    if (event) event.stopPropagation();
    refreshSubscriptionQuota({ force: true });
}

function quotaOpenSetup() {
    Menus.hide();
    openAIConfig();
    switchSetupTab('agy');
}

function quotaIsStale() {
    return !S.providerUsage || Date.now() - S.quotaCheckedAt >= QUOTA_REFRESH_INTERVAL_MS;
}

function shouldCheckQuota() {
    return billingModeForModel(S.currentModel) === 'subscription';
}

// A provider that answered without quota data (business plans can hide rate
// limits entirely) will answer the same way five minutes from now — re-probing
// it every cycle just animates "Checking…" over the gray bar. Back off to an
// hourly re-check so a transient CLI failure still self-heals; opening the
// quota panel always forces a fresh check regardless.
function quotaAutoRefreshDue() {
    if (!shouldCheckQuota() || !quotaIsStale()) return false;
    if (quotaProviderForCurrentModel()?.status !== 'unavailable') return true;
    return Date.now() - S.quotaCheckedAt >= QUOTA_UNAVAILABLE_RETRY_MS;
}

async function refreshSubscriptionQuota({ force = false } = {}) {
    if (!shouldCheckQuota()) {
        renderQuotaMeter();
        return null;
    }
    if (S.quotaRequest) return S.quotaRequest;

    S.quotaLoading = true;
    renderQuotaMeter();
    let request;
    request = (async () => {
        try {
            const response = await fetch('/api/usage', force
                ? { headers: { 'X-Shellteam-Refresh': '1' } }
                : undefined);
            const usage = await response.json();
            if (!response.ok || usage.error) throw new Error('usage unavailable');
            S.providerUsage = usage;
            S.quotaCheckedAt = Date.now();
            S.quotaError = null;
            return usage;
        } catch {
            S.quotaError = 'Couldn’t refresh quota. Click to try again.';
            return null;
        } finally {
            S.quotaLoading = false;
            if (S.quotaRequest === request) S.quotaRequest = null;
            renderQuotaMeter();
            updateInfoWarning();
            refreshInfoPanelIfOpen();
        }
    })();
    S.quotaRequest = request;
    return request;
}

function ensureQuotaPolling() {
    if (!quotaPollTimer) {
        quotaPollTimer = setInterval(() => {
            if (!document.hidden && quotaAutoRefreshDue()) refreshSubscriptionQuota();
        }, QUOTA_REFRESH_INTERVAL_MS);
    }
    if (quotaAutoRefreshDue()) refreshSubscriptionQuota();
}

// Reflect the selected model's billing mode in the badge next to the picker.
function updateAuthBadge() {
    const el = document.getElementById('authBadge');
    const monitor = document.getElementById('subscriptionMonitor');
    if (!el) return;
    const spec = billingBadgeForModel(S.currentModel);
    if (spec) {
        if (monitor) monitor.hidden = false;
        el.hidden = false;
        el.textContent = spec.label;
        el.title = spec.title;
        el.className = 'auth-badge ' + spec.cls;
    } else {
        if (monitor) monitor.hidden = true;
        el.hidden = true;
    }
    renderQuotaMeter();
    updateInfoWarning();
    refreshInfoPanelIfOpen();
    ensureQuotaPolling();
}

document.getElementById('quotaMeter')?.addEventListener('click', () => {
    if (billingModeForModel(S.currentModel) !== 'subscription') return;
    Menus.toggle('quotaPanel');
    const open = Menus.isOpen('quotaPanel');
    document.getElementById('quotaMeter')?.setAttribute('aria-expanded', String(open));
    // Opening a stale panel kicks off a background refresh; renderQuotaMeter()
    // re-renders it live when the data lands.
    if (open && quotaIsStale()) refreshSubscriptionQuota({ force: true });
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && quotaAutoRefreshDue()) refreshSubscriptionQuota();
});

// --- Info panel ------------------------------------------------------------
// The always-available answer to "what is this conversation running on / how
// full is the context / what is it costing me". The inline pills above only
// show on wide screens (and only when they have data) — this panel opens at
// every width and states the unknowns explicitly instead of hiding.

function subscriptionQuotaInfoHtml() {
    const summary = quotaSummary();
    if (!summary.visible) return '<span class="info-dim">not a subscription-backed model</span>';
    const text = `${summary.label} · ${summary.value}${summary.detail ? ` · ${summary.detail}` : ''}`;
    if (summary.percent === null) return `<span class="info-dim">${escHtml(text)}</span>`;
    return `<span>${escHtml(text)}</span>
        <span class="info-bar"><span class="info-bar-fill${summary.percent >= 80 ? ' warn' : ''}" style="width:${summary.percent}%"></span></span>`;
}

function renderInfoPanel() {
    const el = document.getElementById('infoPanel');
    if (!el) return;
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    const famId = agentIdForModel(S.currentModel);
    const fam = catalogAgents().find(a => a.id === famId);
    const billing = billingBadgeForModel(S.currentModel);

    const tokens = slot?.contextTokens;
    const windowSize = contextWindowForSlot(slot);
    const pct = tokens ? Math.min(100, Math.round((tokens / windowSize) * 100)) : null;
    const contextVal = tokens
        ? `<span>${Math.round(tokens / 1000)}k of ${Math.round(windowSize / 1000)}k · ${pct}%</span>
           <span class="info-bar"><span class="info-bar-fill${pct >= 80 ? ' warn' : ''}" style="width:${pct}%"></span></span>`
        : '<span class="info-dim">not reported by this agent yet</span>';

    const connected = S.ws && S.ws.readyState === WebSocket.OPEN;
    const conn = !connected ? 'Disconnected' : (S.isGenerating ? 'Working…' : 'Connected');

    // The cost figure is the agent's API-list price for the tokens used. On a
    // subscription that money was never charged — we show it anyway (it's the
    // honest answer to "what is this usage worth"), with wording that makes
    // clear whether it is a real bill or a token-value estimate.
    const COST_NOTE = {
        subscription: 'token value at API prices — covered by your subscription, nothing billed',
        apikey: 'billed to your API key',
        included: "billed to this box's API key",
    };
    const costNote = COST_NOTE[billingModeForModel(S.currentModel)];
    const costVal = S.totalCost > 0
        ? `<span>$${S.totalCost.toFixed(2)}</span>${costNote ? `<span class="info-note">${costNote}</span>` : ''}`
        : '<span class="info-dim">—</span>';
    const quotaVal = subscriptionQuotaInfoHtml();

    const rows = [
        ['Agent', escHtml((fam && fam.label) || famId)],
        ['Model', escHtml(modelDisplayName(S.currentModel))],
        ['Billing', billing
            ? `<span class="auth-badge ${billing.cls}" title="${escHtml(billing.title)}">${billing.label}</span>`
            : '<span class="info-dim">unknown until connected</span>'],
        ['Subscription quota', quotaVal],
        ['Context', contextVal],
        ['Cost', costVal],
        ['Workspace', `<span class="info-mono">${escHtml(shortPath(currentCwd()))}</span>`],
        ['Session', S.sessionId
            ? `<span class="info-mono" title="${escHtml(S.sessionId)}">${escHtml(String(S.sessionId).slice(0, 8))}</span>`
            : '<span class="info-dim">not started</span>'],
        ['Connection', `<span class="info-conn${connected ? '' : ' off'}">${conn}</span>`],
    ];
    el.innerHTML = '<div class="info-title">This conversation</div>' + rows.map(([k, v]) =>
        `<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`
    ).join('');
}

function refreshInfoPanelIfOpen() {
    if (window.Menus && Menus.isOpen('infoPanel')) renderInfoPanel();
}

// Amber dot on the Info button whenever something in the panel deserves a
// look before the next message: a metered API key ($$$), a missing credential,
// or a context window ≥80% full.
function updateInfoWarning() {
    const btn = document.getElementById('btnInfo');
    if (!btn) return;
    const mode = billingModeForModel(S.currentModel);
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    const tokens = slot?.contextTokens;
    const hot = tokens && tokens / contextWindowForModel(S.currentModel) >= 0.8;
    const quota = quotaSummary();
    const quotaHot = quota.percent !== null && quota.percent >= 85;
    const subscriptionExpired = subscriptionHealthForFamily(agentIdForModel(S.currentModel)) === 'expired';
    btn.classList.toggle('warn', subscriptionExpired || mode === 'apikey' || mode === 'none' || !!hot || quotaHot);
}

// Values shown inline in the AI menu's Model / Workspace rows.
function renderAIMenuValues() {
    setModelDisplay(S.currentModel);
    const cwdEl = document.getElementById('aiMenuCwd');
    if (cwdEl) cwdEl.textContent = shortPath(currentCwd());
}

function hasAnyProvider() {
    // True when at least one agent can actually run: credentials AND an installed
    // CLI. OpenCode only counts when the box has a Fireworks key (S.hasOpenCode) —
    // otherwise it is a broken fallback.
    return (agentInstalled('claude') && familyHasAuth('claude'))
        || (agentInstalled('codex') && familyHasAuth('codex'))
        || (agentInstalled('antigravity') && familyHasAuth('antigravity'))
        || (agentInstalled('opencode') && S.hasOpenCode);
}

// The user explicitly took the "on us" option (renderIncludedFallback). Kept in
// this browser: an included key is a courtesy fallback, so the setup screen
// asks for the user's OWN plan first and only stops asking once they chose it.
const INCLUDED_CHOSEN_KEY = 'shellteam.includedChosen';
function includedFallbackChosen() {
    return localStorage.getItem(INCLUDED_CHOSEN_KEY) === '1';
}

function hasIncludedFamily() {
    return Object.keys(SETUP_TAB_FAMILY).map(t => SETUP_TAB_FAMILY[t])
        .some(fam => agentInstalled(fam) && familyIsIncluded(fam));
}

function isAuthed() {
    // When OpenCode is available (managed Fireworks key), a brand-new box can chat
    // immediately. When it is NOT (OSS box with no FIREWORKS_API_KEY), a box with
    // zero credentials has no working agent, so we must show the setup flow instead
    // of silently dropping the user into a chat that fails on first message.
    //
    // A family whose only credential is the box's INCLUDED key is different: the
    // operator wants the user asked for their own plan first, so it counts only
    // once the user has explicitly chosen the "on us" option.
    //
    // This does NOT suppress the per-model auth screen: `changeModel()` still calls
    // `hasAuthForModel(model)` and shows setup if the user switches to a provider
    // without credentials. `isAuthed()` only gates the initial chat-vs-setup choice.
    if (!hasAnyProvider()) return false;
    const own = ['claude', 'codex', 'antigravity'].some(fam => agentInstalled(fam) && familyHasOwnAuth(fam))
        || (agentInstalled('opencode') && S.hasOpenCode);
    return own || !hasIncludedFamily() || includedFallbackChosen();
}

function showChat() {
    E.setupScreen.classList.add('hidden');
    E.composer.classList.remove('hidden');
    updateEmptyState();
    E.input.focus();
}

let _manualConfigOpen = false;

function showSetup() {
    E.setupScreen.classList.remove('hidden');
    E.messages.classList.add('hidden');
    E.emptyState.classList.add('hidden');
    E.composer.classList.add('hidden');
    resetOAuthUI();
    updateSetupDots();
}

function openAIConfig() {
    _manualConfigOpen = true;
    $('setupClose').classList.remove('hidden');
    showSetup();
    ActionsMenu.hide();
}

function closeAIConfig() {
    _manualConfigOpen = false;
    $('setupClose').classList.add('hidden');
    showChat();
}

function continueWithOpenCode() {
    _manualConfigOpen = false;
    $('setupClose').classList.add('hidden');
    const model = opencodeDefaultModel();
    changeModel(model);
}

function continueWithIncluded(model) {
    localStorage.setItem(INCLUDED_CHOSEN_KEY, '1');
    _manualConfigOpen = false;
    $('setupClose').classList.add('hidden');
    changeModel(model);
}

// One button per model the box offers on its own key, under every setup tab:
// "connect your plan" stays the headline, the courtesy option comes second.
function renderIncludedFallback() {
    const box = $('setupIncluded');
    if (!box) return;
    const entries = [];
    for (const fam of Object.values(SETUP_TAB_FAMILY)) {
        if (!agentInstalled(fam) || !familyIsIncluded(fam)) continue;
        for (const id of includedModelsFor(fam)) entries.push(id);
    }
    box.classList.toggle('hidden', entries.length === 0);
    if (!entries.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="setup-divider"><span>or skip the sign-in</span></div>`
        + entries.map(id => `<button class="setup-btn setup-included-btn" type="button" onclick="continueWithIncluded('${jsArg(id)}')">
                ${escHtml(modelDisplayName(id))} <span class="setup-included-tag">on us</span>
            </button>`).join('')
        + `<div class="setup-hint" style="text-align: center; margin-top: 8px;">Runs on this box's own key, nothing billed to you. Connect your plan any time for the full model list.</div>`;
}

function updateSetupDots() {
    const ccDot = $('dot-cc');
    const cdxDot = $('dot-cdx');
    if (ccDot) ccDot.classList.toggle('connected', familyHasAuth('claude'));
    if (ccDot) ccDot.classList.toggle('attention', subscriptionHealthForFamily('claude') === 'expired');
    if (cdxDot) cdxDot.classList.toggle('connected', familyHasAuth('codex'));
    if (cdxDot) cdxDot.classList.toggle('attention', subscriptionHealthForFamily('codex') === 'expired');
    const agyDot = $('dot-agy');
    if (agyDot) agyDot.classList.toggle('connected', familyHasAuth('antigravity'));
    if (agyDot) agyDot.classList.toggle('attention', subscriptionHealthForFamily('antigravity') === 'expired');
    updateSetupTabVisibility();
    updateOpenCodeSetup();
    renderIncludedFallback();
}

// Setup tab ↔ agent family. A family whose CLI isn't installed on the box gets
// its tab hidden outright — offering it produced a dead "Connecting…" screen
// (the employee container only ships claude + codex).
const SETUP_TAB_FAMILY = { cc: 'claude', cdx: 'codex', agy: 'antigravity', oc: 'opencode' };

function setupTabBtn(tab) {
    return document.querySelector(`.setup-tab[onclick*="'${tab}'"]`);
}

function firstInstalledSetupTab() {
    return Object.keys(SETUP_TAB_FAMILY).find(t => agentInstalled(SETUP_TAB_FAMILY[t]));
}

function updateSetupTabVisibility() {
    let activeHidden = false;
    for (const [tab, fam] of Object.entries(SETUP_TAB_FAMILY)) {
        const btn = setupTabBtn(tab);
        if (!btn) continue;
        const show = agentInstalled(fam);
        btn.classList.toggle('hidden', !show);
        if (!show && btn.classList.contains('active')) activeHidden = true;
    }
    // The intro line advertises OpenCode as the no-subscription path — drop it
    // when OpenCode isn't on the box.
    const intro = $('setupIntroOc');
    if (intro) intro.classList.toggle('hidden', !agentInstalled('opencode'));
    if (activeHidden) {
        const fallback = firstInstalledSetupTab();
        if (fallback) switchSetupTab(fallback);
    }
}

function updateOpenCodeSetup() {
    // OpenCode is "included" only when the box holds a Fireworks key. Reflect the
    // real state in the setup screen so we never advertise a fallback that fails.
    const ocDot = $('dot-oc');
    if (ocDot) ocDot.classList.toggle('connected', S.hasOpenCode);
    const card = document.querySelector('.setup-oc-card');
    const btn = document.querySelector('button[onclick="continueWithOpenCode()"]');
    if (!card) return;
    const title = card.querySelector('.setup-oc-title');
    const body = card.querySelector('.setup-oc-body');
    if (S.hasOpenCode) {
        if (title) title.innerHTML = '✓ Frontier open-source models';
        if (body) body.textContent = 'OpenCode is the open-source coding agent, running on '
            + 'state-of-the-art open-source models via this box\u2019s Fireworks API key.';
        if (btn) { btn.disabled = false; btn.textContent = 'Continue with OpenCode'; }
    } else {
        if (title) title.textContent = 'OpenCode needs a Fireworks key';
        if (body) body.textContent = 'OpenCode runs on Fireworks. Add your Fireworks key in '
            + 'Settings → Feature keys — it activates immediately. Or connect '
            + 'Claude, OpenAI or Antigravity above.';
        if (btn) { btn.disabled = true; btn.textContent = 'Unavailable — needs a Fireworks key'; }
    }
}

function updateEmptyState() {
    const hasMessages = E.messages.children.length > 0;
    E.messages.classList.toggle('hidden', !hasMessages);
    E.emptyState.classList.toggle('hidden', hasMessages);
}

function fillSuggestion(btn) {
    const text = btn.textContent.replace(/^"|"$/g, '');
    E.input.value = text;
    E.input.focus();
}

function autoSwitchToAuthedModel() {
    // Current model already has credentials — nothing to do
    if (hasAuthForModel(S.currentModel)) return false;
    // Preference order: Claude Opus → Codex GPT-5.6 Sol → OpenCode.
    // OpenCode is the fallback when the box has a Fireworks key configured.
    const fallbacks = [
        { check: () => agentInstalled('claude') && familyHasAuth('claude'), model: 'claude-opus-5' },
        { check: () => agentInstalled('codex') && familyHasAuth('codex'), model: preferredModelFor('codex', 'gpt-5.6-sol-max') },
        { check: () => agentInstalled('opencode') && S.hasOpenCode, model: opencodeDefaultModel() },
    ];
    for (const { check, model } of fallbacks) {
        if (check()) {
            changeModel(model);
            return true;
        }
    }
    return false;
}

function updateAuthUI() {
    updateSetupDots();
    updateAuthBadge();
    if (_manualConfigOpen) return; // user is browsing config — don't auto-navigate
    if (isAuthed()) {
        if (!hasAuthForModel(S.currentModel)) {
            // Auto-switch to a model the user has credentials for
            if (autoSwitchToAuthedModel()) {
                setModelDisplay(S.currentModel);
                showChat();
            } else {
                showSetup();
                switchSetupTab(setupTabForModel(S.currentModel));
            }
        } else {
            showChat();
        }
    } else {
        showSetup();
    }
}

// --- Setup Screen ---

const PROVIDERS = {
    cc: {
        name: 'Claude',
        oauthStateKey: 'hasOAuth',
        apiKeyStateKey: 'hasApiKey',
        oauthBtnLabel: 'Login with Claude',
        oauthFlow: 'code',
        wsStartOAuth: 'start_oauth',
    },
    cdx: {
        name: 'OpenAI',
        oauthStateKey: 'hasCodexOAuth',
        apiKeyStateKey: 'hasOpenAIKey',
        oauthBtnLabel: 'Login with OpenAI',
        oauthFlow: 'device',
        wsStartOAuth: 'start_codex_oauth',
    },
};

let oauthUrl = null;

function $(id) { return document.getElementById(id); }

function openUrl(url) {
    try { (window.top || window).open(url, '_blank'); } catch { window.open(url, '_blank'); }
}

function showSetupError(text) {
    const el = $('setupError');
    el.textContent = text;
    el.style.display = 'block';
}

function switchSetupTab(tab) {
    // Never land on a hidden tab (e.g. a model whose family isn't installed
    // routed here) — divert to the first family this box can actually run.
    if (setupTabBtn(tab)?.classList.contains('hidden')) tab = firstInstalledSetupTab() || tab;
    document.querySelectorAll('.setup-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.setup-panel').forEach(p => p.classList.remove('active'));
    const tabBtn = document.querySelector(`.setup-tab[onclick*="${tab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    const panel = $('panel-' + tab);
    if (panel) panel.classList.add('active');
}

function showOAuthStep(provider, step) {
    ['start', 'pending', 'success'].forEach((s, i) => {
        const el = $(`${provider}-oauth-${s}`);
        if (el) el.classList.toggle('hidden', i !== step);
    });
    const alt = $(`${provider}-alt`);
    if (alt) alt.classList.toggle('hidden', step !== 0);
}

function resetProviderUI(provider) {
    const p = PROVIDERS[provider];
    showOAuthStep(provider, 0);
    const oBtn = $(`${provider}-oauth-btn`);
    if (oBtn) { oBtn.disabled = false; oBtn.textContent = p.oauthBtnLabel; }
    const kBtn = $(`${provider}-key-btn`);
    if (kBtn) kBtn.disabled = false;
    const kInput = $(`${provider}-key-input`);
    if (kInput) kInput.value = '';
    if (provider === 'cc') {
        const cBtn = $(`${provider}-oauth-code-btn`);
        if (cBtn) { cBtn.disabled = false; cBtn.textContent = 'Connect'; }
        const cInput = $(`${provider}-oauth-code-input`);
        if (cInput) cInput.value = '';
    }
}

function resetOAuthUI() {
    for (const key of Object.keys(PROVIDERS)) resetProviderUI(key);
    // Antigravity uses dedicated handlers (not the PROVIDERS map) — reset it too.
    showOAuthStep('agy', 0);
    const agyBtn = $('agy-oauth-btn');
    if (agyBtn) { agyBtn.disabled = false; agyBtn.textContent = 'Login with Google'; }
    const agyCodeBtn = $('agy-oauth-code-btn');
    if (agyCodeBtn) { agyCodeBtn.disabled = false; agyCodeBtn.textContent = 'Connect'; }
    const agyCodeInput = $('agy-oauth-code-input');
    if (agyCodeInput) agyCodeInput.value = '';
    oauthUrl = null;
    localStorage.removeItem('pendingOAuthUrl');
}

function submitProviderKey(provider) {
    const key = $(`${provider}-key-input`).value.trim();
    if (!key.startsWith('sk-')) {
        showSetupError('API key should start with sk-');
        return;
    }
    $('setupError').style.display = 'none';
    $(`${provider}-key-btn`).disabled = true;
    S.ws?.send(JSON.stringify({ type: 'set_api_key', key }));
}

function startProviderOAuth(provider) {
    const p = PROVIDERS[provider];
    const btn = $(`${provider}-oauth-btn`);
    btn.disabled = true;
    btn.textContent = p.oauthFlow === 'device' ? 'Connecting...' : 'Opening...';
    S.ws?.send(JSON.stringify({ type: p.wsStartOAuth }));
}

function submitProviderOAuthCode(provider) {
    const input = $(`${provider}-oauth-code-input`);
    const btn = $(`${provider}-oauth-code-btn`);
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    $('setupError').style.display = 'none';
    S.ws?.send(JSON.stringify({ type: 'complete_oauth', code }));
}

function reopenProviderOAuth(provider) {
    if (provider === 'cc' && oauthUrl) openUrl(oauthUrl);
}

function providerOAuthSuccess(provider) {
    const p = PROVIDERS[provider];
    S[p.oauthStateKey] = true;
    showOAuthStep(provider, 2);
    setTimeout(updateAuthUI, 1000);
}

// --- Claude OAuth handlers ---
function handleOAuthUrl(url) {
    oauthUrl = url;
    localStorage.setItem('pendingOAuthUrl', url);
    switchSetupTab('cc');
    showOAuthStep('cc', 1);
    $('cc-oauth-link').href = oauthUrl;
    $('cc-oauth-code-input').focus();
    openUrl(url);
}

function restoreOAuthState(pendingFromServer) {
    if (pendingFromServer?.url) {
        oauthUrl = pendingFromServer.url;
        switchSetupTab('cc');
        showOAuthStep('cc', 1);
        $('cc-oauth-link').href = oauthUrl;
        $('cc-oauth-code-input').focus();
    } else {
        localStorage.removeItem('pendingOAuthUrl');
    }
}

// --- Codex OAuth handlers ---
function handleCodexDeviceCode(msg) {
    switchSetupTab('cdx');
    showOAuthStep('cdx', 1);
    $('cdx-device-code').textContent = msg.userCode;
    $('cdx-oauth-link').href = msg.verificationUri;
    openUrl(msg.verificationUri);
}

function restoreCodexAuthState(pending) {
    if (pending?.userCode) handleCodexDeviceCode(pending);
}

// --- Antigravity OAuth handlers (agy — Google code-paste, drives the real CLI) ---
function restoreAntigravityAuthState(pending) {
    if (pending?.url) {
        switchSetupTab('agy');
        showOAuthStep('agy', 1);
        $('agy-oauth-link').href = pending.url;
        $('agy-oauth-code-input').focus();
    }
}

function startAntigravityOAuth() {
    $('agy-oauth-btn').disabled = true;
    $('agy-oauth-btn').textContent = 'Opening...';
    $('setupError').style.display = 'none';
    S.ws?.send(JSON.stringify({ type: 'start_antigravity_oauth' }));
}

function handleAntigravityOAuthUrl(url) {
    switchSetupTab('agy');
    showOAuthStep('agy', 1);
    $('agy-oauth-link').href = url;
    $('agy-oauth-code-input').focus();
    openUrl(url);
}

function submitAntigravityOAuthCode() {
    const input = $('agy-oauth-code-input');
    const btn = $('agy-oauth-code-btn');
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    $('setupError').style.display = 'none';
    S.ws?.send(JSON.stringify({ type: 'complete_antigravity_oauth', code }));
}

// --- WebSocket ---
let _connectCount = 0;
// True once the first status snapshot after a (re)connect has been applied.
// Only that snapshot may materialize new local tabs from server slots —
// every later broadcast (fired on ~20 unrelated events, to all clients)
// must NOT create tabs, or slots opened in another view / by an agent pop
// up here unasked (SHE-44).
let _slotsSyncedThisConnection = false;
let _lastMessageAt = 0;
let _aliveCheckTimer = null;
let _consecutiveAuthFailures = 0;
const ALIVE_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_AUTH_FAILURES = 6;

// On a 1008 auth-rejected close, ask the parent (dashboard) to refresh the cookie
// and reconnect once it acknowledges. Falls back to a long backoff if the parent
// is unreachable (dashboard tab closed, iframe orphaned).
function _waitForAuthRefreshThenReconnect() {
    let done = false;
    const onAck = (e) => {
        if (e.data?.type !== 'auth_cookie_refreshed' || done) return;
        done = true;
        window.removeEventListener('message', onAck);
        setTimeout(connect, 250);
    };
    window.addEventListener('message', onAck);
    window.parent.postMessage({ type: 'refresh_auth_cookie' }, '*');
    setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onAck);
        setTimeout(connect, 30_000);
    }, 5_000);
}

function _resetAliveCheck() {
    _lastMessageAt = Date.now();
    if (_aliveCheckTimer) clearInterval(_aliveCheckTimer);
    _aliveCheckTimer = setInterval(() => {
        if (S.ws && S.ws.readyState === 1 && Date.now() - _lastMessageAt > ALIVE_TIMEOUT_MS) {
            console.log('[ws] No message in 45s — closing for reconnect');
            S.ws.close();
        }
    }, 10_000);
}

function connect() {
    S.ws = new WebSocket(wsUrl);

    S.ws.onopen = () => {
        _connectCount++;
        _slotsSyncedThisConnection = false;
        S.reconnectDelay = 1000;
        setStatus('idle', 'Connected');
        _resetAliveCheck();
        S.ws.send(JSON.stringify({ type: 'list_workspaces' }));
        // Reconnect deliberately does NOT replay local tabs as create_tab
        // commands. The server owns which tabs exist; the first status snapshot
        // reconciles this client instead (see the status handler). The old
        // replay was SHE-78: a client reconnecting with stale state re-created
        // — and re-persisted — every tab another device had closed, so "empty
        // chat tabs keep appearing" on all devices.
    };

    S.ws.onmessage = (e) => {
        // Only a real server message proves the connection is healthy — onopen alone
        // fires even when the server accepts then immediately closes 1008.
        _consecutiveAuthFailures = 0;
        _lastMessageAt = Date.now();
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
            if (S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }
        handleMessage(msg);
    };

    S.ws.onclose = (event) => {
        if (_aliveCheckTimer) { clearInterval(_aliveCheckTimer); _aliveCheckTimer = null; }
        setStatus('disconnected', 'Disconnected');
        if (event.code === 1008) {
            _consecutiveAuthFailures++;
            if (_consecutiveAuthFailures > MAX_CONSECUTIVE_AUTH_FAILURES) {
                setStatus('error', 'Session expired — please refresh the page');
                return;
            }
            _waitForAuthRefreshThenReconnect();
        } else {
            setTimeout(connect, S.reconnectDelay);
            S.reconnectDelay = Math.min(S.reconnectDelay * 1.5, 15000);
        }
    };

    S.ws.onerror = () => {};
}

// =============================================================
// Message routing — protocol messages go to Chat.handle()
// =============================================================

// Protocol message types that Chat.handle() knows about
const CHAT_TYPES = new Set([
    'text_delta', 'text_done', 'tool_start', 'tool_input', 'tool_result',
    'ask_user', 'plan_start', 'plan_done', 'subagent_progress', 'subagent_done',
    'turn_done', 'error', 'streaming_catchup',
]);

// Global message types (not per-slot)
const GLOBAL_TYPES = new Set([
    'status', 'api_key_saved', 'oauth_url', 'oauth_success', 'oauth_error',
    'codex_device_code', 'codex_oauth_success', 'codex_oauth_error',
    'antigravity_oauth_url', 'antigravity_oauth_success', 'antigravity_oauth_error',
    'subscription_expired',
    'workspaces_list', 'directories_list', 'sessions_list', 'sessions_search_result', 'files_list',
]);

function handleMessage(msg) {
    const msgSlot = msg.slot ?? 0;

    // The server allocated the canonical id for a fresh create (SHE-52). When
    // another device won the raced id, the ack renames our optimistic local
    // tab instead of letting two conversations merge into one server slot.
    if (msg.type === 'tab_created') {
        if (msg.nonce && _pendingCreates.has(msg.nonce)) {
            renameLocalSlot(_pendingCreates.get(msg.nonce), msg.slot);
            _pendingCreates.delete(msg.nonce);
        }
        return;
    }

    // The server refused a command because this slot no longer exists (closed
    // on another device): drop the ghost tab; a refused `send` echoes the
    // content back so the typed message lands in the composer, never the void.
    if (msg.type === 'slot_gone') {
        const i = sessionSlots.findIndex(s => s.id === msg.slot);
        if (i !== -1 && sessionSlots.length > 1) {
            const wasActive = activeSlotId === msg.slot;
            sessionSlots.splice(i, 1);
            if (wasActive) { activeSlotId = -1; switchSessionTab(sessionSlots[0].id); }
            renderSessionTabs();
        }
        let restored = '';
        if (typeof msg.content === 'string') restored = msg.content;
        else if (Array.isArray(msg.content)) restored = msg.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
        if (restored && E.input) {
            E.input.value = restored;
            E.input.dispatchEvent(new Event('input'));
        }
        showError('That tab was closed on another device' + (restored ? ' — your message was restored to the input box.' : '.'));
        return;
    }

    // Chat protocol messages — route by slot
    if (CHAT_TYPES.has(msg.type)) {
        if (msgSlot !== activeSlotId) {
            accumulateForSlot(msgSlot, msg);
            return;
        }
        if (!S.isReplayingHistory) Chat.handle(msg);
        // Track slot state
        if (msg.type === 'turn_done') {
            const slot = sessionSlots.find(s => s.id === activeSlotId);
            if (slot) { slot.isGenerating = false; slot.pendingSend = false; }
            setGenerating(false);
            setStatus('idle', 'Idle');
        }
        return;
    }

    // Init message — track session ID and auth
    if (msg.type === 'init') {
        if (msgSlot !== activeSlotId) {
            accumulateForSlot(msgSlot, msg);
            return;
        }
        S.apiKeySource = msg.apiKeySource || S.apiKeySource;
        if (msg.sessionId) {
            S.sessionId = msg.sessionId;
            updateSlotSessionId(activeSlotId, msg.sessionId);
        }
        updateAuthUI();
        return;
    }

    // History replay
    if (msg.type === 'history') {
        if (msgSlot !== activeSlotId) {
            accumulateForSlot(msgSlot, msg);
            return;
        }
        Chat.replayHistory(msg.messages);
        if (msg.messages && !isCompactedHistory(msg.messages)) {
            const firstUser = msg.messages.find(m => m.type === 'user_message');
            if (firstUser) updateSlotLabel(activeSlotId, firstUser.content);
        }
        return;
    }

    // Session events (per-slot)
    if (msg.type === 'session_event') {
        // Occupancy is per-slot, so a compaction invalidates its own slot's
        // meter whether or not you're looking at that tab (SHE-48).
        if (msg.event === 'compacted') clearContextMeter(msgSlot);
        if (msgSlot !== activeSlotId) {
            accumulateForSlot(msgSlot, msg);
            return;
        }
        Chat.handle(msg);
        if (msg.sessionId) {
            S.sessionId = msg.sessionId;
            updateSlotSessionId(activeSlotId, msg.sessionId);
        }
        return;
    }

    // Model/CWD changes (per-slot but also update UI). The server decides
    // whether the conversation survives the switch (msg.reset) — same-family
    // model changes keep the session, cross-family ones reset it.
    if (msg.type === 'model_changed') {
        const changedSlotId = msg.slot ?? 0;
        const changedSlot = sessionSlots.find(s => s.id === changedSlotId);
        if (changedSlot) changedSlot.config.model = msg.model;
        // A per-model operative window (Codex reports 258400) must not outlive
        // its model: clearing it lets the meter re-derive the new model's window
        // instead of capping a 1M-window Claude model against a stale 258k
        // denominator — the Codex→Fable switch that read "584k · 100%" (SHE-92).
        if (changedSlot) changedSlot.contextWindow = null;
        if (changedSlotId === activeSlotId) {
            S.currentModel = msg.model;
            setModelDisplay(msg.model);
            updateAuthBadge();
            renderContextMeter();
        }
        if (msg.reset) {
            if (changedSlotId === activeSlotId) {
                resetActiveSlotSession();
            } else if (changedSlot) {
                Object.assign(changedSlot, {
                    sessionId: null, isGenerating: false, domSnapshot: null,
                    pendingMessages: [], totalCost: 0, quotes: [],
                });
                renderSessionTabs();
            }
        } else if (msg.handoff && changedSlotId === activeSlotId) {
            // Cross-family switch that carried the conversation over (portable
            // sessions). Keep the chat; render the visible handoff marker.
            Chat.renderHandoffMarker(msg.handoff);
        }
        return;
    }

    // A fork landed: point the (already-created, already-active) fork tab at
    // its fresh native session. The follow-up `history` broadcast paints the
    // copied transcript + the fork marker; nothing else to do here.
    if (msg.type === 'slot_forked') {
        // Our own fork's ack: adopt the server-allocated id first (it can
        // differ from our optimistic hint when two devices forked at once).
        if (msg.nonce && _pendingCreates.has(msg.nonce)) {
            renameLocalSlot(_pendingCreates.get(msg.nonce), msg.slot);
            _pendingCreates.delete(msg.nonce);
        }
        const forkSlotId = msg.slot;
        const forked = sessionSlots.find(s => s.id === forkSlotId);
        if (forked) {
            forked.sessionId = msg.sessionId;
            if (msg.model) forked.config.model = msg.model;
            if (msg.cwd) forked.config.cwd = msg.cwd;
        }
        if (forkSlotId === activeSlotId) {
            S.sessionId = msg.sessionId;
            if (msg.model) { S.currentModel = msg.model; setModelDisplay(msg.model); }
            if (msg.cwd) setWorkspaceDisplay(msg.cwd);
        }
        renderSessionTabs();
        return;
    }

    // Console mode toggle response from server (slot-scoped)
    if (msg.type === 'console_mode') {
        if (msgSlot === activeSlotId) {
            TerminalMode.handleServerMessage(msg);
        }
        return;
    }

    if (msg.type === 'cwd_changed') {
        const cwdSlot = sessionSlots.find(s => s.id === (msg.slot ?? activeSlotId));
        if (cwdSlot) cwdSlot.config.cwd = msg.cwd;
        if ((msg.slot ?? activeSlotId) === activeSlotId) {
            setWorkspaceDisplay(msg.cwd);
            renderAIMenuValues();
        }
        return;
    }

    // Global messages
    if (msg.type === 'status') {
        handleStatusMessage(msg);
        return;
    }

    // Other global types
    switch (msg.type) {
        case 'subscription_expired':
            S.subscriptionStatus ||= {};
            S.subscriptionStatus[msg.family] = 'expired';
            renderSubscriptionWarning();
            updateAuthBadge();
            updateSetupDots();
            break;
        case 'api_key_saved':
            if (msg.hasOpenAIKey) S.hasOpenAIKey = true;
            else S.hasApiKey = true;
            updateAuthUI();
            break;
        case 'oauth_url':
            handleOAuthUrl(msg.url);
            break;
        case 'oauth_success':
            localStorage.removeItem('pendingOAuthUrl');
            providerOAuthSuccess('cc');
            break;
        case 'oauth_error':
            showSetupError(msg.error);
            $('cc-oauth-code-btn').disabled = false;
            $('cc-oauth-code-btn').textContent = 'Connect';
            break;
        case 'codex_device_code':
            handleCodexDeviceCode(msg);
            break;
        case 'codex_oauth_success':
            providerOAuthSuccess('cdx');
            break;
        case 'codex_oauth_error':
            showSetupError(msg.error || 'OpenAI authentication failed');
            showOAuthStep('cdx', 0);
            break;
        case 'antigravity_oauth_url':
            handleAntigravityOAuthUrl(msg.url);
            break;
        case 'antigravity_oauth_success':
            S.hasAntigravityOAuth = true;
            showOAuthStep('agy', 2);
            updateAuthUI();
            break;
        case 'antigravity_oauth_error':
            showSetupError(msg.error || 'Antigravity sign-in failed');
            showOAuthStep('agy', 0);
            $('agy-oauth-btn').disabled = false;
            $('agy-oauth-btn').textContent = 'Login with Google';
            $('agy-oauth-code-btn').disabled = false;
            $('agy-oauth-code-btn').textContent = 'Connect';
            break;
        case 'tab_closed': {
            const idx = sessionSlots.findIndex(s => s.id === msg.slot);
            if (idx >= 0) {
                sessionSlots.splice(idx, 1);
                if (msg.slot === activeSlotId) {
                    const newIdx = Math.min(idx, sessionSlots.length - 1);
                    activeSlotId = -1;
                    switchSessionTab(sessionSlots[newIdx].id);
                } else {
                    renderSessionTabs();
                }
            }
            break;
        }
        case 'slot_renamed': {
            // Another device (or the echo of our own rename) retitled a tab.
            const slot = sessionSlots.find(s => s.id === msg.slot);
            if (slot) {
                slot.label = msg.title || '';
                if (_renamingSlotId === null) renderSessionTabs();
            }
            break;
        }
        case 'workspaces_list':
            populateWorkspaces(msg.workspaces);
            break;
        case 'directories_list':
            // Only the modal workspace picker consumes this now (SHE-100 made
            // it the single picker); drop stale results if it closed meanwhile.
            if (workspacePickerVisible()) {
                _pickerDirs = msg.dirs || [];
                renderWorkspacePickerList();
            }
            break;
        case 'sessions_list':
            renderSessionPicker(msg.sessions || []);
            break;
        case 'sessions_search_result':
            handleSessionSearchResult(msg.query || '', msg.sessions || []);
            break;
        case 'files_list':
            handleFilesReceived(msg.files || []);
            break;
    }
}

// Workspace lock (guest cockpit): the server pins every session inside one
// directory and reports it via status.workspaceLock (+ optional guestName).
// Enforcement is entirely server-side — this only hides the switching UI and
// shows a lock badge. No-op (all elements untouched) when unlocked.
function applyWorkspaceLockUI() {
    const locked = !!S.workspaceLock;
    const combo = document.getElementById('workspaceCombo');
    if (combo) combo.style.display = locked ? 'none' : '';
    const menuItem = document.getElementById('aiMenuWorkspaceItem');
    if (menuItem) menuItem.style.display = locked ? 'none' : '';
    const badge = document.getElementById('workspaceLockBadge');
    if (badge) {
        badge.hidden = !locked;
        if (locked) {
            const name = S.workspaceLock.split('/').filter(Boolean).pop() || S.workspaceLock;
            badge.textContent = '🔒 ' + name + (S.guestName ? ' · ' + S.guestName : '');
            badge.title = 'Workspace locked to ' + S.workspaceLock;
        }
    }
}

function handleStatusMessage(msg) {
    if (msg.workspaceLock !== undefined) {
        S.workspaceLock = msg.workspaceLock || null;
        S.guestName = msg.guestName || null;
        applyWorkspaceLockUI();
    }
    S.hasApiKey = msg.hasApiKey;
    S.hasOpenAIKey = msg.hasOpenAIKey;
    S.hasOAuth = msg.hasOAuth;
    S.hasCodexOAuth = !!msg.hasCodexOAuth;
    S.hasAntigravityOAuth = !!msg.hasAntigravityOAuth;
    S.hasOpenCode = !!msg.hasOpenCode;
    if (msg.sttAvailable !== undefined) {
        S.sttAvailable = !!msg.sttAvailable;
        updateMicAvailability();
    }
    if (msg.ttsAvailable !== undefined) {
        S.ttsAvailable = !!msg.ttsAvailable;
        updateAudioReplyAvailability();
    }
    if (msg.installedAgents) S.installedAgents = msg.installedAgents;
    S.apiKeySource = msg.apiKeySource || S.apiKeySource;
    if (msg.authMode) S.authMode = msg.authMode;
    if (msg.includedModels) S.includedModels = msg.includedModels;
    if (msg.subscriptionStatus) S.subscriptionStatus = msg.subscriptionStatus;
    renderSubscriptionWarning();
    // NB: top-level msg.sessionId is a legacy slot-0-only field (server sends
    // getSessionId(0)). Applying it unconditionally clobbers the session of a
    // non-zero active slot with slot 0's (often null) — which silently breaks
    // Compact/Rewind ("No active session"). Derive S.sessionId from the active
    // slot after the slot sync below; only fall back to the top-level field when
    // the server sent no slots array (it always does in current builds).
    if (msg.sessionId !== undefined && (!msg.slots || msg.slots.length === 0)) {
        S.sessionId = msg.sessionId;
        updateSlotSessionId(activeSlotId, msg.sessionId);
    }
    if (msg.totalCost !== undefined) S.totalCost = msg.totalCost;

    // Sync slots from server
    if (msg.slots && msg.slots.length > 0) {
        const firstSnapshot = !_slotsSyncedThisConnection;
        for (const serverSlot of msg.slots) {
            let local = sessionSlots.find(s => s.id === serverSlot.id);
            if (!local) {
                // A server slot this client doesn't have yet. Materialize it as a
                // background tab — never auto-switch to it (that would yank the
                // user's active view). The first snapshot after (re)connect is the
                // persisted-tab restore; a later broadcast means the slot was
                // opened on another device or by an agent. Either way it MUST be
                // materialized so its message traffic isn't black-holed in
                // accumulateForSlot — multi-device is a headline feature (SHE-44
                // suppresses the auto-switch/jump, not the slot itself).
                const lateMaterialize = _slotsSyncedThisConnection;
                local = makeSlot(serverSlot.id, serverSlot.label);
                local.sessionId = serverSlot.sessionId;
                local.isGenerating = serverSlot.isGenerating;
                local.totalCost = serverSlot.totalCost || 0;
                if (serverSlot.model) local.config.model = serverSlot.model;
                if (serverSlot.cwd) local.config.cwd = serverSlot.cwd;
                sessionSlots.push(local);
                // Output that arrived before this slot existed was dropped by
                // accumulateForSlot. On the first snapshot the connect handler
                // already streamed every slot's history; a late materialization
                // must pull it explicitly so switching in shows the full thread.
                if (lateMaterialize) {
                    S.ws?.send(JSON.stringify({ type: 'touch_slot', slot: serverSlot.id, wantHistory: true }));
                }
            } else {
                local.locallyCreated = false; // the server knows it now
                local.sessionId = serverSlot.sessionId || local.sessionId;
                local.isGenerating = serverSlot.isGenerating;
                // The server now reflects this slot's real state, so the
                // optimistic in-flight guard has done its job — retiring it here
                // keeps a stale pendingSend from outliving the turn.
                if (serverSlot.isGenerating) local.pendingSend = false;
                local.totalCost = serverSlot.totalCost || local.totalCost;
                if (_connectCount <= 1 && serverSlot.label) local.label = serverSlot.label;
                // Config (model/cwd): the ACTIVE slot only syncs on the first
                // connection — mid-edit, a broadcast racing a local set_model
                // must not revert the user's pick (model_changed reconciles it).
                // BACKGROUND slots always take the server value: this client
                // isn't editing them, and the tab switcher shows their model +
                // workspace, which another device may have just changed.
                if (_connectCount <= 1 || serverSlot.id !== activeSlotId) {
                    if (serverSlot.model) local.config.model = serverSlot.model;
                    if (serverSlot.cwd) local.config.cwd = serverSlot.cwd;
                }
            }
            if (serverSlot.id >= nextSlotId) nextSlotId = serverSlot.id + 1;
        }

        // Reflect the server's persisted tab ORDER (drag-reorder, SHE-75) — but
        // never yank the strip out from under an in-progress local drag.
        if (_tabDragId === null) applyServerSlotOrder(msg.slots);

        // The bootstrap slot 0 (created at page load so there's a tab to type in
        // before the socket opens) is a placeholder, not a real conversation. If
        // the server's first snapshot has no slot 0 — because the user closed it —
        // drop the pristine local one instead of leaving it as a ghost tab that
        // "keeps reappearing" on every reload (SHE-50). Only when it's untouched
        // (no session, no queued output, no draft) and other tabs exist.
        if (firstSnapshot && !msg.slots.some(s => s.id === 0)) {
            const i = sessionSlots.findIndex(s => s.id === 0);
            const s0 = sessionSlots[i];
            // `draft` is only synced into the slot on a tab switch; text typed
            // into the bootstrap tab before the first snapshot lives only in the
            // live input, so check that too or we'd silently discard it.
            const typing = activeSlotId === 0 && E.input && E.input.value.trim();
            const pristine = s0 && !s0.sessionId && !s0.pendingMessages.length
                && !s0.domSnapshot && !s0.draft && !s0.isGenerating && !typing;
            if (pristine && sessionSlots.length > 1) {
                const wasActive = activeSlotId === 0;
                sessionSlots.splice(i, 1);
                if (wasActive) { activeSlotId = -1; switchSessionTab(sessionSlots[0].id); }
            }
        }

        // Server-authoritative existence (SHE-78): the first snapshot after a
        // (re)connect states which tabs exist. A local tab missing from it was
        // closed from another device while this client was offline — drop it
        // instead of ghosting it (the conversation itself is safe server-side;
        // Resume can recover it). The exceptions carry un-synced user intent —
        // a tab created here the server never acked, a saved draft, or live
        // typing — and are re-created explicitly (fresh) so no input is lost.
        // (Slot 0 is the bootstrap tab, handled above.)
        if (firstSnapshot) {
            const serverIds = new Set(msg.slots.map(s => s.id));
            for (const local of [...sessionSlots]) {
                if (serverIds.has(local.id) || local.id === 0) continue;
                const typing = local.id === activeSlotId && E.input && E.input.value.trim();
                if (local.locallyCreated || local.draft || typing) {
                    // Recover the DRAFT, not the closed slot's identity: no id
                    // hint, so the server allocates a brand-new slot and the
                    // nonce'd ack renames this local tab to it. Reintroducing
                    // the old id would resurrect a closed conversation slot.
                    S.ws.send(JSON.stringify({ type: 'create_tab', fresh: true, nonce: newCreateNonce(local.id), ...local.config }));
                    continue;
                }
                sessionSlots.splice(sessionSlots.indexOf(local), 1);
                if (local.id === activeSlotId) { activeSlotId = -1; switchSessionTab(msg.slots[0].id); }
            }
        }

        _slotsSyncedThisConnection = true;
        if (_connectCount <= 1) {
            const savedActive = parseInt(localStorage.getItem('activeSlotId') || '0');
            if (savedActive !== activeSlotId && sessionSlots.some(s => s.id === savedActive)) {
                activeSlotId = -1;
                switchSessionTab(savedActive);
            }
        }
        const activeSlot = sessionSlots.find(s => s.id === activeSlotId);
        // Source of truth for the active session: the synced active slot, not the
        // legacy slot-0 top-level field. Keeps Compact/Rewind working when the
        // active tab isn't slot 0 (and across reconnects, which re-send status).
        if (activeSlot) {
            S.sessionId = activeSlot.sessionId || null;
            updateSlotSessionId(activeSlotId, S.sessionId);
        }
        if (activeSlot?.config.model) {
            S.currentModel = activeSlot.config.model;
            setModelDisplay(S.currentModel);
        }
        if (activeSlot?.config.cwd) {
            setWorkspaceDisplay(activeSlot.config.cwd);
        }
        renderSessionTabs();
    } else if (msg.model) {
        S.currentModel = msg.model;
        setModelDisplay(msg.model);
    }

    if (msg.pendingOAuth) restoreOAuthState(msg.pendingOAuth);
    else if (msg.pendingCodexAuth) restoreCodexAuthState(msg.pendingCodexAuth);
    else if (msg.pendingAntigravityAuth) restoreAntigravityAuthState(msg.pendingAntigravityAuth);
    else updateAuthUI();

    // Derive generating state from active slot. pendingSend covers the window
    // between "user sent" and the agent's first event, where the server flag is
    // still false — without it a racing status snapshot tears down the live Stop
    // button mid-request (SHE-90/88).
    const activeSlotData = sessionSlots.find(s => s.id === activeSlotId);
    if (activeSlotData?.isGenerating || activeSlotData?.pendingSend) {
        setGenerating(true);
    } else {
        setGenerating(false);
        setStatus('idle', 'Idle');
    }
}

// --- Background slot message accumulation ---

const MAX_PENDING_MESSAGES = 2000;

function accumulateForSlot(slotId, msg) {
    const slot = sessionSlots.find(s => s.id === slotId);
    if (!slot) return;

    if (slot.pendingMessages.length >= MAX_PENDING_MESSAGES) {
        // Drop streaming deltas first, then trim from front
        slot.pendingMessages = slot.pendingMessages.filter(m => m.type !== 'text_delta');
        if (slot.pendingMessages.length >= MAX_PENDING_MESSAGES) {
            slot.pendingMessages = slot.pendingMessages.slice(-Math.floor(MAX_PENDING_MESSAGES / 2));
        }
    }
    slot.pendingMessages.push(msg);

    // Track generating state for tab indicator
    if (msg.type === 'turn_done') {
        slot.isGenerating = false;
        slot.pendingSend = false;
        renderSessionTabs();
    } else if (msg.type === 'text_delta' || msg.type === 'init') {
        if (!slot.isGenerating || slot.pendingSend) {
            slot.isGenerating = true;
            slot.pendingSend = false;
            renderSessionTabs();
        }
    }

    // Track cost
    if (msg.type === 'turn_done' && msg.cost !== undefined) {
        slot.totalCost = msg.cost;
    }

    // Track session ID
    if (msg.type === 'init' && msg.sessionId) {
        slot.sessionId = msg.sessionId;
    }
    if (msg.type === 'session_event' && msg.sessionId) {
        slot.sessionId = msg.sessionId;
    }

    // Auto-label from history
    if (msg.type === 'history' && msg.messages && !isCompactedHistory(msg.messages)) {
        const firstUser = msg.messages.find(m => m.type === 'user_message');
        if (firstUser) updateSlotLabel(slotId, firstUser.content);
    }
}

/** Replay accumulated messages when switching to a background slot. */
function replayPendingMessages(messages) {
    for (const msg of messages) {
        // Skip streaming deltas — superseded by text_done
        if (msg.type === 'text_delta') continue;
        if (msg.type === 'streaming_catchup') continue;

        if (msg.type === 'history') {
            Chat.replayHistory(msg.messages || []);
            continue;
        }

        if (msg.type === 'init') {
            S.apiKeySource = msg.apiKeySource || S.apiKeySource;
            if (msg.sessionId) {
                S.sessionId = msg.sessionId;
                updateSlotSessionId(activeSlotId, msg.sessionId);
            }
            updateAuthUI();
            continue;
        }

        // All other protocol messages → Chat.handle()
        Chat.handle(msg);
    }
}

// --- Input ---

function handleStop() {
    if (S.isGenerating) {
        S.ws?.send(JSON.stringify({ type: 'interrupt', slot: activeSlotId }));
    }
}

function handleSend() {
    let text = E.input.value.trim();
    const hasFiles = S.pendingFiles.some(f => f.path);
    const hasQuotes = window.QuoteReview?.hasContent();
    if (!text && S.pendingImages.length === 0 && !hasFiles && !hasQuotes) return;
    if (S.pendingFiles.some(f => f.uploading)) {
        showError('Files still uploading...');
        return;
    }

    // Prepend any quote+comment pairs, in the owner's "> quote / --> comment"
    // convention, ahead of whatever was typed in the composer.
    if (hasQuotes) {
        const quoteBlock = window.QuoteReview.assemble();
        text = text ? `${quoteBlock}\n\n${text}` : quoteBlock;
    }

    const uploadedFiles = S.pendingFiles.filter(f => f.path);
    if (uploadedFiles.length > 0) {
        const refs = uploadedFiles.map(f => `[Attached file: ${f.path}]`).join('\n');
        text = text ? `${text}\n\n${refs}` : refs;
    }

    // Audio replies are two halves. This is the half only the agent can do:
    // writing for the ear. The other half — stripping the markdown an agent
    // emits anyway — is mechanical and happens server-side in speakable.mjs,
    // which is why the header can promise that paths and links are free to stay.
    const speakThisTurn = S.audioReply && S.ttsAvailable !== false;
    // The bubble and the tab label show what the user actually typed; only the
    // wire carries the header (Chat.addUserMessage strips it back out, which
    // also cleans up replayed history).
    const displayText = text;
    if (speakThisTurn) {
        text = text ? `${text}\n\n${Chat.AUDIO_REPLY_HEADER}` : Chat.AUDIO_REPLY_HEADER;
    }
    Chat.speakNextReply = speakThisTurn;
    Chat.speakSlotId = activeSlotId;

    let content;
    const imageUrls = S.pendingImages.map(i => i.dataUrl);
    if (S.pendingImages.length > 0) {
        content = [];
        for (const img of S.pendingImages) {
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
            });
        }
        if (text) content.push({ type: 'text', text });
    } else {
        content = text;
    }

    Chat.addUserMessage(displayText, imageUrls);
    updateSlotLabel(activeSlotId, displayText);
    if (!S.isGenerating) setGenerating(true);
    // Mark the slot in-flight until the agent's first event lands. Guards the
    // Stop button + running dot against a status snapshot racing this send
    // (SHE-90/88/89); cleared on the first event or turn_done for this slot.
    const activeSlot = sessionSlots.find(s => s.id === activeSlotId);
    if (activeSlot) { activeSlot.pendingSend = true; renderSessionTabs(); }
    // Use "send" type (new protocol) instead of "user"
    S.ws?.send(JSON.stringify({ type: 'send', content, slot: activeSlotId }));

    S.pendingImages = [];
    S.pendingFiles = [];
    updateAttachmentPreviews();
    window.QuoteReview?.clear();
    E.input.value = '';
    E.input.style.height = 'auto';
    E.input.focus();
    const sentSlot = sessionSlots.find(s => s.id === activeSlotId);
    if (sentSlot) { sentSlot.draft = ''; sentSlot.quotes = []; }
}

/** Reset the active slot's session state. */
function resetActiveSlotSession() {
    clearContextMeter(activeSlotId);
    Chat.resetChatState();
    window.QuoteReview?.clear();
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    if (slot) {
        slot.sessionId = null;
        slot.isGenerating = false;
        slot.pendingSend = false;
        slot.domSnapshot = null;
        slot.pendingMessages = [];
        slot.totalCost = 0;
        slot.quotes = [];
    }
    renderSessionTabs();
    return slot;
}

function changeModel(model) {
    const activeSlot = sessionSlots.find(s => s.id === activeSlotId);
    const prevModel = activeSlot?.config.model || S.currentModel;
    // Crossing agent families with a live conversation triggers a portable
    // handoff — the server translates the session into the target CLI's native
    // format. Confirm first so the switch is never a surprise. (Family rules
    // mirror the server registry via agentIdForModel.)
    if (activeSlot?.sessionId && agentIdForModel(prevModel) !== agentIdForModel(model)) {
        const FAMILY_LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' };
        const to = FAMILY_LABEL[agentIdForModel(model)] || model;
        const ok = confirm(`Continue this conversation with ${to}? ShellTeam translates it into ${to}'s native session format so ${to} picks up with full context.`);
        if (!ok) {
            setModelDisplay(prevModel);
            return;
        }
    }
    S.currentModel = model;
    setModelDisplay(model);
    S.ws?.send(JSON.stringify({ type: 'set_model', model, slot: activeSlotId }));
    // No local reset here — the server's model_changed broadcast carries a
    // `reset` flag, and only cross-family switches reset the conversation.
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    if (slot) slot.config.model = model;
    updateAuthBadge();
    if (!hasAuthForModel(model)) {
        showSetup();
        switchSetupTab(setupTabForModel(model));
    } else {
        showChat();
    }
}

function changeWorkspace(cwd) {
    // Optimistically record the new cwd on the active slot so every surface —
    // the header combo, the AI menu's Workspace row, the Info panel — reads one
    // value immediately (cwd_changed confirms it). Without this the AI menu kept
    // showing the old cwd while the combo showed the new one (SHE-54).
    const slot = sessionSlots.find(s => s.id === activeSlotId);
    if (slot) slot.config.cwd = cwd;
    S.ws?.send(JSON.stringify({ type: 'set_cwd', cwd, slot: activeSlotId }));
    resetActiveSlotSession();
    renderAIMenuValues();
}

// --- Workspaces ---
let _workspaces = [];

function populateWorkspaces(workspaces) {
    _workspaces = workspaces;
    // The workspace picker requests a refresh when it opens — repaint its list
    // (not the header, so the input keeps focus).
    if (document.getElementById('workspacePicker')?.classList.contains('visible')) {
        renderWorkspacePickerList();
    }
}

function workspacePickerVisible() {
    return !!document.getElementById('workspacePicker')?.classList.contains('visible');
}

function shortPath(p) {
    if (!p) return '~';
    if (p === BOX.home) return '~';
    if (p.startsWith(BOX.home + '/')) return '~/' + p.slice(BOX.home.length + 1);
    return p;
}

function expandPath(p) {
    if (!p || p === '~') return BOX.home;
    if (p.startsWith('~/')) return BOX.home + '/' + p.slice(2);
    return p;
}

// The header workspace element is a display + a button into the one true
// picker (openWorkspacePicker) — the old free-text combo kept its own
// dropdown/blur/expansion machinery that could disagree with the modal
// (SHE-100/SHE-54). _displayedCwd (declared with the slot state above) feeds
// defaultSlotConfig before the first slot has a cwd of its own.
function setWorkspaceDisplay(path) {
    _displayedCwd = path || null;
    const el = document.getElementById('workspaceSelect');
    if (el) {
        el.textContent = shortPath(path);
        el.title = 'Workspace: ' + shortPath(path) + ' — click to change';
    }
}

// Tool-call blocks expand/collapse on header click. Delegated on the stable
// #messages element (not per-block) so the handler survives the innerHTML
// snapshot restore that switchSessionTab does — a per-element .onclick is lost
// when the saved markup is re-parsed, which left restored tabs' tool calls dead.
E.messages?.addEventListener('click', (e) => {
    const header = e.target.closest('.tool-header');
    if (header && E.messages.contains(header)) header.parentElement.classList.toggle('open');
});

// Copy button on fenced code blocks (SHE-108). Delegated on #messages, like the
// tool headers, so it survives a tab's DOM being restored via innerHTML.
E.messages?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn || !E.messages.contains(btn)) return;
    const pre = btn.parentElement.querySelector('pre');
    const ok = await copyToClipboard((pre?.textContent || '').replace(/\n$/, ''));
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    btn.classList.toggle('copied', ok);
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
});

async function copyToClipboard(text) {
    // navigator.clipboard only exists in a secure context; a box reached over
    // plain http (LAN / Tailscale IP) falls back to the selection command.
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('[copy] clipboard API refused, falling back:', err.message);
        }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) console.error('[copy] execCommand copy failed');
    return ok;
}

// Report links open in the right-side panel, delegated on the stable #messages
// container so they keep working after switchSessionTab restores a tab's DOM via
// innerHTML (which drops per-element listeners). Keyed on isBoxReport, so any box
// report link opens in the panel whether or not scanMessage has marked it yet —
// the "sometimes it opens in another window" case was a restored, unbound link
// falling through to its default target="_blank" (SHE-53).
E.messages?.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && E.messages.contains(a) && ReportPanel.isBoxReport(a.href)) {
        e.preventDefault();
        ReportPanel.show(a.href);
    }
});

// --- Session actions ---

function newSession() {
    S.ws?.send(JSON.stringify({ type: 'new_session', slot: activeSlotId }));
    const slot = resetActiveSlotSession();
    if (slot) slot.label = '';
    localStorage.removeItem('pendingOAuthUrl');
    ActionsMenu.hide();
}

function compactSession() {
    if (!S.sessionId) { showError('No active session to compact'); return; }
    Chat.handleCompactStarted();
    S.ws?.send(JSON.stringify({ type: 'compact', slot: activeSlotId }));
    ActionsMenu.hide();
}

function rewindSession() {
    if (!S.sessionId) { showError('No active session to rewind'); return; }
    if (S.isGenerating) { showError('Cannot rewind while generating'); return; }
    ActionsMenu.hide();

    const userEls = E.messages.querySelectorAll('.msg-user');
    if (userEls.length === 0) { showError('Nothing to rewind'); return; }

    const turns = [...userEls].map(el => {
        const bubble = el.querySelector('.bubble span');
        return bubble ? bubble.textContent : el.textContent;
    });

    const picker = document.getElementById('rewindPicker');
    const backdrop = document.getElementById('rewindBackdrop');
    let html = '<div class="session-picker-header">Rewind to before...</div>';
    for (let i = turns.length - 1; i >= 0; i--) {
        const count = turns.length - i;
        const preview = turns[i].length > 100 ? turns[i].slice(0, 100) + '...' : turns[i];
        html += `<div class="session-item" onclick="executeRewind(${count})">
            <div class="session-time">Turn ${i + 1}</div>
            <div class="session-preview">${escHtml(preview)}</div>
        </div>`;
    }
    picker.innerHTML = html;
    picker.classList.add('visible');
    backdrop.classList.add('visible');
}

function hideRewindPicker() {
    document.getElementById('rewindPicker').classList.remove('visible');
    document.getElementById('rewindBackdrop').classList.remove('visible');
}

function executeRewind(count) {
    hideRewindPicker();
    S.ws?.send(JSON.stringify({ type: 'rewind', count, slot: activeSlotId }));
}

// --- File/image handling ---
const API_IMAGE_LIMIT = 4.5 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function addFile(file) {
    if (SUPPORTED_IMAGE_TYPES.includes(file.type) && file.size <= API_IMAGE_LIMIT) {
        if (S.pendingImages.length >= App.MAX_IMAGES) { showError(`Max ${App.MAX_IMAGES} images`); return; }
        const reader = new FileReader();
        reader.onload = () => {
            S.pendingImages.push({
                data: reader.result.split(',')[1],
                mediaType: file.type,
                dataUrl: reader.result,
            });
            updateAttachmentPreviews();
        };
        reader.readAsDataURL(file);
    } else {
        if (file.size > App.MAX_FILE_SIZE) { showError('File too large (max 200MB)'); return; }
        if (S.pendingFiles.length >= App.MAX_FILES) { showError(`Max ${App.MAX_FILES} files`); return; }
        const entry = { name: file.name, path: null, uploading: true };
        S.pendingFiles.push(entry);
        updateAttachmentPreviews();
        fetch('/upload', {
            method: 'POST',
            headers: { 'X-File-Name': file.name },
            body: file,
        }).then(r => r.json()).then(data => {
            if (data.ok) {
                entry.path = data.path;
                entry.uploading = false;
            } else {
                showError(`Upload failed: ${data.error}`);
                S.pendingFiles = S.pendingFiles.filter(f => f !== entry);
            }
            updateAttachmentPreviews();
        }).catch(() => {
            showError('Upload failed');
            S.pendingFiles = S.pendingFiles.filter(f => f !== entry);
            updateAttachmentPreviews();
        });
    }
}

function updateAttachmentPreviews() {
    const container = document.getElementById('imagePreviews');
    if (S.pendingImages.length === 0 && S.pendingFiles.length === 0) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    container.innerHTML = '';
    S.pendingImages.forEach((img, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'image-thumb';
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        const btn = document.createElement('button');
        btn.className = 'image-remove';
        btn.textContent = '\u00d7';
        btn.onclick = () => { S.pendingImages.splice(i, 1); updateAttachmentPreviews(); };
        thumb.appendChild(imgEl);
        thumb.appendChild(btn);
        container.appendChild(thumb);
    });
    S.pendingFiles.forEach((f, i) => {
        const chip = document.createElement('div');
        chip.className = 'file-thumb' + (f.uploading ? ' uploading' : '');
        const span = document.createElement('span');
        span.textContent = f.uploading ? `${f.name}...` : f.name;
        const btn = document.createElement('button');
        btn.className = 'image-remove';
        btn.textContent = '\u00d7';
        btn.onclick = () => { S.pendingFiles.splice(i, 1); updateAttachmentPreviews(); };
        chip.appendChild(span);
        chip.appendChild(btn);
        container.appendChild(chip);
    });
}

document.getElementById('imageInput').addEventListener('change', (e) => {
    for (const file of e.target.files) addFile(file);
    e.target.value = '';
});

E.input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.kind === 'file') {
            e.preventDefault();
            addFile(item.getAsFile());
        }
    }
});

// --- Folder attachments (SHE-99) ---
// A dropped folder is zipped in the browser and attached as one file: the
// chat upload endpoint is deliberately flat (single files, no paths), and one
// archive beats attaching dozens of loose files. DEFLATE comes from the
// native CompressionStream; where unsupported, entries are stored raw.
const ZIP_CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function zipCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function zipDosDateTime(ms) {
    const d = new Date(ms);
    if (d.getFullYear() < 1980) return { date: 0x21, time: 0 };  // ZIP epoch floor
    return {
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    };
}

async function zipDeflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildZip(items) {  // items: [{ rel, file }] → Blob
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { rel, file } of items) {
        const data = new Uint8Array(await file.arrayBuffer());
        const crc = zipCrc32(data);
        const deflated = await zipDeflate(data);
        const method = deflated && deflated.length < data.length ? 8 : 0;
        const payload = method === 8 ? deflated : data;
        const name = encoder.encode(rel);
        const { date, time } = zipDosDateTime(file.lastModified);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);       // version needed to extract
        local.setUint16(6, 0x0800, true);   // names are UTF-8
        local.setUint16(8, method, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, payload.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        chunks.push(local, name, payload);
        central.push({ name, method, time, date, crc, csize: payload.length, usize: data.length, offset });
        offset += 30 + name.length + payload.length;
    }
    let cdSize = 0;
    for (const e of central) {
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, 20, true);          // version made by
        cd.setUint16(6, 20, true);          // version needed to extract
        cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, e.method, true);
        cd.setUint16(12, e.time, true);
        cd.setUint16(14, e.date, true);
        cd.setUint32(16, e.crc, true);
        cd.setUint32(20, e.csize, true);
        cd.setUint32(24, e.usize, true);
        cd.setUint16(28, e.name.length, true);
        cd.setUint32(42, e.offset, true);
        chunks.push(cd, e.name);
        cdSize += 46 + e.name.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, central.length, true);
    end.setUint16(10, central.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    chunks.push(end);
    return new Blob(chunks, { type: 'application/zip' });
}

function entryAsFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectEntry(entry, prefix, out) {
    if (entry.isFile) {
        out.push({ rel: prefix + entry.name, file: await entryAsFile(entry) });
        return;
    }
    const reader = entry.createReader();
    let batch;
    do {  // readEntries returns successive batches until an empty one
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await collectEntry(child, prefix + entry.name + '/', out);
    } while (batch.length);
}

async function attachFolderAsZip(dirEntry) {
    const pending = { name: `${dirEntry.name}.zip`, path: null, uploading: true };
    S.pendingFiles.push(pending);
    updateAttachmentPreviews();
    let zip = null;
    try {
        const items = [];
        await collectEntry(dirEntry, dirEntry.name + '/', items);
        if (!items.length) { showError(`Folder "${dirEntry.name}" is empty`); return; }
        const total = items.reduce((sum, it) => sum + it.file.size, 0);
        if (total > App.MAX_FILE_SIZE) { showError(`Folder "${dirEntry.name}" is over the 200MB attachment limit`); return; }
        zip = new File([await buildZip(items)], `${dirEntry.name}.zip`, { type: 'application/zip' });
    } catch (err) {
        showError(`Could not zip "${dirEntry.name}": ${err.message}`);
    } finally {
        S.pendingFiles = S.pendingFiles.filter(f => f !== pending);
        updateAttachmentPreviews();
    }
    if (zip) addFile(zip);
}

// Drag and drop
let dragCounter = 0;
const dropOverlay = document.getElementById('dropOverlay');
document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (++dragCounter === 1) dropOverlay.classList.add('visible');
});
document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragCounter === 0) dropOverlay.classList.remove('visible');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    // Entries must be read synchronously — DataTransferItems die after the
    // handler yields. Folders become zips; loose files attach as before.
    const entries = [...(e.dataTransfer.items || [])].map(it => it.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.some(en => en.isDirectory)) {
        for (const en of entries) {
            if (en.isDirectory) attachFolderAsZip(en);
            else entryAsFile(en).then(addFile);
        }
        return;
    }
    for (const file of e.dataTransfer.files) addFile(file);
});

// --- Voice recording ---
let mediaRecorder = null;
let audioChunks = [];
const btnMic = document.getElementById('btnMic');

function updateMicAvailability() {
    // Only an explicit server verdict changes anything: sttAvailable === false
    // hides the mic (no ElevenLabs key on the box); true restores it; an older
    // server that never sends the field keeps today's always-visible behavior.
    if (!btnMic || S.sttAvailable === null) return;
    btnMic.classList.toggle('hidden', S.sttAvailable === false);
    btnMic.title = S.sttAvailable === false
        ? 'Voice input needs an ElevenLabs key — add it in Settings'
        : 'Voice message';
}

// --- Spoken replies ---
const btnAudioReply = document.getElementById('btnAudioReply');

function updateAudioReplyAvailability() {
    // Hidden until the server explicitly says the box can synthesise speech:
    // an unusable button that fails on click is worse than no button. Turning
    // the capability off also turns the mode off, so a key removed in Settings
    // can't leave every message carrying an audio header nothing will honour.
    if (!btnAudioReply) return;
    btnAudioReply.classList.toggle('hidden', S.ttsAvailable !== true);
    if (S.ttsAvailable === false && S.audioReply) setAudioReply(false);
    renderAudioReplyButton();
}

function renderAudioReplyButton() {
    if (!btnAudioReply) return;
    btnAudioReply.classList.toggle('active', S.audioReply);
    btnAudioReply.setAttribute('aria-pressed', String(S.audioReply));
    btnAudioReply.title = S.audioReply
        ? 'Replies are spoken out loud (Alt+A to stop)'
        : 'Have replies read out loud (Alt+A)';
}

function setAudioReply(on) {
    S.audioReply = on;
    localStorage.setItem('audioReply', on ? '1' : '0');
    renderAudioReplyButton();
}

function toggleAudioReply() {
    setAudioReply(!S.audioReply);
    if (!S.audioReply) Chat.stopSpeaking();
}

function loadAudioReplyPreference() {
    S.audioReply = localStorage.getItem('audioReply') === '1';
    renderAudioReplyButton();
}
loadAudioReplyPreference();

function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        audioChunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            btnMic.classList.remove('recording');
            if (audioChunks.length === 0) return;
            const blob = new Blob(audioChunks, { type: mimeType });
            audioChunks = [];
            await transcribeAndFill(blob);
        };
        mediaRecorder.start();
        btnMic.classList.add('recording');
    }).catch(() => showError('Microphone access denied'));
}

async function transcribeAndFill(blob) {
    const prevPlaceholder = E.input.placeholder;
    E.input.placeholder = 'Transcribing...';
    E.input.disabled = true;
    try {
        const form = new FormData();
        form.append('file', blob, 'voice.webm');
        const resp = await fetch('/transcribe', { method: 'POST', body: form });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `Transcription failed (${resp.status})`);
        }
        const data = await resp.json();
        const text = (data.text || '').trim();
        if (text) {
            E.input.value = text;
            E.input.dispatchEvent(new Event('input'));
            E.input.focus();
        } else {
            showError('No speech detected');
        }
    } catch (err) {
        showError(err.message || 'Transcription failed');
    } finally {
        E.input.disabled = false;
        E.input.placeholder = prevPlaceholder;
    }
}

// --- Session Browser ---
const sessionPicker = document.getElementById('sessionPicker');
const sessionBackdrop = document.getElementById('sessionBackdrop');
let _allSessions = [];
let _sessionFilter = 'all';
let _sessionSearch = '';
// Server-side content/path search (SHE-82): the browser only holds the newest
// 50 sessions, so a term in an older conversation is only findable server-side.
let _sessionSearchResults = null; // { query, sessions } for the current query, or null
let _sessionSearchPending = false;
let _sessionSearchTimer = null;

function showSessionPicker() {
    S.ws?.send(JSON.stringify({ type: 'list_sessions' }));
    sessionPicker.innerHTML = '<div class="session-empty">Loading...</div>';
    sessionPicker.classList.add('visible');
    sessionBackdrop.classList.add('visible');
    ActionsMenu.hide();
}

function hideSessionPicker() {
    sessionPicker.classList.remove('visible');
    sessionBackdrop.classList.remove('visible');
    _sessionFilter = 'all';
    _sessionSearch = '';
    _sessionSearchResults = null;
    _sessionSearchPending = false;
    clearTimeout(_sessionSearchTimer);
}

function renderSessionPicker(sessions) {
    _allSessions = sessions;
    _sessionFilter = 'all';
    _sessionSearch = '';
    _sessionSearchResults = null;
    _sessionSearchPending = false;
    clearTimeout(_sessionSearchTimer);
    // The header (with the search input) is built ONCE per open. Only the
    // results below it re-render on filter/search — rebuilding the input on
    // every keystroke destroyed focus + caret mid-typing (SHE-71).
    sessionPicker.innerHTML = `<div class="session-picker-header">
        <div class="session-picker-title">Sessions</div>
        <input type="search" class="session-search" placeholder="Search all sessions…"
               oninput="onSessionSearchInput(this.value)">
    </div>
    <div class="session-results"></div>`;
    renderSessionBrowser();
}

function onSessionSearchInput(value) {
    _sessionSearch = value;
    const q = value.trim();
    clearTimeout(_sessionSearchTimer);
    if (q.length < 2) {
        // Too short to justify scanning every transcript — just filter the
        // loaded set; drop any stale server result so the counts stay honest.
        _sessionSearchResults = null;
        _sessionSearchPending = false;
        renderSessionBrowser();
        return;
    }
    // Instant local preview over the loaded 50 while the full-corpus search runs.
    _sessionSearchPending = !(_sessionSearchResults && _sessionSearchResults.query === q);
    renderSessionBrowser();
    _sessionSearchTimer = setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN) {
            S.ws.send(JSON.stringify({ type: 'search_sessions', query: q }));
        }
    }, 250);
}

function handleSessionSearchResult(query, sessions) {
    // Ignore a response for a keystroke the user has already moved past.
    if (query !== _sessionSearch.trim()) return;
    _sessionSearchResults = { query, sessions };
    _sessionSearchPending = false;
    renderSessionBrowser();
}

function localSessionMatch(s, q) {
    return (s.firstMessage || '').toLowerCase().includes(q)
        || (s.project || '').toLowerCase().includes(q)
        || (s.cwd || '').toLowerCase().includes(q)
        || (s.model || '').toLowerCase().includes(q);
}

function renderSessionBrowser() {
    const resultsEl = sessionPicker.querySelector('.session-results');
    if (!resultsEl) return;

    if (_allSessions.length === 0) {
        resultsEl.innerHTML = '<div class="session-empty">No previous sessions found</div>';
        return;
    }

    const query = _sessionSearch.trim();
    // With a query, the authoritative result is the server's full-corpus search
    // (content + folder, across ALL sessions on disk — not just the loaded 50,
    // so an old ~/avsv conversation is still findable). Until it arrives,
    // preview by filtering the loaded set locally.
    let base = _allSessions;
    let serverAnswered = false;
    if (query) {
        if (_sessionSearchResults && _sessionSearchResults.query === query) {
            base = _sessionSearchResults.sessions;
            serverAnswered = true;
        } else {
            const q = query.toLowerCase();
            base = _allSessions.filter(s => localSessionMatch(s, q));
        }
    }

    const projects = [...new Set(base.map(s => s.project || '~'))].sort();

    let filtered = base;
    if (_sessionFilter !== 'all') {
        filtered = filtered.filter(s => (s.project || '~') === _sessionFilter);
    }

    let html = '';

    if (projects.length > 1) {
        html += '<div class="session-filters">';
        html += `<button class="session-filter${_sessionFilter === 'all' ? ' active' : ''}"
                  onclick="_sessionFilter='all'; renderSessionBrowser()">All (${base.length})</button>`;
        for (const p of projects) {
            const count = base.filter(s => (s.project || '~') === p).length;
            const label = p.startsWith('~/') ? p.slice(2) : p;
            html += `<button class="session-filter${_sessionFilter === p ? ' active' : ''}"
                      onclick="_sessionFilter='${jsArg(p)}'; renderSessionBrowser()">${escHtml(label)} (${count})</button>`;
        }
        html += '</div>';
    }

    html += '<div class="session-list">';
    if (filtered.length === 0) {
        const searching = query && _sessionSearchPending && !serverAnswered;
        html += `<div class="session-empty">${searching ? 'Searching all sessions…' : 'No matching sessions'}</div>`;
    }
    for (const s of filtered) {
        const isActive = s.sessionId === S.sessionId;
        const ago = timeAgo(s.mtime);
        const projectLabel = s.project ? (s.project.startsWith('~/') ? s.project.slice(2) : s.project) : '';
        const modelLabel = shortModel(s.model);
        const turnsLabel = s.turnCount != null ? `${s.turnCount} turn${s.turnCount !== 1 ? 's' : ''}` : '';

        html += `<div class="session-item${isActive ? ' active' : ''}" onclick="resumeSession('${jsArg(s.sessionId)}')">
            <div class="session-meta">
                ${projectLabel ? `<span class="session-badge project">${escHtml(projectLabel)}</span>` : ''}
                ${modelLabel ? `<span class="session-badge model">${escHtml(modelLabel)}</span>` : ''}
                ${turnsLabel ? `<span class="session-badge turns">${escHtml(turnsLabel)}</span>` : ''}
                <span class="session-time">${ago}</span>
            </div>
            <div class="session-preview">${escHtml(s.firstMessage)}</div>
        </div>`;
    }
    html += '</div>';

    resultsEl.innerHTML = html;
}

function shortModel(model) {
    if (!model) return '';
    return model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/^openai\//, '');
}

function resumeSession(sid) {
    hideSessionPicker();
    Chat.resetChatState();
    S.ws?.send(JSON.stringify({ type: 'resume_session', sessionId: sid, slot: activeSlotId }));
}

function timeAgo(mtime) {
    const diff = Date.now() - mtime;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    return Math.floor(days / 30) + 'mo ago';
}

// --- Session Tabs ---

// Display name for a slot: its captured title, else "Chat <position>" —
// numbered by where the tab sits, not by the ever-growing internal id (SHE-43).
function slotDisplayLabel(slot) {
    if (slot.label) return slot.label;
    const idx = sessionSlots.indexOf(slot);
    return `Chat ${(idx === -1 ? 0 : idx) + 1}`;
}

// Set while a tab title is being edited in place, so a status broadcast's
// renderSessionTabs() doesn't blow away the live contenteditable field.
let _renamingSlotId = null;

function renderSessionTabs() {
    if (_renamingSlotId !== null) return;
    const container = document.getElementById('sessionTabList');
    const showClose = sessionSlots.length > 1;
    let html = '';
    for (const slot of sessionSlots) {
        const active = slot.id === activeSlotId ? ' active' : '';
        // Show the running dot on EVERY generating tab, including the one you're
        // viewing — otherwise the active tab gives no clue its agent is still
        // working, so you can't tell which of two tabs is live (SHE-81). Include
        // pendingSend so the tab you just sent to lights up immediately, not only
        // once its first token lands (SHE-89).
        const generating = (slot.isGenerating || slot.pendingSend) ? ' generating' : '';
        const label = escHtml(slotDisplayLabel(slot));
        const close = showClose
            ? `<button class="session-tab-close" type="button" tabindex="-1" aria-hidden="true" onclick="closeSessionTab(${slot.id})" title="Close ${label}">&times;</button>`
            : '';
        const tip = escHtml(slotMetaSummary(slot)) + ' — double-click to rename';
        const selected = slot.id === activeSlotId;
        const tabLabel = `${label}${showClose ? ', press Delete to close' : ''}`;
        html += `<div class="session-tab${active}${generating}" data-slot="${slot.id}" draggable="true" title="${tip}" role="presentation">
            <button class="session-tab-open" type="button" role="tab" aria-selected="${selected}" aria-controls="messages" aria-label="${tabLabel}" tabindex="${selected ? 0 : -1}" onclick="switchSessionTab(${slot.id})" onkeydown="handleSessionTabKey(event, ${slot.id})"><span class="session-tab-label" ondblclick="event.stopPropagation(); beginRenameTab(${slot.id})">${label}</span></button>${close}
        </div>`;
    }
    container.innerHTML = html;
    setupTabDragReorder();
    renderSessionDrawer();
}

function focusSessionTab(slotId) {
    requestAnimationFrame(() => document.querySelector(
        `.session-tab[data-slot="${slotId}"] .session-tab-open`,
    )?.focus());
}

function handleSessionTabKey(event, slotId) {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        switchSessionTab(slotId);
        return;
    }
    if (event.key === 'Delete' && sessionSlots.length > 1) {
        event.preventDefault();
        closeSessionTab(slotId);
        focusSessionTab(activeSlotId);
        return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = sessionSlots.findIndex(slot => slot.id === slotId);
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sessionSlots.length - 1;
    else next = (current + (event.key === 'ArrowRight' ? 1 : -1) + sessionSlots.length) % sessionSlots.length;
    const nextId = sessionSlots[next].id;
    switchSessionTab(nextId);
    focusSessionTab(nextId);
}

// --- Drag-and-drop tab reorder (SHE-75) ------------------------------------------
// Delegated on #sessionTabs, attached once. Reordering is applied on DROP (never
// mid-drag — re-rendering the strip would abort the native drag). The new order is
// pushed to the server (reorder_tabs), which persists it (survives reload/restart)
// and broadcasts so other devices re-lay their strip to match.
let _tabDragId = null;
let _tabDragWired = false;
function setupTabDragReorder() {
    const container = document.getElementById('sessionTabs');
    if (!container || _tabDragWired) return;
    _tabDragWired = true;

    container.addEventListener('dragstart', (e) => {
        const tab = e.target.closest('.session-tab');
        if (!tab) return;
        _tabDragId = parseInt(tab.dataset.slot);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox requires data to be set for a drag to start.
        try { e.dataTransfer.setData('text/plain', String(_tabDragId)); } catch (_) {}
        tab.classList.add('dragging');
    });
    container.addEventListener('dragend', () => {
        _tabDragId = null;
        container.querySelectorAll('.session-tab').forEach(t => t.classList.remove('dragging', 'drag-over'));
    });
    container.addEventListener('dragover', (e) => {
        if (_tabDragId === null) return;
        e.preventDefault();           // allow drop
        e.dataTransfer.dropEffect = 'move';
        const over = e.target.closest('.session-tab');
        container.querySelectorAll('.session-tab').forEach(t => t.classList.toggle('drag-over', t === over && parseInt(t.dataset.slot) !== _tabDragId));
    });
    container.addEventListener('drop', (e) => {
        if (_tabDragId === null) return;
        e.preventDefault();
        const over = e.target.closest('.session-tab');
        const dragId = _tabDragId;
        // Dropped on empty strip space / the + button → move to the end.
        let targetId = over ? parseInt(over.dataset.slot) : null;
        let before = true;
        if (over && targetId !== dragId) {
            const r = over.getBoundingClientRect();
            before = e.clientX < r.left + r.width / 2;   // left half → insert before
        }
        commitTabReorder(dragId, targetId, before);
    });
}

function commitTabReorder(dragId, targetId, before) {
    const from = sessionSlots.findIndex(s => s.id === dragId);
    if (from === -1) return;
    const [moved] = sessionSlots.splice(from, 1);
    let insertAt;
    if (targetId === null || targetId === dragId) {
        insertAt = sessionSlots.length;                  // to the end
    } else {
        const ti = sessionSlots.findIndex(s => s.id === targetId);
        insertAt = before ? ti : ti + 1;
        if (insertAt < 0) insertAt = 0;
    }
    sessionSlots.splice(insertAt, 0, moved);
    const order = sessionSlots.map(s => s.id);
    S.ws?.send(JSON.stringify({ type: 'reorder_tabs', order }));
    renderSessionTabs();
}

// Re-lay the local tab strip to match a server snapshot's slot ORDER, so a reorder
// on another device (or a reload) is reflected here. Slots the server doesn't know
// about yet (freshly created locally, not acked) keep their relative order at the end.
function applyServerSlotOrder(serverSlots) {
    const rank = new Map(serverSlots.map((s, i) => [s.id, i]));
    sessionSlots.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
}

// "model · workspace" one-liner for a slot (tab tooltips, meta rows).
function slotMetaSummary(slot) {
    const model = modelDisplayName(slot.config?.model || '');
    const cwd = shortPath(slot.config?.cwd || '') || '~';
    return `${model} · ${cwd}`;
}

// Mobile conversation drawer (bottom sheet) — same data as the desktop tab
// strip, but each item carries the resume-picker's meta badges (model +
// workspace) so picking a tab shows what it runs, not just its title.
function renderSessionDrawer() {
    const active = sessionSlots.find(s => s.id === activeSlotId);
    const sw = document.getElementById('convSwitcherLabel');
    if (sw) sw.textContent = active ? slotDisplayLabel(active) : 'Chat';
    const cwdEl = document.getElementById('sessionDrawerCwd');
    if (cwdEl) cwdEl.textContent = (active && active.config && active.config.cwd) || currentCwd();

    const list = document.getElementById('sessionDrawerList');
    if (!list) return;
    const showClose = sessionSlots.length > 1;
    list.innerHTML = sessionSlots.map(slot => {
        const isActive = slot.id === activeSlotId;
        const gen = (slot.isGenerating || slot.pendingSend) ? ' generating' : '';
        const label = escHtml(slotDisplayLabel(slot));
        const model = shortModel(slot.config?.model || '');
        const proj = shortPath(slot.config?.cwd || '');
        const close = showClose
            ? `<button class="drawer-item-close" type="button" onclick="closeSessionTab(${slot.id}); renderSessionDrawer();" aria-label="Close ${label}">&times;</button>`
            : '';
        return `<div class="drawer-item${isActive ? ' active' : ''}" data-slot="${slot.id}" role="listitem">
            <button class="drawer-item-open" type="button" onclick="switchSessionTab(${slot.id}); closeSessionDrawer();"${isActive ? ' aria-current="true"' : ''} aria-label="Open ${label}">
                <span class="drawer-item-dot${gen}" aria-hidden="true"></span>
                <span class="drawer-item-main">
                    <span class="drawer-item-label">${label}</span>
                    <span class="drawer-item-meta">
                        ${model ? `<span class="session-badge model">${escHtml(model)}</span>` : ''}
                        ${proj ? `<span class="session-badge project">${escHtml(proj)}</span>` : ''}
                    </span>
                </span>
            </button>
            <button class="drawer-item-rename" type="button" onclick="beginRenameDrawer(${slot.id})" aria-label="Rename ${label}" title="Rename">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            </button>
            ${close}
        </div>`;
    }).join('');
}

const sessionDrawerBackgroundState = new Map();

function sessionDrawerFocusable() {
    const drawer = document.getElementById('sessionDrawer');
    return [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.hidden && el.getClientRects().length > 0);
}

function openSessionDrawer() {
    renderSessionDrawer();
    const bd = document.getElementById('sessionDrawerBackdrop');
    const dr = document.getElementById('sessionDrawer');
    for (const child of document.body.children) {
        if (child === dr || child === bd || child.tagName === 'SCRIPT') continue;
        sessionDrawerBackgroundState.set(child, child.inert);
        child.inert = true;
    }
    if (bd) bd.classList.add('visible');
    if (dr) {
        dr.inert = false;
        dr.setAttribute('aria-hidden', 'false');
        dr.classList.add('visible');
    }
    document.getElementById('convSwitcher')?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
        const target = dr?.querySelector('.drawer-item-open[aria-current="true"]')
            || dr?.querySelector('.session-drawer-close');
        target?.focus();
    });
}

function closeSessionDrawer() {
    const bd = document.getElementById('sessionDrawerBackdrop');
    const dr = document.getElementById('sessionDrawer');
    if (bd) bd.classList.remove('visible');
    if (dr) {
        dr.classList.remove('visible');
        dr.setAttribute('aria-hidden', 'true');
        dr.inert = true;
    }
    for (const [child, wasInert] of sessionDrawerBackgroundState) child.inert = wasInert;
    sessionDrawerBackgroundState.clear();
    const switcher = document.getElementById('convSwitcher');
    switcher?.setAttribute('aria-expanded', 'false');
    switcher?.focus();
}

document.getElementById('sessionDrawer')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeSessionDrawer();
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = sessionDrawerFocusable();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

function addSessionTab() {
    if (sessionSlots.length >= MAX_SESSION_TABS) {
        showError(`Max ${MAX_SESSION_TABS} sessions`);
        return;
    }
    const id = nextSlotId++;
    const newSlot = makeSlot(id);
    // Un-acked until a server snapshot includes it — the reconnect reconcile
    // re-creates (never drops) such tabs. `fresh` marks a genuinely new tab;
    // the server refuses non-fresh creates of unknown ids (SHE-78). The id is
    // only a HINT — the server allocates the canonical id and the nonce'd ack
    // renames this tab if another device raced the same id (SHE-52).
    newSlot.locallyCreated = true;
    sessionSlots.push(newSlot);
    S.ws?.send(JSON.stringify({ type: 'create_tab', slot: id, fresh: true, nonce: newCreateNonce(id), ...newSlot.config }));
    switchSessionTab(id);
}

// Action-bar entry point: fork the active conversation (mirrors compactSession /
// rewindSession — operates on whichever tab is current).
function forkSession() {
    forkTab(activeSlotId);
}

// Branch a conversation into a new tab. The fork carries the full history over
// natively (portable-sessions engine); the source tab is left untouched.
function forkTab(sourceId) {
    const src = sessionSlots.find(s => s.id === sourceId);
    if (!src || !src.sessionId) {
        showError('Nothing to fork yet — start the conversation first.');
        return;
    }
    if (sessionSlots.length >= MAX_SESSION_TABS) {
        showError(`Max ${MAX_SESSION_TABS} sessions`);
        return;
    }
    const id = nextSlotId++;
    const baseLabel = src.label ? src.label.replace(/ ↳.*$/, '') : 'Chat';
    const newSlot = makeSlot(id, `${baseLabel} ↳`);
    newSlot.config = { ...src.config };
    newSlot.locallyCreated = true; // un-acked until a snapshot includes it
    sessionSlots.push(newSlot);
    // Server allocates the fork's canonical slot id (ours is a hint) and its
    // native session, copies history, and replies slot_forked + history.
    S.ws?.send(JSON.stringify({ type: 'fork_slot', slot: src.id, newSlot: id, nonce: newCreateNonce(id), model: src.config.model }));
    switchSessionTab(id);
    renderSessionTabs();
}

function switchSessionTab(id) {
    if (id === activeSlotId) return;

    fileCache = null;

    const current = sessionSlots.find(s => s.id === activeSlotId);
    if (current) {
        current.domSnapshot = E.messages.innerHTML;
        current.sessionId = S.sessionId;
        current.isGenerating = S.isGenerating;
        current.totalCost = S.totalCost;
        current.config.model = S.currentModel;
        current.draft = E.input.value;
        current.quotes = window.QuoteReview?.getQuotes() || [];
    }

    activeSlotId = id;
    localStorage.setItem('activeSlotId', String(id));
    S.ws?.send(JSON.stringify({ type: 'touch_slot', slot: id }));
    const target = sessionSlots.find(s => s.id === id);

    Chat.clearMessages();

    S.sessionId = target.sessionId;
    S.totalCost = target.totalCost || 0;
    // The composer is shared DOM — swap in this tab's own draft (SHE-38),
    // sized so the draft is visible without focusing (SHE-63).
    E.input.value = target.draft || '';
    autosizeComposer();
    S.currentModel = target.config.model || S.currentModel;
    setModelDisplay(S.currentModel);
    updateAuthBadge();
    if (target.config.cwd) setWorkspaceDisplay(target.config.cwd);

    if (target.domSnapshot !== null) {
        E.messages.innerHTML = target.domSnapshot;
        target.domSnapshot = null;
    }
    // Restore this tab's pending quote+comment pairs (highlights are re-linked to
    // the just-restored markup by data-qid). Must follow the innerHTML restore.
    window.QuoteReview?.setQuotes(target.quotes || []);

    if (target.pendingMessages.length > 0) {
        replayPendingMessages(target.pendingMessages);
        target.pendingMessages = [];
    }

    updateEmptyState();

    if (target.isGenerating || target.pendingSend) {
        setGenerating(true);
    } else {
        setGenerating(false);
        setStatus('idle', 'Idle');
    }

    scrollToBottom(true);
    renderSessionTabs();
    renderContextMeter();
}

function closeSessionTab(id) {
    if (sessionSlots.length <= 1) return;
    const idx = sessionSlots.findIndex(s => s.id === id);
    if (idx < 0) return;

    // Closing a tab never deletes its conversation — point at the recovery
    // path so a mis-click isn't experienced as data loss (SHE-73).
    const closed = sessionSlots[idx];
    const hadConversation = closed.sessionId ||
        (closed.id === activeSlotId && S.sessionId);
    if (hadConversation) showInfoToast('Tab closed — reopen it anytime from Resume (R)');

    S.ws?.send(JSON.stringify({ type: 'close_tab', slot: id }));
    sessionSlots.splice(idx, 1);

    if (id === activeSlotId) {
        const newIdx = Math.min(idx, sessionSlots.length - 1);
        activeSlotId = -1;
        switchSessionTab(sessionSlots[newIdx].id);
    } else {
        renderSessionTabs();
    }
}

function updateSlotSessionId(slotId, sid) {
    const slot = sessionSlots.find(s => s.id === slotId);
    if (slot && sid) slot.sessionId = sid;
}

// Post-compaction history starts with a compacted marker; its first
// user_message is compaction-turn text, not a usable title (SHE-43).
function isCompactedHistory(messages) {
    return messages[0]?.type === 'session_event' && messages[0]?.event === 'compacted';
}

function updateSlotLabel(slotId, rawText) {
    // Covers the two history paths as well as a live send: no tab is ever
    // titled after the audio-reply boilerplate.
    const text = Chat.withoutAudioReplyHeader(rawText);
    const slot = sessionSlots.find(s => s.id === slotId);
    // Only fill in a title when the slot is still untitled — titles are
    // captured once and never re-derived (mirrors the server; SHE-43). A custom
    // name (set via rename) is a truthy label, so it's never overwritten here.
    if (!slot || slot.label) return;
    if (!text) return;
    slot.label = text.length > 30 ? text.slice(0, 30) + '...' : text;
    renderSessionTabs();
}

// --- Rename a tab in place ---
// Double-click a desktop tab (or the drawer label / pencil on mobile) to edit
// its title inline. Enter/blur commits, Escape cancels. The custom name is
// persisted server-side (rename_slot) so it survives reload and is broadcast to
// other devices. An empty name reverts the tab to its auto-derived label.
function beginRenameTab(slotId) {
    const span = document.querySelector(`.session-tab[data-slot="${slotId}"] .session-tab-label`);
    if (span) beginRenameOn(span, slotId);
}

function beginRenameDrawer(slotId) {
    const slot = sessionSlots.find(s => s.id === slotId);
    const item = document.querySelector(`.drawer-item[data-slot="${slotId}"]`);
    const openButton = item?.querySelector('.drawer-item-open');
    if (!slot || !item || !openButton) return;
    const input = document.createElement('input');
    input.className = 'drawer-rename-input';
    input.value = slot.label || slotDisplayLabel(slot);
    input.setAttribute('aria-label', 'Conversation name');
    openButton.hidden = true;
    item.insertBefore(input, item.querySelector('.drawer-item-rename'));
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit) commitRenameTab(slotId, input.value);
        else renderSessionDrawer();
    };
    input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
}

function beginRenameOn(span, slotId) {
    const slot = sessionSlots.find(s => s.id === slotId);
    if (!slot) return;
    _renamingSlotId = slotId;
    span.contentEditable = 'true';
    span.classList.add('renaming');
    span.textContent = slot.label || slotDisplayLabel(slot);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    span.focus();

    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        const value = span.textContent;
        span.contentEditable = 'false';
        span.classList.remove('renaming');
        span.removeEventListener('keydown', onKey);
        span.removeEventListener('blur', onBlur);
        _renamingSlotId = null;
        if (commit) commitRenameTab(slotId, value);
        else renderSessionTabs();
    };
    const onKey = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    span.addEventListener('keydown', onKey);
    span.addEventListener('blur', onBlur);
}

function commitRenameTab(slotId, value) {
    const slot = sessionSlots.find(s => s.id === slotId);
    if (!slot) return;
    const title = (value || '').trim().slice(0, 40);
    slot.label = title;   // '' → falls back to the auto-derived display label
    S.ws?.send(JSON.stringify({ type: 'rename_slot', slot: slotId, title: title || null }));
    renderSessionTabs();
}

// --- @File Autocomplete ---
let fileCache = null;
let fileCacheTime = 0;
const FILE_CACHE_TTL = 30000;
let acSelectedIndex = -1;
let acVisible = false;
let acFiltered = [];
const fileAutocomplete = document.getElementById('fileAutocomplete');

function getAtQuery() {
    const val = E.input.value;
    const cursor = E.input.selectionStart;
    let i = cursor - 1;
    while (i >= 0 && val[i] !== ' ' && val[i] !== '\n' && val[i] !== '@') i--;
    if (i < 0 || val[i] !== '@') return null;
    if (i > 0 && val[i - 1] !== ' ' && val[i - 1] !== '\n') return null;
    const query = val.slice(i + 1, cursor);
    if (query.includes(' ')) return null;
    return { query, start: i, end: cursor };
}

function fetchFiles() {
    if (fileCache && Date.now() - fileCacheTime < FILE_CACHE_TTL) return;
    S.ws?.send(JSON.stringify({ type: 'list_files', slot: activeSlotId }));
}

function handleFilesReceived(files) {
    fileCache = files;
    fileCacheTime = Date.now();
    updateFileAutocomplete();
}

function updateFileAutocomplete() {
    const at = getAtQuery();
    if (!at || !fileCache) {
        hideFileAutocomplete();
        return;
    }
    const q = at.query.toLowerCase();
    acFiltered = fileCache.filter(f => f.toLowerCase().includes(q)).slice(0, 8);
    if (acFiltered.length === 0) {
        fileAutocomplete.innerHTML = '<div class="file-empty">No matching files</div>';
        fileAutocomplete.classList.add('visible');
        acVisible = true;
        acSelectedIndex = -1;
        return;
    }
    let html = '';
    acFiltered.forEach((f, i) => {
        const highlighted = highlightMatch(f, q);
        html += `<div class="file-item${i === acSelectedIndex ? ' selected' : ''}" data-index="${i}" onmousedown="selectFileItem(${i})">${highlighted}</div>`;
    });
    fileAutocomplete.innerHTML = html;
    fileAutocomplete.classList.add('visible');
    acVisible = true;
}

function highlightMatch(text, query) {
    if (!query) return escHtml(text);
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return escHtml(text);
    return escHtml(text.slice(0, idx)) + '<span class="match">' + escHtml(text.slice(idx, idx + query.length)) + '</span>' + escHtml(text.slice(idx + query.length));
}

function selectFileItem(index) {
    const at = getAtQuery();
    if (!at || !acFiltered[index]) return;
    const file = acFiltered[index];
    const val = E.input.value;
    E.input.value = val.slice(0, at.start) + '@' + file + ' ' + val.slice(at.end);
    E.input.selectionStart = E.input.selectionEnd = at.start + 1 + file.length + 1;
    hideFileAutocomplete();
    E.input.focus();
}

function hideFileAutocomplete() {
    fileAutocomplete.classList.remove('visible');
    acVisible = false;
    acSelectedIndex = -1;
}

// Grow the composer to fit its content, capped by focus state: a focused
// composer gets the full editing height; an unfocused one still shows the
// draft up to ~4 lines rather than collapsing to a single clipped line
// (SHE-63) — only drafts longer than that need a click to reveal the rest.
const COMPOSER_MAX_FOCUSED = 200;
const COMPOSER_MAX_BLURRED = 110;
function autosizeComposer() {
    const cap = document.activeElement === E.input ? COMPOSER_MAX_FOCUSED : COMPOSER_MAX_BLURRED;
    E.input.style.height = 'auto';
    E.input.style.height = Math.min(E.input.scrollHeight, cap) + 'px';
    // Piggyback on the existing choke point: every path that changes the
    // draft (typing, tab-switch, send-clear, suggestion fill via focus)
    // already ends up here, so the collapse can never go stale.
    updateComposerCollapse();
}
E.input.addEventListener('focus', autosizeComposer);
E.input.addEventListener('blur', autosizeComposer);

// --- Phone composer collapse ---
// Four 44px controls next to a text field don't fit a phone. While the user is
// typing, the attach/mic/audio trio folds into one chevron and the field takes
// the width back; the chevron (or clearing the field) brings them back. Idle
// state is untouched, so discoverability doesn't pay for the space.
const composerPhoneQuery = window.matchMedia('(max-width: 480px)');
let composerManuallyExpanded = false;

function updateComposerCollapse() {
    const composer = document.getElementById('composer');
    const expand = document.getElementById('btnComposerExpand');
    if (!composer || !expand) return;
    // Never collapse mid-recording: hiding the pulsing mic would leave the
    // user with a live microphone and no way to see or stop it.
    const recording = btnMic?.classList.contains('recording');
    // An emptied field (sent, cleared, tab-switched to a blank draft) also
    // resets the manual override, so the next draft starts collapsed again.
    if (E.input.value.length === 0) composerManuallyExpanded = false;
    const collapsed = composerPhoneQuery.matches
        && E.input.value.length > 0
        && !composerManuallyExpanded
        && !recording;
    composer.classList.toggle('collapsed', collapsed);
    expand.classList.toggle('hidden', !collapsed);
}

function expandComposer() {
    // Sticky until the draft is sent or cleared — re-collapsing on the very
    // next keystroke would make the buttons unusable while composing.
    composerManuallyExpanded = true;
    updateComposerCollapse();
    E.input.focus();
}

composerPhoneQuery.addEventListener?.('change', updateComposerCollapse);

E.input.addEventListener('input', () => {
    autosizeComposer();
    const at = getAtQuery();
    if (at) {
        fetchFiles();
        updateFileAutocomplete();
    } else {
        hideFileAutocomplete();
    }
});

// On a touch device with no mouse (phone/tablet) the Enter key is the only way
// to type a newline, so it must insert one — sending is the Send button's job,
// like WhatsApp. On desktop, Enter sends and Shift+Enter is the newline.
// `(pointer: coarse) and (hover: none)` is true for soft-keyboard devices and
// false for a touchscreen laptop that still has a real mouse + physical keys.
const softKeyboardQuery = window.matchMedia('(pointer: coarse) and (hover: none)');
function enterSendsMessage(e) {
    return e.key === 'Enter' && !e.shiftKey && !e.isComposing && !softKeyboardQuery.matches;
}

E.input.addEventListener('keydown', (e) => {
    if (acVisible && acFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            acSelectedIndex = Math.min(acSelectedIndex + 1, acFiltered.length - 1);
            updateFileAutocomplete();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            acSelectedIndex = Math.max(acSelectedIndex - 1, 0);
            updateFileAutocomplete();
            return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && acSelectedIndex >= 0) {
            e.preventDefault();
            selectFileItem(acSelectedIndex);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            hideFileAutocomplete();
            return;
        }
    }
    if (e.key === 'Escape' && S.isGenerating) {
        e.preventDefault();
        handleStop();
        return;
    }
    if (enterSendsMessage(e)) {
        e.preventDefault();
        handleSend();
    }
});

// "/" opens the AI controls menu — same as clicking the ✦ engine button — so
// switching model/workspace is one keystroke away. Fires only when it wouldn't
// eat a typed slash: either focus is outside any text field, or it's in the
// (empty) composer. A composer with text, or any other input/textarea (e.g. a
// quote comment, the terminal), types "/" normally.
document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const composerEmpty = el === E.input && E.input.value === '';
    if (!editable || composerEmpty) {
        e.preventDefault();
        window.Menus?.toggle('aiMenu');
    }
});

// --- Keyboard shortcuts cheat sheet ---
// Single source of truth for every cockpit shortcut. The "?" overlay and the
// System menu → Keyboard Shortcuts row both render from this table — add new
// shortcuts here so the help stays honest.
const SHORTCUTS = [
    { group: 'AI menu', rows: [
        ['/', 'Open the AI menu (model, workspace, session actions)'],
        ['↑ ↓ then Enter', 'Navigate the open menu and run the highlighted item'],
        ['M W N S F R C', 'Jump straight to Model · Workspace · New chat · Resume session · Fork · Rewind · Compact'],
        ['Esc', 'Close the menu'],
      ] },
    { group: 'Conversations', rows: [
        ['Alt+1 … Alt+9', 'Jump to that conversation tab'],
        ['Alt+↑ / Alt+↓', 'Previous / next tab'],
        ['Double-click', 'On a tab: rename it (Enter saves, Esc cancels)'],
      ] },
    { group: 'Composing', rows: [
        ['Enter / Shift+Enter', 'Send / insert a newline'],
        ['@', 'Autocomplete a file path into the message'],
        ['Alt+A', 'Have replies read out loud (needs an ElevenLabs key)'],
        ['Esc', 'Stop the agent while it is generating'],
      ] },
    { group: 'Replying to the agent', rows: [
        ['C', 'With reply text selected: comment on that exact quote (stack as many as you want)'],
        ['Cmd/Ctrl+Enter', 'In a quote comment: send all quotes + comments'],
      ] },
    { group: 'Help', rows: [
        ['?', 'This cheat sheet'],
      ] },
];

function showShortcutsHelp() {
    const panel = document.getElementById('shortcutsHelp');
    panel.innerHTML = '<div class="shortcuts-title">Keyboard shortcuts</div>' +
        SHORTCUTS.map(g => `
            <div class="shortcuts-group">
                <div class="shortcuts-group-name">${escHtml(g.group)}</div>
                ${g.rows.map(([keys, desc]) => `
                    <div class="shortcuts-row">
                        <span class="shortcuts-keys">${keys.split(' ').map(tok =>
                            (tok === 'then' || tok === '…' || tok === '/') && keys !== '/'
                                ? `<span class="shortcuts-sep">${tok}</span>`
                                : `<kbd>${escHtml(tok)}</kbd>`
                        ).join(' ')}</span>
                        <span class="shortcuts-desc">${escHtml(desc)}</span>
                    </div>`).join('')}
            </div>`).join('');
    panel.classList.add('visible');
    document.getElementById('shortcutsBackdrop').classList.add('visible');
}

function hideShortcutsHelp() {
    document.getElementById('shortcutsHelp').classList.remove('visible');
    document.getElementById('shortcutsBackdrop').classList.remove('visible');
}

// "?" opens the cheat sheet — same guard as "/": never steals a typed "?".
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideShortcutsHelp(); return; }
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const composerEmpty = el === E.input && E.input.value === '';
    if (!editable || composerEmpty) {
        e.preventDefault();
        showShortcutsHelp();
    }
});

// Keyboard tab switching: Alt+1…9 jumps to that tab, Alt+↑/↓ cycles. Alt is
// the deliberate choice — Ctrl/Cmd+digit and Ctrl+Tab are browser-reserved
// (they switch *browser* tabs and pages can't reliably intercept them), and
// Alt+←/→ is history back/forward. e.code keeps digits layout-independent
// (Alt+digit types special characters on some layouts). Works even while
// typing: Alt combos never insert text, so there's nothing to hijack.
document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
        const slot = sessionSlots[Number(digit[1]) - 1];
        if (slot) { e.preventDefault(); switchSessionTab(slot.id); }
        return;
    }
    if (e.code === 'KeyA' && S.ttsAvailable === true) {
        e.preventDefault();
        toggleAudioReply();
        return;
    }
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        const idx = sessionSlots.findIndex(s => s.id === activeSlotId);
        if (idx < 0 || sessionSlots.length < 2) return;
        e.preventDefault();
        const delta = e.code === 'ArrowDown' ? 1 : -1;
        const next = sessionSlots[(idx + delta + sessionSlots.length) % sessionSlots.length];
        switchSessionTab(next.id);
    }
});

// --- Boot ---
window.QuoteReview?.init();
initUseCaseSuggestions();
// Load the model catalog (populates the dropdown + enables routing) and the box
// identity (real $HOME + file-URL origin, used by path linkification) before
// opening the socket, so both exist before any history renders. On failure we
// still connect — but loudly, since an empty dropdown is very visible.
Promise.allSettled([
    loadModelCatalog()
        .catch(err => { console.error('[models] failed to load /api/models — model dropdown will be empty:', err); throw err; }),
    loadBoxInfo()
        .catch(err => { console.error('[box] failed to load /api/box — file links may use the wrong home/origin:', err); throw err; }),
]).then(() => {
    initUseCaseSuggestions(); // re-render: BOX.modules is known now
    connect();
});
