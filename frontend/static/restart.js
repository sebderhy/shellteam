// "Restart ShellTeam" (SHE-156): one implementation for every page that
// offers it (Settings, the header chip, the feature-key and Composio hints).
// Any button with class .restart-btn restarts the cockpit and the control
// plane; a .restart-status inside it or beside it shows progress. The API restarts itself,
// so: wait until /health stops answering, then until it and the cockpit are
// back, then reload this page.
(function () {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const healthy = () => fetch('/health', { cache: 'no-store' }).then((r) => r.ok, () => false);
    const cockpitUp = () => fetch('/api/computers/status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}), () => ({}))
        .then((s) => s.status === 'running');

    async function restartShellTeam(btn) {
        const status = btn.querySelector('.restart-status') || btn.parentNode.querySelector('.restart-status');
        const say = (m) => { if (status) status.textContent = m; };
        if (!confirm('Restart ShellTeam? Agents in the middle of a reply will stop.')) return;
        btn.disabled = true;
        say('Restarting…');
        const r = await fetch('/api/computers/restart', { method: 'POST' }).catch(() => null);
        if (!r || r.status !== 202) {
            btn.disabled = false;
            say('Could not restart' + (r ? ' (HTTP ' + r.status + ')' : '') + '. Try again.');
            return;
        }
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && await healthy()) await sleep(500);
        while (Date.now() - t0 < 120000) {
            if (await healthy() && await cockpitUp()) {
                say('Back. Reloading…');
                location.reload();
                return;
            }
            await sleep(1000);
        }
        btn.disabled = false;
        say('ShellTeam did not come back within 2 minutes. Check: journalctl --user -u shellteam-api -u shellteam-ai-chat');
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.restart-btn');
        if (btn) restartShellTeam(btn);
    });
})();
