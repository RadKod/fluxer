// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {PremiumTrialEligibilityResponse} from '@fluxer/schema/src/domains/premium/PremiumTrialSchemas';
import {setupI18n} from '@lingui/core';
import {makeObservable, observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	id: string;
	isPremium: () => boolean;
}

const runtime = vi.hoisted(() => ({premiumTrialDays: 7}));
const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));
const users = vi.hoisted(() => ({store: null as unknown as FakeUsers}));
const toasts = vi.hoisted(() => ({success: vi.fn(), error: vi.fn()}));
const forms = vi.hoisted(() => ({pushApiErrorModal: vi.fn()}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/user/state/Users', () => ({
	get default() {
		return users.store;
	},
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => toasts);
vi.mock('@app/lib/forms', () => forms);

const {usePremiumTrial} = await import('@app/features/premium/hooks/usePremiumTrial');

// Stands in for the Users store: the gateway's USER_UPDATE replaces currentUser there.
class FakeUsers {
	currentUser: FakeUser | null = freeUser;
	handleUserUpdate = vi.fn();

	constructor() {
		makeObservable(this, {currentUser: observable});
	}
}

const freeUser: FakeUser = {id: '1', isPremium: () => false};
const premiumUser: FakeUser = {id: '1', isPremium: () => true};

// The hero's "Try free" button, as the page draws it from the hook.
const Probe = observer(() => {
	const trial = usePremiumTrial();
	if (!trial) return null;
	return createElement(
		'button',
		{type: 'button', disabled: trial.claiming, onClick: () => void trial.start(), 'data-days': trial.days},
		'Try free',
	);
});

function reply<T>(body: T) {
	return {ok: true, status: 200, statusText: '', headers: {}, body};
}

function eligibility(body: Partial<PremiumTrialEligibilityResponse>) {
	return reply<PremiumTrialEligibilityResponse>({eligible: true, days: 7, reason: null, ...body});
}

function refusal(code: string, status: number): HttpError {
	return new HttpError({method: 'POST', path: Endpoints.PREMIUM_TRIAL, status, body: {code, message: code}});
}

describe('usePremiumTrial', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.premiumTrialDays = 7;
		users.store = new FakeUsers();
		for (const mock of [http.get, http.post, toasts.success, toasts.error, forms.pushApiErrorModal]) mock.mockReset();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = async () => {
		await act(async () => root.render(createElement(Probe)));
	};
	const button = () => container.querySelector('button');
	const click = async () => {
		await act(async () => button()!.click());
	};

	it('offers nothing and asks nothing when the instance has no trial', async () => {
		runtime.premiumTrialDays = 0;
		await render();

		expect(button()).toBeNull();
		expect(http.get).not.toHaveBeenCalled();
	});

	it('offers nothing and asks nothing to a premium member', async () => {
		users.store.currentUser = premiumUser;
		await render();

		expect(button()).toBeNull();
		expect(http.get).not.toHaveBeenCalled();
	});

	it('offers nothing when the server says the user cannot start it', async () => {
		http.get.mockResolvedValue(eligibility({eligible: false, reason: 'already_used'}));
		await render();

		expect(http.get).toHaveBeenCalledWith(Endpoints.PREMIUM_TRIAL);
		expect(button()).toBeNull();
	});

	it('offers an eligible user the trial with its real length and starts it with POST /premium/trial', async () => {
		http.get.mockResolvedValue(eligibility({days: 14}));
		http.post.mockResolvedValue({...reply(null), status: 204});
		await render();

		expect(button()?.getAttribute('data-days')).toBe('14');
		await click();

		expect(http.post).toHaveBeenCalledWith(Endpoints.PREMIUM_TRIAL);
		expect(toasts.success).toHaveBeenCalledTimes(1);
		expect(button()).toBeNull();
		// USER_UPDATE writes premium, not the response.
		expect(users.store.handleUserUpdate).not.toHaveBeenCalled();
	});

	it('goes away when USER_UPDATE makes the user premium', async () => {
		http.get.mockResolvedValue(eligibility({}));
		await render();
		expect(button()).not.toBeNull();

		await act(async () => runInAction(() => (users.store.currentUser = premiumUser)));

		expect(button()).toBeNull();
	});

	it('explains an already used trial, re-reads the user and stops offering it', async () => {
		const me = {id: '1', username: 'me', premium_type: 1};
		http.get.mockImplementation(async (path: string) => (path === Endpoints.USER_ME ? reply(me) : eligibility({})));
		http.post.mockRejectedValue(refusal(APIErrorCodes.TRIAL_ALREADY_USED, 409));
		await render();
		await click();

		expect(button()).toBeNull();
		expect(toasts.error).toHaveBeenCalledWith(
			'You have already used the free trial. It is one per account and email address.',
		);
		expect(http.get).toHaveBeenCalledWith(Endpoints.USER_ME);
		expect(users.store.handleUserUpdate).toHaveBeenCalledWith(me);
		expect(forms.pushApiErrorModal).not.toHaveBeenCalled();
	});

	it("shows the server's reason for any other refusal and keeps offering it", async () => {
		http.get.mockResolvedValue(eligibility({}));
		const error = refusal(APIErrorCodes.TRIAL_NOT_ELIGIBLE, 403);
		http.post.mockRejectedValue(error);
		await render();
		await click();

		expect(forms.pushApiErrorModal).toHaveBeenCalledWith(i18n, error);
		expect(button()!.disabled).toBe(false);
	});

	it('stays quiet when the user closes the captcha', async () => {
		http.get.mockResolvedValue(eligibility({}));
		http.post.mockRejectedValue(new Error('Captcha cancelled'));
		await render();
		await click();

		expect(forms.pushApiErrorModal).not.toHaveBeenCalled();
		expect(toasts.error).not.toHaveBeenCalled();
		expect(button()!.disabled).toBe(false);
	});
});
