// --- Plan Mode ---
window.PlanMode = {
    isPlanMode: false,
    bannerEl: null,

    enter() {
        this.isPlanMode = true;
        Chat.ensureAssistantEl();
        this.bannerEl = document.createElement('div');
        this.bannerEl.className = 'plan-banner';
        this.bannerEl.innerHTML = '<span class="tool-spinner"></span> Planning...';
        Chat.currentAssistantEl.appendChild(this.bannerEl);
        scrollToBottom();
    },

    renderCard(assistantEl, toolInput) {
        this.isPlanMode = false;

        if (this.bannerEl) {
            this.bannerEl.remove();
            this.bannerEl = null;
        }

        // Collect plan content from rendered .content elements
        const contentEls = assistantEl ? assistantEl.querySelectorAll('.content') : [];
        let planHtml = '';
        for (const el of contentEls) {
            planHtml += el.innerHTML;
        }

        // Fallback: use plan from ExitPlanMode input
        if (!planHtml && toolInput?.plan) {
            planHtml = marked.parse(toolInput.plan);
        }

        if (!planHtml && typeof toolInput === 'object') {
            for (const [key, val] of Object.entries(toolInput)) {
                if (typeof val === 'string' && val.length > 50) {
                    planHtml = marked.parse(val);
                    break;
                }
            }
        }

        if (!planHtml) {
            planHtml = '<p>Plan submitted for approval.</p>';
        }

        for (const el of contentEls) el.remove();

        const card = document.createElement('div');
        card.className = 'plan-card';
        card.innerHTML = `
            <div class="plan-card-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                </svg>
                Implementation Plan
            </div>
            <div class="plan-card-body">${planHtml}</div>
            <div class="plan-card-actions">
                <button class="plan-approve" onclick="PlanMode.approve(this)">Approve Plan</button>
                <button class="plan-reject" onclick="PlanMode.showReject(this)">Suggest Changes</button>
                <input class="plan-feedback" placeholder="What should change?" onkeydown="if(event.key==='Enter'){PlanMode.submitReject(this);event.preventDefault()}">
            </div>
        `;

        if (assistantEl) {
            assistantEl.appendChild(card);
        } else {
            Chat.ensureAssistantEl();
            Chat.currentAssistantEl.appendChild(card);
        }
        scrollToBottom();
    },

    approve(btn) {
        const actions = btn.closest('.plan-card-actions');
        btn.disabled = true;
        btn.textContent = 'Plan approved';
        const reject = actions.querySelector('.plan-reject');
        const feedback = actions.querySelector('.plan-feedback');
        if (reject) reject.style.display = 'none';
        if (feedback) feedback.style.display = 'none';
        App.el.input.value = 'Looks good, proceed with the implementation.';
        handleSend();
    },

    showReject(btn) {
        const actions = btn.closest('.plan-card-actions');
        btn.style.display = 'none';
        const feedback = actions.querySelector('.plan-feedback');
        feedback.classList.add('visible');
        feedback.focus();
    },

    submitReject(input) {
        const text = input.value.trim();
        if (!text) return;
        const actions = input.closest('.plan-card-actions');
        const approve = actions.querySelector('.plan-approve');
        if (approve) { approve.disabled = true; approve.style.display = 'none'; }
        input.disabled = true;
        App.el.input.value = text;
        handleSend();
    },
};
