// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createMetricsMiddleware,
	createRegisteredMetricsHandler,
	registerCounter,
} from '@fluxer/hono/src/middleware/Metrics';
import {Hono} from 'hono';
import {afterEach, describe, expect, test, vi} from 'vitest';

function requestMetrics(app: Hono, remoteAddress = '127.0.0.1') {
	return app.request('/_metrics', undefined, {incoming: {socket: {remoteAddress}}});
}

function createAllowListApp(allowedCidrs?: ReadonlyArray<string>) {
	const {metricsHandler} = createMetricsMiddleware('test', {allowedCidrs});
	const app = new Hono();
	app.get('/_metrics', metricsHandler);
	return app;
}

function createTestApp() {
	const {middleware, metricsHandler} = createMetricsMiddleware('test');
	const app = new Hono();
	app.use('*', middleware);
	app.get('/_metrics', metricsHandler);
	return {app};
}

describe('Metrics Middleware', () => {
	describe('loopback restriction', () => {
		test('serves metrics to an IPv4 loopback peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '127.0.0.1');
			expect(res.status).toBe(200);
		});

		test('serves metrics to any 127.0.0.0/8 peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '127.0.0.2');
			expect(res.status).toBe(200);
		});

		test('serves metrics to an IPv6 loopback peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '::1');
			expect(res.status).toBe(200);
		});

		test('serves metrics to an IPv4-mapped loopback peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '::ffff:127.0.0.1');
			expect(res.status).toBe(200);
		});

		test('rejects a public peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '8.8.8.8');
			expect(res.status).toBe(403);
			expect(await res.text()).toBe('FORBIDDEN');
		});

		test('rejects a container network peer', async () => {
			const {app} = createTestApp();
			const res = await requestMetrics(app, '172.18.0.4');
			expect(res.status).toBe(403);
		});

		test('rejects a request with no peer address', async () => {
			const {app} = createTestApp();
			const res = await app.request('/_metrics', undefined, {incoming: {socket: {}}});
			expect(res.status).toBe(403);
		});

		test('rejects a request with no node bindings', async () => {
			const {app} = createTestApp();
			const res = await app.request('/_metrics', undefined, {});
			expect(res.status).toBe(403);
		});

		test('ignores a forged x-forwarded-for header', async () => {
			const {app} = createTestApp();
			const res = await app.request(
				'/_metrics',
				{headers: {'x-forwarded-for': '127.0.0.1'}},
				{incoming: {socket: {remoteAddress: '203.0.113.9'}}},
			);
			expect(res.status).toBe(403);
		});
	});

	describe('allowed networks', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		test('serves metrics to a peer inside an allowed network', async () => {
			const res = await requestMetrics(createAllowListApp(['10.77.0.0/24']), '10.77.0.3');
			expect(res.status).toBe(200);
		});

		test('still serves loopback peers when networks are allowed', async () => {
			const res = await requestMetrics(createAllowListApp(['10.77.0.0/24']), '127.0.0.1');
			expect(res.status).toBe(200);
		});

		test('serves only loopback peers when the list is empty', async () => {
			const app = createAllowListApp([]);
			expect((await requestMetrics(app, '127.0.0.1')).status).toBe(200);
			expect((await requestMetrics(app, '10.77.0.3')).status).toBe(403);
		});

		test('rejects a peer outside every allowed network', async () => {
			const res = await requestMetrics(createAllowListApp(['10.77.0.0/24']), '10.77.1.3');
			expect(res.status).toBe(403);
		});

		test('matches an IPv4-mapped peer against an IPv4 network', async () => {
			const res = await requestMetrics(createAllowListApp(['10.77.0.0/24']), '::ffff:10.77.0.3');
			expect(res.status).toBe(200);
		});

		test('matches IPv6 networks and single addresses', async () => {
			const app = createAllowListApp(['fd00:77::/64', '192.0.2.10']);
			expect((await requestMetrics(app, 'fd00:77::5')).status).toBe(200);
			expect((await requestMetrics(app, '192.0.2.10')).status).toBe(200);
			expect((await requestMetrics(app, '192.0.2.11')).status).toBe(403);
		});

		test('ignores a forged x-forwarded-for header from a peer outside the list', async () => {
			const res = await createAllowListApp(['10.77.0.0/24']).request(
				'/_metrics',
				{headers: {'x-forwarded-for': '10.77.0.3'}},
				{incoming: {socket: {remoteAddress: '203.0.113.9'}}},
			);
			expect(res.status).toBe(403);
		});

		test('refuses to start with an invalid entry', () => {
			for (const entry of [
				'10.77.0.0/33',
				'fd00::/129',
				'not-an-ip/24',
				'10.77.0.0/',
				'10.77.0.0/2x',
				'10.0.0.0/+24',
				'10.0.0.0/0024',
			]) {
				expect(() => createMetricsMiddleware('test', {allowedCidrs: [entry]})).toThrow('FLUXER_METRICS_ALLOWED_CIDRS');
			}
		});

		// Same rejections as the Rust and Erlang parsers: only commas separate entries.
		test('refuses to start with networks separated by spaces', () => {
			vi.stubEnv('FLUXER_METRICS_ALLOWED_CIDRS', '10.0.0.0/24 10.1.0.0/24');
			expect(() => createMetricsMiddleware('test')).toThrow('FLUXER_METRICS_ALLOWED_CIDRS');
		});

		test('reads FLUXER_METRICS_ALLOWED_CIDRS when no list is given', async () => {
			vi.stubEnv('FLUXER_METRICS_ALLOWED_CIDRS', ' 10.77.0.0/24 , ,fd00:77::/64 ');
			const app = createAllowListApp();
			expect((await requestMetrics(app, '10.77.0.3')).status).toBe(200);
			expect((await requestMetrics(app, 'fd00:77::5')).status).toBe(200);
			expect((await requestMetrics(app, '172.18.0.4')).status).toBe(403);
		});
	});

	describe('registered metrics', () => {
		test('serves only registered metrics from the standalone handler', async () => {
			registerCounter('fluxer_test_standalone_total', 'Standalone counter').inc();
			const app = new Hono();
			app.get('/_metrics', createRegisteredMetricsHandler());
			const res = await requestMetrics(app);
			const body = await res.text();
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('text/plain; version=0.0.4; charset=utf-8');
			expect(body).toContain('fluxer_test_standalone_total 1');
			expect(body).not.toContain('_http_requests_total');
			expect((await requestMetrics(app, '8.8.8.8')).status).toBe(403);
		});
	});
});
