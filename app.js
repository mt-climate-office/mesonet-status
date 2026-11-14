/* ============================================================================
   Mesonet Station Status · app.js
   Built on mco-web-style (window.MCO / MCO.map — pinned + SRI in index.html).
   External classic script so the page CSP can pin script-src 'self'.
   House conventions: HOUSE-STYLE.md in mt-climate-office/mco-web-style.
   ========================================================================== */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  // All API reads go to mesonet2 (the CSP connect-src in index.html must
  // match). The dashboard is a page link, not a fetch, and stays on the old
  // host: mesonet2's /dash/ 301s to the Pages dashboard and drops the id.
  const API_BASE        = 'https://mesonet2.climate.umt.edu/api';
  const STATIONS_URL    = `${API_BASE}/stations/?type=json`;
  const LATEST_URL      = `${API_BASE}/latest/?type=json`;
  const DASH_URL        = (s) => `https://mesonet.climate.umt.edu/dash/${encodeURIComponent(s)}`;
  const LATEST_FOR_URL  = (s) => `${API_BASE}/latest/?stations=${encodeURIComponent(s)}`;
  // Expected elements (sensors) per station. Returns HTML without type=json.
  // The bulk form (?all=true, mesonet-db-rds PR #175) answers for every
  // station in one response with a leading `station` column; an API that
  // predates it ignores the flag and returns the bare catalog, which has no
  // `station` column — that absence is the signal to fall back per station.
  const ELEMENTS_ALL_URL = `${API_BASE}/elements/?all=true&type=json`;
  const ELEMENTS_URL     = (s) => `${API_BASE}/elements/${encodeURIComponent(s)}/?type=json`;

  // Auto-refresh latest records every 5 min; refresh "minutes since" colors every 30 s
  const LATEST_REFRESH_MS = 5 * 60 * 1000;
  const REPAINT_TICK_MS   =     30 * 1000;
  // A station is "fresh" (Status mode) / eligible for Operational or Partial
  // (Health mode) when its latest record is younger than this.
  const FRESH_MINUTES     = 120;

  // Element lists change only when a station is re-instrumented, so they're
  // cached in localStorage per station. A list from the bulk listing carries
  // the AirTable outage windows, which staff edit any day, so it expires
  // after 1 h (one request, ~29 KB gzipped, ~0.2–0.3 s). A per-station list
  // (older API: no windows) keeps the 24 h TTL: 245 stations at concurrency
  // 8 loads in ~10 s cold. The kit's default 60 s fetch timeout would let one
  // hung request stall a worker for a minute, hence 15 s.
  const ELEMENTS_CACHE_KEY        = 'mco-status-elements-v2';
  const ELEMENTS_TTL_MS           = 24 * 60 * 60 * 1000;
  const OUTAGES_TTL_MS            = 60 * 60 * 1000;
  const ELEMENTS_CONCURRENCY      = 8;
  const ELEMENTS_TIMEOUT_MS       = 15 * 1000;
  const ELEMENTS_PERSIST_EVERY    = 40;      // completions between cache writes
  const HEALTH_REFRESH_DEBOUNCE_MS = 500;    // coalesce rebuilds while lists stream in

  const SEARCH_FLY_ZOOM         = 11;     // zoom when search/deep-link flies to a station
  const SEARCH_FLY_SPEED        = 1.4;
  // Label collision detection switches on at this zoom
  const LABEL_MINZOOM           = 6;
  // Reservation name labels switch on at this zoom (less cluttered at MT extent)
  const TRIBAL_LABEL_MINZOOM    = 7;

  // ── Role registry: the app's category colors (HOUSE-STYLE §6) ──────────
  // Status ramp = kit roma, option B (Kyle, 2026-10-10; kept 2026-11-04
  // over the kit 0.21.0 category sets, which 0.21.1 deprecates). Crameri roma
  // (MCO.palette, diverging, midpoint 0.5) sampled at five evenly spaced
  // points from 0.1 to 0.9, reversed so fresh = the blue end and stale = the
  // brown end: MCO.palette.sample('roma', 5, {from: .1, to: .9, reverse:
  // true}). The 0.1 and 0.9 ends keep the extremes vivid, and their lightness
  // differs enough to survive grayscale. Health reuses bins 0, 2 and 4 so the
  // modes agree on "good" and "bad", and puts "known outage" on bin 1, next
  // to operational: accounted for, not news. Bin 1 against the other Health
  // colors, OKLab ΔE×100 under none/protan/deutan/tritan (Machado 2009, full
  // severity): operational ≥ 22.0, partial ≥ 18.9, outage ≥ 25.6; grayscale
  // ΔL ≥ 18.1 to all three (operational vs outage is 1.0). Its fill is 2.35:1
  // on Positron, so like partial's pale fill it leans on the --dot-stroke
  // edge for ≥ 3:1; the pill takes dark text (6.95:1). One value per theme
  // (the same in all three today); verify.config.mjs checks the registry against the sample
  // and the --status-* literals in index.html. Data-encoding (§6).
  const ROMA_BINS = ['#1e5fac', '#4bb2ce', '#c0eac3', '#c1a545', '#984e14'];
  const ROLE_SETS = {
    'status-reporting': [
      { key: 'fresh', label: 'Reported < 2 h ago', color: ROMA_BINS[0] },
      { key: 'stale', label: 'Stale (≥ 2 h)',      color: ROMA_BINS[4] },
    ],
    'status-age': ['< 2 h', '2–3 h', '3–6 h', '6–24 h', '> 24 h']
      .map((label, i) => ({ key: String(i), label, color: ROMA_BINS[i] })),
    'status-health': [
      { key: 'operational', label: 'Operational',                  color: ROMA_BINS[0] },
      { key: 'known',       label: 'Partial — known outage',       color: ROMA_BINS[1] },
      { key: 'partial',     label: 'Partial — new sensor outage',  color: ROMA_BINS[2] },
      { key: 'outage',      label: 'Total outage',                 color: ROMA_BINS[4] },
    ],
  };
  const ROLES = { dark: ROLE_SETS, light: ROLE_SETS, 'high-contrast': ROLE_SETS };
  const SET_FOR_MODE = { status: 'status-reporting', timesince: 'status-age', health: 'status-health' };
  // A fresh copy of a set's rows for the current theme, in legend order.
  const catSet = (name) => (ROLES[MCO.getTheme()] || ROLES.dark)[name].map((r) => ({ ...r }));
  // The sheet's pills read these (index.html .pop-pill.*).
  {
    const root = document.documentElement.style;
    root.setProperty('--status-fresh', ROMA_BINS[0]);
    root.setProperty('--status-known', ROMA_BINS[1]);
    root.setProperty('--status-partial', ROMA_BINS[2]);
    root.setProperty('--status-stale', ROMA_BINS[4]);
  }
  // Time-since bins: the upper bound in minutes of status-age's keys '0'..'4'
  // (its labels run '< 2 h' … '> 24 h'). Bin 0 is the Status/Health cutoff,
  // so stale means ≥ 2 h in every mode.
  const TIME_BIN_MAX = [FRESH_MINUTES, 180, 360, 1440, Infinity];
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Health mode classes, in status-health's order (operational, known,
  // partial, outage); the colors come from the role registry. `partial` keeps
  // its key, so an old ?hcat=partial link still means "needs a look".
  const HEALTH_CLASSES = [
    { key: 'operational', label: 'Operational',                 short: 'operational'           },
    { key: 'known',       label: 'Partial — known outage',      short: 'partial, known outage' },
    { key: 'partial',     label: 'Partial — new sensor outage', short: 'partial, new outage'   },
    { key: 'outage',      label: 'Total outage',                short: 'total outage'          },
  ];
  const healthClass = (key) => HEALTH_CLASSES.find(c => c.key === key)
    || HEALTH_CLASSES.find(c => c.key === 'outage');

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const refreshStampEl  = document.getElementById('refresh-stamp');
  const subnetFiltersEl = document.getElementById('subnet-filters');
  const legendRowsEl    = document.getElementById('legend-rows');
  const legendTitleEl   = document.getElementById('legend-title');
  const searchInput     = document.getElementById('search-input');
  const searchDropdown  = document.getElementById('search-dropdown');
  const infoModal       = document.getElementById('info-modal');

  // Screen-reader users hear "Station X opened" when a popup is shown via
  // click, search, or deep-link — through MCO.announce, the page's one
  // announcer (kit 0.8.0: clears then sets, so a repeat is re-read).
  function announcePopup(stationId) {
    const s = stationById.get(stationId);
    if (!s) return;
    const ts = latestById.get(stationId) ?? null;
    const when = ts == null ? 'no record' : `last reported ${relativeStamp(ts)}`;
    const { emergent, known } = splitMissing(stationId);
    const health = [
      emergent.length ? `${emergent.length} sensor${emergent.length === 1 ? '' : 's'} not reporting` : '',
      known.length ? `${known.length} flagged outage${known.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    MCO.announce(`${s.name} (${s.station}), ${s.sub_network || 'station'}, ${when}${health ? ', ' + health : ''}.`);
  }

  // ── Info modal ───────────────────────────────────────────────────────────
  // The first-visit intro is the kit's (initInfoModal intro, 0.21.0): once
  // per key, never over a deep link (someone following a shared ?station=
  // URL shouldn't land behind a help dialog), never once focus has left
  // <body>, the seen flag written as it opens. Deferred to after the first
  // data load (loadAll), so it never lands mid-boot. The key predates the
  // kit option and is kept, so returning visitors don't see it again.
  const btnInfo = document.getElementById('btn-info');
  const urlParams = MCO.urlParams();
  const DEEP_LINK_PARAMS = ['station', 'mode', 'net', 'scat', 'tcat', 'hcat', 'lng'];
  const hasDeepLink = DEEP_LINK_PARAMS.some((k) => urlParams.has(k));
  const infoDialog = MCO.initInfoModal({
    dialog: infoModal, trigger: btnInfo,
    intro: { key: 'mco-status-seen-intro', skip: hasDeepLink, defer: true },
  });
  document.getElementById('info-credit').textContent = MCO.credit({ source: 'Montana Mesonet' });

  // ── Time helpers ─────────────────────────────────────────────────────────
  // Absolute stamps are Mountain Time (house convention: every MCO product
  // reports in the network's timezone) — MCO.formatStampMT / formatDateMT.
  function minutesSince(ts) {
    if (ts == null) return null;
    return Math.max(0, (Date.now() - ts) / 60000);
  }
  function relativeStamp(ms) {
    if (ms == null) return 'no record';
    const m = (Date.now() - ms) / 60000;
    if (m < 1)   return 'just now';
    if (m < 60)  return `${Math.round(m)} min ago`;
    if (m < 60*24) {
      const h = m / 60;
      return `${h < 10 ? h.toFixed(1) : Math.round(h)} h ago`;
    }
    const d = m / 60 / 24;
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} days ago`;
  }
  function statusBucket(minSince) {
    if (minSince == null) return 'null';
    return minSince < FRESH_MINUTES ? 'fresh' : 'stale';
  }
  // Expected elements whose value is null in the station's latest record.
  // [] when either the element list or the record is unknown — callers that
  // need to tell "unknown" from "all present" check elementsById.has(id).
  const _warnedLabels = new Set();
  function missingElements(stationId) {
    const rec = latestRecordById.get(stationId);
    const els = elementsById.get(stationId);
    if (!rec || !els) return [];
    return els.filter((el) => {
      const k = _wideKeyByLabel.get(el.label);
      if (k == null) {
        // Verified never to happen for the current API; if it does, the
        // element can't be checked, so it reads as missing — say so once.
        if (!_warnedLabels.has(el.label)) {
          _warnedLabels.add(el.label);
          console.warn(`No /latest/ column for element "${el.label}" (${el.code})`);
        }
        return true;
      }
      return rec[k] == null;
    });
  }
  // ── Known (flagged) outages ──────────────────────────────────────────
  // An element's `outages` (from /elements/?all=true) lists every open
  // registration behind it as {sn, ranges}; each range is an AirTable window
  // of whole America/Denver days, [start] (ongoing) or [start, end],
  // inclusive. `outages` is null when the API didn't say (per-station
  // fallback, or an API without the column): unknown, so the sensor counts
  // as a new outage, as before outage flags existed.
  //
  // Active today (MT): ISO date strings compare in date order.
  function windowActive(range, today) {
    const [start, end] = range;
    return typeof start === 'string' && start <= today && (end == null || end >= today);
  }
  // The date an element became a known outage, or null if it isn't one.
  // EVERY registration must be inside an active window: at a dual-chain depth
  // with one chain flagged, the other chain still reports into the combined
  // element, so a null there is news. Since = the latest of the chains'
  // window starts (the day the last chain was flagged).
  function knownOutageSince(el, today = MCO.todayMT()) {
    if (!Array.isArray(el.outages) || !el.outages.length) return null;
    let since = null;
    for (const d of el.outages) {
      const active = (d.ranges || []).filter((r) => windowActive(r, today));
      if (!active.length) return null;
      const start = active.map((r) => r[0]).sort()[0];
      if (since == null || start > since) since = start;
    }
    return since;
  }
  // The station's silent sensors, split: `emergent` (no flag: news) first,
  // then `known` (each with .since, an ISO date).
  function splitMissing(stationId) {
    const today = MCO.todayMT();
    const emergent = [], known = [];
    for (const el of missingElements(stationId)) {
      const since = knownOutageSince(el, today);
      if (since) known.push({ ...el, since }); else emergent.push(el);
    }
    return { emergent, known };
  }
  // Health class: outage when there's no fresh record; otherwise partial if
  // any silent sensor is unflagged, known if every silent sensor is a flagged
  // outage. A station whose element list hasn't loaded (or failed) reads as
  // operational — the legend note keeps that visible.
  function healthKey(stationId, minSince) {
    if (minSince == null || minSince >= FRESH_MINUTES) return 'outage';
    if (!elementsById.has(stationId)) return 'operational';
    const { emergent, known } = splitMissing(stationId);
    return emergent.length ? 'partial' : known.length ? 'known' : 'operational';
  }
  // Discrete bin index for time-since mode: '0'..'4' (status-age's keys), or
  // 'null'. Strings, so the same value type covers both modes in URL params +
  // filters.
  function timeBinKey(minSince) {
    if (minSince == null) return 'null';
    let i = 0;
    while (i < TIME_BIN_MAX.length - 1 && minSince >= TIME_BIN_MAX[i]) i++;
    return String(i);
  }

  // ── State ────────────────────────────────────────────────────────────────
  let stations    = [];                       // raw /api/stations response
  let latestById  = new Map();                // station id → datetime ms
  let latestRecordById = new Map();           // station id → full wide /latest/ record
  let stationById = new Map();                // station id → meta object
  // Health-mode inputs. elementsById holds the expected sensors per station
  // (deduped, sorted by sort_order); a station absent from it is "not loaded
  // yet" — elementsFailed tells that apart from "fetch failed this session".
  let elementsById   = new Map();             // station id → [{code, label, outages}]
  let elementsFetchedAt = new Map();          // station id → ms the list was fetched
  let elementsFailed = new Set();
  let _elementsProgress = { done: 0, total: 0, loading: false };
  // description_short → wide-record key ("Soil VWC @ -91 cm" → "Soil VWC @ -91 cm [%]").
  // Wide keys are the union across stations, so one record's keys suffice;
  // rebuilt per /latest/ payload so the 30 s tick never scans strings.
  let _wideKeyByLabel = new Map();
  // Colocated sites: one marker with a count badge and a spider
  // (MCO.map.colocation, kit 0.21.0), created with the map in initMap.
  let coloc = null;
  let _mapReady = false;
  // Cached static overlay FeatureCollections — fetched once, reused across
  // every setStyle() (the source is re-added but data stays in memory).
  let _tribalFC   = null;
  let _stateFC    = null;
  let _countiesFC = null;
  async function preloadOverlay(sourceId, url, save) {
    try {
      const fc = await MCO.fetchJSON(url);
      save(fc);
      // If the source still has the URL data (initial load), swap to the
      // in-memory copy so subsequent re-adds don't refetch.
      const src = map.getSource(sourceId);
      if (src) src.setData(fc);
    } catch { /* overlays are decorative — silent failure is fine */ }
  }

  // ── URL state ────────────────────────────────────────────────────────────
  // URL params take precedence over localStorage take precedence over defaults.
  // All values are validated (never trust persisted state either — another MCO
  // app, or an old version of this one, shares the origin).
  const getLower = (key) => MCO.getParamLower(key, urlParams);

  // Single-character shortcuts can misfire for speech-input users — WCAG 2.1.4
  // wants an off switch. Re-emitted on writeUrl so the preference sticks
  // across navigation, but deliberately a URL param (not localStorage): it's
  // the sharer's input preference, not part of the view.
  const kbdShortcuts = getLower('kbd') !== 'off';

  // Lowercase → canonical lookup for the two known sub-networks. (The API uses
  // mixed-case strings; URL params are lowercase.)
  const KNOWN_NETWORKS = ['HydroMet', 'AgriMet'];
  const networkByLowerName = new Map(KNOWN_NETWORKS.map(n => [n.toLowerCase(), n]));

  // Mode ids double as URL/localStorage values; MODES (below) is the whitelist.
  const MODE_IDS = ['status', 'timesince', 'health'];
  let activeMode = (() => {
    const u = getLower('mode');
    if (MODE_IDS.includes(u)) return u;
    const saved = MCO.lsGet('mco-status-mode');
    return MODE_IDS.includes(saved) ? saved : 'status';
  })();

  let activeNetworks = (() => {
    const tokens = MCO.splitTokens(urlParams.get('net'));
    if (tokens !== null) {
      return new Set(tokens.map(t => networkByLowerName.get(t)).filter(Boolean));
    }
    try {
      const saved = JSON.parse(MCO.lsGet('mco-status-networks') || 'null');
      if (Array.isArray(saved)) {
        // Re-validate persisted values exactly like URL params.
        return new Set(saved.map(t => networkByLowerName.get(String(t).toLowerCase())).filter(Boolean));
      }
    } catch {}
    return new Set();
  })();

  const _initLng    = parseFloat(urlParams.get('lng'));
  const _initLat    = parseFloat(urlParams.get('lat'));
  const _initZoom   = parseFloat(urlParams.get('zoom'));
  const _hasInitPos = Number.isFinite(_initLng) && Number.isFinite(_initLat) && Number.isFinite(_initZoom);
  // Station IDs in the API are already lowercase; normalize the URL param too.
  const _initStation = getLower('station');

  // ── Legend category visibility (Plotly-style toggles) ────────────────────
  // Each mode has its own visible-category set. Missing URL param = all visible.
  const ALL_STATUS_CATS = ['fresh', 'stale', 'null'];
  const ALL_TIME_CATS   = ['0', '1', '2', '3', '4', 'null'];
  // No 'null' in health: a station with no record IS a total outage.
  const ALL_HEALTH_CATS = HEALTH_CLASSES.map(c => c.key);
  function parseCatSet(urlKey, allKeys) {
    const tokens = MCO.splitTokens(urlParams.get(urlKey));
    if (tokens === null) return new Set(allKeys);
    const set = new Set(tokens.filter(k => allKeys.includes(k)));
    return set.size ? set : new Set();   // an explicit empty list = nothing visible
  }
  // One row per mode: its category universe, the live visible set, the
  // feature property the layer filter reads, and the URL param that mirrors
  // the set. Adding a mode is adding a row.
  const MODES = {
    status:    { all: ALL_STATUS_CATS, cats: parseCatSet('scat', ALL_STATUS_CATS), prop: 'staleStatus', param: 'scat', title: 'Reporting status' },
    timesince: { all: ALL_TIME_CATS,   cats: parseCatSet('tcat', ALL_TIME_CATS),   prop: 'timeBinKey',  param: 'tcat', title: 'Time since last record' },
    health:    { all: ALL_HEALTH_CATS, cats: parseCatSet('hcat', ALL_HEALTH_CATS), prop: 'healthKey',   param: 'hcat', title: 'Station health' },
  };
  function currentCats()    { return MODES[activeMode].cats; }
  function currentAllCats() { return MODES[activeMode].all; }
  function currentCatKey()  { return MODES[activeMode].prop; }

  let _selectedStation = _initStation;

  // ── Map init ─────────────────────────────────────────────────────────────
  // MapLibre 6 is an ES module that mco-map.js imports on demand, so the map
  // is created in initMap() once MCO.map.loadMapLibre() resolves (Boot, at the
  // bottom). Everything else is wired first and never waits on the map; code
  // that can run before it exists checks `map` (null until then).
  let map = null;
  let zoomFloor = null;
  function initMap(maplibregl) {
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: MCO.map.cartoStyleUrl(),
        ...MCO.map.initialCamera(urlParams),
      });
    } catch (err) {
      // MapLibre 6 requires WebGL2 (GPUInitializationError otherwise).
      onMapFail(err);
      return;
    }
    MCO.map.addNavigation(map);                                     // top-left (kit 1.0.0), no compass
    MCO.map.addFitControl(map, { onBeforeFit: () => coloc && coloc.close() });
    zoomFloor = MCO.map.installZoomFloor(map);                      // snapback + resize refit
    // The legend clears the attribution (index.html #legend): publish the
    // bottom-right control box's height, re-measured whenever it wraps,
    // expands or collapses to its ⓘ.
    MCO.metrics.observe('--attrib-h', map.getContainer().querySelector('.maplibregl-ctrl-bottom-right'));
    // A basemap style that 404s or hangs used to leave 'load' unfired and the
    // app empty. The kit retries it, then falls back to a blank style (which
    // does load, so the overlays and dots still draw on style.load) with a
    // Retry notice (kit 0.8.0). styleUrl is read at retry time (theme).
    MCO.map.watchBasemap(map, { styleUrl: MCO.map.cartoStyleUrl });
    // Colocated sites (kit 0.21.0): stations whose lat/lon agree to 4
    // decimals are one marker, the best-ranked visible member (HydroMet
    // first), with a count badge; hover (or a first tap) fans the rest out
    // around it, with a 250 ms grace to reach a foot. The kit owns the
    // grouping, the spider sources and the hover / click / Esc behavior;
    // this app keeps its source, properties, paints and sheet. Hidden
    // networks are left out of the source, so hiding one turns a pair into
    // a plain dot.
    coloc = MCO.map.colocation(map, {
      source: 'stations',
      rank: (s) => netRank(s.sub_network),
      visible: isShown,
      properties: stationProps,
      anchorLayers: ['stations-hit', 'stations-layer', 'stations-badge', 'stations-badge-disc', 'stations-id-label'],
      spiderLayers: ['spider-hit', 'spider-layer', 'spider-id-label'],
      onSelect: (id) => openStation(id, { push: true, opener: map.getCanvas() }),
      onEmpty: () => closeDetail(),
    });
    wireMapEvents();
    wireMapHover();
  }
  function onMapFail(err) {
    console.error(err);
    const msg = err && err.name === 'GPUInitializationError'
      ? 'The map needs WebGL2, which this browser does not provide.'
      : 'The map library failed to load.';
    MCO.notice({ tone: 'danger', text: `${msg} Reload the page to try again.` });
    MCO.ready();
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  MCO.initThemeToggle({
    button: document.getElementById('btn-theme'),
    iconSun: document.getElementById('icon-sun'),
    iconMoon: document.getElementById('icon-moon'),
    // Kit 0.10.0: dark → light → high contrast, so high contrast is reachable
    // from the page (it was ?theme= / storage only). The label names the next.
    cycle: true,
    iconContrast: document.getElementById('icon-contrast'),
  });
  // Any theme change (this toggle or anything else calling MCO.setTheme) —
  // kit 0.9.0's mco:themechange. Our layers come back on style.load
  // (wireMapEvents), every time.
  document.addEventListener('mco:themechange', () => {
    if (map) map.setStyle(MCO.map.cartoStyleUrl());
    writeUrl();
  });

  function addCustomLayers() {
    // The CARTO basemaps draw their own dashed county boundaries from z9
    // (layer 'boundary_county') — hide them so our kit-styled counties are
    // the single treatment at every zoom (HOUSE-STYLE §7).
    if (map.getLayer('boundary_county')) {
      map.setLayoutProperty('boundary_county', 'visibility', 'none');
    }

    // Topography first: themed igor hillshade, inserted beneath the basemap's
    // place labels by the kit (HOUSE-STYLE §7 layer order).
    MCO.map.addHillshade(map);

    if (!map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: emptyFC() });
    }
    coloc.addSources();   // the kit's spider feet + connector lines
    // Static overlay data (counties + reservations + state outline): fetched
    // once on first load, then reused across setStyle() so theme toggle
    // doesn't refetch.
    if (!map.getSource('counties')) {
      map.addSource('counties', {
        type: 'geojson',
        data: _countiesFC || 'data/mt_counties_simple.geojson',
      });
    }
    if (!map.getSource('tribal')) {
      map.addSource('tribal', {
        type: 'geojson',
        data: _tribalFC || 'data/mt_reservations_simple.geojson',
      });
    }
    if (!map.getSource('state')) {
      map.addSource('state', {
        type: 'geojson',
        data: _stateFC || 'data/mt_state_simple.geojson',
      });
    }
    if (!_countiesFC) preloadOverlay('counties', 'data/mt_counties_simple.geojson', fc => _countiesFC = fc);
    if (!_tribalFC)   preloadOverlay('tribal',   'data/mt_reservations_simple.geojson', fc => _tribalFC = fc);
    if (!_stateFC)    preloadOverlay('state',    'data/mt_state_simple.geojson',        fc => _stateFC  = fc);

    const paints = MCO.map.overlayPaints();

    // Faint county lines under everything else; tribal fill + outline below
    // all station layers so the dots always read as primary. The matching
    // tribal label layer is added last (on top).
    if (!map.getLayer('counties-line')) {
      map.addLayer({
        id: 'counties-line', type: 'line', source: 'counties',
        paint: paints.countiesLine,
      });
    }
    if (!map.getLayer('tribal-fill')) {
      map.addLayer({
        id: 'tribal-fill', type: 'fill', source: 'tribal',
        paint: paints.tribalFill,
      });
    }
    if (!map.getLayer('tribal-line')) {
      map.addLayer({
        id: 'tribal-line', type: 'line', source: 'tribal',
        paint: paints.tribalLine,
      });
    }
    // Montana state boundary — heavier line so the state shape reads as the
    // dominant frame. No fill (the basemap already provides context). Sits
    // above tribal so it's the strongest boundary, below stations so dots win.
    if (!map.getLayer('state-line')) {
      map.addLayer({
        id: 'state-line', type: 'line', source: 'state',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: paints.stateLine,
      });
    }

    // Station layers. Every station is one MCO.map.stationPaint circle
    // (kit 0.21.0: no network encoding); the fill is the mode's category.
    // Anchors only on the main source (colocation.ANCHOR_ONLY, folded into
    // the category filter by applyAllFilters); the spider source carries
    // the fanned-out feet. The *-hit layers are the invisible ≥ 22px tap
    // targets, the *-selected layers the open station's ring.
    const A = MCO.map.colocation.ANCHOR_ONLY;
    const NONE = ['==', ['get', 'station'], ''];
    const stationLayers = [
      { id: 'spider-lines-layer', type: 'line', source: coloc.spiderLinesSource,
        paint: MCO.map.colocation.spiderLinePaint() },
      { id: 'stations-hit', type: 'circle', source: 'stations', filter: A, paint: MCO.map.hitPaint() },
      { id: 'stations-layer', type: 'circle', source: 'stations', filter: A, paint: stationPaint() },
      { id: 'stations-selected', type: 'circle', source: 'stations', filter: NONE, paint: MCO.map.selectionPaint() },
      ...MCO.map.colocation.badgeLayers({ id: 'stations-badge', source: 'stations' }),
      { id: 'stations-id-label', type: 'symbol', source: 'stations', filter: A, minzoom: LABEL_MINZOOM,
        layout: stationLabelLayout(), paint: stationLabelPaint() },
      { id: 'spider-hit', type: 'circle', source: coloc.spiderSource, paint: MCO.map.hitPaint() },
      { id: 'spider-layer', type: 'circle', source: coloc.spiderSource, paint: stationPaint() },
      { id: 'spider-selected', type: 'circle', source: coloc.spiderSource, filter: NONE, paint: MCO.map.selectionPaint() },
      { id: 'spider-id-label', type: 'symbol', source: coloc.spiderSource,
        layout: stationLabelLayout(), paint: stationLabelPaint() },
    ];
    for (const l of stationLayers) if (!map.getLayer(l.id)) map.addLayer(l);

    // Reservation name labels — drawn last so they sit above station dots.
    // Minzoom keeps the map uncluttered at state-extent zoom.
    if (!map.getLayer('tribal-label')) {
      map.addLayer({
        id: 'tribal-label', type: 'symbol', source: 'tribal',
        minzoom: TRIBAL_LABEL_MINZOOM,
        layout: MCO.map.TRIBAL_LABEL_LAYOUT,
        paint: paints.tribalLabelPaint,
      });
    }

    applyAllFilters();
    refreshDotColors();
    applyLabelsVisibility();
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // ── Paint expression generators ──────────────────────────────────────────
  // The mode's category color, from the role registry (read now: per theme).
  // "No record" is not in the sets: it is drawn hollow (stationPaint).
  const CLEAR = 'rgba(0,0,0,0)';
  function paintColorForMode(mode) {
    const set = catSet(SET_FOR_MODE[mode]);
    if (mode === 'health') {
      // Categorical: healthKey is computed in JS at emit time (it needs the
      // element lists), so no time math in the expression.
      return ['match', ['get', 'healthKey'], ...set.flatMap(c => [c.key, c.color]), set[set.length - 1].color];
    }
    if (mode === 'status') {
      return ['case',
        ['==', ['get', 'minutesSince'], null], CLEAR,
        ['<',  ['get', 'minutesSince'], FRESH_MINUTES], set[0].color,
        set[1].color,
      ];
    }
    // time-since 5-bin step
    return ['case',
      ['==', ['get', 'minutesSince'], null], CLEAR,
      ['step', ['get', 'minutesSince'],
        set[0].color,                     // < FRESH_MINUTES
        TIME_BIN_MAX[0], set[1].color,    // FRESH_MINUTES+
        TIME_BIN_MAX[1], set[2].color,    // 180+
        TIME_BIN_MAX[2], set[3].color,    // 360+
        TIME_BIN_MAX[3], set[4].color,    // 1440+
      ],
    ];
  }

  // Station markers (HOUSE-STYLE §7, kit 0.21.0): no network encoding.
  // Every station is the kit's one circle, MCO.map.stationPaint, with a
  // --dot-stroke edge and the mode's category as the fill; HydroMet and
  // AgriMet draw the same (the network is the chips and the detail text).
  // No record = no fill: a 2px --dot-stroke ring (the same edge contrast
  // every dot has, so ≥ 3:1 on both basemaps), as the legend's hollow
  // swatch shows. Health mode has no "no record": a station that never
  // reported is an outage.
  const NO_RECORD = ['==', ['get', 'minutesSince'], null];
  const hasNoRecordMode = (mode) => mode !== 'health';
  function stationPaint() {
    const hollow = hasNoRecordMode(activeMode);
    return MCO.map.stationPaint({
      fill: paintColorForMode(activeMode),
      strokeWidth: hollow ? ['case', NO_RECORD, 2, 1.2] : 1.2,
    });
  }

  function stationLabelLayout() {
    return {
      'text-field': ['get', 'station'],
      'text-font':  ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size':  [
        'interpolate', ['linear'], ['zoom'],
        6,  9,
        10, 11,
        14, 12,
      ],
      // Try anchor positions in order until one fits without colliding.
      'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
      'text-padding': 2,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-optional': true,    // hide rather than show colliding labels
    };
  }
  function stationLabelPaint() {
    // Text over halo mirrors the theme's primary-on-deep pair (≥10:1 both
    // themes); on high-contrast the dark values apply and clear easily.
    const dark = document.documentElement.dataset.theme !== 'light';
    return {
      'text-color':      dark ? '#e8ecf0' : '#1a1a2e',
      'text-halo-color': dark ? '#161b22' : '#ffffff',
      'text-halo-width': 1.4,
      'text-halo-blur':  0.4,
    };
  }

  // Re-apply theme-derived paints in place (mode switch / repaint tick —
  // theme switches go through addCustomLayers instead, since setStyle wipes
  // every layer anyway).
  function refreshOverlayPaints() {
    const paints = MCO.map.overlayPaints();
    if (map.getLayer('counties-line')) {
      map.setPaintProperty('counties-line', 'line-color', paints.countiesLine['line-color']);
    }
    if (map.getLayer('tribal-fill')) {
      map.setPaintProperty('tribal-fill', 'fill-color',   paints.tribalFill['fill-color']);
      map.setPaintProperty('tribal-fill', 'fill-opacity', paints.tribalFill['fill-opacity']);
      map.setPaintProperty('tribal-line', 'line-color',   paints.tribalLine['line-color']);
      map.setPaintProperty('tribal-line', 'line-opacity', paints.tribalLine['line-opacity']);
    }
    if (map.getLayer('tribal-label')) {
      map.setPaintProperty('tribal-label', 'text-color',      paints.tribalLabelPaint['text-color']);
      map.setPaintProperty('tribal-label', 'text-halo-color', paints.tribalLabelPaint['text-halo-color']);
    }
    if (map.getLayer('state-line')) {
      map.setPaintProperty('state-line', 'line-color',   paints.stateLine['line-color']);
      map.setPaintProperty('state-line', 'line-opacity', paints.stateLine['line-opacity']);
    }
  }
  function refreshLabelPaint() {
    const p = stationLabelPaint();
    for (const lid of ['stations-id-label', 'spider-id-label']) {
      if (!map.getLayer(lid)) continue;
      map.setPaintProperty(lid, 'text-color',      p['text-color']);
      map.setPaintProperty(lid, 'text-halo-color', p['text-halo-color']);
    }
  }

  function refreshDotColors() {
    if (!map || !map.getLayer('stations-layer')) return;
    // Mode and theme both feed the marker paint (the category set is per
    // theme, the edge is --dot-stroke).
    const paint = stationPaint();
    for (const lid of ['stations-layer', 'spider-layer']) {
      for (const k of ['circle-color', 'circle-stroke-color', 'circle-stroke-width']) {
        map.setPaintProperty(lid, k, paint[k]);
      }
    }
    refreshLabelPaint();
    refreshOverlayPaints();
    renderLegend();
  }

  // ── Data fetch ───────────────────────────────────────────────────────────
  // MCO.fetchJSON: 60 s AbortSignal timeout; cache:'no-store' because this is
  // a polling app — a cached /latest/ defeats the whole point.
  async function loadAll() {
    try {
      const [st, latest] = await Promise.all([
        MCO.fetchJSON(STATIONS_URL, { cache: 'no-store' }),
        MCO.fetchJSON(LATEST_URL,   { cache: 'no-store' }),
      ]);
      stations = st;
      ingestLatest(latest);
      indexStations();
      // Seed element lists from the localStorage cache BEFORE the first
      // rebuild so a warm cache paints health on the first frame; the
      // network fill for missing/expired stations streams in afterwards.
      loadElements();
      buildFilterUI();
      searchBox.refresh();
      rebuildSource();
      applyAllFilters();   // re-apply now that activeNetworks is populated
      refreshStamp();
      // Deep-link from ?station=… in URL. loadAll() is only called from the
      // map's first style.load, so _mapReady is always true here. It always
      // opens the sheet (MCO.map.flyToAndOpen), replacing this entry: the
      // page's own entry is never history.back()'d off the site.
      if (_initStation && stationById.has(_initStation)) {
        goTo(_initStation, { keepCamera: _hasInitPos });
      } else {
        if (_initStation) {
          _selectedStation = null;
          MCO.showToast(`No station "${_initStation}"`);
        }
        // Push initial URL so it's clean even if the user hasn't interacted yet
        writeUrl();
      }
      // First meaningful state: stations drawn, URL state applied. Releases the
      // anti-flash snippet's mco-booting hold (kit 0.9.0; it times out at 3 s
      // regardless).
      MCO.ready();
    } catch (err) {
      console.error(err);
      MCO.showToast(`Error loading data: ${err.message}`);
      MCO.ready();
    }
    // The first-visit intro, once the page has settled (kit rules: never
    // over a deep link, never once the visitor has moved focus).
    infoDialog.intro();
  }

  async function refreshLatest() {
    try {
      const latest = await MCO.fetchJSON(LATEST_URL, { cache: 'no-store' });
      ingestLatest(latest);
      // Retry any element lists that failed earlier (no-op when all loaded).
      loadElements();
      rebuildSource();
      refreshStamp();
    } catch (err) {
      console.error(err);
      MCO.showToast(`Refresh failed: ${err.message}`);
    }
  }

  // Merge rather than replace: the Mesonet /api/latest/ endpoint drops a
  // (different) station from each call ~once per poll. Without a merge,
  // those stations would flicker to "no record" until the next poll
  // happened to include them. With a merge, a station's last-known
  // record persists; if it's truly gone silent, the timestamp just ages
  // into the very-stale bin (and Health's outage class) on its own.
  function ingestLatest(latest) {
    for (const r of latest) {
      latestById.set(r.station, r.datetime);
      latestRecordById.set(r.station, r);
    }
    // Wide keys are the union of every station's columns, so any one record
    // carries them all. Map each element label to its "<label> [unit]" key.
    if (latest.length) {
      const keys = Object.keys(latest[0]);
      const byLabel = new Map();
      for (const k of keys) {
        const i = k.lastIndexOf(' [');
        if (i > 0 && !byLabel.has(k.slice(0, i))) byLabel.set(k.slice(0, i), k);
      }
      _wideKeyByLabel = byLabel;
    }
  }

  // ── Expected element lists (Health mode) ─────────────────────────────────
  // Cache shape: { v: 2, byStation: { [id]: { t: fetchedMs, els: [[code, label, outages], …] } } }
  // — arrays, not objects, keep ~245 stations small on the github.io origin
  // this app shares with other MCO apps. `outages` is [[sn, ranges], …], or
  // null when the source didn't carry the windows (see knownOutageSince).
  // Per-station timestamps so a re-instrumented station expires alone.
  function readElementsCache() {
    try {
      const raw = MCO.lsGet(ELEMENTS_CACHE_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      if (!obj || obj.v !== 2 || typeof obj.byStation !== 'object') return {};
      return obj.byStation;
    } catch { return {}; }
  }
  function writeElementsCache(byStation) {
    MCO.lsSet(ELEMENTS_CACHE_KEY, JSON.stringify({ v: 2, byStation }));
  }
  const packEls = (els) => els.map((e) => [e.code, e.label,
    Array.isArray(e.outages) ? e.outages.map((d) => [d.sn, d.ranges]) : null]);
  const unpackEls = (rows) => rows.map(([code, label, o]) => ({ code, label,
    outages: Array.isArray(o) ? o.map(([sn, ranges]) => ({ sn, ranges })) : null }));
  // A list that carries outage windows goes stale with AirTable; one that
  // doesn't only with re-instrumentation.
  const hasOutageInfo = (els) => els.length > 0 && els.every((e) => Array.isArray(e.outages));
  const elementsTtl = (els) => hasOutageInfo(els) ? OUTAGES_TTL_MS : ELEMENTS_TTL_MS;
  function elementsExpired(id, now) {
    const t = elementsFetchedAt.get(id);
    return t == null || now - t > elementsTtl(elementsById.get(id) || []);
  }
  function setElements(stationId, els, t = Date.now()) {
    elementsById.set(stationId, els);
    elementsFetchedAt.set(stationId, t);
    elementsFailed.delete(stationId);
  }
  // Dedupe (the endpoint repeats rows), sort by the API's display order. A
  // row's `outages` ([{serial_number, ranges}], bulk listing only) is kept as
  // [{sn, ranges}]; without it, null (unknown).
  function normalizeElements(rows) {
    const byCode = new Map();
    for (const r of rows) {
      if (!r || typeof r.element !== 'string' || typeof r.description_short !== 'string') continue;
      if (byCode.has(r.element)) continue;
      const outages = Array.isArray(r.outages)
        ? r.outages.map((d) => ({
          sn: d && d.serial_number != null ? String(d.serial_number) : null,
          ranges: Array.isArray(d && d.ranges) ? d.ranges.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : [],
        }))
        : null;
      byCode.set(r.element, { code: r.element, label: r.description_short, order: r.sort_order ?? 0, outages });
    }
    return [...byCode.values()]
      .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
      .map(({ code, label, outages }) => ({ code, label, outages }));
  }

  // Run `fn` over `items` with at most `limit` in flight. No library: a shared
  // cursor and Math.min(limit, n) async workers.
  async function mapLimit(items, limit, fn) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  let _elementsInFlight = false;
  let _elementsAnnounced = false;
  async function loadElements() {
    if (_elementsInFlight) return;
    const cache = readElementsCache();
    const now = Date.now();
    // 1. Seed from cache synchronously (fresh entries only).
    for (const s of stations) {
      const entry = cache[s.station];
      if (!entry || !Array.isArray(entry.els) || elementsById.has(s.station)) continue;
      const els = unpackEls(entry.els);
      if (now - (entry.t || 0) > elementsTtl(els)) continue;
      setElements(s.station, els, entry.t);
    }
    // 2. Fetch whatever is missing or expired. An expired list stays on the
    // map until its replacement lands (refreshLatest calls this every 5 min).
    const firstLoad = !_elementsAnnounced;
    let needed = stations.map(s => s.station).filter(id => elementsExpired(id, now));
    _elementsProgress = { done: 0, total: needed.length, loading: needed.length > 0 };
    // Only the first load shows progress: an hourly refresh is one request.
    if (!firstLoad) _elementsProgress.loading = false;
    renderLegendNote();
    if (!needed.length) return;

    _elementsInFlight = true;
    const failedBefore = elementsFailed.size;
    let sinceWrite = 0;
    try {
      // 2a. One bulk request for the whole network. Every station the bulk
      // listing knows about is filled from it (a station absent from the
      // listing carries no open deployments → empty list, not a failure).
      // Anything that isn't a bulk payload falls through to per-station.
      const bulk = await loadElementsBulk();
      if (bulk) {
        const t = Date.now();
        for (const id of needed) {
          const els = bulk.get(id) || [];
          setElements(id, els, t);
          cache[id] = { t, els: packEls(els) };
        }
        _elementsProgress.done = needed.length;
        needed = [];
        renderLegendNote();
        scheduleHealthRefresh();
      }

      // 2b. Per-station fallback (older API, or the bulk request failed).
      await mapLimit(needed, ELEMENTS_CONCURRENCY, async (id) => {
        try {
          const rows = await MCO.fetchJSON(ELEMENTS_URL(id), { timeoutMs: ELEMENTS_TIMEOUT_MS });
          const els = normalizeElements(Array.isArray(rows) ? rows : []);
          const t = Date.now();
          setElements(id, els, t);
          cache[id] = { t, els: packEls(els) };
          if (++sinceWrite >= ELEMENTS_PERSIST_EVERY) { sinceWrite = 0; writeElementsCache(cache); }
        } catch (err) {
          elementsFailed.add(id);
          console.warn(`elements/${id} failed:`, err.message);
        }
        _elementsProgress.done++;
        if (firstLoad) renderLegendNote();   // cheap text update per completion
        scheduleHealthRefresh();      // coalesced dot/count rebuild
      });
    } finally {
      _elementsInFlight = false;
      _elementsProgress.loading = false;
      writeElementsCache(cache);
      scheduleHealthRefresh();
      const failed = elementsFailed.size;
      if (failed && failed !== failedBefore) {
        MCO.showToast(`Sensor lists unavailable for ${failed} station${failed === 1 ? '' : 's'}`, 6000);
      }
      renderLegendNote();
      // Once per page: the hourly refresh would otherwise chatter.
      if (firstLoad) {
        _elementsAnnounced = true;
        const c = countHealth();
        const n = (k) => `${c[k]} station${c[k] === 1 ? '' : 's'}`;
        MCO.announce(`Sensor check complete: ${n('partial')} with new sensor outages, ${n('known')} with only known outages.`);
      }
    }
  }

  // GET /elements/?all=true → Map<station, [{code,label,outages}]>, or null when the
  // response isn't the bulk shape (older API ignores the flag and returns the
  // catalog without a `station` column) or the request fails.
  async function loadElementsBulk() {
    try {
      const rows = await MCO.fetchJSON(ELEMENTS_ALL_URL, { timeoutMs: ELEMENTS_TIMEOUT_MS });
      if (!Array.isArray(rows) || !rows.length || typeof rows[0].station !== 'string') return null;
      const byStation = new Map();
      for (const r of rows) {
        let arr = byStation.get(r.station);
        if (!arr) { arr = []; byStation.set(r.station, arr); }
        arr.push(r);
      }
      for (const [id, arr] of byStation) byStation.set(id, normalizeElements(arr));
      return byStation;
    } catch (err) {
      console.warn('elements?all=true unavailable, falling back per station:', err.message);
      return null;
    }
  }

  // Batches of element lists land many times a second while loading; rebuild
  // the source (dots, counts, SR table) at most every 500 ms, and refresh an
  // open popup so its sensor list isn't stale.
  let _healthRefreshTimer = null;
  function scheduleHealthRefresh() {
    if (_healthRefreshTimer) return;
    _healthRefreshTimer = setTimeout(() => {
      _healthRefreshTimer = null;
      rebuildSource();
      if (_sheetFor) fillSheet(_sheetFor);
    }, HEALTH_REFRESH_DEBOUNCE_MS);
  }

  // The freshness stamp (kit 0.21.0, HOUSE-STYLE §4): "Updated 9:40 PM MST",
  // with the date when it isn't today in Mountain Time, built by
  // MCO.formatUpdatedMT into the text span (the kit hides the word visually
  // at ≤ 1400px; AT still reads it). The time is the DATA's: the newest
  // record in the store. A record stamped more than 10 min ahead of this
  // clock is a logger fault, not news, so it doesn't count. No record at all
  // falls back to the fetch time.
  function refreshStamp() {
    const limit = Date.now() + 10 * 60000;
    let newest = null;
    for (const ts of latestById.values()) {
      if (Number.isFinite(ts) && ts <= limit && (newest == null || ts > newest)) newest = ts;
    }
    MCO.formatUpdatedMT(newest ?? Date.now(), { into: refreshStampEl });
  }

  // Network priority for choosing a colocated site's anchor (the kit breaks
  // ties by station id).
  const netRank = (s) => s === 'HydroMet' ? 0 : s === 'AgriMet' ? 1 : 99;

  // Metadata lookup (stations with a location only). Colocation (count,
  // anchor, index) is the kit's, regrouped on every rebuildSource() over the
  // visible networks, so disabling a network resolves a pair to a plain dot.
  function indexStations() {
    stationById.clear();
    for (const s of stations) {
      if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') continue;
      stationById.set(s.station, s);
    }
    // Initialize sub-network filter set if empty (no URL or localStorage value)
    const allNetworks = new Set(stations.map(s => s.sub_network).filter(Boolean));
    if (activeNetworks.size === 0) {
      activeNetworks = new Set(allNetworks);
    } else {
      for (const n of [...activeNetworks]) if (!allNetworks.has(n)) activeNetworks.delete(n);
      if (activeNetworks.size === 0) activeNetworks = new Set(allNetworks);
    }
  }

  // A station is on the map when its network is shown (one with no network
  // always is). The kit's colocation reads this as `visible`.
  function isShown(s) { return !s.sub_network || activeNetworks.has(s.sub_network); }
  // The shown stations: the map's, the table's and the counts' one list.
  function shownStations() { return stations.filter((s) => stationById.has(s.station) && isShown(s)); }
  // Feature properties for the stations source and the spider feet (the kit
  // adds colocationCount / colocationIndex / bucket / colocationId).
  function stationProps(s) {
    const ts   = latestById.get(s.station) ?? null;
    const mins = minutesSince(ts);
    return {
      station:      s.station,
      name:         s.name,
      sub_network:  s.sub_network,
      datetime:     ts,
      minutesSince: mins,
      staleStatus:  statusBucket(mins),
      timeBinKey:   timeBinKey(mins),
      healthKey:    healthKey(s.station, mins),
      missingCount: missingElements(s.station).length,
    };
  }

  // Re-emit the source: the kit regroups the sites over the visible
  // networks, writes the features and refreshes an open spider (its anchor
  // or membership may have just changed).
  function rebuildSource() {
    if (!map || !coloc || !map.getSource('stations')) return;
    coloc.setData(stations.filter((s) => stationById.has(s.station)));
    renderSRTable();
    refreshLegendCounts();
  }

  // Screen-reader table twin of the WebGL station layer (HOUSE-STYLE §5.2):
  // everything the dots encode, as text, rebuilt whenever the source is.
  // MCO.srTable (kit 0.8.0) owns the markup: caption with the row count, row
  // headers, the .sr-only wrapper, and a rebuild only when the content changed
  // (the 30 s repaint tick no longer replaces 245 identical rows).
  const srTwin = MCO.srTable({
    container: document.getElementById('sr-twin'),
    caption: 'Montana Mesonet stations currently shown on the map',
    rowKey: (r) => r.station,
    columns: [
      { key: 'label', label: 'Station', rowHeader: true },
      { key: 'net', label: 'Network' },
      { key: 'status', label: 'Status' },
      { key: 'when', label: 'Last report (Mountain Time)' },
      { key: 'health', label: 'Health' },
      { key: 'missing', label: 'Sensors not reporting (new)' },
      { key: 'known', label: 'Known outages (flagged)' },
      { key: 'site', label: 'Site' },
      { key: 'county', label: 'County' },
    ],
  });
  // The id is this app's hook (verify.config.mjs render evidence).
  srTwin.element.querySelector('table').id = 'sr-station-table';
  function renderSRTable() {
    const visible = shownStations().sort((a, b) => a.name.localeCompare(b.name));
    srTwin.render(visible.map((s) => {
      const ts = latestById.get(s.station) ?? null;
      const mins = minutesSince(ts);
      const bucket = statusBucket(mins);
      const { emergent, known } = splitMissing(s.station);
      return {
        station: s.station,
        label: `${s.name} (${s.station})`,
        net: s.sub_network,
        status: bucket === 'null' ? 'no record' : bucket === 'fresh' ? 'reporting' : 'stale',
        when: ts == null ? 'no record' : `${MCO.formatStampMT(ts)} (${relativeStamp(ts)})`,
        health: healthClass(healthKey(s.station, mins)).short,
        missing: emergent.length ? emergent.map(e => e.label).join(', ')
          : elementsById.has(s.station) ? null
          : elementsFailed.has(s.station) ? 'sensor list unavailable' : 'sensor list loading',
        known: known.length ? known.map(e => `${e.label} (since ${MCO.formatDateStr(e.since)})`).join(', ') : null,
        // The count badge, as text: the canvas spider is pointer-only.
        site: (() => {
          const n = (coloc && coloc.info(s.station) || { count: 1 }).count;
          return n > 1 ? `${n} stations at this site` : null;
        })(),
        county: s.county,
      };
    }), { selected: _selectedStation });
  }

  // ── Health bookkeeping ───────────────────────────────────────────────────
  // Counts run over the visible-network stations (shownStations), never
  // filtered by the legend toggles.
  function countHealth() {
    const counts = { operational: 0, known: 0, partial: 0, outage: 0, total: 0, unknown: 0, noFlags: 0 };
    for (const s of shownStations()) {
      const mins = minutesSince(latestById.get(s.station) ?? null);
      const key = healthKey(s.station, mins);
      counts[key]++;
      counts.total++;
      if (key === 'outage') continue;
      const els = elementsById.get(s.station);
      if (!els) counts.unknown++;
      else if (els.length && !hasOutageInfo(els)) counts.noFlags++;
    }
    return counts;
  }

  // Legend footer note, Health mode only: progress while element lists stream
  // in, then how many fresh stations lack a list (they count as operational)
  // or lack outage flags (an API without them: every silent sensor reads as
  // new, so say so rather than imply zero known outages).
  // Not aria-live — it'd chatter; the one-time completion goes to MCO.announce.
  function renderLegendNote() {
    const el = document.getElementById('legend-note');
    if (!el) return;
    let txt = '';
    if (activeMode === 'health' && stations.length) {
      if (_elementsProgress.loading) {
        txt = `Checking sensors… ${_elementsProgress.done}/${_elementsProgress.total}`;
      } else {
        const { unknown: u, noFlags: f } = countHealth();
        txt = [
          u ? `${u} station${u === 1 ? '' : 's'} without sensor list` : '',
          f ? `Outage flags unavailable for ${f} station${f === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');
      }
    }
    el.textContent = txt;
    el.hidden = !txt;
  }

  // ── Sub-network filter UI (chip toggles in navbar) ───────────────────────
  function buildFilterUI() {
    const allNetworks = [...new Set(stations.map(s => s.sub_network).filter(Boolean))].sort();
    const byNet = {};
    for (const s of stations) {
      if (!s.sub_network) continue;
      byNet[s.sub_network] = (byNet[s.sub_network] || 0) + 1;
    }
    subnetFiltersEl.innerHTML = '';
    for (const net of allNetworks) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mco-chip';
      chip.dataset.network = net;
      chip.setAttribute('aria-pressed', activeNetworks.has(net) ? 'true' : 'false');
      const lbl = document.createElement('span');
      lbl.textContent = net;
      const count = document.createElement('span');
      count.className = 'mco-chip-count';
      count.dataset.network = net;
      count.textContent = String(byNet[net] || 0);
      chip.appendChild(lbl);
      chip.appendChild(count);
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) activeNetworks.add(net);
        else    activeNetworks.delete(net);
        MCO.lsSet('mco-status-networks', JSON.stringify([...activeNetworks]));
        rebuildSource();   // re-emit source so colocation reflects visible networks
        applyAllFilters();
        writeUrl();
      });
      subnetFiltersEl.appendChild(chip);
    }
  }
  // Only the legend-category visibility filter is applied here. Sub-network
  // filtering happens at source-emit time (see rebuildSource), so hidden-network
  // features aren't even in the source — no layer filter needed.
  const catFilter = () => ['in', ['get', currentCatKey()], ['literal', [...currentCats()]]];
  // The open station's --selection-ring (kit selectionPaint): on its anchor
  // dot, or on its foot while the spider is open.
  function paintSelection() {
    if (!map) return;
    const sel = ['==', ['get', 'station'], _selectedStation || ''];
    if (map.getLayer('stations-selected')) {
      map.setFilter('stations-selected', ['all', MCO.map.colocation.ANCHOR_ONLY, catFilter(), sel]);
    }
    if (map.getLayer('spider-selected')) map.setFilter('spider-selected', ['all', catFilter(), sel]);
  }
  function applyAllFilters() {
    if (!map || !map.getLayer('stations-layer')) return;
    const catMatch = catFilter();
    const anchorOnly = ['all', MCO.map.colocation.ANCHOR_ONLY, catMatch];
    for (const lid of ['stations-hit', 'stations-layer', 'stations-id-label']) {
      if (map.getLayer(lid)) map.setFilter(lid, anchorOnly);
    }
    // The badge: stacked anchors only (the kit's filter), in a shown category.
    const badge = MCO.map.colocation.badgeFilter(catMatch);
    for (const lid of ['stations-badge', 'stations-badge-disc']) {
      if (map.getLayer(lid)) map.setFilter(lid, badge);
    }
    for (const lid of ['spider-hit', 'spider-layer', 'spider-id-label']) {
      if (map.getLayer(lid)) map.setFilter(lid, catMatch);
    }
    paintSelection();
    updateEmptyState();
  }

  // Show a small callout when current filter state hides everything, so the
  // user knows the empty map is intentional and how to recover.
  const emptyStateEl = document.getElementById('empty-state');
  function updateEmptyState() {
    if (!emptyStateEl || stations.length === 0) {
      if (emptyStateEl) emptyStateEl.hidden = true;
      return;
    }
    let msg = null;
    if (activeNetworks.size === 0) {
      msg = '<strong>No networks selected.</strong> Click HydroMet or AgriMet to show stations.';
    } else if (currentCats().size === 0) {
      msg = '<strong>All legend categories hidden.</strong> Click a legend row to show stations.';
    } else if (shownStations().length === 0) {
      msg = 'No stations match the current filters.';
    }
    if (msg) {
      emptyStateEl.innerHTML = `<div class="empty-state-card">${msg}</div>`;
      emptyStateEl.hidden = false;
    } else {
      emptyStateEl.hidden = true;
    }
  }

  // ── Search (kit combobox + flyTo + popup) ────────────────────────────────
  // MCO.initSearchBox (kit 0.8.0): the APG combobox — roles and aria-*, the
  // ranking (accent/typo-tolerant, id or name), Up/Down/Home/End/Enter/Esc,
  // and a polite result count. The app supplies the items and what a pick does.
  const SEARCH_MAX_RESULTS = 8;
  const searchBox = MCO.initSearchBox({
    input: searchInput,
    listbox: searchDropdown,
    label: 'Stations',
    limit: SEARCH_MAX_RESULTS,
    items: () => stations
      .filter((s) => stationById.has(s.station))
      .map((s) => ({ id: s.station, label: s.name, meta: `${s.station} · ${s.sub_network || '—'}` })),
    value: () => _selectedStation,
    onSelect: (id) => selectStation(id),
  });

  // ── Phone bar (kit 0.21.0 compact drawer) + landscape rail (1.0.0) ──────
  // data-rail="compact": on a portrait phone the bar is one row (badge ·
  // mode select · search · ☰) and ☰ opens the brand, controls and meta as a
  // right drawer; on a short landscape phone the bar is the 56px rail at the
  // right edge with the same drawer beside it. Either way, while the drawer is open the rest of
  // the page (and the rest of the bar) is inert, and Esc / the scrim / ☰
  // close it with focus back on the button that opened it. The bar's search
  // button opens the drawer on the field (the kit's search option).
  const railSearchBtn = document.getElementById('btn-rail-search');
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim: document.getElementById('nav-scrim'),
    search: { toggle: railSearchBtn, input: searchInput },
  });
  const inDrawer = () => rail.isRail() || rail.isDrawerMode();
  // The legend on a phone (kit 1.0.0, Kyle 2026-11-12): on compact the
  // floating legend moves into a "Legend" group at the end of the ☰ drawer,
  // and a small Legend button takes its corner on the map and opens the
  // drawer at it. Above compact it floats as before. The panel moves with
  // its collapse and row toggles.
  MCO.initLegendDrawer({ panel: document.getElementById('legend'), rail });
  // The info button sits in the drawer on a phone. The kit (1.0.0) keeps a
  // dialog opened from the open drawer usable and returns focus to the
  // button, so the drawer stays open under it.

  function selectStation(stationId) {
    // Picking from the drawer: close it and let the detail take focus; the
    // sheet hands focus back to the bar's search button when it closes.
    const opener = inDrawer() ? railSearchBtn : searchInput;
    if (rail.isOpen()) rail.close({ restoreFocus: false });
    else searchInput.blur();
    goTo(stationId, { push: true, opener });
  }

  // Search pick, ?station= deep link and Back/Forward all come through here.
  // MCO.map.flyToAndOpen (kit 0.21.0) re-enables a hidden network first,
  // opens at once if the station is already in view, and otherwise flies
  // (jumps under reduced motion) and opens once the map is idle with the
  // station in view. The old copy opened on the first `moveend`, which a
  // reduced-motion jump fires before the listener existed, so a deep link
  // zoomed and opened nothing. opts.push: a new history entry when this
  // opens a detail (writeUrl); opts.keepCamera: a deep link that names its
  // own camera, so don't zoom past it.
  function goTo(stationId, opts) {
    const s = stationById.get(stationId);
    if (!s) { MCO.showToast('Station not found'); return; }
    if (!map) return;
    if (coloc) coloc.close();
    MCO.map.flyToAndOpen(map, {
      center: [s.longitude, s.latitude],
      zoom: opts && opts.keepCamera ? map.getZoom() : SEARCH_FLY_ZOOM,
      speed: SEARCH_FLY_SPEED,
      ensureVisible: () => {
        if (!s.sub_network || activeNetworks.has(s.sub_network)) return;
        // Re-enable its sub-network so the user can see the dot.
        activeNetworks.add(s.sub_network);
        MCO.lsSet('mco-status-networks', JSON.stringify([...activeNetworks]));
        for (const chip of subnetFiltersEl.querySelectorAll('.mco-chip')) {
          if (chip.dataset.network === s.sub_network) chip.setAttribute('aria-pressed', 'true');
        }
        rebuildSource();
        applyAllFilters();
      },
      open: () => openStation(stationId, opts),
    });
  }

  // ── Station detail content ───────────────────────────────────────────────
  // Built with DOM APIs + textContent (HOUSE-STYLE §7): MCO.map.popupContent
  // (kit 0.8.0) gives the subtitle, .mco-facts list and action links (the
  // sheet's own <h2> carries the name); the network badge, category pills,
  // stamp, missing-sensor list and the other stations at the site are this
  // app's, inserted before the facts. Never setHTML of API strings.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // A category pill: the label in words on the category's color (index.html).
  const pill = (cls, label) => el('span', `pop-pill ${cls}`, label);
  function detailNode(stationId) {
    const s = stationById.get(stationId);
    if (!s) return document.createDocumentFragment();
    const ts = latestById.get(stationId) ?? null;
    const mins = minutesSince(ts);
    const status = statusBucket(mins);
    const pillLbl = status === 'fresh' ? 'fresh' : status === 'stale' ? 'stale' : 'no data';
    const elev = (typeof s.elevation === 'number') ? `${s.elevation.toFixed(0)} m` : null;
    const installed = (typeof s.date_installed === 'number') ? MCO.formatDateMT(s.date_installed) : null;
    const frag = MCO.map.popupContent({
      title: null,
      subtitle: s.station,
      facts: [['County', s.county], ['Elevation', elev], ['Installed', installed]],
      actions: [
        { label: 'Open dashboard', href: DASH_URL(stationId) },
        { label: 'Latest data', href: LATEST_FOR_URL(stationId) },
      ],
    });
    const root = frag.querySelector('.mco-popup');
    const before = root.querySelector('.mco-facts');

    // Badge + pills. Health pill only when it adds something: a "no data"
    // station is already a total outage.
    const tags = el('div', 'pop-tags');
    tags.append(el('span', 'pop-badge', s.sub_network || '—'),
      pill(status, pillLbl));
    const hKey = healthKey(stationId, mins);
    const { emergent, known } = splitMissing(stationId);
    if (!(hKey === 'outage' && status === 'null')) {
      const hLbl = hKey === 'partial' ? `${emergent.length} sensor${emergent.length === 1 ? '' : 's'} down`
        : hKey === 'known' ? `${known.length} known outage${known.length === 1 ? '' : 's'}`
        : healthClass(hKey).short;
      tags.append(pill(hKey, hLbl));
    }
    const stamp = el('div', 'pop-stamp');
    stamp.append(el('div', null, ts == null ? '—' : MCO.formatStampMT(ts)), el('div', null, relativeStamp(ts)));
    root.insertBefore(tags, before);
    root.insertBefore(stamp, before);

    // The sensors behind a "partial" or "known" verdict, news first. Only for
    // a fresh station: a stale station's sensor list is moot.
    if (hKey !== 'outage') {
      if (emergent.length) {
        const box = el('div', 'pop-missing');
        const ul = el('ul');
        for (const e of emergent) ul.append(el('li', null, e.label));
        box.append(el('strong', null, 'Sensors not reporting'), ul);
        root.insertBefore(box, before);
      }
      if (known.length) {
        const box = el('div', 'pop-missing pop-known');
        const ul = el('ul');
        for (const e of known) ul.append(el('li', null, `${e.label} — flagged since ${MCO.formatDateStr(e.since)}`));
        box.append(el('strong', null, 'Known outages'), ul);
        root.insertBefore(box, before);
      }
      if (!emergent.length && !known.length && !elementsById.has(stationId)) {
        root.insertBefore(el('div', 'pop-missing pop-missing-note',
          elementsFailed.has(stationId) ? 'Sensor list unavailable' : 'Checking sensors…'), before);
      }
    }

    // The other visible stations at this site (kit colocation): the keyboard
    // and touch route across a site, since the canvas spider is pointer-only.
    const sibs = coloc ? coloc.siblings(stationId) : [];
    if (sibs.length) {
      const box = el('div', 'pop-siblings');
      box.append(el('h3', null, 'Also at this site'));
      const ul = el('ul');
      for (const m of sibs) {
        const b = el('button', 'nav-btn', `${m.name} (${m.sub_network || 'station'})`);
        b.type = 'button';
        b.addEventListener('click', () => openStation(m.station, { push: false }));
        const li = el('li');
        li.append(b);
        ul.append(li);
      }
      box.append(ul);
      root.insertBefore(box, before);
    }
    return frag;
  }

  // ── Station detail: MCO.initSheet at every width ────────────────────────
  // End-docked above compact; on compact (kit 1.0.0) one full-height panel
  // under the bar, which stays live. Stations never open an anchored popup.
  const sheetEl    = document.getElementById('station-sheet');
  const sheetTitle = document.getElementById('station-sheet-title');
  const sheetBody  = sheetEl.querySelector('.mco-sheet-body');
  let _sheetFor = null;                       // station shown in the sheet, or null
  MCO.metrics.observe('--chrome-h', document.getElementById('navbar'));
  const sheet = MCO.initSheet({
    sheet: sheetEl,
    fallbackFocus: document.getElementById('main'),
    onState: (state) => {
      // Closed by the user (×, Esc, Back): clear the selection.
      if (state === 'closed' && _sheetFor) {
        _sheetFor = null;
        _selectedStation = null;
        paintSelection();
        renderSRTable();
        MCO.announce('Station closed.');
        afterDetailClosed();
      }
    },
  });
  function fillSheet(stationId) {
    sheetTitle.textContent = stationById.get(stationId).name;
    sheetBody.replaceChildren(detailNode(stationId));
  }

  // opts.push: open as drill-down — a new history entry when no station was
  // open (HOUSE-STYLE §4), so Back closes it. Switching stations, deep links
  // and history navigation replace. opts.opener: where focus returns on close.
  function openStation(stationId, opts) {
    const s = stationById.get(stationId);
    if (!s) return;
    const push = !!(opts && opts.push) && !_selectedStation;
    _selectedStation = stationId;
    _sheetFor = stationId;
    fillSheet(stationId);
    sheet.open({ opener: opts && opts.opener });
    paintSelection();
    renderSRTable();
    announcePopup(stationId);
    writeUrl({ push });
  }

  // ── Map event wiring (called from initMap) ───────────────────────────────
  function wireMapEvents() {
    // Every style.load — the first one, each theme switch, a watchBasemap
    // retry or its blank fallback — wipes our sources and layers: re-add them
    // and repopulate the stations source. The first one also starts the data
    // fetch, once layers exist, so rebuildSource never lands before its
    // source (and so a dead basemap can't strand the data: 'load' never fires
    // for a style that failed).
    map.on('style.load', () => {
      addCustomLayers();
      rebuildSource();
      if (_mapReady) return;
      _mapReady = true;
      zoomFloor.refresh();
      loadAll();
    });

    // Reflect every pan/zoom in the URL so the view is sharable. (The kit's
    // colocation keeps an open spider's feet at a constant pixel offset.)
    map.on('moveend', () => writeUrl());
  }

  // ── URL writes ──────────────────────────────────────────────────────────
  // Lists are space-joined; URLSearchParams encodes spaces as '+', giving
  // tidy URLs like net=agrimet. Enum-string values are lowercase. Defaults are
  // elided (kit §4): both-networks-on emits no net param at all.
  // replaceUrlState for view adjustments; pushUrlState (kit 0.8.0) only for
  // the first step into a station detail, marked so a close can step back
  // over it instead of leaving a dead entry.
  function writeUrl(opts) {
    const params = {};
    if (activeMode !== 'status') params.mode = activeMode;
    if (activeNetworks.size !== KNOWN_NETWORKS.length) {
      params.net = [...activeNetworks].map(n => n.toLowerCase()).join(' ');
    }
    for (const m of Object.values(MODES)) {
      if (m.cats.size !== m.all.length) params[m.param] = [...m.cats].join(' ');
    }
    if (labelsOn) params.labels = 'on';
    if (legendCtl && legendCtl.isCollapsed()) params.legend = 'collapsed';
    // Clean URL (kit 0.8.0): the theme only when it differs from what a fresh
    // visit would get (the OS preference), the camera only when it isn't the
    // default Montana fit.
    const theme = MCO.getTheme();
    if (theme !== MCO.osTheme()) params.theme = theme;
    if (map) Object.assign(params, MCO.map.cameraParamsIfDefault(map));
    else {
      // Map not created yet: keep the camera the URL arrived with.
      for (const k of ['lng', 'lat', 'zoom']) if (urlParams.has(k)) params[k] = urlParams.get(k);
    }
    if (_selectedStation) params.station = _selectedStation;
    if (!kbdShortcuts) params.kbd = 'off';   // preserve the a11y opt-out across navigation
    if (opts && opts.push) MCO.pushUrlState(params, { state: { mcoDetail: _selectedStation } });
    else MCO.replaceUrlState(params);
  }

  // Close the station sheet from the app (an empty-map click, Back).
  // opts.fromHistory: Back/Forward already moved the URL; just re-sync it.
  function closeDetail(opts) {
    if (!_sheetFor && !_selectedStation) return;
    if (_sheetFor) { _sheetFor = null; sheet.close({ restoreFocus: false }); }
    if (_selectedStation) {
      _selectedStation = null;
      paintSelection();
      renderSRTable();
      if (opts && opts.fromHistory) MCO.announce('Station closed.');
      afterDetailClosed(opts);
    }
  }
  // A detail the user just closed: if its entry was pushed, step back over
  // it (the popstate below re-syncs the URL); otherwise rewrite this one.
  function afterDetailClosed(opts) {
    if (!(opts && opts.fromHistory) && history.state && history.state.mcoDetail) history.back();
    else writeUrl();
  }
  // Back / Forward across a drill-down entry: open or close the detail to
  // match, then re-sync the rest of the URL to the live view (the camera may
  // have moved since that entry was written). Hash-only changes (the skip
  // link's #main) are left alone.
  MCO.onUrlState((params, hash) => {
    if (!stations.length) return;
    const st = MCO.getParamLower('station', params);
    if (st === _selectedStation) { if (!hash) writeUrl(); return; }
    if (!st) closeDetail({ fromHistory: true });
    else if (stationById.has(st)) goTo(st);
  });

  // ── Hover tooltip ────────────────────────────────────────────────────────
  // (The colocated sites' hover fan-out is the kit's colocation.)
  // The tooltip is MCO.map.initCursorTooltip (kit 0.8.0): the query, cursor,
  // edge-flipped positioning, textContent fill and mouseout cleanup. The first
  // value line (relative time) is the accent value; the stamp and health
  // lines below it are styled down in index.html.
  function tooltipFor(f) {
    const stationId = f.properties.station;
    const s = stationById.get(stationId);
    if (!s) return null;
    const ts = latestById.get(stationId) ?? null;
    const fresh = healthKey(stationId, minutesSince(ts)) !== 'outage';
    const { emergent, known } = fresh ? splitMissing(stationId) : { emergent: [], known: [] };
    const lines = ts == null ? ['no record'] : [relativeStamp(ts), MCO.formatStampMT(ts)];
    if (emergent.length) lines.push(`${emergent.length} sensor${emergent.length === 1 ? '' : 's'} not reporting`);
    if (known.length) lines.push(`${known.length} known outage${known.length === 1 ? '' : 's'}`);
    const n = f.properties.colocationCount;
    if (n > 1) lines.push(`${n} stations at this site`);
    return { name: s.name, sub: s.station, line: lines };
  }

  // Layers queried in order; the kit skips any not yet added, and the
  // map-level handlers survive setStyle (theme switch).
  const HOVER_LAYERS = [
    'stations-layer', 'stations-badge', 'stations-id-label',
    'spider-layer', 'spider-id-label',
  ];
  function wireMapHover() {
    MCO.map.initCursorTooltip(map, {
      layers: HOVER_LAYERS,
      element: document.getElementById('tooltip'),
      render: tooltipFor,
    });
  }

  // Global keyboard shortcut: / focuses search. Esc is the kit's (its
  // escStack unwinds one layer per press: the dialog, the drawer, the
  // sheet, then the spider) and stays live regardless of ?kbd=off.
  window.addEventListener('keydown', (e) => {
    if (!kbdShortcuts) return;
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      const inField =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      if (inDrawer()) { rail.open(searchInput, { opener: railSearchBtn }); return; }
      searchInput.focus();
      searchInput.select();
    }
  });
  // Esc in the field: the kit closes the list, then clears the text (and
  // stops the key there). Once it lets Esc through, the drawer (if the field
  // is in one) takes it and returns focus; in the desktop bar, leave the field.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || rail.isOpen()) return;
    searchInput.blur();
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────
  // Single entry point for mode changes.
  function setMode(mode) {
    if (!MODES[mode] || mode === activeMode) return;
    activeMode = mode;
    MCO.lsSet('mco-status-mode', activeMode);
    modeControl.set(activeMode);
    railModeSelect.value = activeMode;
    refreshDotColors();
    applyAllFilters();  // category filter belongs to the active mode
    writeUrl();
  }
  // Mode buttons above 1400px, a <select> at or below it (the bar's shed
  // rung; index.html). The kit mirrors one into the other and moves focus
  // across when a breakpoint flip hides the focused one.
  const modeControl = MCO.initSegmentedFallback({
    group: document.getElementById('mode-seg'),
    select: document.getElementById('mode-select'),
    mq: '(max-width: 1400px)',
    onChange: (v) => setMode(v),
  });
  modeControl.set(activeMode);
  // The phone bar's hot control: the same choice (index.html #rail-mode-select).
  const railModeSelect = document.getElementById('rail-mode-select');
  railModeSelect.value = activeMode;
  railModeSelect.addEventListener('change', () => setMode(railModeSelect.value));

  // ── Labels toggle ────────────────────────────────────────────────────────
  let labelsOn = (() => {
    const u = getLower('labels');
    if (u === 'on' || u === 'off') return u === 'on';
    return MCO.lsGet('mco-status-labels') === 'on';
  })();
  const labelsBtn = document.getElementById('btn-labels');
  labelsBtn.setAttribute('aria-pressed', labelsOn ? 'true' : 'false');
  function applyLabelsVisibility() {
    if (!map) return;
    const vis = labelsOn ? 'visible' : 'none';
    for (const lid of ['stations-id-label', 'spider-id-label']) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    }
  }
  labelsBtn.addEventListener('click', () => {
    labelsOn = !labelsOn;
    labelsBtn.setAttribute('aria-pressed', labelsOn ? 'true' : 'false');
    MCO.lsSet('mco-status-labels', labelsOn ? 'on' : 'off');
    applyLabelsVisibility();
    writeUrl();
  });

  // ── Legend collapse/expand (kit collapsible + animated body) ────────────
  // URL ?legend= wins; then localStorage — including values written by the
  // pre-kit version of this app ('collapsed'/'expanded' rather than '1'/'0').
  const legendToggleBtn = document.getElementById('legend-toggle-btn');
  const legendBodyEl    = document.getElementById('legend-body');
  const startCollapsed = (() => {
    const u = getLower('legend');
    if (u === 'open' || u === 'collapsed') return u === 'collapsed';
    const saved = MCO.lsGet('mco-status-legend');
    if (saved === 'collapsed' || saved === '1') return true;
    if (saved === 'expanded'  || saved === '0') return false;
    return false;
  })();
  let legendCtl = null;
  legendCtl = MCO.initCollapsible({
    toggle: legendToggleBtn,
    body: legendBodyEl,
    storageKey: 'mco-status-legend',
    startCollapsed,
    onChange: (collapsed) => {
      // Swapped label: the button names the ACTION it will perform (§5.7).
      legendToggleBtn.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Collapse legend');
      if (legendCtl) writeUrl();   // skip the init call (map camera not settled)
    },
  });

  // ── Legend (Plotly-style toggles) ────────────────────────────────────────
  // Click toggles a category; double-click (or Shift+Enter) isolates it, and
  // isolating the isolated one shows everything again — MCO.initLegendToggles
  // (kit 0.8.0), which also announces each change. Rows are .mco-legend-row:
  // "off" dims the swatch and strikes the label, never the row's opacity
  // (that was a 2.7:1 label, WCAG 1.4.3). Rows are rebuilt per mode, so the
  // toggles are re-initialized with them.
  let legendToggles = null;

  function renderLegend() {
    if (legendToggles) legendToggles.dispose();
    legendRowsEl.innerHTML = '';
    // Every row gets a live count + share (refreshLegendCounts); the counts
    // ignore the toggles, so a hidden category still reports its number.
    // Rows, colors and labels are the mode's registry set; "No record" (drawn
    // hollow) follows it in the modes that have one.
    const rows = catSet(SET_FOR_MODE[activeMode]);
    if (hasNoRecordMode(activeMode)) rows.push({ key: 'null', color: null, label: 'No record' });
    legendTitleEl.textContent = MODES[activeMode].title;
    const rowEls = rows.map((r) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mco-legend-row';
      row.dataset.key = r.key;
      // The swatch is the marker's shape: a circle in the category color,
      // and No record the hollow ring stationPaint draws.
      const sw = document.createElement('span');
      sw.className = 'mco-legend-swatch';
      if (r.key === 'null') {
        sw.dataset.shape = 'hollow';
        sw.style.setProperty('--swatch', cssVar('--dot-stroke', 'currentColor'));
      } else {
        sw.dataset.shape = 'circle';
        sw.style.setProperty('--swatch', r.color);
      }
      sw.setAttribute('aria-hidden', 'true');
      const lb = document.createElement('span');
      lb.className = 'mco-legend-label';
      lb.textContent = r.label;
      // Live count + share of the visible-network stations, filled by
      // refreshLegendCounts() (also on every rebuildSource tick).
      const n = document.createElement('span');
      n.className = 'mco-legend-count';
      const pct = document.createElement('span');
      pct.className = 'legend-pct';
      row.append(sw, lb, n, pct);
      legendRowsEl.appendChild(row);
      return row;
    });
    legendToggles = MCO.initLegendToggles({
      rows: rowEls,
      visible: currentCats(),
      noun: 'categories',
      onChange: (visible) => {
        MODES[activeMode].cats = visible;
        applyAllFilters();
        writeUrl();
      },
    });
    const hint = document.createElement('div');
    hint.className = 'legend-hint';
    hint.textContent = 'Click to toggle · Double-click to isolate';
    legendRowsEl.appendChild(hint);
    // Health mode only: sensor-list load progress / stations without a list.
    const note = document.createElement('div');
    note.className = 'legend-note';
    note.id = 'legend-note';
    note.hidden = true;
    legendRowsEl.appendChild(note);
    refreshLegendCounts();
  }

  // Per-category counts for the active mode over the visible-network stations
  // (shownStations), NOT filtered by the legend toggles — hiding a
  // category must not zero its count.
  function legendCounts() {
    const prop = currentCatKey();
    const counts = {};
    let total = 0;
    for (const s of shownStations()) {
      const mins = minutesSince(latestById.get(s.station) ?? null);
      const key = prop === 'staleStatus' ? statusBucket(mins)
        : prop === 'timeBinKey' ? timeBinKey(mins)
        : healthKey(s.station, mins);
      counts[key] = (counts[key] || 0) + 1;
      total++;
    }
    return { counts, total };
  }
  function refreshLegendCounts() {
    if (!stations.length) return;   // before data: rows show labels only
    const { counts, total } = legendCounts();
    for (const row of legendRowsEl.querySelectorAll('.mco-legend-row')) {
      const n = counts[row.dataset.key] || 0;
      row.querySelector('.mco-legend-count').textContent = String(n);
      row.querySelector('.legend-pct').textContent = total ? `(${Math.round((n / total) * 100)}%)` : '';
    }
    renderLegendNote();
  }

  // ── Periodic ticks ───────────────────────────────────────────────────────
  setInterval(rebuildSource, REPAINT_TICK_MS);   // recompute minutesSince locally
  setInterval(refreshLatest, LATEST_REFRESH_MS); // re-poll the API

  // ── Boot ─────────────────────────────────────────────────────────────────
  // The map's 'load' event drives the data fetch — see wireMapEvents() above.
  renderLegend();
  MCO.map.loadMapLibre().then(initMap, onMapFail);
})();
