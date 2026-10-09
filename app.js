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

  // Time-since bins (minutes). Crameri "roma" diverging — perceptually uniform,
  // CVD-safe, with the cultural green=good→red=bad traffic-light direction.
  // Stops sampled toward the center of the ramp (q≈0.8/0.65/0.5/0.35/0.2,
  // reversed so low value = cool/teal/fresh, high value = warm/red/stale) —
  // keeps the endpoints in vivid mid-tones so teal vs. red stays distinguishable.
  // SINGLE SOURCE for the ramp hexes (map paint + legend swatches). The three
  // semantic colors below are read from the --status-* CSS tokens so the
  // popup pills and the map always agree.
  const TIME_BINS = [
    { max: FRESH_MINUTES, color: '#2a8a86', label: '< 2 h'  },   // same cutoff as Status/Health
    { max:  180, color: '#84c2a0', label: '2–3 h'  },
    { max:  360, color: '#f4d88e', label: '3–6 h'  },
    { max: 1440, color: '#d4894a', label: '6–24 h' },
    { max: Infinity, color: '#b8421b', label: '> 24 h' },
  ];
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  const STATUS_FRESH   = cssVar('--status-fresh',   '#2a8a86');
  const STATUS_STALE   = cssVar('--status-stale',   '#b8421b');
  const STATUS_PARTIAL = cssVar('--status-partial', '#f4d88e');
  const NULL_COLOR     = cssVar('--status-null',    '#9aa3b3');

  // Health mode classes. Operational/outage reuse the Status colors so the two
  // modes agree on "good" and "bad"; partial takes the roma 3–6 h pale yellow
  // (already in TIME_BINS), the one ramp member whose lightness separates from
  // BOTH teal and red — the three classes survive grayscale (HOUSE-STYLE §6).
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
  const srTableEl       = document.getElementById('sr-station-table');

  // Push a sentence to the aria-live region so screen-reader users hear
  // "Station X opened" when a popup is shown via click, search, or deep-link.
  const srAnnounceEl = document.getElementById('sr-announce');
  function announce(text) { if (srAnnounceEl) srAnnounceEl.textContent = text; }
  function announcePopup(stationId) {
    const s = stationById.get(stationId);
    if (!s) return;
    const ts = latestById.get(stationId) ?? null;
    const when = ts == null ? 'no record' : `last reported ${relativeStamp(ts)}`;
    const miss = missingElements(stationId);
    const health = miss.length ? `${miss.length} sensor${miss.length === 1 ? '' : 's'} not reporting` : '';
    announce(`${s.name} (${s.station}), ${s.sub_network || 'station'}, ${when}${health ? ', ' + health : ''}.`);
  }

  // Hollow/filled dot stroke — the token exists so the value can't drift from
  // the theme (kit §2); MapLibre paints can't read CSS vars, so resolve here.
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
  // wants an off switch. Re-emitted on pushState so the preference sticks
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
    onChange: () => {
      if (!map) { pushState(); return; }
      map.setStyle(MCO.map.cartoStyleUrl());
      map.once('style.load', () => {
        addCustomLayers();   // re-add — setStyle wipes our sources/layers
        rebuildSource();     // repopulate the now-empty stations source
      });
      pushState();
    },
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

  function stationPaint() {
    return {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        4,  3.5,
        7,  5,
        10, 7,
        14, 9,
      ],
      'circle-color': paintColorForMode(activeMode),
      'circle-stroke-color': dotStrokeColor(),
      'circle-stroke-width': 1.2,
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
    const color = paintColorForMode(activeMode);
    const stroke = dotStrokeColor();
    for (const lid of ['stations-layer', 'spider-layer']) {
      map.setPaintProperty(lid, 'circle-color', color);
      map.setPaintProperty(lid, 'circle-stroke-color', stroke);
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
      populateSearch();
      rebuildSource();
      applyAllFilters();   // re-apply now that activeNetworks is populated
      refreshStamp();
      // Deep-link from ?station=… in URL. loadAll() is only called from the
      // map's 'load' handler, so _mapReady is always true here.
      if (_initStation && stationById.has(_initStation)) {
        const s = stationById.get(_initStation);
        if (_hasInitPos) openPopupFor(_initStation, [s.longitude, s.latitude]);
        else             flyToAndOpen(_initStation);
      } else {
        // Push initial URL so it's clean even if the user hasn't interacted yet
        pushState();
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
      announce(`Sensor check complete: ${partial} station${partial === 1 ? '' : 's'} with sensors not reporting.`);
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
      if (_popup && _selectedStation) _popup.setHTML(popupHTML(_selectedStation));
    }, HEALTH_REFRESH_DEBOUNCE_MS);
  }

  function refreshStamp() {
    // Mountain Time like every other stamp (house convention).
    refreshStampEl.textContent = `refreshed ${MCO.hhmmNowMT()} MT`;
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
  function renderSRTable() {
    if (!srTableEl) return;
    const visible = [...bucketMembers.values()].flat()
      .sort((a, b) => a.name.localeCompare(b.name));
    const rows = visible.map((s) => {
      const ts = latestById.get(s.station) ?? null;
      const mins = minutesSince(ts);
      const status = statusBucket(mins) === 'null' ? 'no record'
        : statusBucket(mins) === 'fresh' ? 'reporting' : 'stale';
      const when = ts == null ? 'no record'
        : `${MCO.formatStampMT(ts)} (${relativeStamp(ts)})`;
      const health = healthClass(healthKey(s.station, mins)).short;
      const miss = missingElements(s.station);
      const missTxt = miss.length ? miss.map(e => e.label).join(', ')
        : elementsById.has(s.station) ? '—'
        : elementsFailed.has(s.station) ? 'sensor list unavailable' : 'sensor list loading';
      return `<tr><th scope="row">${MCO.escapeHTML(s.name)} (${MCO.escapeHTML(s.station)})</th>` +
        `<td>${MCO.escapeHTML(s.sub_network || '—')}</td>` +
        `<td>${status}</td>` +
        `<td>${MCO.escapeHTML(when)}</td>` +
        `<td>${MCO.escapeHTML(health)}</td>` +
        `<td>${MCO.escapeHTML(missTxt)}</td>` +
        `<td>${MCO.escapeHTML(s.county || '—')}</td></tr>`;
    }).join('');
    srTableEl.innerHTML =
      '<caption>Montana Mesonet stations currently shown on the map</caption>' +
      '<thead><tr><th scope="col">Station</th><th scope="col">Network</th>' +
      '<th scope="col">Status</th><th scope="col">Last report (Mountain Time)</th>' +
      '<th scope="col">Health</th><th scope="col">Sensors not reporting</th>' +
      '<th scope="col">County</th></tr></thead>' +
      `<tbody>${rows}</tbody>`;
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
  // Not aria-live — it'd chatter; the one-time completion goes to #sr-announce.
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
      chip.className = 'chip';
      chip.dataset.network = net;
      chip.setAttribute('aria-pressed', activeNetworks.has(net) ? 'true' : 'false');
      const lbl = document.createElement('span');
      lbl.textContent = net;
      const count = document.createElement('span');
      count.className = 'chip-count';
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
        pushState();
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

  // ── Search (custom listbox dropdown + flyTo + popup) ─────────────────────
  // Custom rather than native <datalist> so the popup honors the app theme.
  let _searchSorted = [];
  let _activeSearchIndex = -1;
  const SEARCH_MAX_RESULTS = 8;

  function populateSearch() {
    _searchSorted = [...stations].sort((a, b) => a.name.localeCompare(b.name));
  }

  function matchScore(s, q) {
    const n = s.name.toLowerCase();
    const id = s.station.toLowerCase();
    if (n === q || id === q)   return 0;
    if (n.startsWith(q))       return 1;
    if (id.startsWith(q))      return 2;
    if (n.includes(q))         return 3;
    if (id.includes(q))        return 4;
    return Infinity;
  }

  function showSearchDropdown(rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    if (!q) { hideSearchDropdown(); return; }
    const matches = _searchSorted
      .map(s => ({ s, score: matchScore(s, q) }))
      .filter(m => m.score < Infinity)
      .sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name))
      .slice(0, SEARCH_MAX_RESULTS)
      .map(m => m.s);
    searchDropdown.innerHTML = '';
    if (matches.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.setAttribute('aria-disabled', 'true');
      li.textContent = `No stations match "${rawQuery.trim()}"`;
      searchDropdown.appendChild(li);
      searchDropdown.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
      _activeSearchIndex = -1;
      return;
    }
    for (const s of matches) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.stationId = s.station;
      li.id = `search-opt-${s.station}`;
      const name = document.createElement('span');
      name.className = 'search-name';
      name.textContent = s.name;
      const meta = document.createElement('span');
      meta.className = 'search-meta';
      meta.textContent = `${s.station} · ${s.sub_network || '—'}`;
      li.appendChild(name);
      li.appendChild(meta);
      // mousedown (not click) so the option commits before the input's blur.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectStation(s.station);
      });
      searchDropdown.appendChild(li);
    }
    searchDropdown.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
    _activeSearchIndex = -1;
    searchInput.removeAttribute('aria-activedescendant');
  }

  function hideSearchDropdown() {
    searchDropdown.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    _activeSearchIndex = -1;
    searchInput.removeAttribute('aria-activedescendant');
  }

  // Below 460px the search field collapses into #btn-search-toggle and reopens
  // as an overlay bar — kit component (MCO.initSearchCollapse). The kit owns
  // open/close, focus in and out, outside-dismiss and viewport-widening resets;
  // this app keeps Esc precedence against its own suggestions dropdown, the `/`
  // shortcut, and where focus goes after a station is picked.
  const searchCollapse = MCO.initSearchCollapse({
    wrap: document.getElementById('search-wrap'),
    toggle: document.getElementById('btn-search-toggle'),
    input: searchInput,
    onClose: hideSearchDropdown,
  });

  function selectStation(stationId) {
    hideSearchDropdown();
    flyToAndOpen(stationId);
    searchInput.value = '';
    // Collapsed: close the overlay, which returns focus to the toggle. Blurring
    // instead would drop focus to <body>, since the field is display:none once
    // the overlay closes.
    if (searchCollapse.isCollapsed()) searchCollapse.close();
    else searchInput.blur();
  }

  function setActiveSearchItem(idx) {
    const items = searchDropdown.querySelectorAll('li');
    if (!items.length) return;
    if (idx < 0)               idx = items.length - 1;
    if (idx >= items.length)   idx = 0;
    _activeSearchIndex = idx;
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
    searchInput.setAttribute('aria-activedescendant', items[idx].id);
  }

  searchInput.addEventListener('input',  () => showSearchDropdown(searchInput.value));
  searchInput.addEventListener('focus',  () => { if (searchInput.value) showSearchDropdown(searchInput.value); });
  // Delay so a click/mousedown on an option can fire before we hide the list.
  searchInput.addEventListener('blur',   () => setTimeout(hideSearchDropdown, 120));

  function flyToAndOpen(stationId) {
    const s = stationById.get(stationId);
    if (!s) { MCO.showToast('Station not found'); return; }
    if (s.sub_network && !activeNetworks.has(s.sub_network)) {
      // Re-enable its sub-network so the user can see the dot
      activeNetworks.add(s.sub_network);
      MCO.lsSet('mco-status-networks', JSON.stringify([...activeNetworks]));
      for (const chip of subnetFiltersEl.querySelectorAll('.chip')) {
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
    map.once('moveend', () => openPopupFor(stationId));
  }

  // ── Popup ────────────────────────────────────────────────────────────────
  function popupHTML(stationId) {
    const s = stationById.get(stationId);
    if (!s) return '';
    const ts = latestById.get(stationId) ?? null;
    const mins = minutesSince(ts);
    const status = statusBucket(mins);
    const stampAbs = ts == null ? '—' : MCO.formatStampMT(ts);
    const stampRel = relativeStamp(ts);
    const pillCls = status;
    const pillLbl = status === 'fresh' ? 'fresh' : status === 'stale' ? 'stale' : 'no data';
    const elev = (typeof s.elevation === 'number') ? `${s.elevation.toFixed(0)} m` : '—';
    const installed = (typeof s.date_installed === 'number')
      ? MCO.formatDateMT(s.date_installed)
      : '—';
    // Health pill + the sensors behind a "partial" verdict. Only shown when
    // the station is fresh: a stale station's sensor list is moot.
    const hKey = healthKey(stationId, mins);
    const miss = missingElements(stationId);
    const hLbl = hKey === 'partial'
      ? `${miss.length} sensor${miss.length === 1 ? '' : 's'} down`
      : healthClass(hKey).short;
    const healthPill = hKey === 'outage' && status === 'null' ? ''   // "no data" already says it
      : `<span class="pop-pill ${hKey}">${hLbl}</span>`;
    let missingBlock = '';
    if (hKey !== 'outage') {
      if (miss.length) {
        missingBlock = `<div class="pop-missing"><strong>Sensors not reporting</strong>` +
          `<ul>${miss.map(e => `<li>${MCO.escapeHTML(e.label)}</li>`).join('')}</ul></div>`;
      } else if (!elementsById.has(stationId)) {
        missingBlock = `<div class="pop-missing pop-missing-note">${
          elementsFailed.has(stationId) ? 'Sensor list unavailable' : 'Checking sensors…'}</div>`;
      }
    }
    return `
      <div class="pop-title">${MCO.escapeHTML(s.name)}</div>
      <div class="pop-sub">${MCO.escapeHTML(s.station)}</div>
      <div style="margin-top:6px">
        <span class="pop-badge">${MCO.escapeHTML(s.sub_network || '—')}</span>
        <span class="pop-pill ${pillCls}">${pillLbl}</span>${healthPill}
      </div>
      <div class="pop-stamp">
        <div>${stampAbs}</div>
        <div>${stampRel}</div>
      </div>
      ${missingBlock}
      <div class="pop-meta">
        <div><strong>County:</strong> ${MCO.escapeHTML(s.county || '—')}</div>
        <div><strong>Elevation:</strong> ${elev}</div>
        <div><strong>Installed:</strong> ${installed}</div>
      </div>
      <div class="pop-links">
        <a href="${DASH_URL(stationId)}"      target="_blank" rel="noopener">Open dashboard →</a>
        <a href="${LATEST_FOR_URL(stationId)}" target="_blank" rel="noopener">Latest data →</a>
      </div>
    `;
  }

  function openPopupFor(stationId, lngLat) {
    const s = stationById.get(stationId);
    if (!s) return;
    if (_popup) { _suppressNextPopupClose = true; _popup.remove(); _popup = null; }
    _selectedStation = stationId;
    const p = new maplibregl.Popup({ closeOnClick: false, maxWidth: '320px', offset: 12 })
      .setLngLat(lngLat || [s.longitude, s.latitude])
      .setHTML(popupHTML(stationId))
      .addTo(map);
    p.on('close', () => {
      if (_suppressNextPopupClose) { _suppressNextPopupClose = false; return; }
      if (_popup === p) {
        _popup = null;
        _selectedStation = null;
        pushState();
      }
    });
    _popup = p;
    announcePopup(stationId);
    pushState();
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
    map.on('load', () => {
      addCustomLayers();
      zoomFloor.refresh();
      _mapReady = true;
      // Kick off data fetch once layers exist, so rebuildSource never lands before its source.
      loadAll();
    });

    // Reflect every pan/zoom in the URL so the view is sharable
    map.on('moveend', pushState);

    // Keep spider feet anchored at constant pixel offset while the camera moves.
    // Coalesce multiple per-frame `move` events into a single rebuild via rAF.
    let _spiderMoveRaf = 0;
    map.on('move', () => {
      if (!_spiderBucket || _spiderMoveRaf) return;
      _spiderMoveRaf = requestAnimationFrame(() => { _spiderMoveRaf = 0; rebuildSpider(); });
    });
  }

  // ── URL state push ───────────────────────────────────────────────────────
  // Lists are space-joined; URLSearchParams encodes spaces as '+', giving
  // tidy URLs like net=agrimet. Enum-string values are lowercase. Defaults are
  // elided (kit §4): both-networks-on emits no net param at all.
  function pushState() {
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
    const theme = MCO.getTheme();
    if (theme) params.theme = theme;
    if (map) Object.assign(params, MCO.map.cameraParams(map));
    else {
      // Map not created yet: keep the camera the URL arrived with.
      for (const k of ['lng', 'lat', 'zoom']) if (urlParams.has(k)) params[k] = urlParams.get(k);
    }
    if (_selectedStation) params.station = _selectedStation;
    if (!kbdShortcuts) params.kbd = 'off';   // preserve the a11y opt-out across navigation
    MCO.replaceUrlState(params);
  }

  // Track whether the next Popup `close` event was triggered programmatically
  // (so we don't pushState for an open-replace; the new popup pushes its own state).
  let _suppressNextPopupClose = false;
  function closePopup() {
    if (!_popup) return;
    _suppressNextPopupClose = true;
    _popup.remove();
    _popup = null;
    if (_selectedStation) {
      _selectedStation = null;
      pushState();
    }
  }

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
        openPopupFor(props.station, lngLat);
        return;
      }
      // Click on the anchor (or its badge) of a stacked site → ensure the spider
      // is open AND open the anchor station's popup. (Hover already opens the spider
      // on desktop; on mobile this click is the first user gesture.) Dismissal is
      // via clicking elsewhere or pressing Esc — same as any popup.
      if (props.colocationCount > 1) {
        cancelSpiderClose();
        if (_spiderBucket !== props.bucket) openSpider(props.bucket, lngLat);
        openPopupFor(props.station, lngLat);
        return;
      }
      // Plain (non-co-located) station — close any open spider, open popup directly
      if (_spiderBucket) closeSpider();
      openPopupFor(props.station, lngLat);
    });
  }

  // ── Hover tooltip + hover-open spider for co-located sites ────────────────
  const tooltipEl = document.getElementById('tooltip');
  function showTooltip(stationId, e) {
    const s = stationById.get(stationId);
    if (!s) return;
    const ts = latestById.get(stationId) ?? null;
    const timeRow = ts == null
      ? `<span class="tooltip-time">no record</span>`
      : `<span class="tooltip-time">${MCO.escapeHTML(MCO.formatStampMT(ts))}</span>` +
        `<span class="tooltip-rel">${MCO.escapeHTML(relativeStamp(ts))}</span>`;
    const miss = healthKey(stationId, minutesSince(ts)) === 'partial' ? missingElements(stationId).length : 0;
    const healthRow = miss
      ? `<span class="tooltip-health">${miss} sensor${miss === 1 ? '' : 's'} not reporting</span>`
      : '';
    tooltipEl.innerHTML =
      `<span class="tooltip-name">${MCO.escapeHTML(s.name)}</span>` +
      `<span class="tooltip-sub">${MCO.escapeHTML(s.station)}</span>` +
      timeRow + healthRow;
    tooltipEl.classList.add('visible');
    tooltipEl.style.left = `${e.originalEvent.clientX + 14}px`;
    tooltipEl.style.top  = `${e.originalEvent.clientY + 14}px`;
  }
  function hideTooltip() { tooltipEl.classList.remove('visible'); }

  // Single global mousemove dispatcher — does its own queryRenderedFeatures
  // against the layer set. Avoids layer-scoped listeners which can become
  // detached when the style is swapped on theme toggle (MapLibre keeps the
  // map-level handler stable across setStyle).
  const HOVER_LAYERS = [
    'stations-layer', 'stations-badge', 'stations-id-label',
    'spider-layer', 'spider-id-label',
  ];
  const ANCHOR_LAYER_IDS = new Set(['stations-layer', 'stations-badge', 'stations-id-label']);
  let _hoveredStation = null;

  function wireMapHover() {
    map.on('mousemove', (e) => {
      const layers = HOVER_LAYERS.filter(lid => map.getLayer(lid));
      const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
      const f = feats[0] || null;
      if (f) {
        map.getCanvas().style.cursor = 'pointer';
        cancelSpiderClose();
        showTooltip(f.properties.station, e);
        _hoveredStation = f.properties.station;
        if (ANCHOR_LAYER_IDS.has(f.layer.id)
            && f.properties.colocationCount > 1
            && _spiderBucket !== f.properties.bucket) {
          openSpider(f.properties.bucket, f.geometry.coordinates.slice());
        }
      } else if (_hoveredStation !== null) {
        map.getCanvas().style.cursor = '';
        hideTooltip();
        scheduleSpiderClose();
        _hoveredStation = null;
      }
    });
    // Cursor + tooltip cleanup when the pointer leaves the map entirely.
    map.getCanvas().addEventListener('mouseleave', () => {
      map.getCanvas().style.cursor = '';
      hideTooltip();
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
      if (searchCollapse.isCollapsed()) { searchCollapse.open(); return; }
      searchInput.focus();
      searchInput.select();
    }
  });
  // Keyboard nav inside the custom dropdown.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Unwind one step at a time: suggestions first, then the overlay.
      if (!searchDropdown.hidden) { searchInput.value = ''; hideSearchDropdown(); return; }
      if (searchCollapse.isOpen()) { searchCollapse.close(); return; }
      searchInput.value = '';
      searchInput.blur();
      return;
    }
    if (searchDropdown.hidden) return;
    const items = searchDropdown.querySelectorAll('li');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSearchItem(_activeSearchIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSearchItem(_activeSearchIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = _activeSearchIndex >= 0 ? _activeSearchIndex : 0;
      selectStation(items[idx].dataset.stationId);
    }
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────
  // Single entry point for mode changes.
  function setMode(mode) {
    if (!MODES[mode] || mode === activeMode) return;
    activeMode = mode;
    MCO.lsSet('mco-status-mode', activeMode);
    for (const b of document.querySelectorAll('.seg-btn[data-mode]')) {
      b.setAttribute('aria-pressed', b.dataset.mode === activeMode ? 'true' : 'false');
    }
    refreshDotColors();
    applyAllFilters();  // category filter belongs to the active mode
    pushState();
  }
  for (const btn of document.querySelectorAll('.seg-btn[data-mode]')) {
    btn.setAttribute('aria-pressed', btn.dataset.mode === activeMode ? 'true' : 'false');
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }

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
    pushState();
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
      if (legendCtl) pushState();   // skip the init call (map camera not settled)
    },
  });

  // ── Legend (Plotly-style toggles) ────────────────────────────────────────
  // Single click toggles a category; double-click isolates that category
  // (double-click an already-isolated category to show all again).
  const LEGEND_DBLCLICK_MS = 280;

  function renderLegend() {
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
    const set = currentCats();
    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'legend-row';
      row.dataset.catKey = r.key;
      const on = set.has(r.key);
      row.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (!on) row.classList.add('off');
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = r.color;
      sw.setAttribute('aria-hidden', 'true');
      const lb = document.createElement('span');
      lb.className = 'legend-lbl';
      lb.textContent = r.label;
      // Live count + share of the visible-network stations, filled by
      // refreshLegendCounts() (also on every rebuildSource tick).
      const n = document.createElement('span');
      n.className = 'legend-count';
      const pct = document.createElement('span');
      pct.className = 'legend-pct';
      row.append(sw, lb, n, pct);
      attachLegendHandlers(row, r.key);
      legendRowsEl.appendChild(row);
    }
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
    for (const row of legendRowsEl.querySelectorAll('.legend-row')) {
      const n = counts[row.dataset.catKey] || 0;
      row.querySelector('.legend-count').textContent = String(n);
      row.querySelector('.legend-pct').textContent = total ? `(${Math.round((n / total) * 100)}%)` : '';
    }
    renderLegendNote();
  }

  function refreshLegendVisuals() {
    const set = currentCats();
    for (const row of legendRowsEl.querySelectorAll('.legend-row')) {
      const on = set.has(row.dataset.catKey);
      row.setAttribute('aria-pressed', on ? 'true' : 'false');
      row.classList.toggle('off', !on);
    }
  }

  function attachLegendHandlers(row, key) {
    let clickTimer = null;
    row.addEventListener('click', () => {
      // Defer single-click action so a follow-up dblclick can pre-empt it.
      if (clickTimer) return;                  // already pending → second click; let dblclick handle it
      clickTimer = setTimeout(() => {
        clickTimer = null;
        toggleCategory(key);
      }, LEGEND_DBLCLICK_MS);
    });
    row.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      isolateCategory(key);
    });
    // Keyboard equivalent for double-click: Shift+Enter on a focused row isolates.
    // (Plain Enter / Space still fires `click` natively → toggle.)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        isolateCategory(key);
      }
    });
  }

  function toggleCategory(key) {
    const set = currentCats();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    refreshLegendVisuals();
    applyAllFilters();
    pushState();
  }

  function isolateCategory(key) {
    const set = currentCats();
    const all = currentAllCats();
    // Already isolated to this key → restore everything.
    if (set.size === 1 && set.has(key)) {
      set.clear();
      for (const k of all) set.add(k);
    } else {
      set.clear();
      set.add(key);
    }
    refreshLegendVisuals();
    applyAllFilters();
    pushState();
  }

  // ── Periodic ticks ───────────────────────────────────────────────────────
  setInterval(rebuildSource, REPAINT_TICK_MS);   // recompute minutesSince locally
  setInterval(refreshLatest, LATEST_REFRESH_MS); // re-poll the API

  // ── Boot ─────────────────────────────────────────────────────────────────
  // The map's 'load' event drives the data fetch — see wireMapEvents() above.
  renderLegend();
  MCO.map.loadMapLibre().then(initMap, onMapFail);
})();
