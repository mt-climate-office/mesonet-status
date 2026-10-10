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
  // cached in localStorage per station with a 24 h TTL. 245 stations at
  // concurrency 8 loads in ~10 s cold; the kit's default 60 s fetch timeout
  // would let one hung request stall a worker for a minute, hence 15 s.
  const ELEMENTS_CACHE_KEY        = 'mco-status-elements-v1';
  const ELEMENTS_TTL_MS           = 24 * 60 * 60 * 1000;
  const ELEMENTS_CONCURRENCY      = 8;
  const ELEMENTS_TIMEOUT_MS       = 15 * 1000;
  const ELEMENTS_PERSIST_EVERY    = 40;      // completions between cache writes
  const HEALTH_REFRESH_DEBOUNCE_MS = 500;    // coalesce rebuilds while lists stream in

  // Spider geometry / interaction
  const SPIDER_RADIUS_PX        = 26;     // distance from anchor to spider foot
  const SPIDER_CLOSE_GRACE_MS   = 250;    // hover gap when cursor leaves one of the spider layers
  const SEARCH_FLY_ZOOM         = 11;     // zoom when search/deep-link flies to a station
  const SEARCH_FLY_SPEED        = 1.4;
  // Label collision detection switches on at this zoom
  const LABEL_MINZOOM           = 6;
  // Reservation name labels switch on at this zoom (less cluttered at MT extent)
  const TRIBAL_LABEL_MINZOOM    = 7;
  // Coordinate precision for the co-location bucket key (~11 m at MT latitudes)
  const BUCKET_PRECISION        = 4;

  // Status ramp = kit roma, option B (Kyle, 2026-10-10). Crameri roma
  // (MCO.palette, kit 0.12.0, diverging, midpoint 0.5) sampled at five evenly
  // spaced points from 0.1 to 0.9, reversed so fresh = the blue end and
  // stale = the brown end: #1e5fac #4bb2ce #c0eac3 #c1a545 #984e14. The 0.1
  // and 0.9 ends keep the extremes vivid, and their lightness differs enough
  // to survive grayscale (HOUSE-STYLE §6). SINGLE SOURCE: the bins, the map
  // paint, the legend swatches, the Status/Health colors, and the --status-*
  // tokens the popup pills read (set below, so CSS and the map can't drift).
  const ROMA_BINS = MCO.palette.sample('roma', 5, { from: 0.1, to: 0.9, reverse: true });
  const TIME_BINS = [
    { max: FRESH_MINUTES, color: ROMA_BINS[0], label: '< 2 h'  },   // same cutoff as Status/Health
    { max:  180, color: ROMA_BINS[1], label: '2–3 h'  },
    { max:  360, color: ROMA_BINS[2], label: '3–6 h'  },
    { max: 1440, color: ROMA_BINS[3], label: '6–24 h' },
    { max: Infinity, color: ROMA_BINS[4], label: '> 24 h' },
  ];
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  // Fresh / partial / stale are bins 0, 2 and 4. index.html carries the same
  // three hexes as a no-JS fallback; verify.config.mjs checks they match.
  const STATUS_FRESH   = ROMA_BINS[0];
  const STATUS_PARTIAL = ROMA_BINS[2];
  const STATUS_STALE   = ROMA_BINS[4];
  const NULL_COLOR     = cssVar('--status-null', '#9aa3b3');
  {
    const root = document.documentElement.style;
    root.setProperty('--status-fresh', STATUS_FRESH);
    root.setProperty('--status-partial', STATUS_PARTIAL);
    root.setProperty('--status-stale', STATUS_STALE);
  }

  // Health mode classes. Operational/outage reuse the Status colors so the two
  // modes agree on "good" and "bad"; partial is the ramp's pale middle (bin 2),
  // much lighter than both ends, so the three classes survive grayscale
  // (HOUSE-STYLE §6).
  const HEALTH_CLASSES = [
    { key: 'operational', color: STATUS_FRESH,   label: 'Operational',              short: 'operational'  },
    { key: 'partial',     color: STATUS_PARTIAL, label: 'Partial — sensor outage',  short: 'partial'      },
    { key: 'outage',      color: STATUS_STALE,   label: 'Total outage',             short: 'total outage' },
  ];
  const healthClass = (key) => HEALTH_CLASSES.find(c => c.key === key) || HEALTH_CLASSES[2];

  const bucketKey = (lat, lon) =>
    `${lat.toFixed(BUCKET_PRECISION)},${lon.toFixed(BUCKET_PRECISION)}`;

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
    const miss = missingElements(stationId);
    const health = miss.length ? `${miss.length} sensor${miss.length === 1 ? '' : 's'} not reporting` : '';
    MCO.announce(`${s.name} (${s.station}), ${s.sub_network || 'station'}, ${when}${health ? ', ' + health : ''}.`);
  }

  // The --dot-stroke token, for the spider's connector lines (the markers'
  // own edges come from MCO.map.markerPaint). MapLibre paints can't read CSS
  // vars, so resolve here.
  function dotStrokeColor() {
    return cssVar('--dot-stroke', document.documentElement.dataset.theme !== 'light' ? '#ffffff' : '#2a2a3a');
  }

  // ── Info modal ───────────────────────────────────────────────────────────
  const btnInfo = document.getElementById('btn-info');
  MCO.initInfoModal({ dialog: infoModal, trigger: btnInfo });
  // First-visit auto-open — suppressed over deep links (someone following a
  // shared ?station= URL shouldn't land behind a help dialog), and the seen
  // flag is written at open time so an unclosed dialog still counts as seen.
  const urlParams = MCO.urlParams();
  const DEEP_LINK_PARAMS = ['station', 'mode', 'net', 'scat', 'tcat', 'hcat', 'lng'];
  const hasDeepLink = DEEP_LINK_PARAMS.some((k) => urlParams.has(k));
  if (!MCO.lsGet('mco-status-seen-intro') && !hasDeepLink) {
    // Defer one tick so the page is rendered before the dialog steals focus.
    setTimeout(() => {
      if (!infoModal.open) infoModal.showModal();
      MCO.lsSet('mco-status-seen-intro', '1');
    }, 350);
  }

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
  // Health class: outage when there's no fresh record; otherwise partial if
  // any expected sensor is silent. A station whose element list hasn't loaded
  // (or failed) reads as operational — the legend note keeps that visible.
  function healthKey(stationId, minSince) {
    if (minSince == null || minSince >= FRESH_MINUTES) return 'outage';
    return elementsById.has(stationId) && missingElements(stationId).length ? 'partial' : 'operational';
  }
  // Discrete bin index for time-since mode: '0'..'4' for TIME_BINS, or 'null'.
  // Strings, so the same value type covers both modes in URL params + filters.
  function timeBinKey(minSince) {
    if (minSince == null) return 'null';
    let i = 0;
    while (i < TIME_BINS.length - 1 && minSince >= TIME_BINS[i].max) i++;
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
  let elementsById   = new Map();             // station id → [{code, label}]
  let elementsFailed = new Set();
  let _elementsProgress = { done: 0, total: 0, loading: false };
  // description_short → wide-record key ("Soil VWC @ -91 cm" → "Soil VWC @ -91 cm [%]").
  // Wide keys are the union across stations, so one record's keys suffice;
  // rebuilt per /latest/ payload so the 30 s tick never scans strings.
  let _wideKeyByLabel = new Map();
  let bucketById  = new Map();                // station id → bucket key
  // Dynamic colocation indices — recomputed every rebuildSource() based on
  // the currently-visible sub-networks. Hidden-network stations are excluded.
  let bucketSize    = new Map();              // bucket key → visible count
  let bucketIndex   = new Map();              // station id → index within visible members (0..n-1)
  let bucketAnchor  = new Map();              // bucket key → visible anchor station id
  let bucketMembers = new Map();              // bucket key → [station metadata in display order]
  let _spiderBucket = null;                   // bucket key currently spidered, or null
  let _popup = null;
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
    MCO.map.addNavigation(map);                                     // top-right, no compass
    MCO.map.addFitControl(map, { onBeforeFit: () => closeSpider() });
    zoomFloor = MCO.map.installZoomFloor(map);                      // snapback + resize refit
    // A basemap style that 404s or hangs used to leave 'load' unfired and the
    // app empty. The kit retries it, then falls back to a blank style (which
    // does load, so the overlays and dots still draw on style.load) with a
    // Retry notice (kit 0.8.0). styleUrl is read at retry time (theme).
    MCO.map.watchBasemap(map, { styleUrl: MCO.map.cartoStyleUrl });
    wireMapEvents();
    wireMapClicks();
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
    if (!map.getSource('spider')) {
      map.addSource('spider', { type: 'geojson', data: emptyFC() });
    }
    if (!map.getSource('spider-lines')) {
      map.addSource('spider-lines', { type: 'geojson', data: emptyFC() });
    }
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

    if (!map.getLayer('spider-lines-layer')) {
      map.addLayer({
        id: 'spider-lines-layer', type: 'line', source: 'spider-lines',
        paint: {
          'line-color': ['get', '_strokeColor'],
          'line-width': 1.2,
          'line-opacity': 0.65,
        },
      });
    }

    if (!map.getLayer('stations-layer')) {
      map.addLayer({
        id: 'stations-layer', type: 'circle', source: 'stations',
        // Filter is set by applyAllFilters() at the end of this function.
        paint: stationPaint(),
      });
    }

    if (!map.getLayer('stations-badge')) {
      map.addLayer({
        id: 'stations-badge', type: 'symbol', source: 'stations',
        layout: {
          'text-field': ['to-string', ['get', 'colocationCount']],
          'text-font':  ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size':  10,
          'text-offset': [0, -1.05],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          // White on a near-black halo: ≈15:1 over any basemap or dot color,
          // and unchanged on the high-contrast black basemap (WCAG 1.4.11).
          'text-color': '#ffffff',
          'text-halo-color': '#1a1a2e',
          'text-halo-width': 1.2,
        },
      });
    }

    if (!map.getLayer('stations-id-label')) {
      map.addLayer({
        id: 'stations-id-label', type: 'symbol', source: 'stations',
        minzoom: LABEL_MINZOOM,
        layout: stationLabelLayout(),
        paint: stationLabelPaint(),
      });
    }

    if (!map.getLayer('spider-layer')) {
      map.addLayer({
        id: 'spider-layer', type: 'circle', source: 'spider',
        paint: stationPaint(),
      });
    }

    if (!map.getLayer('spider-id-label')) {
      map.addLayer({
        id: 'spider-id-label', type: 'symbol', source: 'spider',
        layout: stationLabelLayout(),
        paint: stationLabelPaint(),
      });
    }

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
  function paintColorForMode(mode) {
    if (mode === 'status') {
      return ['case',
        ['==', ['get', 'minutesSince'], null], NULL_COLOR,
        ['<',  ['get', 'minutesSince'], FRESH_MINUTES], STATUS_FRESH,
        STATUS_STALE,
      ];
    }
    if (mode === 'health') {
      // Categorical: healthKey is computed in JS at emit time (it needs the
      // element lists), so no time math in the expression.
      return ['match', ['get', 'healthKey'],
        ...HEALTH_CLASSES.flatMap(c => [c.key, c.color]),
        NULL_COLOR,
      ];
    }
    // time-since 5-bin step
    return ['case',
      ['==', ['get', 'minutesSince'], null], NULL_COLOR,
      ['step', ['get', 'minutesSince'],
        TIME_BINS[0].color,                     // < FRESH_MINUTES
        TIME_BINS[0].max, TIME_BINS[1].color,   // FRESH_MINUTES+
        TIME_BINS[1].max, TIME_BINS[2].color,   // 180+
        TIME_BINS[2].max, TIME_BINS[3].color,   // 360+
        TIME_BINS[3].max, TIME_BINS[4].color,   // 1440+
      ],
    ];
  }

  // Station markers (HOUSE-STYLE §7, kit 0.9.0): network = SHAPE + color,
  // data value = fill. MCO.map.markerPaint gives HydroMet a filled circle
  // with the --dot-stroke edge and AgriMet a hollow-style thick ring in the
  // palette's AgriMet color; `fill` puts this mode's status color inside
  // both. The network survives grayscale and every CVD type, so a stacked
  // anchor and its spider feet read as two networks without the chips.
  const STATION_RADIUS = ['interpolate', ['linear'], ['zoom'], 4, 3.5, 7, 5, 10, 7, 14, 9];
  function stationPaint() {
    const fill = paintColorForMode(activeMode);
    const hydro = MCO.map.markerPaint('hydromet', { radius: STATION_RADIUS, fill });
    const agri  = MCO.map.markerPaint('agrimet',  { radius: STATION_RADIUS, fill });
    const byNet = (prop) => ['match', ['get', 'sub_network'], 'AgriMet', agri[prop], hydro[prop]];
    return {
      'circle-radius': STATION_RADIUS,
      'circle-color': fill,
      'circle-stroke-color': byNet('circle-stroke-color'),
      'circle-stroke-width': byNet('circle-stroke-width'),
      'circle-opacity': 0.95,
    };
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
    // Mode and theme both feed the marker paint (fill, network ring colors).
    const paint = stationPaint();
    for (const lid of ['stations-layer', 'spider-layer']) {
      for (const k of ['circle-color', 'circle-stroke-color', 'circle-stroke-width']) {
        map.setPaintProperty(lid, k, paint[k]);
      }
    }
    refreshLabelPaint();
    refreshOverlayPaints();
    // Spider connector line color also follows theme
    if (map.getLayer('spider-lines-layer')) {
      // _strokeColor is per-feature; refresh source data so the new color is baked in
      rebuildSpider();
    }
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
      // map's first style.load, so _mapReady is always true here.
      if (_initStation && stationById.has(_initStation)) {
        const s = stationById.get(_initStation);
        if (_hasInitPos) openPopupFor(_initStation, [s.longitude, s.latitude]);
        else             flyToAndOpen(_initStation);
      } else {
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
  // Cache shape: { v: 1, byStation: { [id]: { t: fetchedMs, els: [[code, label], …] } } }
  // — arrays, not objects, keep ~245 stations under ~200 KB on the github.io
  // origin this app shares with other MCO apps. Per-station timestamps so a
  // re-instrumented station expires alone.
  function readElementsCache() {
    try {
      const raw = MCO.lsGet(ELEMENTS_CACHE_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      if (!obj || obj.v !== 1 || typeof obj.byStation !== 'object') return {};
      return obj.byStation;
    } catch { return {}; }
  }
  function writeElementsCache(byStation) {
    MCO.lsSet(ELEMENTS_CACHE_KEY, JSON.stringify({ v: 1, byStation }));
  }
  function setElements(stationId, els) {
    elementsById.set(stationId, els);
    elementsFailed.delete(stationId);
  }
  // Dedupe (the endpoint repeats rows), sort by the API's display order.
  function normalizeElements(rows) {
    const byCode = new Map();
    for (const r of rows) {
      if (!r || typeof r.element !== 'string' || typeof r.description_short !== 'string') continue;
      if (!byCode.has(r.element)) byCode.set(r.element, { code: r.element, label: r.description_short, order: r.sort_order ?? 0 });
    }
    return [...byCode.values()]
      .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
      .map(({ code, label }) => ({ code, label }));
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
  async function loadElements() {
    if (_elementsInFlight) return;
    const cache = readElementsCache();
    const now = Date.now();
    // 1. Seed from cache synchronously (fresh entries only).
    for (const s of stations) {
      const entry = cache[s.station];
      if (!entry || !Array.isArray(entry.els)) continue;
      if (now - (entry.t || 0) > ELEMENTS_TTL_MS) continue;
      if (!elementsById.has(s.station)) {
        setElements(s.station, entry.els.map(([code, label]) => ({ code, label })));
      }
    }
    // 2. Fetch whatever is missing or expired.
    let needed = stations.map(s => s.station).filter(id => !elementsById.has(id));
    _elementsProgress = { done: 0, total: needed.length, loading: needed.length > 0 };
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
          setElements(id, els);
          cache[id] = { t, els: els.map(e => [e.code, e.label]) };
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
          setElements(id, els);
          cache[id] = { t: Date.now(), els: els.map(e => [e.code, e.label]) };
          if (++sinceWrite >= ELEMENTS_PERSIST_EVERY) { sinceWrite = 0; writeElementsCache(cache); }
        } catch (err) {
          elementsFailed.add(id);
          console.warn(`elements/${id} failed:`, err.message);
        }
        _elementsProgress.done++;
        renderLegendNote();           // cheap text update per completion
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
      const partial = countHealth().partial;
      MCO.announce(`Sensor check complete: ${partial} station${partial === 1 ? '' : 's'} with sensors not reporting.`);
    }
  }

  // GET /elements/?all=true → Map<station, [{code,label}]>, or null when the
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
      if (_popup && _selectedStation) _popup.setDOMContent(popupNode(_selectedStation));
      if (_sheetFor) fillSheet(_sheetFor);
    }, HEALTH_REFRESH_DEBOUNCE_MS);
  }

  function refreshStamp() {
    // Mountain Time like every other stamp (house convention). The word is its
    // own span so the 1400 rung can hide it visually (index.html): the bar
    // shows "● 12:21 MT", while the text, AT and the preview generator still
    // read "refreshed 12:21 MT". The wrapper's title carries it for pointer
    // users (the umrb map's pattern).
    const time = `${MCO.hhmmNowMT()} MT`;
    const word = document.createElement('span');
    word.className = 'refresh-word';
    word.textContent = 'refreshed';
    // The space lives outside the hidden span so a screen reader never runs
    // "refreshed" into the time; a line's leading space collapses visually.
    refreshStampEl.replaceChildren(word, ` ${time}`);
    refreshStampEl.parentElement.title = `Last refreshed: ${time}`;
  }

  // Network priority for choosing a bucket anchor; tiebreak by station id.
  const netRank = (s) => s === 'HydroMet' ? 0 : s === 'AgriMet' ? 1 : 99;

  // Static index: each station's lat/lon-derived bucket key + metadata lookup.
  // Co-location structure (count, anchor, index) is recomputed dynamically in
  // rebuildSource() based on the currently-visible sub-networks — so disabling
  // a network resolves a 2-stack to a single un-badged dot.
  function indexStations() {
    stationById.clear();
    bucketById.clear();
    for (const s of stations) {
      if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') continue;
      stationById.set(s.station, s);
      bucketById.set(s.station, bucketKey(s.latitude, s.longitude));
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

  function rebuildSource() {
    if (!map || !map.getSource('stations')) return;

    // Group visible-network stations by bucket and (re)compute colocation per
    // the currently-visible set. This both filters out hidden-network stations
    // at source-emit time AND re-ranks anchors so a HydroMet hide promotes the
    // AgriMet station to anchor (or, if alone in its bucket, treats it as a
    // single non-co-located dot — no badge, no spider).
    bucketMembers.clear();
    bucketSize.clear();
    bucketAnchor.clear();
    bucketIndex.clear();

    for (const s of stations) {
      if (!stationById.has(s.station)) continue;             // missing lat/lon, skipped at index time
      if (s.sub_network && !activeNetworks.has(s.sub_network)) continue;
      const k = bucketById.get(s.station);
      let arr = bucketMembers.get(k);
      if (!arr) { arr = []; bucketMembers.set(k, arr); }
      arr.push(s);
    }
    for (const [k, members] of bucketMembers) {
      members.sort((a, b) =>
        netRank(a.sub_network) - netRank(b.sub_network) ||
        a.station.localeCompare(b.station));
      bucketSize.set(k, members.length);
      bucketAnchor.set(k, members[0].station);
      members.forEach((s, i) => bucketIndex.set(s.station, i));
    }

    const features = [];
    for (const [k, members] of bucketMembers) {
      for (const s of members) {
        const ts   = latestById.get(s.station) ?? null;
        const mins = minutesSince(ts);
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
          properties: {
            station:         s.station,
            name:            s.name,
            sub_network:     s.sub_network,
            datetime:        ts,
            minutesSince:    mins,
            staleStatus:     statusBucket(mins),
            timeBinKey:      timeBinKey(mins),
            healthKey:       healthKey(s.station, mins),
            missingCount:    missingElements(s.station).length,
            colocationCount: members.length,
            colocationIndex: bucketIndex.get(s.station),
            bucket:          k,
          },
        });
      }
    }
    map.getSource('stations').setData({ type: 'FeatureCollection', features });
    renderSRTable();
    refreshLegendCounts();

    // If a spider is open, refresh its feet — the bucket's anchor or membership
    // may have just changed.
    if (_spiderBucket) rebuildSpider();
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
      { key: 'missing', label: 'Sensors not reporting' },
      { key: 'county', label: 'County' },
    ],
  });
  // The id is this app's hook (verify.config.mjs render evidence).
  srTwin.element.querySelector('table').id = 'sr-station-table';
  function renderSRTable() {
    const visible = [...bucketMembers.values()].flat()
      .sort((a, b) => a.name.localeCompare(b.name));
    srTwin.render(visible.map((s) => {
      const ts = latestById.get(s.station) ?? null;
      const mins = minutesSince(ts);
      const bucket = statusBucket(mins);
      const miss = missingElements(s.station);
      return {
        station: s.station,
        label: `${s.name} (${s.station})`,
        net: s.sub_network,
        status: bucket === 'null' ? 'no record' : bucket === 'fresh' ? 'reporting' : 'stale',
        when: ts == null ? 'no record' : `${MCO.formatStampMT(ts)} (${relativeStamp(ts)})`,
        health: healthClass(healthKey(s.station, mins)).short,
        missing: miss.length ? miss.map(e => e.label).join(', ')
          : elementsById.has(s.station) ? null
          : elementsFailed.has(s.station) ? 'sensor list unavailable' : 'sensor list loading',
        county: s.county,
      };
    }));
  }

  // ── Health bookkeeping ───────────────────────────────────────────────────
  // Counts run over the visible-network stations (bucketMembers), never
  // filtered by the legend toggles.
  function countHealth() {
    const counts = { operational: 0, partial: 0, outage: 0, total: 0, unknown: 0 };
    for (const members of bucketMembers.values()) {
      for (const s of members) {
        const mins = minutesSince(latestById.get(s.station) ?? null);
        const key = healthKey(s.station, mins);
        counts[key]++;
        counts.total++;
        if (key !== 'outage' && !elementsById.has(s.station)) counts.unknown++;
      }
    }
    return counts;
  }

  // Legend footer note, Health mode only: progress while element lists stream
  // in, then how many fresh stations lack a list (they count as operational).
  // Not aria-live — it'd chatter; the one-time completion goes to MCO.announce.
  function renderLegendNote() {
    const el = document.getElementById('legend-note');
    if (!el) return;
    let txt = '';
    if (activeMode === 'health' && stations.length) {
      if (_elementsProgress.loading) {
        txt = `Checking sensors… ${_elementsProgress.done}/${_elementsProgress.total}`;
      } else {
        const u = countHealth().unknown;
        if (u) txt = `${u} station${u === 1 ? '' : 's'} without sensor list`;
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
  function applyAllFilters() {
    if (!map || !map.getLayer('stations-layer')) return;
    const catMatch    = ['in', ['get', currentCatKey()], ['literal', [...currentCats()]]];
    const anchorOnly  = ['==', ['get', 'colocationIndex'], 0];

    map.setFilter('stations-layer',  ['all', anchorOnly, catMatch]);
    map.setFilter('stations-badge',  ['all', anchorOnly, ['>', ['get', 'colocationCount'], 1], catMatch]);
    if (map.getLayer('stations-id-label')) {
      map.setFilter('stations-id-label', ['all', anchorOnly, catMatch]);
    }
    map.setFilter('spider-layer', catMatch);
    if (map.getLayer('spider-id-label')) {
      map.setFilter('spider-id-label', catMatch);
    }
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
    } else if (bucketMembers.size === 0) {
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

  // Below 640px the search field collapses into #btn-search-toggle and reopens
  // as an overlay bar — kit component (MCO.initSearchCollapse). The kit owns
  // open/close, focus in and out, outside-dismiss and viewport-widening resets;
  // this app keeps the `/` shortcut, the last Esc step, and where focus goes
  // after a station is picked.
  const searchCollapse = MCO.initSearchCollapse({
    wrap: document.getElementById('search-wrap'),
    toggle: document.getElementById('btn-search-toggle'),
    input: searchInput,
    onClose: () => searchBox.close(),
  });

  // ── Landscape-phone rail (kit 0.10.0) ─────────────────────────────────────
  // The drawer beside the rail holds the brand, controls and meta; while it
  // is open the rest of the page is inert, and Esc / the scrim / the menu
  // button close it with focus back on the button.
  const rail = MCO.initNavRail({
    toggle: document.getElementById('btn-rail-menu'),
    drawer: document.getElementById('nav-drawer'),
    scrim: document.getElementById('nav-scrim'),
  });
  document.getElementById('btn-rail-search').addEventListener('click', () => rail.open(searchInput));
  // The info dialog would open under an inert page: close the drawer first
  // (capture, so it runs before the kit's own opener).
  btnInfo.addEventListener('click', () => rail.close({ restoreFocus: false }), true);

  function selectStation(stationId) {
    // Picking from the drawer: close it and let the detail take focus.
    if (rail.isOpen()) rail.close({ restoreFocus: false });
    flyToAndOpen(stationId, { push: true });
    // Collapsed: close the overlay, which returns focus to the toggle. Blurring
    // instead would drop focus to <body>, since the field is display:none once
    // the overlay closes.
    if (searchCollapse.isCollapsed()) searchCollapse.close();
    else searchInput.blur();
  }

  // opts.push: a new history entry when this opens a detail (writeUrl).
  function flyToAndOpen(stationId, opts) {
    const s = stationById.get(stationId);
    if (!s) { MCO.showToast('Station not found'); return; }
    if (s.sub_network && !activeNetworks.has(s.sub_network)) {
      // Re-enable its sub-network so the user can see the dot
      activeNetworks.add(s.sub_network);
      MCO.lsSet('mco-status-networks', JSON.stringify([...activeNetworks]));
      for (const chip of subnetFiltersEl.querySelectorAll('.mco-chip')) {
        if (chip.dataset.network === s.sub_network) chip.setAttribute('aria-pressed', 'true');
      }
      rebuildSource();
      applyAllFilters();
    }
    closeSpider();
    map.flyTo({
      center: [s.longitude, s.latitude],
      // Live reduced-motion gate (kit §5.3) — honors mid-session OS changes.
      zoom: SEARCH_FLY_ZOOM, speed: SEARCH_FLY_SPEED, animate: !MCO.reducedMotion(),
    });
    map.once('moveend', () => openPopupFor(stationId, null, opts));
  }

  // ── Popup ────────────────────────────────────────────────────────────────
  // Built with DOM APIs + textContent (HOUSE-STYLE §7): MCO.map.popupContent
  // (kit 0.8.0) gives the title, subtitle, .mco-facts list and action links;
  // the network badge, status pills, stamp and missing-sensor list are this
  // app's, inserted before the facts. Never setHTML of API strings.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // inSheet: the sheet's own <h2> carries the name, so the content skips it.
  function popupNode(stationId, inSheet) {
    const s = stationById.get(stationId);
    if (!s) return document.createDocumentFragment();
    const ts = latestById.get(stationId) ?? null;
    const mins = minutesSince(ts);
    const status = statusBucket(mins);
    const pillLbl = status === 'fresh' ? 'fresh' : status === 'stale' ? 'stale' : 'no data';
    const elev = (typeof s.elevation === 'number') ? `${s.elevation.toFixed(0)} m` : null;
    const installed = (typeof s.date_installed === 'number') ? MCO.formatDateMT(s.date_installed) : null;
    const frag = MCO.map.popupContent({
      title: inSheet ? null : s.name,
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
    tags.append(el('span', 'pop-badge', s.sub_network || '—'), el('span', `pop-pill ${status}`, pillLbl));
    const hKey = healthKey(stationId, mins);
    const miss = missingElements(stationId);
    if (!(hKey === 'outage' && status === 'null')) {
      const hLbl = hKey === 'partial'
        ? `${miss.length} sensor${miss.length === 1 ? '' : 's'} down`
        : healthClass(hKey).short;
      tags.append(el('span', `pop-pill ${hKey}`, hLbl));
    }
    const stamp = el('div', 'pop-stamp');
    stamp.append(el('div', null, ts == null ? '—' : MCO.formatStampMT(ts)), el('div', null, relativeStamp(ts)));
    stamp.dataset.peek = '';   // the sheet's peek detent shows down to here
    root.insertBefore(tags, before);
    root.insertBefore(stamp, before);

    // The sensors behind a "partial" verdict. Only for a fresh station: a
    // stale station's sensor list is moot.
    if (hKey !== 'outage') {
      if (miss.length) {
        const box = el('div', 'pop-missing');
        const ul = el('ul');
        for (const e of miss) ul.append(el('li', null, e.label));
        box.append(el('strong', null, 'Sensors not reporting'), ul);
        root.insertBefore(box, before);
      } else if (!elementsById.has(stationId)) {
        root.insertBefore(el('div', 'pop-missing pop-missing-note',
          elementsFailed.has(stationId) ? 'Sensor list unavailable' : 'Checking sensors…'), before);
      }
    }
    return frag;
  }

  // ── Station detail: bottom sheet on compact (kit 0.9.0) ─────────────────
  // Below the compact edge an anchored popup covers the very map it points
  // at; the station opens in MCO.initSheet instead (peek, drag/grip to full),
  // with the same popupContent body.
  const sheetEl    = document.getElementById('station-sheet');
  const sheetTitle = document.getElementById('station-sheet-title');
  const sheetBody  = sheetEl.querySelector('.mco-sheet-body');
  let _sheetFor = null;                       // station shown in the sheet, or null
  MCO.metrics.observe('--chrome-h', document.getElementById('navbar'));
  const sheet = MCO.initSheet({
    sheet: sheetEl,
    onState: (state) => {
      // Closed by the user (×, Esc, drag down): clear the selection.
      if (state === 'closed' && _sheetFor) {
        _sheetFor = null;
        _selectedStation = null;
        afterDetailClosed();
      }
    },
  });
  function fillSheet(stationId) {
    sheetTitle.textContent = stationById.get(stationId).name;
    sheetBody.replaceChildren(popupNode(stationId, true));
  }

  // opts.push: open as drill-down — a new history entry when no station was
  // open (HOUSE-STYLE §4), so Back closes it. Switching stations, deep links
  // and history navigation replace.
  function openPopupFor(stationId, lngLat, opts) {
    const s = stationById.get(stationId);
    if (!s) return;
    const push = !!(opts && opts.push) && !_selectedStation;
    if (_popup) { _suppressNextPopupClose = true; _popup.remove(); _popup = null; }
    _selectedStation = stationId;
    if (MCO.viewport.isCompact()) {
      _sheetFor = stationId;
      fillSheet(stationId);
      sheet.open('peek');
      announcePopup(stationId);
      writeUrl({ push });
      return;
    }
    if (_sheetFor) { _sheetFor = null; sheet.close({ restoreFocus: false }); }
    const p = new maplibregl.Popup({ closeOnClick: false, maxWidth: '320px', offset: 12 })
      .setLngLat(lngLat || [s.longitude, s.latitude])
      .setDOMContent(popupNode(stationId))
      .addTo(map);
    p.on('close', () => {
      if (_suppressNextPopupClose) { _suppressNextPopupClose = false; return; }
      if (_popup === p) {
        _popup = null;
        _selectedStation = null;
        afterDetailClosed();
      }
    });
    _popup = p;
    announcePopup(stationId);
    writeUrl({ push });
  }

  // ── Spider expand ────────────────────────────────────────────────────────
  // Argument is the bucket *key* (a string), not the bucketKey() function;
  // named differently to avoid shadowing the outer helper.
  function openSpider(key, anchorLngLat) {
    _spiderBucket = key;
    rebuildSpider(anchorLngLat);
  }
  function closeSpider() {
    if (_spiderBucket == null || !map) return;
    _spiderBucket = null;
    map.getSource('spider')?.setData(emptyFC());
    map.getSource('spider-lines')?.setData(emptyFC());
  }
  function rebuildSpider(anchorLngLatHint) {
    if (_spiderBucket == null || !map || !map.getSource('spider')) return;
    // Members come from the dynamic bucketMembers map, which already excludes
    // hidden-network stations.
    const members = bucketMembers.get(_spiderBucket) || [];
    if (members.length <= 1) { closeSpider(); return; }

    const anchorId = bucketAnchor.get(_spiderBucket);
    const anchorMeta = stationById.get(anchorId);
    const anchorLngLat = anchorLngLatHint || [anchorMeta.longitude, anchorMeta.latitude];
    const anchorPx = map.project(anchorLngLat);
    const others = members.filter(s => s.station !== anchorId).map(s => s.station);
    const radius = SPIDER_RADIUS_PX;
    const stroke = dotStrokeColor();

    const feet = [];
    const lines = [];
    others.forEach((sid, i) => {
      const theta = (i / others.length) * 2 * Math.PI - Math.PI / 2;  // start at top
      const px = { x: anchorPx.x + radius * Math.cos(theta), y: anchorPx.y + radius * Math.sin(theta) };
      const ll = map.unproject(px);
      const ts = latestById.get(sid) ?? null;
      const mins = minutesSince(ts);
      const s = stationById.get(sid);
      feet.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
        properties: {
          station: sid,
          name: s.name,
          sub_network: s.sub_network,
          datetime: ts,
          minutesSince: mins,
          staleStatus: statusBucket(mins),
          timeBinKey:  timeBinKey(mins),
          healthKey:   healthKey(sid, mins),
          missingCount: missingElements(sid).length,
          colocationCount: 1,
          colocationIndex: 0,
          bucket: _spiderBucket,
        },
      });
      lines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [anchorLngLat, [ll.lng, ll.lat]] },
        properties: { _strokeColor: stroke },
      });
    });
    map.getSource('spider').setData({ type: 'FeatureCollection', features: feet });
    map.getSource('spider-lines').setData({ type: 'FeatureCollection', features: lines });
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

    // Reflect every pan/zoom in the URL so the view is sharable
    map.on('moveend', writeUrl);

    // Keep spider feet anchored at constant pixel offset while the camera moves.
    // Coalesce multiple per-frame `move` events into a single rebuild via rAF.
    let _spiderMoveRaf = 0;
    map.on('move', () => {
      if (!_spiderBucket || _spiderMoveRaf) return;
      _spiderMoveRaf = requestAnimationFrame(() => { _spiderMoveRaf = 0; rebuildSpider(); });
    });
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

  // Track whether the next Popup `close` event was triggered programmatically
  // (so we don't writeUrl for an open-replace; the new popup writes its own state).
  let _suppressNextPopupClose = false;
  // opts.fromHistory: Back/Forward already moved the URL; just re-sync it.
  function closePopup(opts) {
    if (!_popup && !_sheetFor) return;
    if (_popup) {
      _suppressNextPopupClose = true;
      _popup.remove();
      _popup = null;
    }
    if (_sheetFor) { _sheetFor = null; sheet.close({ restoreFocus: false }); }
    if (_selectedStation) {
      _selectedStation = null;
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
    if (!st) closePopup({ fromHistory: true });
    else if (stationById.has(st)) flyToAndOpen(st);
  });

  // ── Spider close grace period (so cursor can travel from anchor to a foot) ─
  let _spiderCloseTimer = null;
  function scheduleSpiderClose() {
    if (_spiderCloseTimer) clearTimeout(_spiderCloseTimer);
    _spiderCloseTimer = setTimeout(() => { _spiderCloseTimer = null; closeSpider(); }, SPIDER_CLOSE_GRACE_MS);
  }
  function cancelSpiderClose() {
    if (_spiderCloseTimer) { clearTimeout(_spiderCloseTimer); _spiderCloseTimer = null; }
  }

  // ── Click handling ───────────────────────────────────────────────────────
  // Single dispatcher so badge + dot at the same point can't double-fire.
  // For stacked anchors: clicking opens (or toggles) the spider only — popups are
  // only opened by a second click on one of the spider feet.
  function wireMapClicks() {
    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: ['spider-layer', 'stations-layer', 'stations-badge'].filter(l => map.getLayer(l)),
      });
      if (feats.length === 0) {
        closeSpider();
        closePopup();
        return;
      }
      const f =
        feats.find(x => x.layer.id === 'spider-layer') ||
        feats.find(x => x.layer.id === 'stations-layer') ||
        feats[0];
      const props  = f.properties;
      const lngLat = f.geometry.coordinates.slice();
      if (f.layer.id === 'spider-layer') {
        // Second click — open the popup for the chosen station
        openPopupFor(props.station, lngLat, { push: true });
        return;
      }
      // Click on the anchor (or its badge) of a stacked site → ensure the spider
      // is open AND open the anchor station's popup. (Hover already opens the spider
      // on desktop; on mobile this click is the first user gesture.) Dismissal is
      // via clicking elsewhere or pressing Esc — same as any popup.
      if (props.colocationCount > 1) {
        cancelSpiderClose();
        if (_spiderBucket !== props.bucket) openSpider(props.bucket, lngLat);
        openPopupFor(props.station, lngLat, { push: true });
        return;
      }
      // Plain (non-co-located) station — close any open spider, open popup directly
      if (_spiderBucket) closeSpider();
      openPopupFor(props.station, lngLat, { push: true });
    });
  }

  // ── Hover tooltip + hover-open spider for co-located sites ────────────────
  // The tooltip is MCO.map.initCursorTooltip (kit 0.8.0): the query, cursor,
  // edge-flipped positioning, textContent fill and mouseout cleanup. The first
  // value line (relative time) is the accent value; the stamp and health
  // lines below it are styled down in index.html.
  function tooltipFor(f) {
    const stationId = f.properties.station;
    const s = stationById.get(stationId);
    if (!s) return null;
    const ts = latestById.get(stationId) ?? null;
    const miss = healthKey(stationId, minutesSince(ts)) === 'partial' ? missingElements(stationId).length : 0;
    const lines = ts == null ? ['no record'] : [relativeStamp(ts), MCO.formatStampMT(ts)];
    if (miss) lines.push(`${miss} sensor${miss === 1 ? '' : 's'} not reporting`);
    return { name: s.name, sub: s.station, line: lines };
  }

  // Layers queried in order; the kit skips any not yet added, and the
  // map-level handlers survive setStyle (theme switch).
  const HOVER_LAYERS = [
    'stations-layer', 'stations-badge', 'stations-id-label',
    'spider-layer', 'spider-id-label',
  ];
  const ANCHOR_LAYER_IDS = new Set(['stations-layer', 'stations-badge', 'stations-id-label']);
  let _hoveredStation = null;

  function wireMapHover() {
    MCO.map.initCursorTooltip(map, {
      layers: HOVER_LAYERS,
      element: document.getElementById('tooltip'),
      render: tooltipFor,
    });
    // Spider: hovering a stacked anchor fans its members out; leaving every
    // station layer closes it after a grace period (so the cursor can travel
    // from the anchor to a foot).
    map.on('mousemove', (e) => {
      const layers = HOVER_LAYERS.filter(lid => map.getLayer(lid));
      const f = layers.length ? map.queryRenderedFeatures(e.point, { layers })[0] : null;
      if (f) {
        cancelSpiderClose();
        _hoveredStation = f.properties.station;
        if (ANCHOR_LAYER_IDS.has(f.layer.id)
            && f.properties.colocationCount > 1
            && _spiderBucket !== f.properties.bucket) {
          openSpider(f.properties.bucket, f.geometry.coordinates.slice());
        }
      } else if (_hoveredStation !== null) {
        scheduleSpiderClose();
        _hoveredStation = null;
      }
    });
    map.getCanvas().addEventListener('mouseleave', () => {
      scheduleSpiderClose();
      _hoveredStation = null;
    });
  }

  // Global keyboard shortcuts: ESC closes things; / focuses search.
  // Esc stays live regardless of ?kbd=off — it's not a printable-character
  // shortcut, so WCAG 2.1.4 doesn't require an opt-out for it.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSpider();
      closePopup();
      return;
    }
    if (!kbdShortcuts) return;
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      const inField =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      if (rail.isRail()) { rail.open(searchInput); return; }
      if (searchCollapse.isCollapsed()) { searchCollapse.open(); return; }
      searchInput.focus();
      searchInput.select();
    }
  });
  // Esc in the field: the kit closes the list, then clears the text (and
  // stops the key there). Once it lets Esc through, close the overlay, then
  // leave the field.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (searchCollapse.isOpen()) { searchCollapse.close(); return; }
    searchInput.blur();
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────
  // Single entry point for mode changes.
  function setMode(mode) {
    if (!MODES[mode] || mode === activeMode) return;
    activeMode = mode;
    MCO.lsSet('mco-status-mode', activeMode);
    modeControl.set(activeMode);
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
    const rows = activeMode === 'status'
      ? [
          { key: 'fresh', color: STATUS_FRESH, label: 'Reported < 2 h ago' },
          { key: 'stale', color: STATUS_STALE, label: 'Stale (≥ 2 h)' },
          { key: 'null',  color: NULL_COLOR,   label: 'No record' },
        ]
      : activeMode === 'health'
      ? HEALTH_CLASSES.map(c => ({ key: c.key, color: c.color, label: c.label }))
      : [
          ...TIME_BINS.map((b, i) => ({ key: String(i), color: b.color, label: b.label })),
          { key: 'null', color: NULL_COLOR, label: 'No record' },
        ];
    legendTitleEl.textContent = MODES[activeMode].title;
    const rowEls = rows.map((r) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mco-legend-row';
      row.dataset.key = r.key;
      const sw = document.createElement('span');
      sw.className = 'mco-legend-swatch';
      sw.style.setProperty('--swatch', r.color);
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
    // Network key: the marker shapes (the chips in the navbar toggle them).
    const key = document.createElement('div');
    key.className = 'legend-networks';
    for (const net of ['hydromet', 'agrimet']) {
      const n = MCO.palette.network(net, document.documentElement.dataset.theme);
      const item = document.createElement('span');
      item.className = 'legend-network';
      const sw = document.createElement('span');
      sw.className = 'mco-legend-swatch';
      sw.dataset.shape = n.shape;
      // The filled circle's network color is its edge, not its fill (the
      // fill is the data): show it with a neutral fill.
      sw.style.setProperty('--swatch', n.shape === 'circle' ? NULL_COLOR : n.color);
      sw.setAttribute('aria-hidden', 'true');
      item.append(sw, document.createTextNode(n.shape === 'circle' ? `${n.label} (dot)` : `${n.label} (ring)`));
      key.appendChild(item);
    }
    legendRowsEl.appendChild(key);
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
  // (bucketMembers), NOT filtered by the legend toggles — hiding a
  // category must not zero its count.
  function legendCounts() {
    const prop = currentCatKey();
    const counts = {};
    let total = 0;
    for (const members of bucketMembers.values()) {
      for (const s of members) {
        const mins = minutesSince(latestById.get(s.station) ?? null);
        const key = prop === 'staleStatus' ? statusBucket(mins)
          : prop === 'timeBinKey' ? timeBinKey(mins)
          : healthKey(s.station, mins);
        counts[key] = (counts[key] || 0) + 1;
        total++;
      }
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
