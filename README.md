# Mesonet Station Status

A map of every Montana Mesonet station, colored by how recently it reported.

https://mesonet.climate.umt.edu/status/

## Run it

No build step. Serve the folder and open http://localhost:8000.

```sh
python -m http.server 8000
```

## Deploy

GitHub Pages publishes `main`. The production host proxies `/status/` to Pages.
A nightly workflow commits `assets/og-card.png` to `main`, so pull before you push.

## URL parameters

Values are case-insensitive. Lists take `+`, spaces or commas.

| Parameter | Values | What it does |
|---|---|---|
| `station` | station id, e.g. `aceabsar` | Opens that station's details |
| `mode` | `status`, `timesince`, `health` | Map mode |
| `net` | `hydromet`, `agrimet` (list) | Networks shown |
| `scat` | `fresh`, `stale`, `null` (list) | Status categories shown |
| `tcat` | `0` to `4`, `null` (list) | Time-since bins shown, `0` is under 2 h |
| `hcat` | `operational`, `known`, `partial`, `outage` (list) | Health categories shown |
| `lng`, `lat`, `zoom` | numbers | Map view |
| `labels` | `on`, `off` | Station id labels |
| `legend` | `open`, `collapsed` | Legend panel |
| `theme` | `dark`, `light`, `high-contrast` | Theme |
| `kbd` | `off` | Turns off the `/` shortcut |

## Data

- Stations: https://mesonet2.climate.umt.edu/api/stations/?type=json
- Latest record, polled every 5 minutes: https://mesonet2.climate.umt.edu/api/latest/?type=json
- Expected sensors and flagged outages: https://mesonet2.climate.umt.edu/api/elements/?all=true&type=json
- Per-station fallback when `all=true` is not served: `https://mesonet2.climate.umt.edu/api/elements/<station>/?type=json`
- State, reservation and county outlines in `data/`, built by `data.R`.

Each poll is merged into the stored records, because the latest endpoint sometimes drops a station.
Sensor lists are cached in `localStorage` as `mco-status-elements-v2`. Clear it to force a refetch.
Station details link to the dashboard at `https://mesonet2.climate.umt.edu/dash/?s=<id>`.
Cutover: change `MESONET_ORIGIN` in `app.js` and the CSP `connect-src`.

## Tests

From an `mco-web-style` checkout beside this repo:

```sh
node tools/verify/head.mjs       --root ../mesonet-status
node tools/verify/axe-matrix.mjs --config ../mesonet-status/verify.config.mjs
node tools/verify/keyboard.mjs   --config ../mesonet-status/verify.config.mjs
node tools/conformance.mjs ../mesonet-status
```

## Kit

`mco-web-style` 1.1.0.
Design rules: mco-web-style/HOUSE-STYLE.md
