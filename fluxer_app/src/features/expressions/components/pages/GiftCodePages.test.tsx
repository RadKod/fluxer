// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement, type FC, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({
	dispatch: vi.fn(),
	matchesConfiguredRouting: vi.fn(() => true),
}));
const runtime = vi.hoisted(() => ({
	selfHosted: true,
	snapshot: null as import('@app/features/app/state/InstanceSnapshotStore').RuntimeConfigSnapshot | null,
}));
const route = vi.hoisted(() => ({code: ''}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const Passthrough = ({children}: {children?: ReactNode}) => children;
const Nothing = () => null;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: Passthrough}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => runtime.snapshot, isSelfHosted: () => runtime.selfHosted},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	push: vi.fn(),
	pop: vi.fn(),
	pushWithKey: vi.fn(),
	modal: (render: () => unknown) => render,
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({success: vi.fn()}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: {load: vi.fn()}}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: {status: 'idle', load: vi.fn()}}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: Nothing}));
vi.mock('@app/features/expressions/components/modals/GiftSendToFriendModal', () => ({GiftSendToFriendModal: Nothing}));
vi.mock('@app/features/expressions/components/modals/GiftAcceptModal', () => ({GiftAcceptModal: Nothing}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getDisplayName: () => 'Sender'}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useParams: () => ({code: route.code}),
	useLocation: () => ({search: ''}),
}));
vi.mock('@app/features/window/hooks/useFluxerDocumentTitle', () => ({useFluxerDocumentTitle: () => {}}));
vi.mock('@app/features/auth/utils/SafeRedirect', () => ({
	safeRedirectTarget: () => null,
	safeRedirectTargetOrFallback: (_raw: unknown, fallback: string) => fallback,
}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({setPathQueryParams: (path: string) => path}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({replaceWith: vi.fn()}));
vi.mock('@app/features/auth/commands/AuthenticationCommands', () => ({}));
vi.mock('@app/features/auth/flow/AuthErrorState', () => ({
	AuthErrorState: ({title, text}: {title: ReactNode; text: ReactNode}) => (
		<p data-flx="expressions.gift-code-pages-test.error">
			{title}|{text}
		</p>
	),
}));
vi.mock('@app/features/auth/flow/AuthLoadingState', () => ({AuthLoadingState: Nothing}));
vi.mock('@app/features/auth/flow/AuthBottomLink', () => ({AuthBottomLink: Nothing}));
vi.mock('@app/features/auth/flow/AuthRegisterFormCore', () => ({AuthRegisterFormCore: Nothing}));
vi.mock('@app/features/auth/flow/AuthSsoPanel', () => ({AuthSsoPanel: Nothing, resolveAuthPanelSso: () => null}));
vi.mock('@app/features/auth/flow/DesktopDeepLinkPrompt', () => ({DesktopDeepLinkPrompt: Nothing}));
vi.mock('@app/features/auth/flow/DesktopHandoffMfaStep', () => ({DesktopHandoffMfaStep: Nothing}));
vi.mock('@app/features/auth/flow/AuthRouterLink', () => ({AuthRouterLink: Nothing}));
vi.mock('@app/features/auth/flow/AuthLoginLayout', () => ({
	AuthLoginLayout: ({extraTopContent}: {extraTopContent: ReactNode}) => extraTopContent,
}));
vi.mock('@app/features/auth/flow/auth_login_core/useDesktopHandoffFlow', () => ({
	isApprovalFlowMode: () => false,
	isHandoffRequest: () => false,
	useDesktopHandoffFlow: () => ({}),
}));
vi.mock('@app/features/auth/flow/HandoffApprovalFlow', () => ({ConnectedHandoffApprovalFlow: Nothing}));
vi.mock('@app/features/auth/flow/MfaScreen', () => ({default: Nothing}));
vi.mock('@app/features/auth/state/AccountManager', () => ({default: {orderedAccounts: []}}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {loginState: 'default'},
	LoginState: {DEFAULT: 'default', MFA: 'mfa'},
}));
vi.mock('@app/features/ui/stepped_carousel/SteppedCarousel', () => ({SteppedCarousel: Passthrough}));

const {default: GiftRegisterPage} = await import('@app/features/expressions/components/pages/GiftRegisterPage');
const {default: GiftLoginPage} = await import('@app/features/expressions/components/pages/GiftLoginPage');
const {AuthRuntimeTarget, AuthRuntimeTargetProvider} = await import('@app/features/auth/state/AuthRuntimeTarget');
const {AuthLayoutContext} = await import('@app/features/auth/state/AuthLayoutContext');
const {runtimeSnapshotFromDiscovery} = await import('@app/features/app/state/InstanceSnapshotStore');
const {instanceDiscoveryFixture} = await import('@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture');
const {parseInstanceDiscoveryDocument} = await import('@fluxer/instance_bootstrap/src/Discovery');

const layout = {
	setSplashUrl: vi.fn(),
	setCardVariant: vi.fn(),
	setContentMode: vi.fn(),
	setSplashCardAlignment: vi.fn(),
};

const WINGS = {
	id: '7',
	type: 'avatar_ultra',
	name: 'Yitik Melek',
	description: null,
	asset: 'a1b2',
	availability: 'owned',
} as const;

// Signed-out visitors of /gift/:code (register) and /gift/:code/login.
describe('gift code pages', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.selfHosted = true;
		runtime.snapshot = null;
		http.dispatch.mockReset();
		http.matchesConfiguredRouting.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const open = async (
		page: FC,
		code: string,
		body: unknown,
		branding = {product_name: 'sanalyer', premium_product_name: 'Plus'},
	) => {
		route.code = code;
		http.dispatch.mockResolvedValueOnce({body});
		const discovery = instanceDiscoveryFixture('https://micup.test/api');
		discovery.features.self_hosted = runtime.selfHosted;
		discovery.app_public = {
			...discovery.app_public!,
			branding: {...discovery.app_public!.branding, ...branding},
		};
		const snapshot = runtimeSnapshotFromDiscovery(parseInstanceDiscoveryDocument(discovery));
		runtime.snapshot = snapshot;
		const target = AuthRuntimeTarget.forBrowserDocument(snapshot);
		await act(async () =>
			root.render(
				createElement(AuthRuntimeTargetProvider, {
					target,
					children: createElement(AuthLayoutContext.Provider, {value: layout}, createElement(page)),
				}),
			),
		);
	};
	const itemCode = (code: string, redeemed = false) => ({code, redeemed, grant: {type: 'cosmetic', item: WINGS}});

	it('the register page shows the item an item code gives', async () => {
		await open(GiftRegisterPage, 'ItemPage0001', itemCode('ItemPage0001'));

		expect(http.dispatch).toHaveBeenCalledWith('GET', '/shop/codes/ItemPage0001', expect.any(Object));
		expect(http.matchesConfiguredRouting).toHaveBeenCalledWith('https://micup.test/api', 9);
		expect(container.textContent).not.toContain('Gift not found');
		expect(container.textContent).toContain("You've received a gift");
		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('Create an account to claim your gift');
	});

	it('the login page shows the item an item code gives', async () => {
		await open(GiftLoginPage, 'ItemPage0002', itemCode('ItemPage0002'));

		expect(container.textContent).not.toContain('Gift not found');
		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('Sign in to claim your gift');
	});

	it('a used item code says it was claimed', async () => {
		await open(GiftRegisterPage, 'ItemPage0003', itemCode('ItemPage0003', true));

		expect(container.textContent).toContain('Gift already redeemed|This gift code has already been claimed.');
		expect(container.textContent).not.toContain('Yitik Melek');
	});

	it('a premium code on the shop preview shows its time without a sender', async () => {
		await open(GiftRegisterPage, 'PremPage0001', {
			code: 'PremPage0001',
			redeemed: false,
			grant: {type: 'premium', duration_type: 'months', duration_quantity: 1},
		});

		expect(container.textContent).toContain("You've received a gift");
		expect(container.textContent).toContain('1 month of sanalyer Plus');
	});

	it('a premium code from /gifts keeps its sender', async () => {
		runtime.selfHosted = false;

		await open(GiftLoginPage, 'PremPage0002', {
			code: 'PremPage0002',
			duration_type: 'months',
			duration_quantity: 1,
			redeemed: false,
			created_by: {id: '1', username: 'sender', discriminator: '0001', global_name: null, avatar: null, flags: 0},
		});

		expect(http.dispatch).toHaveBeenCalledWith('GET', '/gifts/PremPage0002', expect.any(Object));
		expect(http.matchesConfiguredRouting).toHaveBeenCalledWith('https://micup.test/api', 9);
		expect(container.textContent).toContain('Sender sent you a gift');
		expect(container.textContent).toContain('1 month of sanalyer Plus');
	});

	it('a premium gift uses the selected instance product and plan names', async () => {
		await open(
			GiftRegisterPage,
			'PremPage0003',
			{code: 'PremPage0003', redeemed: false, grant: {type: 'premium', duration_type: 'months', duration_quantity: 1}},
			{product_name: 'Example Chat', premium_product_name: 'Gold'},
		);

		expect(container.textContent).toContain('1 month of Example Chat Gold');
	});
});
