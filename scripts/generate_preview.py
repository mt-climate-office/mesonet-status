#!/usr/bin/env python3
"""
Generate assets/og-card.png by screenshotting the live GitHub Pages site: a
1200×630 viewport (the og:image aspect) at 2× DPR, giving a 2400×1260 card.
Teams once dropped cards this large (c91d621); check a Teams unfurl if the
preview goes missing there.

?mode=status is a deep-link param, so it pins the Status view and suppresses
the first-visit help dialog without touching the app. The card is the page
itself — navbar, legend and all — exactly as a visitor sees it.

Usage:
    pip install playwright
    playwright install --with-deps chromium
    python scripts/generate_preview.py
"""

import re
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT   = Path(__file__).parent.parent / "assets" / "og-card.png"
URL   = "https://mt-climate-office.github.io/mesonet-status/"
QUERY = "mode=status"
# After the station data lands (the freshness stamp reads "Updated …", kit
# 0.21.0 MCO.formatUpdatedMT; it reads "Loading…" until then), give
# the basemap tiles and the dot layer time to finish painting.
SETTLE_MS = 4_000


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1200, "height": 630},
            device_scale_factor=2,  # 2400×1260 output
            color_scheme="light",
        )
        page = ctx.new_page()

        # Surface any JS errors or console warnings to stdout for debugging.
        page.on("console", lambda msg: print(f"  [{msg.type}] {msg.text}") if msg.type != "log" else None)
        page.on("pageerror", lambda err: print(f"  [pageerror] {err}"))

        print(f"Loading {URL}?{QUERY} …")
        page.goto(f"{URL}?{QUERY}", wait_until="networkidle", timeout=60_000)
        # A locator, not wait_for_function: the page CSP has no 'unsafe-eval',
        # so a string predicate that has to poll throws EvalError instead of
        # waiting (it only ever passed when the stamp was ready at networkidle).
        page.locator("#refresh-stamp", has_text=re.compile(r"^Updated ")).wait_for(timeout=60_000)
        page.wait_for_timeout(SETTLE_MS)

        page.screenshot(path=str(OUT))
        print(f"Preview saved → {OUT}")

        browser.close()


if __name__ == "__main__":
    main()
