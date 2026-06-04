# Mesonet Station Status

A real-time station status map for the [Montana Mesonet](https://climate.umt.edu/mesonet), built and operated by the [Montana Climate Office](https://climate.umt.edu).

## About

Shows the current reporting state of every station across the HydroMet and AgriMet sub-networks. Two view modes:

- **Status** — single threshold: dot color reflects whether the station has posted within the last hour.
- **Time since** — five bins of "minutes since the latest record," ceiling at >24 h.

Color is sampled from [Crameri's *roma*](https://www.fabiocrameri.ch/colourmaps/) scientific colour map — perceptually uniform, ordered, and safe for the major color-vision deficiencies, with a culturally readable green = good → red = bad direction.

Other features:

- HydroMet / AgriMet sub-network toggles with live counts.
- Search box (datalist autocomplete) over station names and IDs.
- Co-located sites — the HydroMet station is always the visible anchor; hovering it (desktop) or tapping it (mobile) fans out a spider of the other stations at that location. A second click on a spider foot opens that station's popup.
- Toggleable station-ID labels with collision-based dodging.
- Hover tooltip with station name, ID, latest timestamp, and relative time (all in the viewer's local timezone).
- Bottom-left collapsible legend.
- Light/dark theme toggle.
- Zoom-to-Montana button; pan is clamped to the state and zooming out snaps back.
- Honors `prefers-reduced-motion` and `prefers-color-scheme`.

## Sharable URLs

Every piece of UI state is mirrored to the URL via `history.replaceState`. The view is fully shareable and bookmarkable.

| Param     | Values                                    | Notes                                         |
|-----------|-------------------------------------------|-----------------------------------------------|
| `lng`     | float                                     | Map center longitude                          |
| `lat`     | float                                     | Map center latitude                           |
| `zoom`    | float                                     | Map zoom                                      |
| `mode`    | `status` \| `timesince`                   | Visualization mode                            |
| `net`     | comma list (`HydroMet,AgriMet`)           | Active sub-networks. Empty = none.            |
| `labels`  | `on` \| `off`                             | Station-ID labels                             |
| `legend`  | `open` \| `collapsed`                     | Legend panel state                            |
| `theme`   | `light` \| `dark`                         | Theme override                                |
| `station` | station id (e.g. `aceabsar`)              | Open this station's popup on load; deep-link  |

Precedence per setting: URL param > `localStorage` > built-in default.

Examples:

```
/?station=aceabsar
/?station=aceabsar&lng=-109.61&lat=45.56&zoom=12
/?mode=timesince&net=AgriMet&theme=light&labels=on&legend=collapsed
```

## Data sources

- Stations + metadata: <https://mesonet.climate.umt.edu/api/stations/?type=json>
- Latest record per station: <https://mesonet.climate.umt.edu/api/latest/?type=json>

The latest endpoint is polled every 5 minutes. Dot colors are also refreshed every 30 seconds against the local clock so freshness stays current between API calls.

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
