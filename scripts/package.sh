#!/usr/bin/env bash
# Packages dist/ as a Grafana plugin archive: <plugin-id>-<version>.zip with a folder named after the
# plugin ID inside, as Grafana's plugin catalog and `grafana cli plugins install` expect, plus
# .sha1 and .sha256 checksum files. Run after `npm run build` (and signing, if any).
set -euo pipefail

id=$(node -p "require('./dist/plugin.json').id")
version=$(node -p "require('./dist/plugin.json').info.version")
out=${1:-artifacts}
name="$id-$version.zip"

rm -rf "$out" && mkdir -p "$out/stage"
cp -r dist "$out/stage/$id"
(cd "$out/stage" && zip -qr "../$name" "$id")
rm -rf "$out/stage"
(cd "$out" && sha1sum "$name" | cut -d' ' -f1 > "$name.sha1" && sha256sum "$name" | cut -d' ' -f1 > "$name.sha256")

echo "archive=$out/$name"
echo "version=$version"
