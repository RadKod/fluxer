// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {actor, fixture, SOUND_ID, savedSound} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it, vi} from 'vitest';

describe('Guild soundboard permissions', () => {
	it('requires guild membership before listing sounds', async () => {
		const f = fixture();
		f.gateway.getGuildData.mockRejectedValue(new Error('not a member'));
		const list = vi.spyOn(f.repository, 'listSounds');
		await expect(f.service.list(actor)).rejects.toThrow('not a member');
		expect(list).not.toHaveBeenCalled();
	});
	it.each(['update', 'delete'] as const)('requires CREATE_EXPRESSIONS for own %s', async (operation) => {
		const f = fixture();
		await f.repository.upsertSound(savedSound());
		f.gateway.checkPermission.mockResolvedValue(false);
		await expect(f.service[operation]({...actor, soundId: SOUND_ID, name: 'New'})).rejects.toThrow();
		expect(f.gateway.checkPermission).toHaveBeenCalledWith(
			expect.objectContaining({permission: Permissions.CREATE_EXPRESSIONS}),
		);
		expect(await f.repository.getSound(actor.guildId, SOUND_ID)).not.toBeNull();
	});
	it.each(['update', 'delete'] as const)('requires MANAGE_EXPRESSIONS for another creator %s', async (operation) => {
		const f = fixture();
		await f.repository.upsertSound(savedSound({creator_id: createUserID(999n)}));
		f.gateway.checkPermission.mockImplementation(async ({permission}) => permission === Permissions.CREATE_EXPRESSIONS);
		await expect(f.service[operation]({...actor, soundId: SOUND_ID, name: 'New'})).rejects.toThrow();
		expect(f.gateway.checkPermission).toHaveBeenCalledWith(
			expect.objectContaining({permission: Permissions.MANAGE_EXPRESSIONS}),
		);
	});
	it('rejects another guild sound without disclosing or changing it', async () => {
		const f = fixture();
		await f.repository.upsertSound(savedSound({guild_id: createGuildID(999n)}));
		await expect(f.service.update({...actor, soundId: SOUND_ID, name: 'New'})).rejects.toThrow();
		expect(f.gateway.dispatchGuild).not.toHaveBeenCalled();
	});
	it('updates metadata and preserves the asset while emitting its new version', async () => {
		const f = fixture();
		await f.repository.upsertSound(savedSound());
		const result = await f.service.update({...actor, soundId: SOUND_ID, name: 'New', volume: 0});
		expect(result).toMatchObject({name: 'New', volume: 0, version: 2, asset_hash: 'a'.repeat(64)});
		expect(f.gateway.dispatchGuild).toHaveBeenCalledWith(
			expect.objectContaining({data: expect.objectContaining({operation: 'update', version: 2})}),
		);
	});
});
