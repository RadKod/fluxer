// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectChannel: vi.fn()}));
const voice = {channelId: '500' as string | null, connectionId: 'conn-a' as string | null};
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get channelId() {
			return voice.channelId;
		},
		get connectionId() {
			return voice.connectionId;
		},
	},
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const NavigationCommands = await import('@app/features/navigation/commands/NavigationCommands');
const Commands = await import('@app/features/activities/commands/VoiceActivityCommands');
const {default: VoiceActivities} = await import('@app/features/activities/state/VoiceActivities');

const PATH = '/channels/500/activity';
const SESSION: VoiceActivitySessionMetadata = {
	activity_id: 'band',
	session_id: '11',
	started_by: '1',
	started_at: Date.now(),
};

function reply<T>(body: T): RestResponse<T> {
	return {ok: true, status: 200, statusText: '', headers: {}, body};
}

beforeEach(() => {
	for (const method of [http.get, http.post, http.delete]) vi.mocked(method).mockReset();
	vi.mocked(ToastCommands.createToast).mockReset();
	voice.channelId = '500';
	voice.connectionId = 'conn-a';
	VoiceActivities.reset();
	VoiceActivities.handleSession('500', null);
});

describe('VoiceActivityCommands', () => {
	it('starts with my connection and takes the reply before the metadata arrives', async () => {
		vi.mocked(http.post).mockResolvedValue(reply(SESSION));
		await expect(Commands.startVoiceActivity('500', 'band')).resolves.toEqual({ok: true});
		expect(http.post).toHaveBeenCalledWith(PATH, {body: {activity_id: 'band', connection_id: 'conn-a'}});
		expect(VoiceActivities.getSession('500')?.session_id).toBe('11');
		expect(VoiceActivities.request).toBeNull();
	});

	it('joins the session I start but leaves it a tile', async () => {
		vi.mocked(http.post).mockResolvedValue(reply(SESSION));
		await Commands.startVoiceActivity('500', 'band');
		expect(VoiceActivities.isJoined('500')).toBe(true);
		expect(VoiceActivities.isExpanded('500')).toBe(false);
		// The room metadata then brings the same session; I stay joined.
		VoiceActivities.handleSession('500', SESSION);
		expect(VoiceActivities.isJoined('500')).toBe(true);
	});

	it('joins and leaves a running session without touching the call', () => {
		VoiceActivities.handleSession('500', SESSION);
		expect(VoiceActivities.isJoined('500')).toBe(false);
		Commands.joinVoiceActivity('500');
		expect(VoiceActivities.isJoined('500')).toBe(true);
		VoiceActivities.expand();
		Commands.leaveVoiceActivity('500');
		expect(VoiceActivities.isJoined('500')).toBe(false);
		expect(VoiceActivities.isExpanded('500')).toBe(false);
		expect(VoiceActivities.getSession('500')?.session_id).toBe('11');
	});

	it('does not join from outside the voice channel', () => {
		VoiceActivities.handleSession('500', SESSION);
		voice.channelId = '600';
		Commands.joinVoiceActivity('500');
		expect(VoiceActivities.joinedSessionId).toBeNull();
	});

	it('shows a running activity expanded in its channel', () => {
		VoiceActivities.handleSession('500', SESSION);
		VoiceActivities.closeMiniWindow();
		Commands.showVoiceActivity('7', '500');
		expect(VoiceActivities.isExpanded('500')).toBe(true);
		expect(VoiceActivities.miniWindowClosed).toBe(false);
		expect(NavigationCommands.selectChannel).toHaveBeenCalledWith('7', '500');
	});

	it('tells me another activity won and reads the running one', async () => {
		vi.mocked(http.post).mockRejectedValue(
			new HttpError({method: 'POST', path: PATH, status: 409, body: {code: APIErrorCodes.VOICE_ACTIVITY_CONFLICT}}),
		);
		vi.mocked(http.get).mockResolvedValue(reply({...SESSION, session_id: '12'}));
		await expect(Commands.startVoiceActivity('500', 'band')).resolves.toEqual({ok: false, error: 'conflict'});
		expect(ToastCommands.createToast).toHaveBeenCalledWith(expect.objectContaining({type: 'info'}));
		await vi.waitFor(() => expect(VoiceActivities.getSession('500')?.session_id).toBe('12'));
		expect(http.get).toHaveBeenCalledWith(PATH, {query: {connection_id: 'conn-a'}});
	});

	it('does nothing outside the voice channel', async () => {
		voice.channelId = '600';
		await expect(Commands.startVoiceActivity('500', 'band')).resolves.toEqual({ok: false, error: 'not_in_voice'});
		expect(http.post).not.toHaveBeenCalled();
	});

	it('ends the session it was asked to end and leaves a newer one alone', async () => {
		VoiceActivities.handleSession('500', SESSION);
		vi.mocked(http.delete).mockResolvedValue(reply(null));
		await expect(Commands.endVoiceActivity('500', '11')).resolves.toBe(true);
		expect(http.delete).toHaveBeenCalledWith(PATH, {query: {connection_id: 'conn-a'}});
		expect(VoiceActivities.getSession('500')).toBeNull();

		VoiceActivities.handleSession('500', {...SESSION, session_id: '13'});
		await Commands.endVoiceActivity('500', '11');
		expect(VoiceActivities.getSession('500')?.session_id).toBe('13');
	});

	it('keeps the session when ending fails', async () => {
		VoiceActivities.handleSession('500', SESSION);
		vi.mocked(http.delete).mockRejectedValue(new Error('offline'));
		await expect(Commands.endVoiceActivity('500', '11')).resolves.toBe(false);
		expect(VoiceActivities.getSession('500')?.session_id).toBe('11');
		expect(ToastCommands.createToast).toHaveBeenCalledWith(expect.objectContaining({type: 'error'}));
	});
});
