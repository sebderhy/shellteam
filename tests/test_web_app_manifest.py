"""SHE-133: "Install app" on a phone must give a full-screen app, not a browser
window with a title bar. Without a web app manifest, Android only makes a
home-screen shortcut, which opens in a Custom-Tab style window (page title,
domain, menu) like a link opened from Gmail.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "frontend" / "static" / "manifest.webmanifest"


def test_dashboard_links_the_manifest():
    html = (ROOT / "frontend" / "dashboard.html").read_text()
    assert '<link rel="manifest" href="/static/manifest.webmanifest">' in html
    assert '<meta name="theme-color"' in html


def test_manifest_is_installable_full_screen():
    m = json.loads(MANIFEST.read_text())
    assert m["display"] == "standalone"
    # The whole dashboard is in scope, so its own pages never show the bar.
    assert m["scope"] == "/" and m["start_url"] == "/"
    sizes = {i["sizes"] for i in m["icons"]}
    assert {"192x192", "512x512"} <= sizes  # Chrome's install requirement
    for icon in m["icons"]:
        assert (ROOT / "frontend" / icon["src"].lstrip("/")).is_file(), icon["src"]


def test_manifest_is_served_without_a_login(client):
    # Browsers fetch the manifest without cookies, so it must not need auth.
    r = client.get("/static/manifest.webmanifest")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/manifest+json")
    assert json.loads(r.text)["name"] == "ShellTeam"
