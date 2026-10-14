// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {put: vi.fn()}}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {channelId: '500', connectionId: 'conn-a'}}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {takeVoiceSeat} = await import('@app/features/voice_scene/commands/VoiceSeatCommands');

const refused = (status: number) =>
	new HttpError({
		method: 'PUT',
		path: '/channels/500/voice-seat',
		status,
		body: {code: 'RATE_LIMITED', retry_after: 1},
	});

beforeEach(() => {
	vi.mocked(http.put).mockReset();
	vi.mocked(ToastCommands.createToast).mockClear();
});

describe('takeVoiceSeat', () => {
	it('asks for the seat with my connection id', async () => {
		vi.mocked(http.put).mockResolvedValue({} as never);
		await takeVoiceSeat('500', 'seat_T01_Y2');
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {
			body: {connection_id: 'conn-a', seat: 'seat_T01_Y2'},
		});
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
	});

	it('429 (the channel limit of seat changes) shows a short notice', async () => {
		vi.mocked(http.put).mockRejectedValue(refused(429));
		await takeVoiceSeat('500', 'seat_T01_Y2');
		expect(ToastCommands.createToast).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ToastCommands.createToast).mock.calls[0]![0]).toMatchObject({type: 'info'});
	});

	it("the room's own any-seat request (useSeatFallback) stays quiet on 429; only a picked seat is told (CR4)", async () => {
		vi.mocked(http.put).mockRejectedValue(refused(429));
		await takeVoiceSeat('500', null);
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {body: {connection_id: 'conn-a', seat: null}});
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
	});

	it('other failures stay quiet (the room keeps the seat it had)', async () => {
		vi.mocked(http.put).mockRejectedValue(refused(404));
		await takeVoiceSeat('500', 'seat_T01_Y2');
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
	});
});
