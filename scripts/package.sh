#!/usr/bin/env bash
# Packages dist/ as a Grafana plugin archive: <plugin-id>-<version>.zip with a folder named after the
# plugin ID inside, as Grafana's plugin catalog and `grafana cli plugins install` expect, plus
# .sha1 and .sha256 checksum files. Also writes the same archive as <plugin-id>.zip (with checksums):
# attached to every release, it is always the latest one at
# https://github.com/<owner>/<repo>/releases/latest/download/<plugin-id>.zip, so install
# instructions need no version. Run after `npm run build` (and signing, if any).
set -euo pipefail

id=$(node -p "require('./dist/plugin.json').id")
version=$(node -p "require('./dist/plugin.json').info.version")
out=${1:-artifacts}
name="$id-$version.zip"
unversioned="$id.zip"

rm -rf "$out" && mkdir -p "$out/stage"
cp -r dist "$out/stage/$id"
(cd "$out/stage" && zip -qr "../$name" "$id")
rm -rf "$out/stage"
cp "$out/$name" "$out/$unversioned"
for archive in "$name" "$unversioned"; do
  (cd "$out" && sha1sum "$archive" | cut -d' ' -f1 > "$archive.sha1" && sha256sum "$archive" | cut -d' ' -f1 > "$archive.sha256")
done

echo "archive=$out/$name"
echo "unversioned_archive=$out/$unversioned"
echo "version=$version"
