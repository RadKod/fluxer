// SPDX-License-Identifier: AGPL-3.0-or-later

import type {EmailHtmlBranding} from '@pkgs/email/src/EmailProviderTypes';

// Micup dark theme tokens from fluxer_app/scripts/GenerateColorSystem.ts (coal block; link is the dark --text-link).
const PAGE_COLOR = '#060608';
const CARD_COLOR = '#141519';
const BORDER_COLOR = '#232329';
const HEADING_COLOR = '#f2f2f4';
const BODY_COLOR = '#dedee4';
const MUTED_COLOR = '#8e8e98';
const LINK_COLOR = '#6ccff9';
// The action button follows the app's add friend button instead of the white accent.
const BUTTON_COLOR = '#5764ef';
const BUTTON_TEXT_COLOR = '#ffffff';
const CODE_COLOR = '#0c0c0f';
const HEADER_COLOR = '#0B0B0C';
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/;
const CODE_PATTERN = /^(?=.*[\d-])[A-Za-z0-9-]{4,32}$/;
const RTL_LOCALES = new Set(['ar', 'he']);
// Hebrew sign-offs start with "צוות" (team) instead of a dash.
const SIGNATURE = /^(?:–|צוות )/;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO_FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

interface EmailHtmlAction {
	url: string;
	label: string;
}

interface EmailHtmlInput {
	subject: string;
	body: string;
	locale: string;
	branding: EmailHtmlBranding;
	action?: EmailHtmlAction;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function isWebUrl(value: string): boolean {
	return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

function renderText(text: string, style = 'margin:0 0 16px;'): string {
	const html = text
		.split(URL_SPLIT)
		.map((part, index) =>
			index % 2 && isWebUrl(part)
				? `<a href="${escapeHtml(part)}" style="color:${LINK_COLOR};text-decoration:underline;word-break:break-all;">${escapeHtml(part)}</a>`
				: escapeHtml(part),
		)
		.join('')
		.replaceAll('\n', '<br>');
	return `<p style="${style}">${html}</p>`;
}

function renderButton({url, label}: EmailHtmlAction): string {
	const href = escapeHtml(url);
	return `<table ${TABLE} style="margin:8px 0 12px;"><tr><td bgcolor="${BUTTON_COLOR}" style="background-color:${BUTTON_COLOR};border-radius:8px;mso-padding-alt:14px 28px;"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:${BUTTON_TEXT_COLOR};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a></td></tr></table><p style="margin:0 0 24px;font-size:13px;line-height:18px;word-break:break-all;"><a href="${href}" target="_blank" style="color:${MUTED_COLOR};text-decoration:underline;">${href}</a></p>`;
}

function renderCode(code: string): string {
	return `<table ${TABLE} style="margin:8px 0 24px;"><tr><td bgcolor="${CODE_COLOR}" style="background-color:${CODE_COLOR};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:16px 20px 16px 24px;font-family:${MONO_FONT};font-size:28px;line-height:36px;font-weight:700;letter-spacing:4px;color:${HEADING_COLOR};word-break:break-all;-webkit-user-select:all;user-select:all;">${escapeHtml(code)}</td></tr></table>`;
}

function renderBody(body: string, action: EmailHtmlAction | undefined): string {
	let pending = action && isWebUrl(action.url) ? action : undefined;
	const paragraphs = body
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
	return paragraphs
		.map((paragraph, index) => {
			const lines = paragraph.split('\n');
			const actionLine = pending ? lines.findIndex((line) => line.trim() === pending?.url) : -1;
			if (pending && actionLine >= 0) {
				const before = lines.slice(0, actionLine).join('\n').trim();
				const after = lines
					.slice(actionLine + 1)
					.join('\n')
					.trim();
				const button = renderButton(pending);
				pending = undefined;
				return `${before && renderText(before)}${button}${after && renderText(after)}`;
			}
			if (CODE_PATTERN.test(paragraph)) {
				return renderCode(paragraph);
			}
			if (index === paragraphs.length - 1 && SIGNATURE.test(paragraph)) {
				return renderText(paragraph, `margin:24px 0 0;color:${MUTED_COLOR};`);
			}
			return renderText(paragraph);
		})
		.join('');
}

export function renderEmailHtml({subject, body, locale, branding, action}: EmailHtmlInput): string {
	const headerColor =
		branding.headerColor && HEX_COLOR.test(branding.headerColor) ? branding.headerColor : HEADER_COLOR;
	const dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
	const logo = branding.logoUrl?.startsWith('https://')
		? `<img src="${escapeHtml(branding.logoUrl)}" width="40" height="40" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:10px;margin:${dir === 'rtl' ? '0 0 0 12px' : '0 12px 0 0'};">`
		: '';
	const footer = branding.footer[locale] ?? branding.footer['en-US'];
	const footerDir = Object.hasOwn(branding.footer, locale) ? dir : 'ltr';
	return `<!doctype html>
<html lang="${escapeHtml(locale)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(subject)}</title>
<style>:root{color-scheme:dark;}@media (max-width:480px){.email-pad{padding-left:20px !important;padding-right:20px !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_COLOR};-webkit-text-size-adjust:100%;">
<table ${TABLE} width="100%" bgcolor="${PAGE_COLOR}" style="background-color:${PAGE_COLOR};">
<tr><td align="center" style="padding:32px 16px;">
<!--[if mso]><table ${TABLE} width="560" align="center"><tr><td><![endif]-->
<table ${TABLE} width="100%" bgcolor="${CARD_COLOR}" style="max-width:560px;background-color:${CARD_COLOR};border:1px solid ${BORDER_COLOR};border-radius:12px;overflow:hidden;">
<tr><td class="email-pad" bgcolor="${headerColor}" style="background-color:${headerColor};padding:20px 32px;border-bottom:1px solid ${BORDER_COLOR};font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:#ffffff;">${logo}<span style="vertical-align:middle;">${escapeHtml(branding.productName)}</span></td></tr>
<tr><td dir="${dir}" class="email-pad" style="padding:32px;font-family:${FONT};font-size:16px;line-height:26px;color:${BODY_COLOR};word-wrap:break-word;"><h1 style="margin:0 0 20px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${HEADING_COLOR};">${escapeHtml(subject)}</h1>${renderBody(body, action)}</td></tr>
</table>
${footer ? `<p dir="${footerDir}" style="max-width:560px;margin:20px auto 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED_COLOR};text-align:center;">${escapeHtml(footer).replaceAll('\n', '<br>')}</p>` : ''}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
