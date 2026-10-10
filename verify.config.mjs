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
      // Status mode: roma blue (#1e5fac) = fresh, roma brown (#984e14) = stale.
      const [fresh, stale] = await colorPixels(page, ['#1e5fac', '#984e14']);
      check(`${tag} map paints station dots (fresh ${fresh}px, stale ${stale}px)`, fresh > 150);
      // One source for the ramp: the bins come from MCO.palette, and the no-JS
      // --status-* literals in index.html must be the same samples.
      const ramp = await page.evaluate(() => {
        const want = MCO.palette.sample('roma', 5, { from: 0.1, to: 0.9, reverse: true });
        const css = document.querySelector('style').textContent;
        const lit = (n) => (css.match(new RegExp('--status-' + n + ':\\s*(#[0-9a-f]{6})', 'i')) || [])[1];
        const live = (n) => getComputedStyle(document.documentElement).getPropertyValue('--status-' + n).trim();
        return { want, lit: [lit('fresh'), lit('partial'), lit('stale')], live: [live('fresh'), live('partial'), live('stale')] };
      });
      const exp = [ramp.want[0], ramp.want[2], ramp.want[4]].join();
      check(`${tag} --status-* literals and live values = roma bins 0/2/4 (${exp})`, ramp.lit.join().toLowerCase() === exp && ramp.live.join().toLowerCase() === exp, JSON.stringify(ramp));
      const q = await page.evaluate(() => location.search);
      check(`${tag} defaults elided from the URL on load (${q})`, !/mode=|net=|scat=|legend=/.test(q));
      await close();
    }
    {
      const { page, close } = await open('?theme=dark');
      await page.waitForTimeout(1500);
      const [fresh] = await colorPixels(page, ['#1e5fac']);
      check(`${tag} dark basemap: station dots painted (fresh ${fresh}px)`, fresh > 150);
      // Theme flip restyles the map; dots must come back after style.load.
      await page.click('#btn-theme');
      await page.waitForTimeout(3500);
      const [fresh2] = await colorPixels(page, ['#1e5fac']);
      check(`${tag} dots repainted after a theme flip (fresh ${fresh2}px)`, fresh2 > 150);
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
      // Landscape phone (kit 0.10.0 rail): the bar is a 56px rail; the menu
      // opens the drawer with focus inside and the page inert; Esc returns.
      const { page, close } = await open('', { viewport: { width: 750, height: 342, touch: true } });
      const w = await page.evaluate(() => Math.round(document.getElementById('navbar').getBoundingClientRect().width));
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(300);
      const o = await page.evaluate(() => ({ inside: document.getElementById('nav-drawer').contains(document.activeElement), inert: document.getElementById('main').inert }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const c = await page.evaluate(() => ({ focus: document.activeElement?.id, inert: document.getElementById('main').inert }));
      check(`${tag} 750×342 rail: ${w}px bar, drawer focus+inert, Esc back to the menu`, w === 56 && o.inside && o.inert && c.focus === 'btn-rail-menu' && !c.inert, JSON.stringify({ w, o, c }));
      await close();
    }
    {
      // Attribution is a licence requirement: at 390 (where it wraps across
      // the whole bottom edge) every credit link must be the topmost element
      // at its centre, and the legend must not overlap it.
      const { page, close } = await open('?legend=open', { viewport: { width: 390, height: 844, touch: true } });
      const r = await page.evaluate(() => {
        const L = document.getElementById('legend').getBoundingClientRect();
        const A = document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect();
        const blocked = [...document.querySelectorAll('.maplibregl-ctrl-attrib-inner a')].filter((a) => {
          const b = a.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !(t && (a === t || a.contains(t)));
        }).map((a) => a.textContent.trim());
        return { gap: Math.round(A.top - L.bottom), blocked };
      });
      check(`${tag} 390: legend clears the attribution (gap ${r.gap}px), every credit clickable`, r.gap >= 0 && r.blocked.length === 0, JSON.stringify(r));
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
