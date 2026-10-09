# Mesonet Station Status

A real-time station status map for the [Montana Mesonet](https://climate.umt.edu/mesonet), built and operated by the [Montana Climate Office](https://climate.umt.edu).

## About

Shows the current reporting state of every station across the HydroMet and AgriMet sub-networks. Two view modes:

- **Status** — single threshold: dot color reflects whether the station has posted within the last 2 hours.
- **Time since** — five bins of "minutes since the latest record," ceiling at >24 h.
- **Health** — three classes. **Operational**: reported within the last 2 hours with every expected sensor present. **Partial**: reported within the 2 hours, but one or more expected sensors are null in the latest record (the popup lists them). **Total outage**: no report in the last 2 hours, or no record at all.

In Health mode the legend footer reports sensor-list loading progress and, afterwards, how many fresh stations have no sensor list (those count as operational).

Color is sampled from [Crameri's *roma*](https://www.fabiocrameri.ch/colourmaps/) scientific colour map — perceptually uniform, ordered, and safe for the major color-vision deficiencies, with a culturally readable green = good → red = bad direction.

Other features:

- **HydroMet / AgriMet** sub-network toggles with live counts. Hiding a network dynamically resolves any stacked sites at that location to single dots.
- **Search box** with a custom themed dropdown (8 results, scored by relevance), keyboard navigation (`↑` `↓` `Enter`), and a `/` global shortcut to jump to it from anywhere on the page.
- **Plotly-style interactive legend** in the lower-left: click a row to hide/show that category; double-click (or <kbd>Shift</kbd>+<kbd>Enter</kbd>) to isolate it. Every row shows the live count and share of the selected networks' stations in that category (label, count, percentage); hiding a category never changes its count.
- **Co-located sites** — the HydroMet station is always the visible anchor with a count badge. Hover (desktop) or tap (mobile) to fan the others out; a second click on a foot opens that station's popup.
- **Toggleable station-ID labels** with collision-based dodging.
- **Hover tooltip** with station name, ID, latest timestamp, and relative time — all in the viewer's local timezone.
- **Tribal lands overlay** — the 7 federal reservations in Montana drawn as a subtle fill + outline, with names at zoom ≥ 7.
- **Montana state outline** so the state shape reads as the primary frame.
- **Light/dark theme** with neutral [CARTO Positron / Dark Matter](https://carto.com/basemaps) basemaps designed as data-overlay canvases.
- **Map controls**: zoom in/out + a "zoom to full extent" button (top-right). Zooming out below the state-fit zoom springs back; resizing the window also snaps back if the viewport drops below fit.
- **First-visit help dialog** auto-opens once so newcomers get the orientation.
- Honors `prefers-reduced-motion` and `prefers-color-scheme`.

## Sharable URLs

Every piece of UI state is mirrored to the URL via `history.replaceState`. The view is fully shareable and bookmarkable.

| Param     | Values                                    | Notes                                         |
|-----------|-------------------------------------------|-----------------------------------------------|
| `lng`     | float                                     | Map center longitude. Omitted at the default Montana fit. |
| `lat`     | float                                     | Map center latitude. Omitted at the default Montana fit. |
| `zoom`    | float                                     | Map zoom. Omitted at the default Montana fit. |
| `mode`    | `status` \| `timesince` \| `health`       | Visualization mode                            |
| `net`     | `+`/space/comma list (`hydromet+agrimet`) | Active sub-networks. Empty = none. Case-insensitive. |
| `scat`    | list (`fresh+stale`, `null`)              | Visible Status-mode categories. Omitted = all. |
| `tcat`    | list (`0+1+2+3+4`, `null`)                | Visible Time-since bins (0 = `<2 h`, 4 = `>24 h`). Omitted = all. |
| `hcat`    | list (`operational+partial+outage`)       | Visible Health classes. Omitted = all.        |
| `labels`  | `on` \| `off`                             | Station-ID labels                             |
| `legend`  | `open` \| `collapsed`                     | Legend panel state                            |
| `theme`   | `light` \| `dark` \| `high-contrast`       | Theme override. Omitted when it matches the OS preference. |
| `station` | station id (e.g. `aceabsar`)              | Open this station's popup on load; deep-link  |

Precedence per setting: URL param > `localStorage` > built-in default.

All enum-string values (`mode`, `theme`, `labels`, `legend`, network names, category keys, station IDs) are matched **case-insensitively**. List params accept `+`, spaces, or commas as separators.

Examples:

```
/?station=aceabsar
/?station=aceabsar&lng=-109.61&lat=45.56&zoom=12
/?mode=timesince&net=agrimet&theme=light&labels=on&legend=collapsed
/?net=hydromet+agrimet&scat=fresh+stale
```

## Data sources

- Stations + metadata: <https://mesonet2.climate.umt.edu/api/stations/?type=json>
- Latest record per station: <https://mesonet2.climate.umt.edu/api/latest/?type=json>
- Expected elements (sensors) for the whole network: <https://mesonet2.climate.umt.edu/api/elements/?all=true&type=json> (one request; rows carry a `station` column). If the API doesn't serve `all` yet, it ignores the flag and returns the bare catalog, which the app detects by the missing `station` column and falls back to the per-station form `https://mesonet2.climate.umt.edu/api/elements/<station>/?type=json` (e.g. <https://mesonet2.climate.umt.edu/api/elements/acemidwa/?type=json>). Without `type=json` the endpoints return HTML; per-station rows are duplicated and are de-duplicated by `element`.

**Health** cross-references the two: an expected element whose `description_short` column (`"<description_short> [<unit>]"`) is null in the station's latest record counts as a sensor not reporting. The element lists are fetched once (one bulk request, or 8 concurrent per-station requests on the fallback path, ~10 s cold for the full network) and cached in `localStorage` under `mco-status-elements-v1` with a 24 h per-station TTL, so a reload paints Health from cache immediately. Clear that key (or the site's storage) to force a refetch. Stations whose list fails to load are counted as operational when fresh and called out in the panel footer.

All API reads go to `mesonet2.climate.umt.edu` (the page CSP's `connect-src` pins that host). The per-station dashboard link stays on `mesonet.climate.umt.edu/dash/`.

The latest endpoint is polled every 5 minutes. Each response is **merged** into our in-memory store rather than replacing it — the Mesonet API occasionally drops a (different) station per call, and merging keeps a station's last-known timestamp from flickering to "no record" between polls. If a station genuinely stops reporting, its timestamp just ages naturally into the very-stale bin. Dot colors are also refreshed every 30 seconds against the local clock so freshness stays current between API calls.

Static overlay GeoJSON files in `data/` (state, reservations, counties) are built by `data.R` from `tigris` + `rmapshaper` and checked into the repo so the app has zero runtime dependencies beyond the Mesonet API.

## Development

The app is a single static `index.html` with no build step. Serve it locally with any static server:

```sh
# Python
python -m http.server 8000

# Node
npx serve .
```

Open <http://localhost:8000>.

## Deployment

Published via [GitHub Pages](https://pages.github.com) from the `main` branch. To enable for a fresh fork:

1. Push to `main`.
2. Repo → Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main / (root)**.
3. Site goes live at `https://<owner>.github.io/mesonet-status/` within a minute or two. Add a `CNAME` file later if you want a custom subdomain.

### Social preview image

`.github/workflows/preview.yml` runs nightly (and on manual dispatch) and **commits `assets/og-card.png` back to `main`** — always pull/rebase before pushing, or you race it.

`scripts/generate_preview.py` screenshots the live Pages site at 2400×1260 (a 1200×630 viewport at 2×) with `?mode=status`, which pins the Status view and, as a deep link, keeps the first-visit help dialog closed. It waits for the `#refresh-stamp` text to read `refreshed …` and then 4 seconds for tiles to paint — that param, element id and stamp text are a contract with the script. Run it locally to check:

```sh
pip install playwright
playwright install --with-deps chromium
python scripts/generate_preview.py
```

## Tooling

- [MapLibre GL JS](https://maplibre.org) v6.11.2 via CDN (imported by mco-web-style's `MCO.map.loadMapLibre()`; SRI in the import map).
- [mco-web-style](https://github.com/mt-climate-office/mco-web-style) 0.10.0 (pinned + SRI).
- [CARTO Basemaps](https://carto.com/basemaps) Positron + Dark Matter (neutral data-vis backdrops, free, no API key).
- Vanilla JS / HTML / CSS — no bundler, no framework.

## License

[MIT](LICENSE) — Copyright (c) 2026–present Montana Climate Office
