#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# sanalyer masaüstü uygulamasını bu Mac'te (Apple Silicon) imzasız/ad-hoc derler; GitHub Actions'a gitmeden
# önce hızlı deneme döngüsü. İmza ve notarization yalnız CI'da; bu script keychain'e ve Apple hesabına dokunmaz.
#
# Kullanım (worktree kökünden ya da fluxer_desktop içinden):
#   fluxer_desktop/scripts/yerel-mac-build.sh            # native eklentiler + renderer + main + .app/.dmg/.zip
#   SADECE_APP=1 fluxer_desktop/scripts/yerel-mac-build.sh   # dmg/zip yerine yalnız .app (en hızlısı)
#   RENDERER=atla fluxer_desktop/scripts/yerel-mac-build.sh  # fluxer_desktop/dist/renderer duruyorsa renderer'ı yeniden derleme
#
# Çıktı: fluxer_desktop/dist-electron/mac-arm64/sanalyer.app (+ dmg ve zip). Ad-hoc imzalı, bu Mac'te açılır;
# başka Mac'te Gatekeeper uyarı verir. Kanal varsayılan stable: kurulu sanalyer ile aynı bundle id ve kullanıcı
# verisini paylaşır. Ayrı tutmak için BUILD_CHANNEL=canary verilebilir.
#
# Ölçülen süreler (2026-10-16, bu Mac): ilk koşu native ~4.5 dk + renderer ~2 dk + paket ~3.5 dk (dmgbuild
# indirmesi dahil). Önbellek dolunca tam koşu ~3.7 dk (build.mjs ~70 sn, dmg+zip ~2.5 dk);
# SADECE_APP=1 RENDERER=atla ile ~1 dk (build.mjs ~30 sn, .app ~20 sn).
#
# Not: FLUXER_MODULES bilerek açılmıyor. CI'da açık; açıkken uygulama renderer modülünü dl.sanalyer.com'dan
# güncelleyebilir ve yerel renderer değişikliği görünmez olur.

set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
# node_modules'un alınacağı ana checkout (pnpm install burada yapılmış olmalı). Worktree'de pnpm install yapılmaz.
ANA_REPO="${FLUXER_ANA_REPO:-$HOME/Documents/radkod/fluxer}"
BUILD_CHANNEL="${BUILD_CHANNEL:-stable}"
PNPM_SURUM="11.27.0"
RUST_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.98.1-aarch64-apple-darwin}"

adim() { printf '\n==> %s\n' "$*"; }
sure() { local t=$(( $(date +%s) - $1 )); printf '    (%d sn)\n' "$t"; }

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "Bu script Apple Silicon Mac içindir." >&2; exit 1; }

# --- Ortam ---------------------------------------------------------------------------------------------------
# anaconda'nın bin dizini PATH'ten çıkarılır: onun ar/ranlib/clang'ı Xcode'unkileri gölgeliyor.
# /usr/bin öne alınır: oradaki cc/ar/ranlib xcrun kabukları, SDK yolunu kendileri bulur. Xcode toolchain dizinini
# doğrudan PATH'e koymak C derlemesini bozuyor (stdlib.h bulunamıyor).
TEMIZ_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v anaconda | paste -sd: -)"

# Bu Mac'te corepack bozuk; pnpm npx ile, sabit sürümle çağrılır. build.mjs ve CI yardımcısı "pnpm" adını
# çağırdığı için geçici bir kabuk script'i PATH'in başına konur.
SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sanalyer-pnpm.XXXXXX")"
trap 'rm -rf "$SHIM_DIR"' EXIT
printf '#!/bin/sh\nexec npx -y pnpm@%s "$@"\n' "$PNPM_SURUM" > "$SHIM_DIR/pnpm"
chmod +x "$SHIM_DIR/pnpm"

export PATH="$SHIM_DIR:$HOME/.cargo/bin:/usr/bin:$TEMIZ_PATH"
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"

# Renderer'ın wasm parçası (libfluxcore -> zstd-sys) C kodu derliyor. Xcode clang'ı wasm32 hedefini kabul etse
# de Apple ar'ı wasm arşivine sembol indeksi yazamıyor ve link "undefined symbol: ZSTD_*" ile düşüyor.
# Homebrew LLVM'in clang ve llvm-ar'ı açıkça verilir (brew install llvm).
LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
[[ -x "$LLVM_BIN/clang" && -x "$LLVM_BIN/llvm-ar" ]] || { echo "Homebrew llvm bulunamadı: brew install llvm" >&2; exit 1; }
export CC_wasm32_unknown_unknown="$LLVM_BIN/clang"
export AR_wasm32_unknown_unknown="$LLVM_BIN/llvm-ar"
# Genel AR/RANLIB bilerek verilmez; wasm hedefine de uygulanıp aynı hatayı doğuruyor.
unset AR RANLIB

