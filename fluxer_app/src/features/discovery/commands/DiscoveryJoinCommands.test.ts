// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/app/I18n', () => ({default: {_: (descriptor: {message: string}) => descriptor.message}}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/discovery/commands/DiscoveryCommands', () => ({joinGuild: vi.fn()}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectGuild: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: null}}));

const DiscoveryCommands = await import('@app/features/discovery/commands/DiscoveryCommands');
const NavigationCommands = await import('@app/features/navigation/commands/NavigationCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {joinDiscoveryGuild} = await import('@app/features/discovery/commands/DiscoveryJoinCommands');

// The modal pushed on a failed join, rendered to read its title.
const pushedModal = () => {
	const render = vi.mocked(ModalCommands.push).mock.calls[0]?.[0] as unknown as () => {props: {title: string}};
	return render().props;
};

describe('joinDiscoveryGuild', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('joins and opens the community by default', async () => {
		vi.mocked(DiscoveryCommands.joinGuild).mockResolvedValueOnce(undefined as never);
		await expect(joinDiscoveryGuild('5')).resolves.toBe(true);
		expect(DiscoveryCommands.joinGuild).toHaveBeenCalledWith('5');
		expect(NavigationCommands.selectGuild).toHaveBeenCalledWith('5');
	});

	it('with open false joins without opening the community', async () => {
		vi.mocked(DiscoveryCommands.joinGuild).mockResolvedValueOnce(undefined as never);
		await expect(joinDiscoveryGuild('5', {open: false})).resolves.toBe(true);
		expect(DiscoveryCommands.joinGuild).toHaveBeenCalledWith('5');
		expect(NavigationCommands.selectGuild).not.toHaveBeenCalled();
		expect(ModalCommands.push).not.toHaveBeenCalled();
	});

	it.each([{open: true}, {open: false}])(
		'shows the join error modal and returns false when the join fails (%o)',
		async (options) => {
			vi.mocked(DiscoveryCommands.joinGuild).mockRejectedValueOnce(
				new HttpError({
					method: 'POST',
					path: '/discovery/guilds/5/join',
					status: 400,
					body: {code: APIErrorCodes.MAX_GUILD_MEMBERS, message: 'full'},
				}),
			);
			await expect(joinDiscoveryGuild('5', options)).resolves.toBe(false);
			expect(NavigationCommands.selectGuild).not.toHaveBeenCalled();
			expect(pushedModal().title).toBe('This community is full');
		},
	);
});
