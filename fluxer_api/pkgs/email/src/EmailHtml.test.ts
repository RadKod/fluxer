// SPDX-License-Identifier: AGPL-3.0-or-later

import {renderEmailHtml} from '@pkgs/email/src/EmailHtml';
import type {EmailHtmlBranding} from '@pkgs/email/src/EmailProviderTypes';
import {describe, expect, it} from 'vitest';

const BRANDING: EmailHtmlBranding = {productName: 'sanalyer', logoUrl: null, headerColor: null, footer: {}};
const BUTTON_CELL = 'bgcolor="#5764ef"';

function render(body: string, action?: {url: string; label: string}): string {
	return renderEmailHtml({subject: 'Subject', body, locale: 'en-US', branding: BRANDING, action});
}

describe('renderEmailHtml', () => {
	it('renders at most one button when the action URL appears on two lines', () => {
		const html = render('https://a.test/x\n\nhttps://a.test/x', {url: 'https://a.test/x', label: 'Go'});
		expect(html.split(BUTTON_CELL)).toHaveLength(2);
		expect(html).toMatch(/<a href="https:\/\/a\.test\/x"[^>]*>https:\/\/a\.test\/x<\/a>/);
	});

	it('keeps a standalone URL without a label as an inline link', () => {
		const html = render('Hi\n\nhttps://a.test/x/y\n\nBye');
		expect(html).not.toContain(BUTTON_CELL);
		expect(html).toMatch(/<a href="https:\/\/a\.test\/x\/y"[^>]*>https:\/\/a\.test\/x\/y<\/a>/);
		expect(html).not.toContain('>a.test/x/y<');
	});

	it('adds no button when the action URL is not on a line of its own', () => {
		const html = render('Visit https://a.test/x now', {url: 'https://a.test/x', label: 'Go'});
		expect(html).not.toContain(BUTTON_CELL);
		expect(html).not.toContain('>Go<');
	});
});
