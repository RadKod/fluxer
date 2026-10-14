// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import type {APIConfig} from '@app/api/config/APIConfig';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {createRuntimeEmailService} from '@app/api/middleware/ServiceSingletons';
import type {InstanceBranding} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import nodemailer from 'nodemailer';
import {describe, expect, it, vi} from 'vitest';

const BRANDING: InstanceBranding = {
	product_name: 'sanalyer',
	premium_product_name: 'Plus',
	premium_info_url: null,
	icon_url: 'https://static.example.test/icon.png',
	symbol_url: null,
	logo_url: null,
	wordmark_url: null,
	favicon_url: null,
	theme_color: '#0B0B0C',
	status_page_url: null,
	status_page_incident_history_url: null,
};

async function sendThroughRuntime(htmlEnabled: boolean) {
	const transport = nodemailer.createTransport({streamTransport: true, buffer: true});
	const sendMail = vi.spyOn(transport, 'sendMail');
	const createTransport = vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => transport as never);
	const emailConfig: APIConfig['email'] = {
		...Config.email,
		enabled: true,
		provider: 'smtp',
		fromName: 'sanalyer Bildirim',
		smtp: {host: 'smtp.example.test', port: 465, username: 'user', password: 'pass', secure: true},
		htmlEnabled,
		htmlFooter: {},
	};
	const getAppPublicConfig = vi.fn(async () => ({branding: BRANDING}));
	const repository = {
		getEffectiveEmailConfig: async () => emailConfig,
		getAppPublicConfig,
	} as unknown as InstanceConfigRepository;
	try {
		const service = createRuntimeEmailService({isEmailBounced: async () => false}, () => repository);
		const sent = await service.sendIpAuthorizationEmail(
			'user@example.test',
			'ayse',
			'tok123',
			'203.0.113.7',
			'Istanbul',
			'tr',
		);
		expect(sent).toBe(true);
		const info = await sendMail.mock.results[0].value;
		return {
			html: sendMail.mock.calls[0][0].html,
			mime: info.message.toString(),
			brandingReads: getAppPublicConfig.mock.calls.length,
		};
	} finally {
		createTransport.mockRestore();
	}
}

describe('runtime email service HTML part', () => {
	it('sends the upstream single-part text email and skips the branding read when the flag is off', async () => {
		const {html, mime, brandingReads} = await sendThroughRuntime(false);
		expect(brandingReads).toBe(0);
		expect(html).toBeUndefined();
		expect(mime).toMatch(/^Content-Type: text\/plain/m);
		expect(mime).not.toContain('multipart');
		expect(mime).not.toContain('text/html');
	});

	it('sends multipart/alternative with the instance branding when the flag is on', async () => {
		const {html, mime, brandingReads} = await sendThroughRuntime(true);
		expect(brandingReads).toBe(1);
		expect(html).toContain('src="https://static.example.test/icon.png"');
		expect(html).toContain('background-color:#0B0B0C');
		expect(html).toContain('>sanalyer</span>');
		expect(html).not.toContain('sanalyer Bildirim');
		expect(mime).toMatch(/^Content-Type: multipart\/alternative/m);
		expect(mime).toMatch(/^Content-Type: text\/plain/m);
		expect(mime).toMatch(/^Content-Type: text\/html/m);
	});
});
