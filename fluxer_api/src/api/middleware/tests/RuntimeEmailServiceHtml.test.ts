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
	favicon_dark_url: null,
	theme_color: '#0B0B0C',
	status_page_url: null,
	status_page_instatus: false,
	status_page_incident_history_url: null,
	sign_in_backdrop_url: null,
	custom_css: null,
	upload_limit_message: null,
	trusted_domains: [],
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
		smtp: {host: 'smtp.example.test', port: 465, username: 'user', password: 'pass', tlsMode: 'implicit'},
		htmlEnabled,
		htmlFooter: {},
	};
	const getAppPublicConfig = vi.fn(async () => ({branding: BRANDING, legal: {terms_url: null, guidelines_url: null}}));
	const repository = {
		getEffectiveEmailConfig: async () => emailConfig,
		getAppPublicConfig,
	} as unknown as InstanceConfigRepository;
	try {
		const service = createRuntimeEmailService({isEmailBounced: async () => false}, () => repository);
		const sent = await service.send(
			'ip_authorization',
			'user@example.test',
			{authorizationToken: 'tok123', ipAddress: '203.0.113.7', location: 'Istanbul'},
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
	// Upstream's MJML renderer now builds the HTML part of every email, so the Micup html_enabled switch and its
	// instance branding (logo, header color) no longer change the message; both settings send the same multipart mail.
	it.each([false, true])('sends upstream multipart/alternative mail (html_enabled %s)', async (htmlEnabled) => {
		const {html, mime} = await sendThroughRuntime(htmlEnabled);
		expect(html).toContain('sanalyer');
		expect(html).not.toContain('sanalyer Bildirim');
		expect(mime).toMatch(/^Content-Type: multipart\/alternative/m);
		expect(mime).toMatch(/^Content-Type: text\/plain/m);
		expect(mime).toMatch(/^Content-Type: text\/html/m);
	});
});
