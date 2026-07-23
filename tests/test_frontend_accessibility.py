"""Static accessibility and narrow-layout contracts for the shipping shells.

Browser-level Axe and geometry checks belong in release QA. These inexpensive
tests pin the semantics and CSS hooks that make those checks pass so a later
markup refactor cannot silently reintroduce the audited failures.
"""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = (ROOT / "frontend/dashboard.html").read_text()
BROWSER = (ROOT / "frontend/browser.html").read_text()
KNOWLEDGE = (ROOT / "frontend/knowledge.html").read_text()
EDITOR = (ROOT / "computer/file-editor.html").read_text()
COCKPIT = (ROOT / "computer/ai-chat/public/index.html").read_text()
COCKPIT_JS = (ROOT / "computer/ai-chat/public/app.js").read_text()
COCKPIT_CSS = (ROOT / "computer/ai-chat/public/styles.css").read_text()
TOKENS = (ROOT / "frontend/static/tokens.css").read_text()


def test_dashboard_tabs_use_roving_native_controls() -> None:
    tabs = re.findall(
        r'<button class="tab(?: active)?"[^>]+role="tab"[^>]*>', DASHBOARD
    )
    assert len(tabs) == 6
    assert '<div class="tab ' not in DASHBOARD
    assert all('aria-controls="panel-' in tab for tab in tabs)
    assert all('aria-selected="' in tab and 'tabindex="' in tab for tab in tabs)
    for key in ("ArrowLeft", "ArrowRight", "Home", "End"):
        assert key in DASHBOARD


def test_dashboard_wizard_is_modal_in_behavior_not_only_appearance() -> None:
    assert re.search(
        r'id="wizard"[^>]+aria-modal="true"[^>]+aria-labelledby="wizard-title"'
        r'[^>]+aria-hidden="true"[^>]+inert',
        DASHBOARD,
    )
    assert "child.inert = true" in DASHBOARD
    assert "wizard.inert = true" in DASHBOARD
    assert "event.key !== 'Tab'" in DASHBOARD
    assert "last.focus()" in DASHBOARD and "first.focus()" in DASHBOARD


def test_wizard_opens_at_the_top_with_heading_focus() -> None:
    """Round-6 audit P1-01: autofocusing the accept checkbox scrolled short
    phones past the title and half the risk explanation on open. Each step must
    take focus on its HEADING (tabindex="-1", no scroll) and reset the modal's
    scroll — the behavioral layer lives in scripts/qa/phone-geometry.mjs
    (short-phone viewports); this pins the source so CI catches a revert."""
    for heading in ("wizard-title", "wizard-title-ai", "wizard-title-github"):
        assert re.search(rf'id="{heading}" tabindex="-1"', DASHBOARD)
    assert "focus({ preventScroll: true })" in DASHBOARD
    assert "wizard.scrollTop = 0" in DASHBOARD
    assert "accept.focus()" not in DASHBOARD


def test_wizard_controls_carry_the_44px_phone_tap_bar() -> None:
    """Round-6 audit P2-01: setup-path controls measured 14–37px tall on
    phones. Same coarse-pointer enforcement pattern as base.css / SHE-79."""
    assert re.search(
        r"@media \(pointer: coarse\)[\s\S]*?"
        r"\.ai-tab, \.ai-btn, \.wizard-skip \{ min-height: 44px; \}[\s\S]*?"
        r"\.wizard-accept \{ min-height: 44px;",
        DASHBOARD,
    )


def test_settings_provider_tabs_reflow_at_phone_width() -> None:
    assert "grid-template-columns: repeat(4, minmax(0, 1fr))" in DASHBOARD
    assert re.search(
        r"@media \(max-width: 520px\)[\s\S]*?\.ai-tabs\s*\{"
        r"\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)",
        DASHBOARD,
    )


