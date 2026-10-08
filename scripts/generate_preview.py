#!/usr/bin/env python3
"""
Generate assets/og-card.png by screenshotting the live GitHub Pages site at
1200×630 (the og:image size; larger cards are rejected by Teams).

?mode=status is a deep-link param, so it pins the Status view and suppresses
the first-visit help dialog without touching the app. The card is the page
itself — navbar, legend and all — exactly as a visitor sees it.

Usage:
    pip install playwright
    playwright install --with-deps chromium
    python scripts/generate_preview.py
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

OUT   = Path(__file__).parent.parent / "assets" / "og-card.png"
URL   = "https://mt-climate-office.github.io/mesonet-status/"
QUERY = "mode=status"
# After the station data lands (the refresh stamp reads "refreshed …"), give
# the basemap tiles and the dot layer time to finish painting.
SETTLE_MS = 4_000


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1200, "height": 630},
            device_scale_factor=1,
            color_scheme="light",
        )
        page = ctx.new_page()

        # Surface any JS errors or console warnings to stdout for debugging.
        page.on("console", lambda msg: print(f"  [{msg.type}] {msg.text}") if msg.type != "log" else None)
        page.on("pageerror", lambda err: print(f"  [pageerror] {err}"))

        print(f"Loading {URL}?{QUERY} …")
        page.goto(f"{URL}?{QUERY}", wait_until="networkidle", timeout=60_000)
        page.wait_for_function(
            "document.getElementById('refresh-stamp')?.textContent.startsWith('refreshed')",
            timeout=60_000,
        )
        page.wait_for_timeout(SETTLE_MS)

        page.screenshot(path=str(OUT))
        print(f"Preview saved → {OUT}")

        browser.close()


if __name__ == "__main__":
    main()
