// SPDX-License-Identifier: AGPL-3.0-or-later

import type {EmailConfig, EmailHtmlBranding, EmailMessage, IEmailProvider} from '@pkgs/email/src/EmailProviderTypes';
import {EmailService} from '@pkgs/email/src/EmailService';
import {describe, expect, it} from 'vitest';

const CONFIG: EmailConfig = {
	enabled: true,
	fromEmail: 'noreply@example.test',
	fromName: 'sanalyer',
	appBaseUrl: 'https://app.example.test',
	termsUrl: 'https://example.test/marketing/terms',
	guidelinesUrl: 'https://example.test/marketing/guidelines',
	appealsEmail: 'info@sanalyer.com',
	safetyEmail: 'info@sanalyer.com',
	supportEmail: 'info@sanalyer.com',
	productName: 'sanalyer',
};
const LOGO_URL = 'https://static.example.test/web/android-chrome-192x192.png';
const HTML: EmailHtmlBranding = {
	productName: 'sanalyer',
	logoUrl: LOGO_URL,
	headerColor: '#0B0B0C',
	footer: {
		tr: 'sanalyer, bireysel bir geliştirici tarafından işletilir. İletişim: pr@example.test',
		'en-US': 'sanalyer is operated by an individual developer. Contact: pr@example.test',
	},
};

async function capture(config: EmailConfig, send: (service: EmailService) => Promise<boolean>): Promise<EmailMessage> {
	const sent: Array<EmailMessage> = [];
	await send(
		new EmailService(config, {
			sendEmail: async (message) => {
				sent.push(message);
				return true;
			},
		}),
	);
	return sent[0];
}

function sendIpAuthorization(config: EmailConfig, locale: string, username = 'ayse'): Promise<EmailMessage> {
	return capture(config, (service) =>
		service.sendIpAuthorizationEmail('user@example.test', username, 'tok123', '203.0.113.7', 'Istanbul', locale),
	);
}

async function tempBanHtml(config: EmailConfig, reason: string): Promise<string> {
	const message = await capture(config, (service) =>
		service.sendAccountTempBannedEmail('user@example.test', 'ayse', reason, 24, new Date('2026-09-26T00:00:00Z'), 'tr'),
	);
	return message.html ?? '';
}

