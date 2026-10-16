#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// sanalyer: fluxer_docs içeriğini (src/content/docs) sanalyer'e markalar.
//
// Kullanım (repo kökünden):
//   node tools/brand/docs-marka.mjs            kuralları uygular, dosya başına özet basar
//   node tools/brand/docs-marka.mjs --dry-run  yazmadan ne değişeceğini gösterir
//   node tools/brand/docs-marka.mjs --check    hiçbir şey yazmaz; kullanıcıya görünen kalan
//                                              Fluxer/Micup izlerini listeler, varsa çıkış kodu 1
//
// Haftalık upstream merge'den sonra: docs içeriğinde çakışma çıkarsa upstream'in halini al
// (`git checkout --theirs fluxer_docs/src/content`), sonra bu script'i çalıştır ve `--check` ile bak.
// Script idempotent: ikinci çalıştırma hiçbir şey değiştirmez. Elle yapılan içerik düzeltmeleri
// bu dosyadaki tablolara yazılır, içerik dosyasına doğrudan değil; yoksa bir sonraki merge'de kaybolur.
//
// Kodda kalan, bilerek dokunulmayan adlar: X-Fluxer-* başlıkları, FLUXER_* env adları, @fluxer/* paketleri,
// /.well-known/fluxer keşif yolu, fluxer_* / micupbot gibi tanımlayıcılar, upstream kaynak repo URL'leri
// (github.com/fluxerapp/...), lisans başlıkları. Bunlar wire/sözleşme adlarıdır; değiştirmek belgeyi yanlış yapar.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KOK = path.join(REPO, 'fluxer_docs/src/content/docs');

// ---------------------------------------------------------------------------------------------
// KURAL TABLOSU
// ---------------------------------------------------------------------------------------------

// 1) Gizlenen sayfalar. Dosya silinmez (upstream merge'de modify/delete çakışması olmasın diye);
//    frontmatter'a `draft: true` yazılır, Starlight bunları production build'e almaz. Gövdeleri
//    markalanmaz ve --check'te sayılmaz. Başka sayfalardan bunlara giden linkler düz metne çevrilir.
//    Kenar çubuğundaki karşılıkları fluxer_docs/astro.config.ts içinde (branded dalı) çıkarıldı.
const GIZLI_SAYFALAR = [
	// Upstream'in kendi sunucunu kur rehberi: sanalyer kullanıcısını yanıltır, kurulum Fluxer imajlarını çeker.
	'operator/get-started',
	'operator/sign-in',
	'operator/configuration',
	'operator/reverse-proxy',
	'operator/upgrading',
	'operator/kubernetes',
	// pkgs.fluxer.com paket deposu ve Fluxer masaüstü yolları. Bizim karşılığımız downloads/overview'da.
	'downloads/desktop',
	'downloads/linux-repositories',
	// Fluxer şirketinin ödeme altyapısı (Stripe ödeme, mağaza içi satın alma, bağış). sanalyer'de kapalı.
	'http-api/billing',
	'http-api/donations',
	'http-api/in-app-purchases',
	// Duyuru kanalları kapalı; DocsBranding.ts zaten draft yapıyor, burada da --check dışında tutulur.
	'topics/announcement-channels',
];

