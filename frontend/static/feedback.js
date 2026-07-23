/* Shared feedback widget — used by BOTH the owner dashboard and the guest
 * (employee) shell. Self-contained and theme-portable: it injects its own CSS
 * (design tokens with fallbacks, so it looks right whether or not the host page
 * defines them), the modal markup, and the behaviour (text + voice + screenshots
 * → POST /api/feedback). Any element with id="feedback-open" or a
 * [data-feedback-open] attribute opens it.
 *
 * Single source of truth: edit the widget here, both shells pick it up. */
(function () {
  if (window.__shellteamFeedback) return;
  window.__shellteamFeedback = true;

  const CSS = `
    .fb-trigger {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 11px; border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 8px);
      background: var(--surface-2, #1f1f1f); color: var(--text-secondary, #b5b5b5);
      font-size: var(--text-xs, .72rem); font-weight: var(--weight-medium, 500); font-family: inherit;
      cursor: pointer; transition: color .15s ease, border-color .15s ease;
    }
    .fb-trigger:hover { color: var(--text-primary, #e5e5e5); border-color: var(--border-hover, #3a3a3a); }
    .fb-trigger svg { width: 14px; height: 14px; }
    .fb-overlay {
      position: fixed; inset: 0; z-index: 9000; display: none;
      align-items: center; justify-content: center; padding: 16px;
      background: rgba(0,0,0,.5); backdrop-filter: blur(3px);
    }
    .fb-overlay.show { display: flex; }
    .fb-modal {
      width: 100%; max-width: 520px; max-height: 88vh; overflow-y: auto;
      background: var(--surface-1, #141414); border: 1px solid var(--border, #262626);
      border-radius: var(--radius-lg, 12px); box-shadow: 0 16px 48px rgba(0,0,0,.4);
      color: var(--text-primary, #e5e5e5); font-family: system-ui, -apple-system, sans-serif;
    }
    .fb-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid var(--border, #262626);
    }
    .fb-head h2 { margin: 0; font-size: var(--text-base, .95rem); font-weight: var(--weight-semibold, 600); }
    .fb-close { border: 0; background: transparent; color: var(--text-tertiary, #888); cursor: pointer; padding: 4px; border-radius: var(--radius-sm, 6px); }
    .fb-close:hover { color: var(--text-primary, #e5e5e5); background: var(--surface-2, #1f1f1f); }
    .fb-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
    .fb-label { display: block; font-size: var(--text-xs, .72rem); font-weight: var(--weight-semibold, 600); color: var(--text-secondary, #b5b5b5); margin-bottom: 6px; }
    .fb-seg { display: flex; gap: 3px; border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 8px); padding: 3px; }
    .fb-seg button {
      flex: 1; padding: 7px; border: 0; background: transparent; cursor: pointer; font-family: inherit;
      color: var(--text-tertiary, #888); font-size: var(--text-sm, .82rem); font-weight: var(--weight-medium, 500); border-radius: var(--radius-sm, 6px);
    }
    .fb-seg button.active { background: var(--surface-2, #1f1f1f); color: var(--text-primary, #e5e5e5); }
    .fb-text {
      width: 100%; min-height: 92px; resize: vertical; padding: 10px 12px; box-sizing: border-box;
      border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 8px);
      background: var(--surface-0, #0a0a0a); color: var(--text-primary, #e5e5e5); font-family: inherit; font-size: var(--text-sm, .82rem);
    }
    .fb-text:focus { outline: none; border-color: var(--brand, #f59e0b); }
    .fb-rec { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border, #262626); border-radius: var(--radius-md, 8px); background: var(--surface-0, #0a0a0a); }
    .fb-rec-btn {
      width: 34px; height: 34px; border-radius: 50%; border: 0; flex-shrink: 0; cursor: pointer;
      display: flex; align-items: center; justify-content: center; background: var(--surface-2, #1f1f1f); color: var(--text-secondary, #b5b5b5);
    }
    .fb-rec-btn.rec { background: var(--negative, #ef4444); color: #fff; animation: fb-pulse 1.4s ease-in-out infinite; }
    @keyframes fb-pulse { 50% { opacity: .55; } }
    .fb-rec-btn svg { width: 15px; height: 15px; }
    .fb-rec-label { flex: 1; font-size: var(--text-xs, .72rem); color: var(--text-tertiary, #888); }
    .fb-rec audio { flex: 1; height: 32px; }
    .fb-drop {
      border: 1.5px dashed var(--border, #262626); border-radius: var(--radius-md, 8px); padding: 16px;
      text-align: center; font-size: var(--text-xs, .72rem); color: var(--text-tertiary, #888); cursor: pointer;
      transition: border-color .15s ease, color .15s ease;
    }
    .fb-drop:hover, .fb-drop.over { border-color: var(--brand, #f59e0b); color: var(--text-secondary, #b5b5b5); }
    .fb-thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .fb-thumb { position: relative; width: 64px; height: 64px; border-radius: var(--radius-sm, 6px); overflow: hidden; border: 1px solid var(--border, #262626); }
    .fb-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .fb-thumb button {
      position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border: 0; border-radius: 50%;
      background: rgba(0,0,0,.65); color: #fff; cursor: pointer; font-size: 12px; line-height: 1; display: flex; align-items: center; justify-content: center;
    }
    .fb-err { font-size: var(--text-xs, .72rem); color: var(--negative, #ef4444); }
    .fb-submit {
      width: 100%; padding: 11px; border: 0; border-radius: var(--radius-md, 8px);
      background: var(--brand, #f59e0b); color: #0a0a0a; font-weight: var(--weight-semibold, 600); font-size: var(--text-sm, .82rem);
      cursor: pointer; font-family: inherit;
    }
    .fb-submit:disabled { opacity: .5; cursor: not-allowed; }
    .fb-done { padding: 36px 18px; text-align: center; }
    .fb-done svg { width: 44px; height: 44px; color: var(--positive, #22c55e); margin-bottom: 10px; }
    .fb-done p { margin: 0; }
    .fb-done .sub { color: var(--text-tertiary, #888); font-size: var(--text-sm, .82rem); margin-top: 4px; }
    .fb-done a { color: var(--brand, #f59e0b); }
  `;

  const MODAL = `
    <div class="fb-overlay" id="fb-overlay">
      <div class="fb-modal" role="dialog" aria-modal="true" aria-label="Send feedback">
        <div class="fb-head">
          <h2>Send feedback</h2>
          <button type="button" class="fb-close" id="fb-close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div id="fb-form" class="fb-body">
          <div>
            <span class="fb-label">Type</span>
            <div class="fb-seg" id="fb-kind">
              <button type="button" data-kind="bug" class="active">🐞 Bug</button>
              <button type="button" data-kind="feature">✨ Feature request</button>
            </div>
          </div>
          <div>
            <label class="fb-label" for="fb-desc">What happened? What would you like?</label>
            <textarea id="fb-desc" class="fb-text" placeholder="Describe it — or record a voice note below…"></textarea>
          </div>
          <div>
            <span class="fb-label">Voice note (optional)</span>
            <div class="fb-rec">
              <button type="button" class="fb-rec-btn" id="fb-rec-btn" title="Record">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>
              </button>
              <span class="fb-rec-label" id="fb-rec-label">Click to record a voice description</span>
              <audio id="fb-audio" controls style="display:none"></audio>
              <button type="button" class="fb-close" id="fb-rec-clear" style="display:none" title="Remove recording">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <div>
            <span class="fb-label">Screenshots (optional)</span>
            <div class="fb-drop" id="fb-drop">Paste (Ctrl+V), drag &amp; drop, or click to upload</div>
            <input type="file" id="fb-file" accept="image/*" multiple hidden>
            <div class="fb-thumbs" id="fb-thumbs"></div>
          </div>
          <div class="fb-err" id="fb-err" style="display:none"></div>
          <button type="button" class="fb-submit" id="fb-submit">Send feedback</button>
        </div>
        <div id="fb-success" class="fb-done" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
          <p>Thanks — your feedback was sent.</p>
          <p class="sub" id="fb-success-link"></p>
        </div>
      </div>
    </div>
  `;

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const host = document.createElement('div');
    host.innerHTML = MODAL;
    document.body.appendChild(host.firstElementChild);

    const MAX_BYTES = 10 * 1024 * 1024, MAX_SHOTS = 5;
    const overlay = document.getElementById('fb-overlay');
    const form = document.getElementById('fb-form');
    const success = document.getElementById('fb-success');
    const desc = document.getElementById('fb-desc');
    const err = document.getElementById('fb-err');
    const drop = document.getElementById('fb-drop');
    const fileInput = document.getElementById('fb-file');
    const thumbs = document.getElementById('fb-thumbs');
    const recBtn = document.getElementById('fb-rec-btn');
    const recLabel = document.getElementById('fb-rec-label');
    const audioEl = document.getElementById('fb-audio');
    const recClear = document.getElementById('fb-rec-clear');
    const submitBtn = document.getElementById('fb-submit');

    let kind = 'bug', shots = [], voiceBlob = null;
    let recorder = null, recTimer = null, recSecs = 0;

    function showErr(m) { err.textContent = m; err.style.display = m ? 'block' : 'none'; }

    function renderThumbs() {
      thumbs.innerHTML = '';
      shots.forEach((f, i) => {
        const d = document.createElement('div');
        d.className = 'fb-thumb';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        const x = document.createElement('button');
        x.type = 'button'; x.textContent = '×';
        x.onclick = () => { shots.splice(i, 1); renderThumbs(); };
        d.append(img, x); thumbs.appendChild(d);
      });
    }
    function addShots(files) {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        if (f.size > MAX_BYTES) { showErr(`${f.name} is over 10 MB.`); continue; }
        if (shots.length >= MAX_SHOTS) { showErr(`At most ${MAX_SHOTS} screenshots.`); break; }
        shots.push(f);
      }
      renderThumbs();
    }

    function reset() {
      kind = 'bug'; shots = []; voiceBlob = null; recSecs = 0;
      desc.value = ''; thumbs.innerHTML = ''; showErr('');
      document.querySelectorAll('#fb-kind button').forEach(b =>
        b.classList.toggle('active', b.dataset.kind === 'bug'));
      audioEl.style.display = 'none'; audioEl.removeAttribute('src');
      recClear.style.display = 'none'; recLabel.style.display = 'block';
      recLabel.textContent = 'Click to record a voice description';
      recBtn.classList.remove('rec');
      if (recorder && recorder.state === 'recording') recorder.stop();
      recorder = null; if (recTimer) clearInterval(recTimer); recTimer = null;
      form.style.display = 'flex'; success.style.display = 'none';
      submitBtn.disabled = false; submitBtn.textContent = 'Send feedback';
    }
    function open() { reset(); overlay.classList.add('show'); desc.focus(); }
    function close() { overlay.classList.remove('show'); reset(); }

    document.querySelectorAll('#feedback-open, [data-feedback-open]')
      .forEach(el => el.addEventListener('click', open));
    document.getElementById('fb-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('show')) close();
    });

    document.getElementById('fb-kind').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      kind = b.dataset.kind;
      document.querySelectorAll('#fb-kind button').forEach(x => x.classList.toggle('active', x === b));
    });

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addShots(fileInput.files); fileInput.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer.files?.length) addShots(e.dataTransfer.files);
    });
    document.addEventListener('paste', e => {
      if (!overlay.classList.contains('show')) return;
      const imgs = [...(e.clipboardData?.items || [])]
        .filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
      if (imgs.length) { addShots(imgs); e.preventDefault(); }
    });

    recBtn.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
      showErr('');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        const chunks = [];
        recorder.addEventListener('dataavailable', ev => { if (ev.data?.size) chunks.push(ev.data); });
        recorder.addEventListener('stop', () => {
          stream.getTracks().forEach(t => t.stop());
          if (recTimer) clearInterval(recTimer); recTimer = null;
          const blob = new Blob(chunks, { type: mime || 'audio/webm' });
          recBtn.classList.remove('rec');
          if (blob.size) {
            voiceBlob = blob;
            audioEl.src = URL.createObjectURL(blob); audioEl.style.display = 'block';
            recClear.style.display = 'block'; recLabel.style.display = 'none';
          }
        });
        recorder.start(); recBtn.classList.add('rec');
        recSecs = 0; recLabel.style.display = 'block'; audioEl.style.display = 'none'; recClear.style.display = 'none';
        recLabel.textContent = 'Recording… 0:00';
        recTimer = setInterval(() => {
          recSecs++;
          recLabel.textContent = `Recording… ${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, '0')}`;
        }, 1000);
      } catch (e) {
        showErr(e?.name === 'NotAllowedError' ? 'Microphone permission denied.' : (e?.message || 'Could not access microphone.'));
      }
    });
    recClear.addEventListener('click', () => {
      voiceBlob = null; audioEl.style.display = 'none'; audioEl.removeAttribute('src');
      recClear.style.display = 'none'; recLabel.style.display = 'block';
      recLabel.textContent = 'Click to record a voice description';
    });

    submitBtn.addEventListener('click', async () => {
      if (!desc.value.trim() && !voiceBlob) { showErr('Add a description or record a voice note.'); return; }
      showErr(''); submitBtn.disabled = true;
      submitBtn.textContent = voiceBlob ? 'Transcribing & sending…' : 'Sending…';
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('description', desc.value.trim());
      fd.append('page_url', window.location.href);
      fd.append('browser_info', JSON.stringify({
        userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}`,
        viewport: `${innerWidth}x${innerHeight}`, dpr: window.devicePixelRatio,
      }));
      for (const f of shots) fd.append('screenshots', f);
      if (voiceBlob) fd.append('voice_recording', voiceBlob, 'voice.webm');
      try {
        const r = await fetch('/api/feedback', { method: 'POST', body: fd });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || ('HTTP ' + r.status));
        form.style.display = 'none'; success.style.display = 'block';
        const link = document.getElementById('fb-success-link');
        link.textContent = data.identifier
          ? `It reached the maintainers — reference ${data.identifier}.`
          : 'It reached the maintainers.';
        setTimeout(close, 3500);
      } catch (e) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send feedback';
        showErr(e.message || 'Failed to send. Try again.');
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