describe('EmailService HTML part', () => {
	it('sends the upstream text-only message when no HTML branding is configured', async () => {
		const message = await sendIpAuthorization(CONFIG, 'tr');
		expect(Object.keys(message).sort()).toEqual(['from', 'subject', 'text', 'to']);
	});

	it('leaves the text part unchanged when the HTML part is added', async () => {
		const plain = await sendIpAuthorization(CONFIG, 'tr');
		const branded = await sendIpAuthorization({...CONFIG, html: HTML}, 'tr');
		expect(branded.text).toBe(plain.text);
		expect(branded.subject).toBe(plain.subject);
	});

	it('brands the HTML part with the logo, product name, header colour and action link', async () => {
		const html = (await sendIpAuthorization({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(html).toContain(`src="${LOGO_URL}"`);
		expect(html).toContain('>sanalyer<');
		expect(html).toContain('background-color:#0B0B0C');
		expect(html).toContain('href="https://app.example.test/authorize-ip#token=tok123"');
		expect(html.toLowerCase()).not.toContain('fluxer');
	});

	it('names the header after the instance product name, not the sender name', async () => {
		const html = (await sendIpAuthorization({...CONFIG, fromName: 'sanalyer Bildirim', html: HTML}, 'tr')).html ?? '';
		expect(html).toContain('>sanalyer</span>');
		expect(html).not.toContain('sanalyer Bildirim');
	});

	it('picks the footer for the message locale and falls back to en-US', async () => {
		const tr = (await sendIpAuthorization({...CONFIG, html: HTML}, 'tr')).html ?? '';
		const de = (await sendIpAuthorization({...CONFIG, html: HTML}, 'de')).html ?? '';
		expect(tr).toContain('bireysel bir geliştirici');
		expect(de).toContain('operated by an individual developer');
		expect(de).not.toContain('bireysel');
	});

	it('lays out Arabic and Hebrew right-to-left and other locales left-to-right', async () => {
		const ar = (await sendIpAuthorization({...CONFIG, html: HTML}, 'ar')).html ?? '';
		const he = (await sendIpAuthorization({...CONFIG, html: HTML}, 'he')).html ?? '';
		const tr = (await sendIpAuthorization({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(ar).toContain('<html lang="ar" dir="rtl">');
		expect(ar).toMatch(/<td dir="rtl"[^>]*><h1 /);
		expect(he).toContain('<html lang="he" dir="rtl">');
		expect(tr).toContain('<html lang="tr" dir="ltr">');
		expect(tr).toMatch(/<td dir="ltr"[^>]*><h1 /);
		expect(tr).not.toContain('rtl');
	});

	it('keeps an English fallback footer left-to-right inside a right-to-left email', async () => {
		const ar = (await sendIpAuthorization({...CONFIG, html: HTML}, 'ar')).html ?? '';
		const arFooter = (await sendIpAuthorization({...CONFIG, html: {...HTML, footer: {ar: 'تذييل'}}}, 'ar')).html ?? '';
		expect(ar).toMatch(/<p dir="ltr"[^>]*>sanalyer is operated/);
		expect(arFooter).toMatch(/<p dir="rtl"[^>]*>تذييل/);
	});

	it('escapes user text in the HTML part', async () => {
		const html = (await sendIpAuthorization({...CONFIG, html: HTML}, 'tr', '<img src=x onerror=alert(1)>')).html ?? '';
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('cannot break out of a link href with a quote inside a URL', async () => {
		const html = await tempBanHtml({...CONFIG, html: HTML}, 'https://a.test/x"onmouseover="alert(1)');
		expect(html).toContain('<a href="https://a.test/x" ');
		expect(html).not.toContain('"onmouseover');
		expect(html).toContain('&quot;onmouseover=&quot;alert(1)');
	});

	it('never turns a javascript: URL into a link', async () => {
		const html = await tempBanHtml({...CONFIG, html: HTML}, 'javascript:alert(1)');
		expect(html).toContain('javascript:alert(1)');
		expect(html).not.toContain('href="javascript');
	});

	it('escapes markup in the footer and keeps its line breaks', async () => {
		const html = await tempBanHtml({...CONFIG, html: {...HTML, footer: {tr: '<b>sanalyer</b>\nsatır'}}}, 'spam');
		expect(html).not.toContain('<b>');
		expect(html).toContain('&lt;b&gt;sanalyer&lt;/b&gt;<br>satır');
	});

	it('drops a logo that is not https and a header colour that is not hex', async () => {
		const html =
			(
				await sendIpAuthorization(
					{...CONFIG, html: {...HTML, logoUrl: 'http://static.example.test/logo.png', headerColor: 'red;x:y'}},
					'tr',
				)
			).html ?? '';
		expect(html).toContain('>sanalyer<');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('red;x:y');
		expect(html).toContain('background-color:#0B0B0C');
	});
});

const VERIFY_URL = 'https://app.example.test/verify#token=tok123';
const BUTTON_CELL = 'bgcolor="#5764ef"';
const HARVEST_URL = 'https://cdn.example.test/exports/abc.zip';

function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, '');
}

function sendVerification(config: EmailConfig, locale: string, username = 'ayse', token = 'tok123') {
	return capture(config, (service) => service.sendEmailVerification('user@example.test', username, token, locale));
}

function sendHarvest(config: EmailConfig, downloadUrl = HARVEST_URL) {
	return capture(config, (service) =>
		service.sendHarvestCompletedEmail(
			'user@example.test',
			'ayse',
			downloadUrl,
			1200,
			5 * 1024 * 1024,
			new Date('2026-10-20T00:00:00Z'),
			'tr',
		),
	);
}

describe('EmailService action button', () => {
	it('turns the Turkish verification link into a labelled button with a small fallback link under it', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(html).toMatch(/<a href="https:\/\/app\.example\.test\/verify#token=tok123"[^>]*>E-postamı doğrula<\/a>/);
		expect(html.split(BUTTON_CELL)).toHaveLength(2);
		expect(html).toMatch(
			/<\/table><p style="[^"]*font-size:13px;[^"]*word-break:break-all;[^"]*"><a href="https:\/\/app\.example\.test\/verify#token=tok123"[^>]*>https:\/\/app\.example\.test\/verify#token=tok123<\/a><\/p>/,
		);
		expect(visibleText(html).split(VERIFY_URL)).toHaveLength(2);
	});

	it('labels the English verification button', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'en-US')).html ?? '';
		expect(html).toMatch(/<a href="https:\/\/app\.example\.test\/verify#token=tok123"[^>]*>Verify email<\/a>/);
	});

	it('styles the button like the app add friend button', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(html).toMatch(
			/<td bgcolor="#5764ef" style="background-color:#5764ef;border-radius:8px;[^"]*"><a [^>]*font-weight:600;color:#ffffff;[^>]*border-radius:8px;/,
		);
	});

	it('leaves the verification text part byte for byte unchanged', async () => {
		const plain = await sendVerification(CONFIG, 'tr');
		const branded = await sendVerification({...CONFIG, html: HTML}, 'tr');
		expect(branded.text).toBe(plain.text);
		expect(branded.text).toContain(`\n\n${VERIFY_URL}\n\n`);
	});

	it('escapes the username and the button URL', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'tr', '<b>ayse</b>', 'a&b"c<d')).html ?? '';
		expect(html).toContain('&lt;b&gt;ayse&lt;/b&gt;');
		expect(html).not.toContain('<b>ayse');
		expect(html).toContain('href="https://app.example.test/verify#token=a&amp;b&quot;c&lt;d"');
		expect(html).toContain('>https://app.example.test/verify#token=a&amp;b&quot;c&lt;d</a>');
		expect(html).not.toContain('b"c');
	});

	it('never renders a javascript: action URL as a button or link', async () => {
		const html = (await sendHarvest({...CONFIG, html: HTML}, 'javascript:alert(1)')).html ?? '';
		expect(html).not.toContain('href="javascript');
		expect(html).not.toContain(BUTTON_CELL);
		expect(html).not.toContain('Verilerimi indir');
	});

	it('replaces the URL under the download label with a button and keeps the label text', async () => {
		const plain = await sendHarvest(CONFIG);
		const message = await sendHarvest({...CONFIG, html: HTML});
		const html = message.html ?? '';
		expect(message.text).toBe(plain.text);
		expect(html).toContain('İndirme bağlantısı:');
		expect(html).toMatch(/<a href="https:\/\/cdn\.example\.test\/exports\/abc\.zip"[^>]*>Verilerimi indir<\/a>/);
		expect(visibleText(html).split(HARVEST_URL)).toHaveLength(2);
		expect(html.split(BUTTON_CELL)).toHaveLength(2);
	});

	it('keeps the terms and guidelines URLs as inline links without a button', async () => {
		const html = await tempBanHtml({...CONFIG, html: HTML}, 'spam');
		expect(html).toMatch(
			/<a href="https:\/\/example\.test\/marketing\/terms" style="color:#6ccff9;[^>]*>https:\/\/example\.test\/marketing\/terms<\/a>/,
		);
		expect(html).toMatch(
			/<a href="https:\/\/example\.test\/marketing\/guidelines"[^>]*>https:\/\/example\.test\/marketing\/guidelines<\/a>/,
		);
		expect(html).not.toContain(BUTTON_CELL);
	});
});

