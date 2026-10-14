// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({selfHosted: false, giftCodesEnabled: true}));
const page = vi.hoisted(() => () => Object.assign(() => null, {preload: undefined}));
const session = vi.hoisted(() => ({authenticated: false, initialized: true}));
const referral = vi.hoisted(() => ({saveReferralCode: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => snapshot,
		isSelfHosted: () => runtime.selfHosted,
		get giftCodesEnabled() {
			return runtime.giftCodesEnabled;
		},
	},
}));
vi.mock('@app/app/router/routes/RootRoutes', async () => {
	const {createRootRoute} = await import('@app/features/platform/components/router/RouterBuilder');
	return {rootRoute: createRootRoute()};
});
vi.mock('@app/features/app/components/layout/AuthLayout', () => ({AuthLayout: () => null}));
vi.mock('@app/features/auth/flow/AuthLoadableRoutePage', () => ({
	createAuthRoutePage: page,
	createNamedAuthRoutePage: page,
}));
vi.mock('@app/features/auth/flow/auth_login_core/useDesktopHandoffFlow', () => ({isHandoffRequest: () => false}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {
		get isAuthenticated() {
			return session.authenticated;
		},
	},
}));
vi.mock('@app/features/auth/utils/SafeRedirect', () => ({
	safeRedirectTarget: () => null,
	safeRedirectTargetOrFallback: () => '/',
}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({setPathQueryParams: (path: string) => path}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({replaceWith: vi.fn()}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {
		get isInitialized() {
			return session.initialized;
		},
		initialize: () => Promise.resolve(),
	},
}));
vi.mock('@app/features/referral/utils/ReferralCodeStorage', () => referral);

const {runtimeSnapshotFromDiscovery} = await import('@app/features/app/state/InstanceSnapshotStore');
const {instanceDiscoveryFixture} = await import('@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture');
const {parseInstanceDiscoveryDocument} = await import('@fluxer/instance_bootstrap/src/Discovery');
const snapshot = runtimeSnapshotFromDiscovery(
	parseInstanceDiscoveryDocument(instanceDiscoveryFixture('https://micup.test/api')),
);

const giftRouteIds = async () => {
	const {authRouteTree} = await import('@app/app/router/routes/AuthRoutes');
	return authRouteTree
		.build()
		.map((route) => route.id)
		.filter((id) => id === 'giftRegister' || id === 'giftLogin');
};

// The /gift/:code pages open wherever a gift code can be redeemed.
describe('gift code routes', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('are there on a mirror instance, where item and premium codes exist', async () => {
		runtime.selfHosted = true;
		runtime.giftCodesEnabled = true;

		expect(await giftRouteIds()).toEqual(['giftRegister', 'giftLogin']);
	});

	it('rejects entry on a self-hosted instance without gift codes or premium', async () => {
		runtime.selfHosted = true;
		runtime.giftCodesEnabled = false;

		expect(await giftRouteIds()).toEqual(['giftRegister', 'giftLogin']);
		const {authRouteTree} = await import('@app/app/router/routes/AuthRoutes');
		const {NotFound} = await import('@app/features/platform/components/router/RouterTypes');
		for (const route of authRouteTree.build().filter((route) => ['giftRegister', 'giftLogin'].includes(route.id))) {
			expect(route.onEnter?.({params: {code: 'gift-code'}} as never)).toBeInstanceOf(NotFound);
		}
	});

	it('are there on the hosted service', async () => {
		runtime.selfHosted = false;
		runtime.giftCodesEnabled = true;

		expect(await giftRouteIds()).toEqual(['giftRegister', 'giftLogin']);
	});
});

// A /r/<code> link sends a visitor to registration with the code kept for the registration request.
describe('referral link route', () => {
	const enter = async (code: string) => {
		const {authRouteTree} = await import('@app/app/router/routes/AuthRoutes');
		const route = authRouteTree.build().find((candidate) => candidate.id === 'referral');
		return route?.onEnter?.({params: {code}} as never);
	};

	beforeEach(() => {
		vi.resetModules();
		referral.saveReferralCode.mockClear();
		session.authenticated = false;
		session.initialized = true;
	});

	it('/r/:code stores and redirects to /register', async () => {
		const redirect = await enter('ABCDEF2345');

		expect(referral.saveReferralCode).toHaveBeenCalledWith('ABCDEF2345');
		expect(redirect).toMatchObject({to: '/register'});
	});

	it('authenticated -> ME, nothing stored', async () => {
		session.authenticated = true;

		const redirect = await enter('abcdef2345');

		expect(referral.saveReferralCode).not.toHaveBeenCalled();
		expect(redirect).toMatchObject({to: '/channels/@me'});
	});

	it('still registers the visit when the code is malformed', async () => {
		referral.saveReferralCode.mockReturnValue(false);

		expect(await enter('nope')).toMatchObject({to: '/register'});
	});
});
