#!/usr/bin/env bash
# Rebuild vendor/ from pinned npm releases (the app is served from the repo
# root, so vendor/ sits beside app.js). Self-hosted rather than CDN:
# hyparquet ships as many ES modules (no single file to pin with SRI), and
# 'self' needs no CSP entry. Bump a version here, re-run, commit the output
# and the printed sha384s.
set -euo pipefail
HYPARQUET=1.31.1
FZSTD=0.1.1
ESBUILD=0.25.10
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "hyparquet@$HYPARQUET" "fzstd@$FZSTD" "esbuild@$ESBUILD"
cat > entry.js <<JS
export { parquetMetadataAsync, parquetReadObjects, asyncBufferFromUrl } from 'hyparquet';
export { decompress as zstdDecompress } from 'fzstd';
JS
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof \
  --outfile="$here/vendor/parquet.min.js"
for f in "$here"/vendor/*.js; do
  echo "$(basename "$f") sha384-$(openssl dgst -sha384 -binary "$f" | openssl base64 -A)"
done
echo "hyparquet@$HYPARQUET fzstd@$FZSTD" > "$here/vendor/VERSIONS"