describe('EmailService dark layout', () => {
	it('declares a dark colour scheme on the sanalyer dark surfaces', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(html).toContain('<meta name="color-scheme" content="dark">');
		expect(html).toContain('<meta name="supported-color-schemes" content="dark">');
		expect(html).toContain('background-color:#060608');
		expect(html).toContain('background-color:#141519');
		expect(html).toContain('border:1px solid #232329');
		expect(html).toContain('max-width:560px');
	});

	it('puts the subject in the card as the heading and mutes the signature', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'tr')).html ?? '';
		expect(html).toMatch(/<h1 [^>]*color:#f2f2f4;[^>]*>sanalyer e-posta adresini doğrula<\/h1>/);
		expect(html).toMatch(/<p [^>]*color:#8e8e98;[^>]*>– sanalyer Ekibi<\/p>/);
	});

	it('mutes the Hebrew team signature, which has no leading dash', async () => {
		const html = (await sendVerification({...CONFIG, html: HTML}, 'he')).html ?? '';
		expect(html).toMatch(/<p [^>]*color:#8e8e98;[^>]*>צוות sanalyer<\/p>/);
	});

	it('sets a verification code in a monospace code box', async () => {
		const message = await capture({...CONFIG, html: HTML}, (service) =>
			service.sendEmailChangeNew('user@example.test', 'ayse', 'K7QP-2XMD', 'tr'),
		);
		const html = message.html ?? '';
		expect(html).toMatch(/<td [^>]*background-color:#0c0c0f;[^>]*border:1px solid #232329;[^>]*>K7QP-2XMD<\/td>/);
		expect(html).toMatch(/<td [^>]*font-family:ui-monospace,[^>]*font-size:28px;[^>]*>K7QP-2XMD<\/td>/);
		expect(html).not.toContain(BUTTON_CELL);
	});
});

