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

const STATION = 'aceabsar';   // a real id from /api/stations/ (a colocated HydroMet + AgriMet site)
const rows = () => document.querySelectorAll('#sr-station-table tbody tr').length > 100;
// The station detail is the kit sheet at every width (MCO.initSheet, kit
// 0.21.0), open when it is shown and not data-state="closed". Inlined in
// each page function below — a function passed to the page can't close over
// this module.
const PHONE = { width: 390, height: 844, touch: true };
const DESKTOP = { width: 1440, height: 900 };

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
    { name: 'timesince', query: '?mode=timesince', ready: rows },
    {
      // The deep link opens the station sheet (kit 0.21.0), at 1440 and 390.
      name: 'station', query: `?station=${STATION}`,
      ready: () => document.querySelectorAll('#sr-station-table tbody tr').length > 100
        && [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state !== 'closed'),
    },
  ],
  exemptTargets: '',
  allowProblems: [],
  dialogOpener: '.mco-btn-info',
  shortcuts: [{ key: '/', effect: () => document.activeElement?.id === 'search-input' }],
  probes: async ({ env, open: open30, check }) => {
    const tag = `[${env.engine}]`;
    // MapLibre on SwiftShader is slow when the machine is busy: give every
    // probe page 60 s to show its render evidence, not the default 30.
    const open = (q, o = {}) => open30(q, { timeout: 60000, ...o });
    // The kit's category sets, per theme, as the page reads them.
    const setColors = (page, name) => page.evaluate((n) => MCO.palette.categorySet(n, MCO.getTheme()).map((c) => c.color), name);
    const sheetOpen = () => [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state !== 'closed');
    {
      const { page, close } = await open('?theme=light');
      await page.waitForTimeout(1500);
      // Status mode, kit status-reporting set: fresh and stale markers painted.
      const [fresh, stale] = await setColors(page, 'status-reporting');
      const [nFresh] = await colorPixels(page, [fresh]);
      check(`${tag} map paints station dots in the kit's fresh color ${fresh} (${nFresh}px)`, nFresh > 150);
      // Legend: the kit set's rows and colors, circle swatches (the marker's
      // shape), No record hollow, and no network rows (kit 0.21.0: no network
      // encoding on markers).
      const lg = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#legend-rows .mco-legend-row')].map((r) => {
          const sw = r.querySelector('.mco-legend-swatch');
          return { key: r.dataset.key, shape: sw.dataset.shape, color: sw.style.getPropertyValue('--swatch').trim() };
        }),
        net: document.querySelectorAll('.legend-networks, .legend-network').length,
        legendText: document.getElementById('legend-rows').textContent,
      }));
      const want = JSON.stringify([{ key: 'fresh', shape: 'circle', color: fresh }, { key: 'stale', shape: 'circle', color: stale }]);
      check(`${tag} legend = kit status-reporting set, circle swatches, No record hollow, no network rows`,
        JSON.stringify(lg.rows.slice(0, 2)) === want && lg.rows[2]?.key === 'null' && lg.rows[2]?.shape === 'hollow'
          && lg.net === 0 && !/HydroMet|AgriMet/.test(lg.legendText), JSON.stringify(lg));
      const q = await page.evaluate(() => location.search);
      check(`${tag} defaults elided from the URL on load (${q})`, !/mode=|net=|scat=|legend=/.test(q));
      // Freshness stamp (kit 0.21.0): "Updated 9:40 PM MST" from the data's time.
      const stamp = await page.evaluate(() => document.querySelector('.refresh-status').textContent.replace(/\s+/g, ' ').trim());
      check(`${tag} stamp reads "Updated … M[SD]T" ("${stamp}")`, /^Updated .* M[SD]T$/.test(stamp));
      await close();
    }
    {
      const { page, close } = await open('?theme=dark');
      await page.waitForTimeout(1500);
      const [fresh] = await setColors(page, 'status-reporting');
      const [n] = await colorPixels(page, [fresh]);
      check(`${tag} dark basemap: station dots painted in ${fresh} (${n}px)`, n > 150);
      // Theme flip restyles the map; dots must come back after style.load, in
      // the new theme's set color.
      await page.click('#btn-theme');
      await page.waitForTimeout(3500);
      const [fresh2] = await setColors(page, 'status-reporting');
      const [n2] = await colorPixels(page, [fresh2]);
      check(`${tag} dots repainted after a theme flip in ${fresh2} (${n2}px)`, n2 > 150 && fresh2 !== fresh);
      await close();
    }
    {
      // Time since: the kit status-age set's five bins, in legend order.
      const { page, close } = await open('?mode=timesince&theme=light');
      const r = await page.evaluate(() => ({
        sw: [...document.querySelectorAll('#legend-rows .mco-legend-row .mco-legend-swatch')].map((s) => s.style.getPropertyValue('--swatch').trim()),
        want: MCO.palette.categorySet('status-age', 'light').map((c) => c.color),
      }));
      check(`${tag} Time since legend = kit status-age set`, JSON.stringify(r.sw.slice(0, 5)) === JSON.stringify(r.want), JSON.stringify(r));
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
    for (const [name, viewport] of [['1440', DESKTOP], ['390', PHONE]]) {
      // Deep link (kit 0.21.0): ?station= opens the sheet at both widths, in
      // both motion settings (a reduced-motion jump is the case that used to
      // open nothing), and the intro stays shut.
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const { page, close } = await open(`?station=${STATION}`, { viewport, reducedMotion, ready: rows });
        const ok = await page.waitForFunction(sheetOpen, null, { timeout: 15000 }).then(() => true, () => false);
        const st = await page.evaluate(() => ({
          title: document.querySelector('.mco-sheet-title')?.textContent,
          popup: !!document.querySelector('.maplibregl-popup'),
          intro: !!document.querySelector('#info-modal[open]'),
          q: location.search,
        }));
        check(`${tag} ${name} ${reducedMotion}: ?station= opens the sheet (${JSON.stringify(st)})`,
          ok && st.title === 'Absarokee' && !st.popup && !st.intro && /station=aceabsar/.test(st.q));
        await close();
      }
      // Back closes it: open from a no-detail state (a search pick pushes an
      // entry), then Back.
      {
        const { page, close } = await open('', { viewport });
        if (!(await page.isVisible('#search-input'))) await page.click('#btn-rail-search');
        await page.fill('#search-input', 'absar');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        const opened = await page.waitForFunction(sheetOpen, null, { timeout: 15000 }).then(() => true, () => false);
        const q1 = await page.evaluate(() => location.search);
        await page.goBack({ waitUntil: 'commit' });
        await page.waitForTimeout(1200);
        const after = await page.evaluate(() => ({
          open: [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state !== 'closed'),
          q: location.search,
        }));
        check(`${tag} ${name}: search opens the sheet (${q1}), Back closes it (${after.q})`,
          opened && /station=aceabsar/.test(q1) && !after.open && !/station=/.test(after.q), JSON.stringify(after));
        await close();
      }
    }
    {
      // Colocation (kit MCO.map.colocation): aceabsar's site is two stations;
      // the sheet lists the other one, and hiding AgriMet makes it a plain dot.
      const { page, close } = await open(`?station=${STATION}`, { ready: rows });
      await page.waitForFunction(sheetOpen, null, { timeout: 15000 }).catch(() => {});
      const sib = await page.evaluate(() => [...document.querySelectorAll('.pop-siblings button')].map((b) => b.textContent));
      const site = await page.evaluate(() => [...document.querySelectorAll('#sr-station-table tbody tr')]
        .find((tr) => /\(aceabsar\)/.test(tr.textContent))?.textContent || '');
      check(`${tag} colocated site: sheet lists the other station (${sib.join(', ')}), table says 2 at this site`,
        sib.length === 1 && /AgriMet/.test(sib[0]) && /2 stations at this site/.test(site));
      await close();
    }
    {
      // Chip toggle: a network chip is .mco-chip[aria-pressed]; pressing it
      // hides that network (table rows drop, ?net= written) and back.
      const { page, close } = await open('');
      const n0 = await page.evaluate(() => document.querySelectorAll('#sr-station-table tbody tr').length);
      const chip = page.locator('#subnet-filters .mco-chip[data-network="AgriMet"]');
      await chip.click();
      await page.waitForTimeout(800);
      const off = await page.evaluate(() => ({
        pressed: document.querySelector('#subnet-filters [data-network="AgriMet"]').getAttribute('aria-pressed'),
        rows: document.querySelectorAll('#sr-station-table tbody tr').length,
        q: location.search,
      }));
      await chip.click();
      await page.waitForTimeout(800);
      const on = await page.evaluate(() => ({
        pressed: document.querySelector('#subnet-filters [data-network="AgriMet"]').getAttribute('aria-pressed'),
        rows: document.querySelectorAll('#sr-station-table tbody tr').length,
        q: location.search,
      }));
      check(`${tag} AgriMet chip toggles the network (${n0} → ${off.rows} → ${on.rows}, ${off.q})`,
        off.pressed === 'false' && off.rows < n0 && off.rows > 100 && /net=hydromet/.test(off.q)
          && on.pressed === 'true' && on.rows === n0 && !/net=/.test(on.q), JSON.stringify({ off, on }));
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
      // Phone bar (kit 0.21.0 compact drawer): one row ≤ 64px, badge at the
      // left edge, ☰ at the right; ☰ opens the right drawer with focus inside,
      // the page inert and axe clean in every theme; Esc returns focus to ☰.
      const { AxeBuilder } = await load('@axe-core/playwright');
      for (const theme of ['dark', 'light', 'high-contrast']) {
        const { page, close } = await open(`?theme=${theme}`, { viewport: PHONE });
        const bar = await page.evaluate(() => {
          const r = (el) => el.getBoundingClientRect();
          const nav = document.getElementById('navbar');
          return { h: Math.round(r(nav).height), logo: Math.round(r(document.querySelector('.logo-link')).left),
            menuRight: Math.round(nav.clientWidth - r(document.getElementById('btn-rail-menu')).right),
            mode: Math.round(r(document.getElementById('rail-mode-select')).height) };
        });
        await page.click('#btn-rail-menu');
        await page.waitForTimeout(400);
        // Measure once the drawer's slide-in (a 12px nudge) has settled.
        await page.waitForFunction(() => getComputedStyle(document.getElementById('nav-drawer')).transform === 'none', null, { timeout: 5000 }).catch(() => {});
        const o = await page.evaluate(() => {
          const d = document.getElementById('nav-drawer').getBoundingClientRect();
          return { inside: document.getElementById('nav-drawer').contains(document.activeElement),
            inert: document.getElementById('main').inert, right: Math.round(window.innerWidth - d.right), w: Math.round(d.width),
            stamp: document.querySelector('#nav-drawer .refresh-status').textContent.replace(/\s+/g, ' ').trim() };
        });
        const ax = await new AxeBuilder({ page }).analyze();
        const bad = ax.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const c = await page.evaluate(() => ({ focus: document.activeElement?.id, inert: document.getElementById('main').inert }));
        check(`${tag} 390 ${theme}: one-row bar ${bar.h}px (badge left, ☰ right, mode ${bar.mode}px); drawer opens right with focus+inert, "${o.stamp}"; axe ${bad.length}; Esc back to ☰`,
          bar.h <= 64 && bar.logo <= 16 && bar.menuRight <= 16 && bar.mode === 40 && o.inside && o.inert && o.right === 0 && o.w > 200
            && /^Updated /.test(o.stamp) && bad.length === 0 && c.focus === 'btn-rail-menu' && !c.inert,
          JSON.stringify({ bar, o, c, bad: bad.map((v) => v.id) }));
        await close();
      }
      // The bar's search button opens the drawer on the field; the mode hot
      // control switches the mode.
      const { page, close } = await open('', { viewport: PHONE });
      await page.click('#btn-rail-search');
      await page.waitForTimeout(400);
      const s = await page.evaluate(() => ({ focus: document.activeElement?.id, open: document.getElementById('nav-drawer').classList.contains('is-open') }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => document.activeElement?.id);
      await page.selectOption('#rail-mode-select', 'health');
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => ({ q: location.search, title: document.getElementById('legend-title').textContent, drawer: document.getElementById('mode-select').value }));
      check(`${tag} 390: search button opens the drawer on the field, Esc back (${JSON.stringify(s)}, ${back}); mode select → ${JSON.stringify(m)}`,
        s.focus === 'search-input' && s.open && back === 'btn-rail-search' && /mode=health/.test(m.q) && m.title === 'Station health' && m.drawer === 'health');
      await close();
    }
    {
      // First-visit intro (kit initInfoModal intro): opens once on a plain
      // visit with focus on its close button, never over a deep link.
      const { page, close } = await open('', { storage: {} });
      await page.waitForFunction(() => !!document.querySelector('#info-modal[open]'), null, { timeout: 10000 }).catch(() => {});
      const a = await page.evaluate(() => ({ open: !!document.querySelector('#info-modal[open]'), focus: document.activeElement?.matches('#info-modal .modal-close'), seen: localStorage.getItem('mco-status-seen-intro') }));
      await close();
      const d = await open(`?station=${STATION}`, { storage: {}, ready: rows });
      await d.page.waitForTimeout(1500);
      const b = await d.page.evaluate(() => ({ open: !!document.querySelector('#info-modal[open]'), seen: localStorage.getItem('mco-status-seen-intro') }));
      await d.close();
      check(`${tag} intro: opens once on a plain visit (focus on close), not over ?station= (${JSON.stringify({ a, b })})`,
        a.open && a.focus && a.seen === '1' && !b.open && b.seen === null);
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
      const { page, close } = await open('?legend=open', { viewport: PHONE });
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
  },
};
