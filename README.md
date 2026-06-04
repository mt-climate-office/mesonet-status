# Mesonet Station Status

A real-time station status map for the [Montana Mesonet](https://climate.umt.edu/mesonet), built and operated by the [Montana Climate Office](https://climate.umt.edu).

## About

Shows the current reporting state of every station across the HydroMet and AgriMet sub-networks. Two view modes:

- **Status** — single threshold: dot color reflects whether the station has posted within the last hour.
- **Time since** — five bins of "minutes since the latest record," ceiling at >24 h.

Color is sampled from [Crameri's *roma*](https://www.fabiocrameri.ch/colourmaps/) scientific colour map — perceptually uniform, ordered, and safe for the major color-vision deficiencies, with a culturally readable green = good → red = bad direction.

Other features:

- **HydroMet / AgriMet** sub-network toggles with live counts. Hiding a network dynamically resolves any stacked sites at that location to single dots.
- **Search box** with a custom themed dropdown (8 results, scored by relevance), keyboard navigation (`↑` `↓` `Enter`), and a `/` global shortcut to jump to it from anywhere on the page.
- **Plotly-style interactive legend** in the lower-left: click a row to hide/show that category; double-click (or <kbd>Shift</kbd>+<kbd>Enter</kbd>) to isolate it.
- **Co-located sites** — the HydroMet station is always the visible anchor with a count badge. Hover (desktop) or tap (mobile) to fan the others out; a second click on a foot opens that station's popup.
- **Toggleable station-ID labels** with collision-based dodging.
- **Hover tooltip** with station name, ID, latest timestamp, and relative time — all in the viewer's local timezone.
- **Tribal lands overlay** — the 7 federal reservations in Montana drawn as a subtle fill + outline, with names at zoom ≥ 7.
- **Montana state outline** so the state shape reads as the primary frame.
- **Light/dark theme** with muted [Stadia Alidade Smooth](https://docs.stadiamaps.com/themes/) basemaps designed as data-overlay canvases.
- **Map controls**: zoom in/out + a "zoom to full extent" button (top-right). Zooming out below the state-fit zoom springs back; resizing the window also snaps back if the viewport drops below fit.
- **First-visit help dialog** auto-opens once so newcomers get the orientation.
- Honors `prefers-reduced-motion` and `prefers-color-scheme`.

## Sharable URLs

Every piece of UI state is mirrored to the URL via `history.replaceState`. The view is fully shareable and bookmarkable.

| Param     | Values                                    | Notes                                         |
|-----------|-------------------------------------------|-----------------------------------------------|
| `lng`     | float                                     | Map center longitude                          |
| `lat`     | float                                     | Map center latitude                           |
| `zoom`    | float                                     | Map zoom                                      |
| `mode`    | `status` \| `timesince`                   | Visualization mode                            |
| `net`     | `+`/space/comma list (`hydromet+agrimet`) | Active sub-networks. Empty = none. Case-insensitive. |
| `scat`    | list (`fresh+stale`, `null`)              | Visible Status-mode categories. Omitted = all. |
| `tcat`    | list (`0+1+2+3+4`, `null`)                | Visible Time-since bins (0 = `<1 h`, 4 = `>24 h`). Omitted = all. |
| `labels`  | `on` \| `off`                             | Station-ID labels                             |
| `legend`  | `open` \| `collapsed`                     | Legend panel state                            |
| `theme`   | `light` \| `dark`                         | Theme override                                |
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

- Stations + metadata: <https://mesonet.climate.umt.edu/api/stations/?type=json>
- Latest record per station: <https://mesonet.climate.umt.edu/api/latest/?type=json>

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

## Tooling

- [MapLibre GL JS](https://maplibre.org) v5.18 via CDN.
- [Stadia Maps](https://stadiamaps.com) Alidade Smooth + Alidade Smooth Dark basemaps (muted data-vis backdrops).
- Vanilla JS / HTML / CSS — no bundler, no framework.

## License

[MIT](LICENSE) — Copyright (c) 2026–present Montana Climate Office
