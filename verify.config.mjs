// verify.config.mjs — config for mco-web-style's tools/verify/ harness.
// Run from a kit checkout beside this repo:
//   node tools/verify/axe-matrix.mjs --config ../mesonet-status/verify.config.mjs
//   node tools/verify/keyboard.mjs   --config ../mesonet-status/verify.config.mjs
// The browser scripts run Chromium and WebKit by default.
//
// Render evidence is the screen-reader table twin (one row per visible
// station, rebuilt with the map source) — never networkidle. The probes add
// the evidence the table can't give: that MapLibre actually PAINTED the
// station dots (a CSP-blocked worker leaves the basemap up and the GeoJSON
// layers empty while the table still fills).
import { load } from '../mco-web-style/tools/verify/lib.mjs';

const STATION = 'aceabsar';   // a real id from /api/stations/
const rows = () => document.querySelectorAll('#sr-station-table tbody tr').length > 100;
// The station detail: the anchored popup (desktop) or the bottom sheet
// (compact, kit 0.9.0 MCO.initSheet). Inlined in each page function below —
// a function passed to the page can't close over this module.

// Pixels in a screenshot of the map close to one of the status colors.
async function colorPixels(page, hexes) {
  const { PNG } = await load('pngjs');
  const buf = await page.locator('#map').screenshot();
  const png = PNG.sync.read(buf);
  const want = hexes.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const counts = want.map(() => 0);
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    want.forEach(([R, G, B], k) => {
      if (Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 30) counts[k]++;
    });
  }
  return counts;
}

export default {
  root: '.',
  page: 'index.html',
  storage: { 'mco-status-seen-intro': '1' },
  scenarios: [
    { name: 'default', query: '', ready: rows },
    { name: 'health', query: '?mode=health', ready: rows },
    {
      name: 'station', query: `?station=${STATION}`,
      // Anchored popup (desktop) or the bottom sheet (compact, kit 0.9.0).
      ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 100
        && !!document.querySelector('.maplibregl-popup .mco-popup-title, .mco-sheet:not([hidden]) .mco-sheet-title:not(:empty)'),
    },
  ],
  exemptTargets: '',
  allowProblems: [],
  dialogOpener: '.mco-btn-info',
  shortcuts: [{ key: '/', effect: () => document.activeElement?.id === 'search-input' }],
  probes: async ({ env, open, check }) => {
    const tag = `[${env.engine}]`;
    {
      const { page, close } = await open('?theme=light');
      await page.waitForTimeout(1500);
      // Status mode: teal (#2a8a86) = fresh, red-orange (#b8421b) = stale.
      const [teal, red] = await colorPixels(page, ['#2a8a86', '#b8421b']);
      check(`${tag} map paints station dots (teal ${teal}px, red ${red}px)`, teal > 150);
      const q = await page.evaluate(() => location.search);
      check(`${tag} defaults elided from the URL on load (${q})`, !/mode=|net=|scat=|legend=/.test(q));
      await close();
    }
    {
      const { page, close } = await open('?theme=dark');
      await page.waitForTimeout(1500);
      const [teal] = await colorPixels(page, ['#2a8a86']);
      check(`${tag} dark basemap: station dots painted (teal ${teal}px)`, teal > 150);
      // Theme flip restyles the map; dots must come back after style.load.
      await page.click('#btn-theme');
      await page.waitForTimeout(3500);
      const [teal2] = await colorPixels(page, ['#2a8a86']);
      check(`${tag} dots repainted after a theme flip (teal ${teal2}px)`, teal2 > 150);
      await close();
    }
    {
      // AgriMet alone is < 100 stations, so the default evidence can't hold.
      const { page, close } = await open('?mode=health&net=agrimet', {
        ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 10,
      });
      const q = await page.evaluate(() => location.search);
      check(`${tag} ?mode=health&net=agrimet honored and re-emitted (${q})`, /mode=health/.test(q) && /net=agrimet/.test(q));
      const pressed = await page.evaluate(() => document.querySelector('[data-mode="health"]').getAttribute('aria-pressed'));
      check(`${tag} Health segment pressed`, pressed === 'true');
      await close();
    }
    {
      const { page, close } = await open(`?station=${STATION}`, {
        ready: () => !!document.querySelector('.maplibregl-popup .mco-popup-title, .mco-sheet:not([hidden]) .mco-sheet-title:not(:empty)'),
      });
      const title = await page.evaluate(() => (document.querySelector('.maplibregl-popup .mco-popup-title') || document.querySelector('.mco-sheet:not([hidden]) .mco-sheet-title'))?.textContent);
      check(`${tag} ?station= opens the station's details (${title})`, !!title);
      const intro = await page.evaluate(() => !!document.querySelector('#info-modal[open]'));
      check(`${tag} deep link suppresses the intro modal`, !intro);
      await close();
    }
    {
      // Legend toggle: click a row, the category's param appears; aria-pressed flips.
      const { page, close } = await open('');
      const row = page.locator('#legend-rows [aria-pressed]').first();
      await row.click();
      await page.waitForTimeout(800);
      const st = await page.evaluate(() => ({
        pressed: document.querySelector('#legend-rows [aria-pressed]').getAttribute('aria-pressed'),
        q: location.search,
      }));
      check(`${tag} legend row toggles a category (${JSON.stringify(st)})`, st.pressed === 'false' && /scat=/.test(st.q));
      await close();
    }
    {
      // Search: type, pick with Enter, popup opens.
      const { page, close } = await open('');
      // Typing makes the best match active (MCO.initSearchBox); Enter picks it.
      await page.fill('#search-input', 'absar');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !!document.querySelector('.maplibregl-popup .mco-popup-title, .mco-sheet:not([hidden]) .mco-sheet-title:not(:empty)'), null, { timeout: 15000 }).catch(() => {});
      const st = await page.evaluate(() => ({ title: (document.querySelector('.maplibregl-popup .mco-popup-title') || document.querySelector('.mco-sheet:not([hidden]) .mco-sheet-title'))?.textContent, q: location.search }));
      check(`${tag} search → Enter opens the station (${JSON.stringify(st)})`, !!st.title && /station=/.test(st.q));
      await close();
    }
  },
};
