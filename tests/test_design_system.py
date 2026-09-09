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

# The ShellTeam brand faces, shared with the marketing site so the product a
# customer lands in reads as the brand they bought.
#
# Chosen by running Impeccable's font_selection_procedure rather than by reflex:
# brand words "warm, sturdy, plain-spoken" (equipment, not software), the reflex
# picks written down and rejected, then a catalog pass. Zilla Slab carries the
# display moments, Libre Franklin the interface, Spline Sans Mono the code.
# See docs/decisions/20260801-brand-typography.md.
BRAND_FONTS = ["Libre Franklin", "Spline Sans Mono", "Zilla Slab"]

# Impeccable's reflex_fonts_to_reject list, in full. These are the model's
# training-data defaults; using one is a sign the face was picked by habit
# rather than chosen. Nothing is exempt — if a brand face ever lands on this
# list, the face is wrong, not the list.
BANNED_FONTS = [
    "Space Grotesk", "Space Mono", "Plus Jakarta Sans", "Inter", "DM Sans",
    "DM Serif", "Syne", "Fraunces", "Lora", "Crimson", "Playfair Display",
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
        assert "Libre Franklin" in tokens, "tokens.css --font-sans must be the brand face"

    def test_tokens_define_every_brand_face(self):
        """All three brand faces must be reachable from the shared tokens, or a
        page picks a fallback and the product stops matching the marketing site."""
        tokens = (STATIC / "tokens.css").read_text()
        for font in BRAND_FONTS:
            assert font in tokens, f"tokens.css must reference the brand face {font}"

    def test_tokens_import_the_self_hosted_faces(self):
        """The faces are self-hosted; without this import they silently fall back
        to a system font on any box with no outbound network."""
        tokens = (STATIC / "tokens.css").read_text()
        assert "vendor/fonts/fonts.css" in tokens, "tokens.css must import the self-hosted faces"

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
