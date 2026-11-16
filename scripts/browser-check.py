#!/usr/bin/env python3
"""Does the box's browser look like an ordinary browser, and do sites let it in?

Why this exists (SHE-207): on 15 Nov 2026 the browser was refused by 6 of 12
common pages. It ran headless with a spoofed fingerprint: a standard detector
called it "headless Chrome", it reported an 800x600 screen in a 1920x1080
window, had no WebGL and no plugins, and sat in UTC on a French address. A
green test suite said nothing about any of it, so this is a release check
(docs/release-qa.md) that looks at the real browser the way a site does.

    uv run --with playwright scripts/browser-check.py            # the box's browser
    uv run --with playwright scripts/browser-check.py --cdp ws://127.0.0.1:3899
    uv run --with playwright scripts/browser-check.py --sites    # also visit 12 real pages

It opens its own tab and closes it; the page the owner or an agent is on is
left alone. Exit code 1 when the browser gives itself away (the "identity"
checks). The site visits are a count to compare between releases, not a gate:
some sites refuse a server's address whatever the browser looks like.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys

IDENTITY_JS = """async () => {
  const gl = document.createElement('canvas').getContext('webgl');
  let renderer = '';
  if (gl) { const e = gl.getExtension('WEBGL_debug_renderer_info'); if (e) renderer = gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }
  const uad = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList']).catch(() => null) : null;
  const brand = uad && (uad.fullVersionList || []).find(b => /Chrom/.test(b.brand));
  return {
    ua: navigator.userAgent, webdriver: navigator.webdriver, plugins: navigator.plugins.length,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height], outer: [window.outerWidth, window.outerHeight],
    webgl: renderer, engine: brand ? brand.version : '', cursorDiv: !!document.getElementById('__cursor__'),
  };
}"""

# Twelve pages an owner's errand could land on, behind the common bot checks.
SITES = [
    ("Cloudflare check (test page)", "https://www.scrapingcourse.com/cloudflare-challenge"),
    ("Anti-bot check (test page)", "https://www.scrapingcourse.com/antibot-challenge"),
    ("nowsecure", "https://nowsecure.nl/"),
    ("Google search", "https://www.google.com/search?q=cinema+tickets+tonight"),
    ("Amazon", "https://www.amazon.com/s?k=usb+c+cable"),
    ("Booking", "https://www.booking.com/searchresults.html?ss=Paris"),
    ("Ticketmaster", "https://www.ticketmaster.com/search?q=concert"),
    ("LinkedIn jobs", "https://www.linkedin.com/jobs/search/?keywords=engineer"),
    ("Reddit", "https://www.reddit.com/r/programming/"),
    ("Zillow", "https://www.zillow.com/homes/Seattle_rb/"),
    ("Leboncoin", "https://www.leboncoin.fr/recherche?text=velo"),
    ("G2", "https://www.g2.com/products/slack/reviews"),
]
WALL = re.compile(
    r"just a moment|verify you are human|access (to this page has been )?denied|unusual traffic|are you a robot|"
    r"pardon our interruption|press (&|and) hold|you('ve| have) been blocked|activity has been paused|security verification",
    re.I,
)


def identity_problems(fp: dict, botd: dict, address_tz: str | None) -> list[str]:
    """Every way the browser gives itself away, in plain words. Empty = none."""
    problems = []
    if botd.get("bot"):
        problems.append(f"the BotD detector calls it a bot ({botd.get('botKind', 'unknown kind')})")
    if fp["webdriver"]:
        problems.append("navigator.webdriver is true")
    if "Headless" in fp["ua"]:
        problems.append("the user agent says HeadlessChrome")
    if fp["plugins"] == 0:
        problems.append("no plugins: an ordinary Chrome lists its PDF viewer")
    if not fp["webgl"]:
        problems.append("no WebGL")
    if abs(fp["screen"][0] - fp["outer"][0]) > 16 or fp["screen"][1] < fp["outer"][1]:
        problems.append(f"screen {fp['screen']} does not fit its window {fp['outer']}")
    claimed = re.search(r"Chrome/(\d+)", fp["ua"])
    if fp["engine"] and claimed and claimed.group(1) != fp["engine"].split(".")[0]:
        problems.append(f"says Chrome {claimed.group(1)} but is Chromium {fp['engine']}: a spoofed fingerprint")
    if not fp["engine"]:
        problems.append("empty browser brand data: a spoofed fingerprint")
    if address_tz and fp["tz"] != address_tz:
        problems.append(f"timezone {fp['tz']} but its address is in {address_tz}")
    if fp["cursorDiv"]:
        problems.append("a fake cursor element is injected in every page")
    return problems


async def run(cdp: str, with_sites: bool) -> int:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        try:
            await page.goto("https://example.com", wait_until="domcontentloaded")
            fp = await page.evaluate(IDENTITY_JS)
            address_tz = None
            try:
                await page.goto("https://ipinfo.io/json", wait_until="domcontentloaded", timeout=20000)
                info = json.loads(await page.inner_text("body"))
                address_tz = info.get("timezone")
                print(f"address: {info.get('org')} ({info.get('country')}), timezone {address_tz}")
            except Exception as e:  # the lookup is a convenience, not the check
                print(f"address lookup failed ({type(e).__name__}): timezone not compared")
            await page.goto("https://fingerprintjs.github.io/BotD/main/", wait_until="load", timeout=30000)
            await page.wait_for_timeout(3000)
            text = await page.inner_text("body")
            m = re.search(r'Detection result:\s*(\{.*?\})', text, re.S)
            botd = json.loads(m.group(1)) if m else {"bot": True, "botKind": "detector page did not answer"}

            print(f"browser: {fp['ua']}\n  engine {fp['engine'] or '?'}, plugins {fp['plugins']}, timezone {fp['tz']}, "
                  f"screen {fp['screen']}, window {fp['outer']}, WebGL {fp['webgl'][:60] or 'none'}")
            problems = identity_problems(fp, botd, address_tz)
            for line in problems:
                print(f"  GIVES ITSELF AWAY: {line}")
            if not problems:
                print("  identity: looks like an ordinary browser (detector: not a bot)")

            if with_sites:
                refused = 0
                for name, url in SITES:
                    try:
                        resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        await page.wait_for_timeout(7000)
                        title = await page.title()
                        body = (await page.inner_text("body"))[:3000]
                        wall = WALL.search(title) or WALL.search(body)
                        status = resp.status if resp else 0
                        blocked = bool(wall) or status in (401, 403, 429)
                        why = f"says: {wall.group(0)!r}" if wall else ("refused with no page" if blocked else "")
                    except Exception as e:
                        blocked, why, status = True, f"{type(e).__name__}", "-"
                    refused += blocked
                    print(f"  {'REFUSED' if blocked else 'ok     '} {name:30} {status} {why}")
                print(f"sites: {refused} of {len(SITES)} refused on first load (15 Nov 2026: 6 before the fix)")
        finally:
            await page.close()
            await browser.close()
    return 1 if problems else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cdp", default=f"ws://127.0.0.1:{os.environ.get('STEEL_PORT', '3877')}", help="the browser's CDP address")
    ap.add_argument("--sites", action="store_true", help="also visit the 12 pages")
    args = ap.parse_args()
    return asyncio.run(run(args.cdp, args.sites))


if __name__ == "__main__":
    sys.exit(main())
