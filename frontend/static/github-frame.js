// Mounts the cockpit's GitHub connect card (github.html) into a container.
// One implementation for every shell that frames it (the first-run wizard,
// the Apps tab). Framed SAME-ORIGIN through the control plane
// (/api/computers/cockpit/…) rather than the owner-<port> subdomain, so it
// needs no wildcard DNS/cert/cross-origin cookies (absent on a fresh --domain
// install). The card reports its height so the frame fits it exactly, one
// scroll container (the repo list's own), never a second scrollbar (SHE-101).
// If the cockpit is unreachable the frame shows plain-text guidance instead
// of a grey void.
(function () {
    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'shellteam:github-card-height') return;
        document.querySelectorAll('iframe[data-github-card]').forEach((f) => {
            f.style.height = Math.min(Math.max(e.data.height, 180), 720) + 'px';
        });
    });

    // root: the element holding (or to receive) the iframe. laterHint: where
    // the user can come back to connect ("the Apps tab").
    window.mountGitHubFrame = function (root, assetVersion, laterHint) {
        if (!root || root.dataset.mounted) return;
        root.dataset.mounted = '1';
        let f = root.querySelector('iframe');
        if (!f) {
            f = document.createElement('iframe');
            f.title = 'Connect GitHub';
            f.style.cssText = 'width:100%;height:300px;border:0;border-radius:10px;background:transparent';
            root.appendChild(f);
        }
        f.dataset.githubCard = '1';
        const fallback = () => {
            if (root.dataset.fallback) return;
            root.dataset.fallback = '1';
            root.innerHTML = '<p style="margin:0;padding:14px;border:1px solid var(--border);'
                + 'border-radius:10px;background:var(--surface-2);color:var(--text-secondary);'
                + 'font-size:var(--text-sm);line-height:1.5">GitHub connect isn\'t reachable yet: '
                + 'the Agents service may still be starting. Open the <b>Agents</b> tab once, then reload this page. '
                + 'You can always connect later from ' + laterHint + '.</p>';
        };
        const guard = setTimeout(fallback, 6000);
        f.addEventListener('load', () => {
            clearTimeout(guard);
            // A cockpit-down proxy returns a 503 JSON body that renders as text
            // in the frame; detect the empty/JSON case and swap in guidance.
            try {
                const doc = f.contentDocument;
                if (doc && !doc.querySelector('.card')) fallback();
            } catch (_) { /* cross-origin (shouldn't happen same-origin): leave it */ }
        }, { once: true });
        f.src = '/api/computers/cockpit/github.html?v=' + assetVersion;
    };
})();
