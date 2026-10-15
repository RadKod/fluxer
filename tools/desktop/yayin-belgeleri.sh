#!/usr/bin/env bash
# sanalyer: payload_tree/desktop/<kanal>/<platform>/<arch>/manifest.json dosyalarindan, kabugun ve API'nin
# bekledigi "latest" belgelerini uretir ve Linux icin <surum>/appimage kopyasini koyar.
#
#   latest, latest.json : {version, pub_date, files: {<bicim>: {url, sha256}}}
#                         (Updater.ts fetchManualLatest; DownloadRedirects 'latest' -> latest.json)
#   <surum>/appimage    : AppImage dosyasinin kendisi (ShellSelfUpdate.ts: base/<surum>/appimage)
#
# Kullanim: tools/desktop/yayin-belgeleri.sh payload_tree/desktop https://dl.sanalyer.com
set -euo pipefail
root="${1:?payload koku}"
origin="${2:?paket origin, ornek https://dl.sanalyer.com}"
origin="${origin%/}"
here="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "jq gerekli" >&2; exit 1; }

find "$root" -name manifest.json | sort | while read -r manifest; do
	dir="$(dirname "$manifest")"
	rel="${dir#"$root/"}"
	base="$origin/desktop/$rel"
	jq --arg base "$base" -f "$here/latest.jq" "$manifest" > "$dir/latest.json"
	cp "$dir/latest.json" "$dir/latest"
	version="$(jq -r '.version' "$manifest")"
	appimage="$(jq -r '.files.appimage.filename // empty' "$manifest")"
	if [ -n "$appimage" ] && [ -f "$dir/$appimage" ]; then
		mkdir -p "$dir/$version"
		cp "$dir/$appimage" "$dir/$version/appimage"
	fi
	echo "latest yazildi: $rel $version"
done