// 2) Baştan yazılan sayfalar. Upstream metni bizim bağlamımızda doğru olmadığı için içerik tamamen
//    buradaki metinle değiştirilir. Upstream bu sayfaları değiştirse de bizim metin kazanır.
const YENIDEN_YAZILAN_SAYFALAR = {
	'index.md': `---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: sanalyer API
description: Build bots, tools and clients for sanalyer.
---

sanalyer is the chat service at [sanalyer.com](https://sanalyer.com). These pages describe its HTTP API, Gateway, media proxy and admin API.

- To build a client or a bot, start with the [HTTP API](/http-api/) and the [Gateway](/gateway/overview/).
- For a first bot in Python, read the Turkish [quick start](/bots/hizli-baslangic/).
- For voice and screen sharing, read [Voice](/voice/).
- The desktop app is on the [download page](https://sanalyer.com/indir).

Questions about the API go to [info@sanalyer.com](mailto:info@sanalyer.com).

## Protocol surfaces

Use the HTTP API to read and change resources, and Gateway [events](/gateway/events/) to receive updates. The [Media Proxy](/media-proxy/overview/) serves media and uploads. The [Admin API](/admin-api/) provides privileged instance management.

## Shared contracts

See [Authentication](/authentication/), [Errors](/http-api/errors/), [Rate limits](/topics/rate-limits/) and [Locales](/topics/locales/) for shared behaviour. Most resource identifiers are [snowflakes](/snowflakes/). Each resource page states where it differs from this shared behaviour.

## Field notation

In field tables, \`?\` after a field name means optional. Before a type, it means nullable.

| Field | Type | Meaning |
| --- | --- | --- |
| \`name\` | \`string\` | Required and cannot be \`null\` |
| \`name?\` | \`string\` | Optional, but cannot be \`null\` when present |
| \`name\` | \`?string\` | Required, but can be \`null\` |
| \`name?\` | \`?string\` | Nullish, so it can be omitted or set to \`null\` |

An omitted field is different from a field set to \`null\`. Each operation explains how these values affect the resource.

In the type column, \`array[type]\` is an array of the named type, and \`map[key, value]\` is a JSON object keyed by the first type with values of the second.

## Endpoint discovery

Start with \`GET /.well-known/fluxer\` on the instance origin. It requires no authentication and allows cross-origin requests. The path keeps its upstream name; it is part of the protocol.

\`\`\`text
GET https://sanalyer.com/.well-known/fluxer
\`\`\`

Read base URLs from the response's [endpoints](/http-api/instance/#instance-endpoints-object). Do not derive them from the origin or hard-code them.

- Bots, libraries and third-party clients use \`endpoints.api_public\`.
- The first-party web application uses \`endpoints.api_client\`. \`endpoints.api\` is an alias for it.

Use \`/v1\` paths and send credentials in the \`Authorization\` header as described in [Authentication](/authentication/).

## Source code

sanalyer runs on open-source software licensed under the AGPLv3. Our modified source is on [GitHub](https://github.com/RadKod/fluxer); the upstream project is [fluxerapp/fluxer](https://github.com/fluxerapp/fluxer).
`,
	'downloads/overview.md': `---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: Downloads
description: Where the sanalyer desktop app is published.
---

The sanalyer desktop app for macOS, Windows and Linux is on the [download page](https://sanalyer.com/indir). The page detects your platform and lists the current packages.

## Package origin

Packages are served from \`https://dl.sanalyer.com\`, a static origin that needs no credential. Only the \`stable\` channel is published.

\`\`\`
GET https://dl.sanalyer.com/desktop/stable/{platform}/{arch}/latest
\`\`\`

\`platform\` is \`darwin\`, \`win32\` or \`linux\`, and \`arch\` is \`x64\` or \`arm64\`. The \`latest\` document is JSON naming the current \`version\`, its \`pub_date\`, and under \`files\` one entry per package format with its \`url\` and \`sha256\`. The macOS packages are universal builds, so both macOS architectures name the same files.
`,
};

