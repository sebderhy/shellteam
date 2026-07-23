"""Design system tests — enforce font bans, color tokens, and accessibility.

These tests parse static HTML/CSS files directly (no browser needed).
They guard the shared design tokens and the shipping cockpit pages
(the standalone terminal page and the ai-chat UI under computer/ai-chat).
"""

import re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
COMPUTER = Path(__file__).resolve().parent.parent / "computer"
STATIC = FRONTEND / "static"

# Fonts on Impeccable's reflex_fonts_to_reject list
BANNED_FONTS = [
    "Space Grotesk", "Plus Jakarta Sans", "Inter", "DM Sans", "DM Serif",
    "Syne", "Fraunces", "Lora", "Crimson", "Playfair Display",
    "Cormorant", "IBM Plex", "Outfit", "Instrument Sans", "Instrument Serif",
    "Newsreader",
]


# All live HTML/CSS files (exclude plans/, DONOTCOMMIT/, node_modules/)
def _live_files(*globs):
    files = []
    for base in [FRONTEND, COMPUTER]:
        for glob in globs:
            for f in base.rglob(glob):
                if any(skip in str(f) for skip in ["DONOTCOMMIT", "node_modules", "plans/"]):
                    continue
                files.append(f)
    return files


# ---------------------------------------------------------------------------
# Design token files exist
# ---------------------------------------------------------------------------
class TestDesignTokensExist:
    def test_tokens_css_exists(self):
        assert (STATIC / "tokens.css").exists(), "frontend/static/tokens.css must exist"

    def test_base_css_exists(self):
        assert (STATIC / "base.css").exists(), "frontend/static/base.css must exist"

    def test_tokens_contains_brand_color(self):
        tokens = (STATIC / "tokens.css").read_text()
        assert "--brand:" in tokens, "tokens.css must define --brand"

    def test_tokens_contains_surfaces(self):
        tokens = (STATIC / "tokens.css").read_text()
        for n in range(4):
            assert f"--surface-{n}:" in tokens, f"tokens.css must define --surface-{n}"

    def test_tokens_contains_font_sans(self):
        tokens = (STATIC / "tokens.css").read_text()
        assert "--font-sans:" in tokens, "tokens.css must define --font-sans"
        assert "Figtree" in tokens, "tokens.css --font-sans must include Figtree"

    def test_terminal_page_links_tokens(self):
        html = (FRONTEND / "terminal.html").read_text()
        assert "tokens.css" in html, "terminal.html must link to tokens.css"


# ---------------------------------------------------------------------------
# Banned fonts
# ---------------------------------------------------------------------------
class TestBannedFonts:
    """No banned font names in any live HTML or CSS file."""

    def test_no_banned_fonts_in_frontend(self):
        for f in _live_files("*.html", "*.css"):
            content = f.read_text()
            for font in BANNED_FONTS:
                # Check in font-family declarations and Google Fonts URLs
                # (not in prose text where "Inter" could appear in "Interactive")
                pattern = rf"""(?:font-family[^;]*{re.escape(font)}|family={re.escape(font.replace(' ', '+'))}|'{re.escape(font)}'|"{re.escape(font)}")"""
                match = re.search(pattern, content)
                assert match is None, (
                    f"Banned font '{font}' found in {f.relative_to(f.parent.parent.parent)}: {match.group()}"
                )


# ---------------------------------------------------------------------------
# No pure black in shared tokens
# ---------------------------------------------------------------------------
class TestNoPureBlack:
    def test_no_pure_black_in_tokens(self):
        tokens = (STATIC / "tokens.css").read_text()
        assert "#000" not in tokens, "Pure black in tokens.css"
        assert "#0a0a0a" not in tokens, "#0a0a0a in tokens.css"


# ---------------------------------------------------------------------------
# No glow effects on status dots
# ---------------------------------------------------------------------------
class TestNoGlowEffects:
    def test_no_status_dot_glow_in_base(self):
        css = (STATIC / "base.css").read_text()
        # status-dot--running should not have box-shadow
        running = re.search(r"\.status-dot--running\s*\{([^}]+)\}", css)
        if running:
            assert "box-shadow" not in running.group(1), (
                "status-dot--running should not have box-shadow (glow)"
            )
