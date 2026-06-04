# Mesonet Station Status

A real-time station status map for the [Montana Mesonet](https://climate.umt.edu/mesonet), built and operated by the [Montana Climate Office](https://climate.umt.edu).

## About

Shows the current reporting state of every station across the HydroMet and AgriMet sub-networks. Two view modes:

- **Status** — green if the station has posted within the last hour, red otherwise.
- **Time since** — choropleth color binned by minutes since the latest record (5 bins, ceiling at >24 h).

Plus sub-network filtering, station search, and a spider-expand interaction for co-located sites. The map is constrained to Montana — panning is clamped and zooming all the way out snaps back to the state extent.

## Data sources

- Stations + metadata: <https://mesonet.climate.umt.edu/api/stations/?type=json>
- Latest record per station: <https://mesonet.climate.umt.edu/api/latest/?type=json>

The latest endpoint is polled every 5 minutes; station colors update every 30 seconds against the local clock so freshness stays current between API calls.

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

- [MapLibre GL JS](https://maplibre.org) (v5.18, CDN) for the map.
- [Stadia Maps](https://stadiamaps.com) Stamen Toner basemap (light + dark variants).
- Vanilla JS / HTML / CSS — no bundler, no framework.

## License

[MIT](LICENSE) — Copyright (c) 2026–present Montana Climate Office