// 3) Bağlama özel cümle kuralları. Genel ad kuralından ÖNCE çalışır. Her satır:
//    [dosya ('*' = hepsi), aranan (string ya da RegExp), yerine, etiket]
//    Passkey köprüsü: upstream'in resmi instance'ı fluxer.app'ten fluxer.com'a taşınıyor; bu alan adları
//    kodda sabit, sanalyer'de bu rotalar 403 döner. sanalyer.com yazmak yanlış olur, o yüzden alan adları
//    "upstream eski/yeni alan adı" diye tarif edilir.
const PASSKEY = ['http-api/authentication.mdx', 'http-api/users/mfa.mdx', 'http-api/index.md', 'http-api/webhooks.mdx'];
const CUMLE_KURALLARI = [
	...PASSKEY.flatMap((d) => [
		[d, '`https://web.canary.fluxer.app`', 'the upstream legacy canary origin', 'passkey-alan-adi'],
		[d, '`https://web.fluxer.app`', 'the upstream legacy web origin', 'passkey-alan-adi'],
		[d, '`https://canary.fluxer.com`', 'the upstream new canary origin', 'passkey-alan-adi'],
		[d, '`https://fluxer.com`', 'the upstream new web origin', 'passkey-alan-adi'],
		[d, '`web.canary.fluxer.app`', 'the upstream legacy canary host', 'passkey-alan-adi'],
		[d, '`web.fluxer.app`', 'the upstream legacy web host', 'passkey-alan-adi'],
		[d, /`fluxer\.app`(?= (?:passkeys?|credential|ones)\b)/g, 'legacy-domain', 'passkey-alan-adi'],
		[d, /`fluxer\.com`(?= (?:passkeys?|credential|ones)\b)/g, 'new-domain', 'passkey-alan-adi'],
		[d, /(?:the )?`fluxer\.app`/g, 'the legacy domain', 'passkey-alan-adi'],
		[d, /(?:the )?`fluxer\.com`/g, 'the new domain', 'passkey-alan-adi'],
		[d, /(?<!upstream )\bofficial (instance|web client)\b/g, 'upstream official $1', 'passkey-resmi-instance'],
		[d, /\bThe official instance\b/g, 'The upstream official instance', 'passkey-resmi-instance'],
	]),
	// Fluxer'ın kendisinin işlettiği şeyler: "sanalyer" demek yanlış olur.
	['*', 'The deployment Fluxer hosts', 'The upstream project’s hosted deployment', 'upstream-hosted'],
	['*', 'the instance Fluxer hosts', 'the upstream project’s hosted instance', 'upstream-hosted'],
	['*', 'Fluxer-run push relay', 'push relay run by the upstream project', 'upstream-hosted'],
	['*', 'Fluxer-run relay', 'relay run by the upstream project', 'upstream-hosted'],
	['*', "Fluxer's own abuse defences", "the instance's own abuse defences", 'upstream-hosted'],
	['*', /\bupstream (?:Fluxer|sanalyer) code\b/g, 'upstream code', 'upstream-hosted'],
	[
		'admin-api/instance.mdx',
		'Apple and Google for the official mobile apps',
		'Apple and Google for the upstream mobile apps',
		'upstream-hosted',
	],
	// Tablo hücresi 120 karakter stil sınırını "sanalyer" uzunluğuyla aşıyordu (VerifyDocsStyle).
	[
		'gateway/commands.md',
		/no response when (?:Fluxer|sanalyer|the server) discards/g,
		'no response when it discards',
		'stil-siniri',
	],
	// MicupBOT, uygulamada "Topluluk botu" diye görünüyor; rota ve feature adları (micupbot) wire adı, kalır.
	['http-api/guild-micupbot.mdx', 'MicupBOT is the instance', 'The community bot is the instance', 'micupbot'],
	[
		'http-api/guild-micupbot.mdx',
		'Applications appear in order: MicupBOT, then',
		'Applications appear in order: the community bot, then',
		'micupbot',
	],
	[
		'http-api/instance.mdx',
		'enable [MicupBOT](/http-api/guild-micupbot/)',
		'enable the [community bot](/http-api/guild-micupbot/)',
		'micupbot',
	],
	// errors.md: "Fluxer" burada upstream varsayılan ürün adı (bir değer), sanalyer değil.
	[
		'http-api/errors.md',
		'or one still named Fluxer,',
		'or one still named with the upstream default,',
		'urun-adi-degeri',
	],
	// Kod bloğu örnekleri (ad kuralı kod bloğunda çalışmadığı için tek tek).
	// Rapor akışı metinleri sunucuda {product_name} ile üretiliyor, sanalyer'de "sanalyer" yazıyor.
	[
		'http-api/reports.mdx',
		'Read the Fluxer Community Guidelines',
		'Read the sanalyer Community Guidelines',
		'kod-ornegi',
	],
	['http-api/reports.mdx', "under Fluxer's minimum age", "under sanalyer's minimum age", 'kod-ornegi'],
	// Identify örneğindeki istemci adı serbest bir değer; bir bot örneği gibi gösterilir.
	['*', '"browser": "Fluxer Client"', '"browser": "my-bot"', 'kod-ornegi'],
	// Örnek rapor yanıtındaki topluluk kuralları adresi.
	['*', 'https://fluxer.app/guidelines', 'https://sanalyer.com/kullanim-kosullari', 'alan-adi'],
	// Media proxy'nin dışarı giden User-Agent'ı (fluxer_media_proxy/src/constants.rs ile aynı olmalı).
	['*', 'Fluxerbot/1.0; +https://fluxer.app', 'sanalyerbot/1.0; +https://sanalyer.com', 'user-agent'],
];