def test_file_toolbar_keeps_every_action_reachable_on_phones() -> None:
    for label in (
        "Upload files",
        "Download current file",
        "Browse files",
        "New file",
        "New folder",
        "Delete current file",
    ):
        assert f'aria-label="{label}"' in EDITOR
    phone_css = re.search(
        r"@media \(max-width: 480px\) \{([\s\S]*?)\n\s*}\n\s*</style>", EDITOR
    )
    assert phone_css
    assert "flex-wrap: wrap" in phone_css.group(1)
    assert ".toolbar-right { height: 36px; margin-left: 0" in phone_css.group(1)
    assert ".sidebar { top: 88px; }" in phone_css.group(1)
    assert 'id="tree" role="tree" aria-label="Files" tabindex="0"' in EDITOR


def test_file_names_never_enter_markup_or_raw_file_urls() -> None:
    assert "${entry.name}" not in EDITOR
    assert "'<span>' + d.label" not in EDITOR
    assert "labelElement.textContent = label" in EDITOR
    assert "filename.textContent = name" in EDITOR
    assert "media.src = fileUrl(relPath)" in EDITOR
    assert "a.href = fileUrl(currentFile)" in EDITOR


def test_file_dialogs_trap_focus_and_restore_the_invoker() -> None:
    for dialog_id in ("modal-overlay", "move-overlay"):
        assert re.search(rf'id="{dialog_id}"[^>]+aria-hidden="true"[^>]+inert', EDITOR)
    assert "dialogBackgroundState" in EDITOR
    assert "child.inert = true" in EDITOR
    assert "event.key !== 'Tab'" in EDITOR
    assert "dialogRestoreFocus?.isConnected" in EDITOR


def test_browser_toolbar_wraps_and_names_dense_controls() -> None:
    assert "@media(max-width:520px)" in BROWSER
    assert "#browser-toolbar{flex-wrap:wrap" in BROWSER
    assert ".browser-zoom-controls{width:100%" in BROWSER
    for label in (
        "Go back",
        "Go forward",
        "Refresh page",
        "Zoom out",
        "Zoom in",
        "Fit page to window",
    ):
        assert f'aria-label="{label}"' in BROWSER


def test_cockpit_menus_and_closed_drawer_have_real_semantics() -> None:
    assert '<div class="actions-item"' not in COCKPIT
    menuitems = re.findall(
        r'<button class="actions-item"[^>]+role="menuitem"[^>]+tabindex="-1"',
        COCKPIT,
    )
    assert len(menuitems) >= 10
    assert re.search(
        r'id="sessionDrawer"[^>]+role="dialog"[^>]+aria-modal="true"'
        r'[^>]+aria-labelledby="sessionDrawerTitle"[^>]+aria-hidden="true"[^>]+inert',
        COCKPIT,
    )
    assert "dr.inert = false" in COCKPIT_JS
    assert "dr.inert = true" in COCKPIT_JS
    assert "sessionDrawerBackgroundState" in COCKPIT_JS
    assert "event.key === 'Escape'" in COCKPIT_JS
    assert 'id="sessionTabList" role="tablist"' in COCKPIT
    assert 'class="session-tab-open" type="button" role="tab"' in COCKPIT
    assert "handleSessionTabKey(event" in COCKPIT_JS
    assert "event.key === 'Delete'" in COCKPIT_JS


def test_shipping_pages_have_landmarks_and_headings() -> None:
    assert "<main" in DASHBOARD
    assert '<h1 class="sr-only">Browser</h1>' in BROWSER
    assert '<header class="bar">' in KNOWLEDGE and "<main" in KNOWLEDGE
    assert '<h1 class="sr-only">Files</h1>' in EDITOR
    assert '<h1 class="sr-only">Agent workspace</h1>' in COCKPIT
    assert '<nav class="session-tabs"' in COCKPIT
    assert '<header class="status-bar">' in COCKPIT


def test_subdued_text_still_meets_small_text_contrast_contract() -> None:
    assert "--text-tertiary:   oklch(0.60 0.01 75);" in TOKENS
    assert "--text-dim: #8c8c8c;" in COCKPIT_CSS
    assert "opacity: 0.7" not in re.search(
        r"\.empty-state\s*\{([^}]*)\}", COCKPIT_CSS
    ).group(1)
    assert "button.primary { background: var(--brand)" in KNOWLEDGE