describe('EmailService contact address', () => {
	it('names info@sanalyer.com as the appeals and safety contact', async () => {
		const tempBan = await capture(CONFIG, (service) =>
			service.sendAccountTempBannedEmail('user@example.test', 'ayse', null, 24, new Date('2026-09-26T00:00:00Z'), 'tr'),
		);
		const report = await capture(CONFIG, (service) =>
			service.sendReportResolvedEmail('user@example.test', 'ayse', '123', '', 'tr'),
		);
		expect(tempBan.text).toContain('info@sanalyer.com');
		expect(report.text).toContain('info@sanalyer.com');
		expect(`${tempBan.text}${report.text}`).not.toContain('destek@micup.gg');
	});
});

describe('EmailService referral reward email', () => {
	it('sendReferralRewardReadyEmail renders tr subject/body with username', async () => {
		const message = await capture(CONFIG, (service) =>
			service.sendReferralRewardReadyEmail('user@example.test', 'ayse', 'tr'),
		);
		expect(message.subject).toBe('Referans ödülün hazır');
		expect(message.text).toContain('Merhaba Ayse,');
		expect(message.text).toContain('Ayarlar → Referans');
	});

	it('template params have no code', async () => {
		const message = await capture(CONFIG, (service) =>
			service.sendReferralRewardReadyEmail('user@example.test', 'ayse', 'en-GB'),
		);
		expect(message.text).toContain('Hello Ayse,');
		expect(message.text).not.toMatch(/https?:\/\//);
	});
});

describe('EmailService username capitalisation', () => {
	it('capitalises the first letter with Turkish rules in Turkish emails', async () => {
		const message = await sendVerification({...CONFIG, html: HTML}, 'tr', 'ismail');
		expect(message.text).toContain('Merhaba İsmail,');
		expect(message.html).toContain('Merhaba İsmail,');
		expect((await sendVerification(CONFIG, 'tr', 'ayşe')).text).toContain('Merhaba Ayşe,');
	});

	it('uses the default rules elsewhere and leaves the rest of the name alone', async () => {
		expect((await sendVerification(CONFIG, 'en-US', 'ismail')).text).toContain('Hello Ismail,');
		expect((await sendVerification(CONFIG, 'tr', 'aYSE_42')).text).toContain('Merhaba AYSE_42,');
		expect((await sendVerification(CONFIG, 'not a locale', 'ayse')).text).toContain('Hello Ayse,');
	});

	it('leaves a name that starts with an emoji or a symbol unchanged', async () => {
		expect((await sendVerification(CONFIG, 'tr', '\u{1F600}ayse')).text).toContain('Merhaba \u{1F600}ayse,');
		expect((await sendVerification(CONFIG, 'tr', '_ayse')).text).toContain('Merhaba _ayse,');
	});

	it('changes only the username, not other values such as the new email address', async () => {
		const message = await capture(CONFIG, (service) =>
			service.sendEmailChangeRevert('user@example.test', 'ayse', 'yeni@example.test', 'tok', 'tr'),
		);
		expect(message.text).toContain('Merhaba Ayse,');
		expect(message.text).toContain('yeni@example.test');
	});
});

describe('EmailService welcome greeting', () => {
	it('opens welcome emails with the party popper in the text and HTML parts', async () => {
		const message = await sendVerification({...CONFIG, html: HTML}, 'tr');
		expect(message.text.startsWith('\u{1F389} Merhaba Ayse,')).toBe(true);
		expect(message.html).toContain('<p style="margin:0 0 16px;">\u{1F389} Merhaba Ayse,</p>');
	});

	it('keeps other emails without an emoji', async () => {
		const message = await capture(CONFIG, (service) =>
			service.sendPasswordResetEmail('user@example.test', 'ayse', 'tok', 'tr'),
		);
		expect(message.text.startsWith('Merhaba Ayse,')).toBe(true);
	});
});

async function sendWith(config: EmailConfig): Promise<EmailMessage> {
	const sent: Array<EmailMessage> = [];
	const provider: IEmailProvider = {
		sendEmail: async (message) => {
			sent.push(message);
			return true;
		},
	};
	const service = new EmailService(config, provider);
	await expect(service.sendRegistrationApprovedEmail('user@example.com', 'testuser', 'en-US')).resolves.toBe(true);
	expect(sent).toHaveLength(1);
	return sent[0];
}

describe('EmailService reply-to', () => {
	it('sets the configured reply-to address on every message', async () => {
		const message = await sendWith({...CONFIG, replyTo: 'support@example.com'});
		expect(message.replyTo).toBe('support@example.com');
		expect(message.from).toEqual({email: CONFIG.fromEmail, name: CONFIG.fromName});
	});

	it.each([undefined, null, ''])('omits the reply-to address when it is %j', async (replyTo) => {
		const message = await sendWith({...CONFIG, replyTo});
		expect(message).not.toHaveProperty('replyTo');
	});
});