// 4) Alan adı kuralları. Kalan her fluxer/micup adresi sanalyer'deki karşılığına gider.
//    Sıra önemli: özelden genele.
const ALAN_ADI_KURALLARI = [
	[/https:\/\/fluxer\.app\/(?:plutonium|pass)\b/g, 'https://sanalyer.com', 'alan-adi'],
	[/https:\/\/fluxer\.app\/donate\b/g, 'https://sanalyer.com', 'alan-adi'],
	[/https:\/\/api\.fluxer\.app/g, 'https://sanalyer.com/api', 'alan-adi'],
	[/https:\/\/docs\.fluxer\.app/g, 'https://sanalyer.com/docs', 'alan-adi'],
	[/https:\/\/fluxer\.dev/g, 'https://sanalyer.com/docs', 'alan-adi'],
	[/https:\/\/pkgs\.fluxer\.com/g, 'https://dl.sanalyer.com', 'alan-adi'],
	[/https:\/\/(?:web\.)?(?:canary\.)?fluxer\.(?:app|com)/g, 'https://sanalyer.com', 'alan-adi'],
	[/https:\/\/(?:www\.)?micup\.gg/g, 'https://sanalyer.com', 'alan-adi'],
	// Destek ve iletişim adresleri.
	[/\b[\w.+-]+@(?:fluxer\.(?:app|com|dev)|micup\.gg)\b/g, 'info@sanalyer.com', 'e-posta'],
];

// 5) Ürün adı kuralları. Kod bloklarında (```) çalışmaz; satır içi `kod`da çalışır, çünkü orada geçen
//    "Fluxer" kelimesi bir değer (ör. `Fluxer Admin` uygulama adı, sunucu bunu ürün adından üretir).
//    Önündeki/arkasındaki karakter kontrolü X-Fluxer-*, app.fluxer.Fluxer, @fluxer gibi tanımlayıcıları korur.
const AD_KURALLARI = [
	[/(?<![\w.@/-])Fluxer Plus(?![\w-])/g, 'sanalyer Plus', 'plus'],
	[/(?<![\w.@/-])Fluxer Plutonium(?![\w-])/g, 'sanalyer Plus', 'plus'],
	[/(?<![\w.@/$-])Fluxer(?![\w-])/g, 'sanalyer', 'urun-adi'],
	[/(?<![\w.@/$-])Micup(?![\w-])/g, 'sanalyer', 'urun-adi'],
];