rustup target list --installed --toolchain "$RUST_TOOLCHAIN" | grep -q '^wasm32-unknown-unknown$' || {
	echo "wasm32 hedefi eksik: rustup target add wasm32-unknown-unknown --toolchain $RUST_TOOLCHAIN" >&2
	exit 1
}

# --- node_modules --------------------------------------------------------------------------------------------
# Worktree'de pnpm install yapılmaz; ana checkout'un node_modules'u bağlanır.
# - Kök node_modules gerçek bir dizin olmalı (pnpm sembolik link olan kök node_modules'u reddediyor); içindeki
#   girdiler ana checkout'a mutlak link olur.
# - Paket dizinlerindeki node_modules kopyalanır (yalnız göreli linkler, birkaç KB), böylece workspace paketleri
#   worktree'nin kendi packages/ dizinine çözülür.
# - fluxer_desktop'taki @fluxer/<native> linkleri doğrudan worktree'nin native/<ad> dizinine çevrilir. Böylece
#   build.mjs derlediği .node dosyalarını ana checkout'un node_modules'una kopyalamaz ve paket worktree'de
#   derlenen eklentiyi alır.
node_modules_bagla() {
	[[ -d "$ANA_REPO/node_modules/.pnpm" ]] || { echo "Ana checkout'ta node_modules yok: $ANA_REPO" >&2; exit 1; }
	if [[ -L "$REPO_DIR/node_modules" ]]; then rm "$REPO_DIR/node_modules"; fi
	if [[ ! -d "$REPO_DIR/node_modules" ]]; then
		mkdir "$REPO_DIR/node_modules"
		local girdi
		for girdi in $(ls -A "$ANA_REPO/node_modules"); do
			case "$girdi" in
				.pnpm-task-run-state-v1 | .DS_Store) ;;
				.bin) cp -a "$ANA_REPO/node_modules/.bin" "$REPO_DIR/node_modules/.bin" ;;
				*)
					if [[ -L "$ANA_REPO/node_modules/$girdi" ]]; then
						cp -a "$ANA_REPO/node_modules/$girdi" "$REPO_DIR/node_modules/$girdi"
					else
						ln -s "$ANA_REPO/node_modules/$girdi" "$REPO_DIR/node_modules/$girdi"
					fi
					;;
			esac
		done
	fi
	local d
	while IFS= read -r d; do
		d="${d#./}"
		[[ -d "$REPO_DIR/$(dirname "$d")" && ! -e "$REPO_DIR/$d" ]] || continue
		cp -a "$ANA_REPO/$d" "$REPO_DIR/$d"
	done < <(cd "$ANA_REPO" && find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*' -not -path './node_modules')
	local p hedef
	for p in "$DESKTOP_DIR/node_modules/@fluxer/"*; do
		hedef="$(readlink "$p" || true)"
		if [[ "$hedef" == *.pnpm* ]]; then
			rm "$p"
			ln -s "../../native/$(basename "$p")" "$p"
		fi
	done
}

T0=$(date +%s)
adim "node_modules bağlanıyor ($ANA_REPO)"
node_modules_bagla

cd "$DESKTOP_DIR"

adim "Build kanalı: $BUILD_CHANNEL"
t=$(date +%s)
BUILD_CHANNEL="$BUILD_CHANNEL" pnpm set-channel
sure "$t"

adim "Native eklentiler, renderer ve Electron main (scripts/build.mjs)"
t=$(date +%s)
BUILD_ARGS=()
if [[ "${RENDERER:-}" == "atla" && -f "$DESKTOP_DIR/dist/renderer/index.html" ]]; then
	BUILD_ARGS+=(--use-shared-renderer)
	echo "    renderer yeniden derlenmiyor, mevcut dist/renderer kullanılıyor"
fi
NODE_ENV=production FLUXER_DESKTOP_PRODUCTION=true BUILD_CHANNEL="$BUILD_CHANNEL" node scripts/build.mjs "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}"
sure "$t"

adim "electron-builder (arm64, ad-hoc imza, notarization yok)"
t=$(date +%s)
EB_ARGS=(--config electron-builder.config.cjs --mac --arm64 -c.mac.sign.identity=- -c.mac.notarize=false)
if [[ "${SADECE_APP:-}" == "1" ]]; then EB_ARGS+=(--dir); fi
# CSC_IDENTITY_AUTO_DISCOVERY=false: keychain'deki Developer ID sertifikası aranmaz.
CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_ARCH=arm64 BUILD_CHANNEL="$BUILD_CHANNEL" \
	pnpm exec electron-builder "${EB_ARGS[@]}"
sure "$t"

APP="$(ls -d "$DESKTOP_DIR"/dist-electron/mac-arm64/*.app | head -1)"
codesign --verify --deep --strict "$APP"
adim "Tamam ($(( $(date +%s) - T0 )) sn)"
echo "    $APP"
ls -1 "$DESKTOP_DIR"/dist-electron/*.dmg "$DESKTOP_DIR"/dist-electron/*.zip 2>/dev/null | sed 's/^/    /' || true
echo "    Açmak için: open \"$APP\""
