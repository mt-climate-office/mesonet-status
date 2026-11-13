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
// The station detail is the kit sheet at every width (MCO.initSheet; one
// state from kit 1.0.0), open when it is shown and data-state="full". Inlined in
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
        && [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state === 'full'),
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
    // The app's category colors (its role registry, kept over the kit 0.21.0
    // sets): the roma sample, bins 0/4 for Status, all five for Time since,
    // 0/1/2/4 for Health (operational, known, partial, outage).
    const roma = (page) => page.evaluate(() => MCO.palette.sample('roma', 5, { from: 0.1, to: 0.9, reverse: true }));
    const setColors = async (page, name) => {
      const r = await roma(page);
      return name === 'status-age' ? r : name === 'status-health' ? [r[0], r[1], r[2], r[4]] : [r[0], r[4]];
    };
    const sheetOpen = () => [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state === 'full');
    {
      const { page, close } = await open('?theme=light');
      await page.waitForTimeout(1500);
      // Status mode: roma blue = fresh, roma brown = stale.
      const [fresh, stale] = await setColors(page, 'status-reporting');
      const [nFresh] = await colorPixels(page, [fresh]);
      check(`${tag} map paints station dots in the fresh color ${fresh} (${nFresh}px)`, nFresh > 150);
      // One source for the ramp: the --status-* literals in index.html (the
      // pills' no-JS fallback) and the live values are roma bins 0/1/2/4.
      const ramp = await page.evaluate(() => {
        const want = MCO.palette.sample('roma', 5, { from: 0.1, to: 0.9, reverse: true });
        const css = document.querySelector('style').textContent;
        const lit = (n) => (css.match(new RegExp('--status-' + n + ':\\s*(#[0-9a-f]{6})', 'i')) || [])[1];
        const live = (n) => getComputedStyle(document.documentElement).getPropertyValue('--status-' + n).trim();
        const names = ['fresh', 'known', 'partial', 'stale'];
        return { want, lit: names.map(lit), live: names.map(live) };
      });
      const exp = [ramp.want[0], ramp.want[1], ramp.want[2], ramp.want[4]].join();
      check(`${tag} --status-* literals and live values = roma bins 0/1/2/4 (${exp})`, ramp.lit.join().toLowerCase() === exp && ramp.live.join().toLowerCase() === exp, JSON.stringify(ramp));
      // Legend: the Status rows and roma colors, circle swatches (the marker's
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
      check(`${tag} legend = the roma Status colors, circle swatches, No record hollow, no network rows`,
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
      // Theme flip restyles the map; dots must come back after style.load.
      await page.click('#btn-theme');
      await page.waitForTimeout(3500);
      const [n2] = await colorPixels(page, [fresh]);
      check(`${tag} dots repainted after a theme flip in ${fresh} (${n2}px)`, n2 > 150);
      await close();
    }
    {
      // Time since: the five roma bins, in legend order.
      const { page, close } = await open('?mode=timesince&theme=light');
      const r = await page.evaluate(() => ({
        sw: [...document.querySelectorAll('#legend-rows .mco-legend-row .mco-legend-swatch')].map((s) => s.style.getPropertyValue('--swatch').trim()),
        want: MCO.palette.sample('roma', 5, { from: 0.1, to: 0.9, reverse: true }),
      }));
      check(`${tag} Time since legend = the five roma bins`, JSON.stringify(r.sw.slice(0, 5)) === JSON.stringify(r.want), JSON.stringify(r));
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
          open: [...document.querySelectorAll('.mco-sheet')].some((el) => !el.hidden && el.dataset.state === 'full'),
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
    for (const vp of [{ width: 844, height: 390, touch: true }, { width: 750, height: 342, touch: true }]) {
      // Short landscape phone (kit 1.0.0): the bar is a 56px rail at the
      // RIGHT edge (badge, ☰, search), every rail button ≥ 44px and the
      // topmost element at its centre; the mode select is not in the rail
      // (a select doesn't fit 56px) but the ☰ drawer carries it; ☰ opens the
      // drawer beside the rail (its right edge at the rail column's left) with focus
      // inside, the page inert and the rail live; Esc returns to ☰.
      const size = `${vp.width}×${vp.height}`;
      const { page, close } = await open('', { viewport: vp });
      const r = await page.evaluate(() => {
        const R = (el) => el.getBoundingClientRect();
        const nav = R(document.getElementById('navbar'));
        const btns = [...document.querySelectorAll('.mco-rail .nav-btn')].filter((b) => R(b).width > 0).map((b) => {
          const q = R(b); const t = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          return { id: b.id, w: Math.round(q.width), h: Math.round(q.height), hit: !!t && b.contains(t) };
        });
        return { left: Math.round(nav.left), right: Math.round(window.innerWidth - nav.right), w: Math.round(nav.width), h: Math.round(nav.height),
          isRail: MCO.viewport.isRail(), btns, select: getComputedStyle(document.getElementById('rail-mode-select')).display,
          sw: document.documentElement.scrollWidth };
      });
      await page.click('#btn-rail-menu');
      await page.waitForTimeout(400);
      const o = await page.evaluate(() => {
        const d = document.getElementById('nav-drawer').getBoundingClientRect();
        const rl = document.getElementById('navbar').getBoundingClientRect();
        const sel = document.getElementById('mode-select');
        const sr = sel.getBoundingClientRect();
        return { inside: document.getElementById('nav-drawer').contains(document.activeElement), inert: document.getElementById('main').inert,
          railInert: !!document.getElementById('navbar').closest('[inert]'), gap: Math.round(rl.left - d.right), w: Math.round(d.width),
          modeSelect: !sel.hidden && sr.width > 0 && sr.height > 0 };
      });
      await page.selectOption('#mode-select', 'timesince');
      await page.waitForTimeout(500);
      const q = await page.evaluate(() => location.search);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const c = await page.evaluate(() => ({ focus: document.activeElement?.id, inert: document.getElementById('main').inert }));
      check(`${tag} ${size} rail at the right edge (${r.w}×${r.h}, right ${r.right}), buttons ≥ 44 and hittable, no mode select in the rail; ☰ opens the drawer beside it with the mode select (${q}); Esc back to ☰`,
        r.isRail && r.right === 0 && r.w === 56 && r.h === vp.height && r.left === vp.width - 56 && r.sw === vp.width
          && r.btns.length >= 2 && r.btns.every((b) => b.w >= 44 && b.h >= 44 && b.hit) && r.select === 'none'
          && o.inside && o.inert && !o.railInert && Math.abs(o.gap) <= 2 && o.w > 200 && o.modeSelect && /mode=timesince/.test(q)
          && c.focus === 'btn-rail-menu' && !c.inert, JSON.stringify({ r, o, q, c }));
      await close();
    }
    for (const [size, vp] of [['390×844', PHONE], ['844×390', { width: 844, height: 390, touch: true }], ['320×568', { width: 320, height: 568, touch: true }]]) {
      // Station panel on a phone (kit 1.0.0): one state ("full"), the whole
      // area under the bar (left of the rail in landscape), the bar not
      // inert; the 44px close button is hittable and closes it, focus back
      // in the bar.
      const { page, close } = await open(`?station=${STATION}`, { viewport: vp, ready: rows });
      const ok = await page.waitForFunction(() => document.querySelector('#station-sheet[data-state="full"]:not([hidden])'), null, { timeout: 15000 }).then(() => true, () => false);
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
        const nav = R(document.getElementById('navbar')), sh = R(document.getElementById('station-sheet'));
        const x = document.querySelector('#station-sheet [data-close-sheet]'); const xr = x.getBoundingClientRect();
        const t = document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2);
        return { nav, sh, vw: window.innerWidth, vh: window.innerHeight, rail: MCO.viewport.isRail(),
          navInert: !!document.getElementById('navbar').closest('[inert]'), mapInert: !!document.getElementById('map').closest('[inert]'),
          close: { w: Math.round(xr.width), h: Math.round(xr.height), hit: !!t && x.contains(t) }, grip: document.querySelectorAll('.mco-sheet-grip').length };
      });
      const want = m.rail ? { x: 0, y: 0, r: m.nav.x, b: m.vh } : { x: 0, y: m.nav.b, r: m.vw, b: m.vh };
      const fits = Math.abs(m.sh.x - want.x) <= 1 && Math.abs(m.sh.y - want.y) <= 1 && Math.abs(m.sh.r - want.r) <= 1 && Math.abs(m.sh.b - want.b) <= 1;
      await page.click('#station-sheet [data-close-sheet]');
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({ state: document.getElementById('station-sheet').dataset.state, q: location.search,
        focusInBar: !!document.activeElement?.closest('#navbar, #main') }));
      check(`${tag} ${size}: ?station= opens the panel full height under the bar (${JSON.stringify(m.sh)}), bar live, close ${m.close.w}×${m.close.h} hittable and closes`,
        ok && fits && !m.navInert && m.mapInert && m.close.w >= 44 && m.close.h >= 44 && m.close.hit && m.grip === 0
          && after.state === 'closed' && !/station=/.test(after.q), JSON.stringify({ m, want, after }));
      await close();
    }
    {
      // The panel header is the same at every width (kit 1.0.0 consistency
      // rule): the title, then one close button, 44px, top right.
      const head = [];
      for (const vp of [DESKTOP, { width: 768, height: 1024, touch: true }, PHONE]) {
        const { page, close } = await open(`?station=${STATION}`, { viewport: vp, ready: rows });
        await page.waitForFunction(sheetOpen, null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
        head.push(await page.evaluate(() => {
          const h = document.querySelector('#station-sheet .mco-sheet-head');
          const x = h.querySelector('[data-close-sheet]').getBoundingClientRect(), hr = h.getBoundingClientRect();
          return { kids: [...h.children].map((c) => c.className + '|' + (c.getAttribute('aria-label') || c.textContent)).join(','),
            x: [Math.round(x.width), Math.round(x.height)].join('×'), topRight: Math.round(hr.right - x.right) <= 16 && Math.round(x.top - hr.top) <= 16 };
        }));
        await close();
      }
      check(`${tag} panel header identical at 1440, 768 and 390 (${head[0].kids}; close ${head.map((h) => h.x).join(', ')})`,
        head.every((h) => h.kids === head[0].kids && h.x === '44×44' && h.topRight), JSON.stringify(head));
    }
    {
      // Legend on a phone (kit 1.0.0 MCO.initLegendDrawer): the panel is in a
      // "Legend" group in the ☰ drawer, a Legend button holds its corner on
      // the map clear of the attribution (a licence requirement: every credit
      // stays the topmost element at its centre); the button opens the
      // drawer at the group with focus on the legend's title, the rows still
      // toggle there, and Esc returns focus to the button.
      const { page, close } = await open('?legend=collapsed', { viewport: PHONE });
      const r = await page.evaluate(() => {
        const btn = document.querySelector('.mco-legend-btn');
        const B = btn.getBoundingClientRect();
        const A = document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect();
        const t = document.elementFromPoint(B.left + B.width / 2, B.top + B.height / 2);
        const blocked = [...document.querySelectorAll('.maplibregl-ctrl-attrib-inner a')].filter((a) => {
          const b = a.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !(e && (a === e || a.contains(e)));
        }).map((a) => a.textContent.trim());
        return { name: btn.textContent.trim(), hidden: btn.hidden, hit: !!t && btn.contains(t), h: Math.round(B.height), gap: Math.round(A.top - B.bottom), blocked,
          inDrawer: !!document.getElementById('legend').closest('#nav-drawer .mco-legend-slot') };
      });
      await page.click('.mco-legend-btn');
      await page.waitForTimeout(500);
      const o = await page.evaluate(() => {
        const t = document.getElementById('legend-title');
        const d = document.getElementById('nav-drawer').getBoundingClientRect(), tr = t.getBoundingClientRect();
        return { open: document.getElementById('nav-drawer').classList.contains('is-open'), focus: document.activeElement === t,
          expanded: document.getElementById('legend-toggle-btn').getAttribute('aria-expanded'), visible: tr.top >= d.top && tr.bottom <= d.bottom,
          slot: document.querySelector('.mco-legend-slot')?.getAttribute('aria-label') };
      });
      await page.locator('#legend-rows [aria-pressed]').first().click();
      await page.waitForTimeout(500);
      const q = await page.evaluate(() => location.search);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => document.activeElement?.classList.contains('mco-legend-btn'));
      check(`${tag} 390: legend in the drawer; "${r.name}" button clears the attribution (gap ${r.gap}px), credits clickable; it opens the drawer at the "${o.slot}" group (focus on its title, expanded), a row toggles (${q}), Esc back to the button`,
        r.name === 'Legend' && !r.hidden && r.hit && r.gap >= 0 && r.blocked.length === 0 && r.inDrawer
          && o.open && o.focus && o.expanded === 'true' && o.visible && o.slot === 'Legend' && /scat=/.test(q) && back,
        JSON.stringify({ r, o, q, back }));
      await close();
    }
    for (const [size, vp] of [['1440', DESKTOP], ['768', { width: 768, height: 1024, touch: true }]]) {
      // Above compact the legend floats on the map as before; no Legend button.
      const { page, close } = await open('?legend=open', { viewport: vp });
      const r = await page.evaluate(() => {
        const L = document.getElementById('legend');
        const B = L.getBoundingClientRect(), M = document.getElementById('map-container').getBoundingClientRect();
        const btn = document.querySelector('.mco-legend-btn');
        return { floating: L.parentElement.id === 'map-container' && getComputedStyle(L).position === 'absolute', inside: B.left >= M.left && B.bottom <= M.bottom && B.top >= M.top,
          btn: !btn || btn.hidden || getComputedStyle(btn).display === 'none', slot: !document.querySelector('.mco-legend-slot') || document.querySelector('.mco-legend-slot').hidden };
      });
      check(`${tag} ${size}: legend floats on the map, no Legend button or drawer group`, r.floating && r.inside && r.btn && r.slot, JSON.stringify(r));
      await close();
    }
  },
};