// 6) Türkçe ek düzeltmesi: "Fluxer'a" → "sanalyer'a" olur, doğrusu "sanalyer'e" (son hece "-yer", ince ünlü).
//    Yalnız Türkçe sayfalarda çalışır. Türkçe sayfa: listede olan ya da gövdesinde Türkçe harf geçen.
const TURKCE_SAYFALAR = ['bots/hizli-baslangic.mdx'];
const TURKCE_EKLER = [
	[/sanalyer['’](?:y?a|e)\b/g, "sanalyer'e"],
	[/sanalyer['’](?:y?ı|y?u)\b/g, "sanalyer'i"],
	[/sanalyer['’](?:n?ın|n?un)\b/g, "sanalyer'in"],
	[/sanalyer['’](?:da|ta)\b/g, "sanalyer'de"],
	[/sanalyer['’](?:dan|tan)\b/g, "sanalyer'den"],
	[/sanalyer['’](?:la|yla)\b/g, "sanalyer'le"],
];

// 7) --check: kullanıcıya görünen izler. İzin verilen tanımlayıcılar bu desenlere zaten takılmaz.
const KONTROL_DESENI =
	/(?<![\w.@/$-])Fluxer(?:bot)?(?![\w-])|(?<![\w-])fluxer\.(?:app|com|dev)\b|micup\.gg|(?<![\w.@/$-])Micup(?:BOT)?(?![\w-])/g;
// Bilerek bırakılanları raporda göstermek için (hata sayılmaz).
const IZINLI_DESEN =
	/X-Fluxer-[\w-]+|FLUXER_\w+|@fluxer\/[\w-]+|\/\.well-known\/fluxer|github\.com\/fluxerapp\/[\w./-]+|\bmicupbot\b|MICUPBOT_\w+|\bfluxer_\w+/g;

// ---------------------------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const DRY = args.has('--dry-run');

function listFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full));
		else if (/\.mdx?$/.test(entry.name)) out.push(full);
	}
	return out.sort();
}

const rel = (file) => path.relative(KOK, file).split(path.sep).join('/');
const pageOf = (relPath) => relPath.replace(/\.mdx?$/, '');
const gizliMi = (relPath) => GIZLI_SAYFALAR.includes(pageOf(relPath));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GIZLI_LINK = new RegExp(
	`(?<!!)\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]\\(/(?:${GIZLI_SAYFALAR.map(escapeRe).join('|')})/(?:#[^)\\s]*)?\\)`,
	'g',
);

function replaceCounting(text, pattern, replacement, counts, label) {
	let n = 0;
	let out;
	if (typeof pattern === 'string') {
		const parts = text.split(pattern);
		n = parts.length - 1;
		out = parts.join(replacement);
	} else {
		out = text.replace(pattern, (...m) => {
			n += 1;
			return replacement.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
		});
	}
	if (n > 0) counts[label] = (counts[label] ?? 0) + n;
	return out;
}

// Metni kod bloğu olan/olmayan parçalara ayırır.
function segments(text) {
	const parts = [];
	const re = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last) parts.push({code: false, text: text.slice(last, m.index)});
		parts.push({code: true, text: m[0]});
		last = m.index + m[0].length;
	}
	if (last < text.length) parts.push({code: false, text: text.slice(last)});
	return parts;
}

function setDraft(text, counts) {
	const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
	if (!fm || /^draft:\s*true\s*$/m.test(fm[1])) return text;
	counts['gizli-sayfa'] = 1;
	return text.replace(/^---\n([\s\S]*?)\n---\n/, (_, body) => `---\n${body}\ndraft: true\n---\n`);
}

function brand(relPath, text) {
	const counts = {};
	if (gizliMi(relPath)) return {text: setDraft(text, counts), counts};
	if (relPath in YENIDEN_YAZILAN_SAYFALAR) {
		const next = YENIDEN_YAZILAN_SAYFALAR[relPath];
		if (next !== text) counts['yeniden-yazildi'] = 1;
		return {text: next, counts};
	}
	const turkce = TURKCE_SAYFALAR.includes(relPath) || /[ğışĞİŞ]/.test(text);
	const out = segments(text)
		.map(({code, text: part}) => {
			for (const [file, pattern, replacement, label] of CUMLE_KURALLARI) {
				if (file === '*' || file === relPath) part = replaceCounting(part, pattern, replacement, counts, label);
			}
			for (const [pattern, replacement, label] of ALAN_ADI_KURALLARI)
				part = replaceCounting(part, pattern, replacement, counts, label);
			if (code) return part;
			part = replaceCounting(part, GIZLI_LINK, '$1', counts, 'gizli-sayfa-linki');
			for (const [pattern, replacement, label] of AD_KURALLARI)
				part = replaceCounting(part, pattern, replacement, counts, label);
			if (turkce)
				for (const [pattern, replacement] of TURKCE_EKLER)
					part = replaceCounting(part, pattern, replacement, counts, 'turkce-ek');
			return part;
		})
		.join('');
	return {text: out, counts};
}

function lineOf(text, index) {
	return text.slice(0, index).split('\n').length;
}

function check() {
	let kalan = 0;
	const izinli = {};
	for (const file of listFiles(KOK)) {
		const relPath = rel(file);
		if (gizliMi(relPath)) continue;
		const text = fs.readFileSync(file, 'utf8');
		for (const m of text.matchAll(KONTROL_DESENI)) {
			kalan += 1;
			const line = text.split('\n')[lineOf(text, m.index) - 1];
			console.log(`${relPath}:${lineOf(text, m.index)}: ${m[0]}  |  ${line.trim().slice(0, 140)}`);
		}
		for (const m of text.matchAll(GIZLI_LINK)) {
			kalan += 1;
			console.log(`${relPath}:${lineOf(text, m.index)}: gizli sayfaya link  |  ${m[0].slice(0, 140)}`);
		}
		for (const m of text.matchAll(IZINLI_DESEN)) {
			const key = m[0].replace(/^(X-Fluxer-|FLUXER_|fluxer_|MICUPBOT_).*/, '$1*');
			izinli[key] = (izinli[key] ?? 0) + 1;
		}
	}
	console.log(`\nKullanıcıya görünen kalan iz: ${kalan}`);
	console.log('Bilerek bırakılan tanımlayıcılar (hata değil):');
	for (const [key, n] of Object.entries(izinli).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${key}`);
	console.log(`Gizli (build'e girmeyen) sayfalar: ${GIZLI_SAYFALAR.length}`);
	process.exitCode = kalan === 0 ? 0 : 1;
}

function apply() {
	const toplam = {};
	let degisen = 0;
	for (const relPath of Object.keys(YENIDEN_YAZILAN_SAYFALAR)) {
		if (!fs.existsSync(path.join(KOK, relPath))) console.warn(`uyarı: yeniden yazılacak sayfa yok: ${relPath}`);
	}
	for (const page of GIZLI_SAYFALAR) {
		if (!['.md', '.mdx'].some((ext) => fs.existsSync(path.join(KOK, page + ext))))
			console.warn(`uyarı: gizlenecek sayfa yok (upstream silmiş olabilir): ${page}`);
	}
	for (const file of listFiles(KOK)) {
		const relPath = rel(file);
		const before = fs.readFileSync(file, 'utf8');
		const {text, counts} = brand(relPath, before);
		if (text === before) continue;
		degisen += 1;
		if (!DRY) fs.writeFileSync(file, text);
		const ozet = Object.entries(counts)
			.map(([k, n]) => `${k}=${n}`)
			.join(' ');
		console.log(`${relPath}: ${ozet}`);
		for (const [k, n] of Object.entries(counts)) toplam[k] = (toplam[k] ?? 0) + n;
	}
	console.log(`\n${DRY ? '(dry-run) ' : ''}${degisen} dosya değişti.`);
	for (const [k, n] of Object.entries(toplam).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
	const stale = CUMLE_KURALLARI.filter(([file, pattern, replacement]) => {
		if (file === '*' || typeof pattern !== 'string' || PASSKEY.includes(file)) return false;
		const p = path.join(KOK, file);
		if (!fs.existsSync(p)) return true;
		const t = fs.readFileSync(p, 'utf8');
		return !t.includes(pattern) && !t.includes(replacement);
	});
	for (const [file, pattern] of stale)
		console.warn(`uyarı: cümle kuralı artık eşleşmiyor (upstream metni değişmiş olabilir): ${file}: ${pattern}`);
}

if (CHECK) check();
else apply();
