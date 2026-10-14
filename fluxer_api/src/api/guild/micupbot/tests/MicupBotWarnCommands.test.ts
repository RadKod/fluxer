// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {useCommandFixture} from '@app/api/guild/micupbot/tests/MicupBotCommandTestUtils';
import {expect, it} from 'vitest';

const fixture = useCommandFixture();

it('#warn writes a warning and the 101st is refused', async () => {
	const f = await fixture();
	const payload = await f.run(`#warn ${f.target.userId} Be kind`);
	const warnings = await f.repository.listWarnings(f.guildId, f.targetId, 100);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toMatchObject({
		warning_id: BigInt(payload.message_id),
		moderator_id: f.authorId,
		reason: 'Be kind',
	});
	for (let index = 1; index < 100; index++) {
		await f.repository.addWarning({...warnings[0], warning_id: BigInt(payload.message_id) + BigInt(index)});
	}
	await f.run(`#warn ${f.target.userId} Overflow`);
	expect(f.reply()?.content).toBe(MICUPBOT_TEXT.warningsFull);
	expect(await f.repository.countWarnings(f.guildId, f.targetId)).toBe(100);
});

it('#warnings lists the latest', async () => {
	const f = await fixture();
	for (let index = 0; index < 12; index++) {
		await f.repository.addWarning({
			guild_id: f.guildId,
			user_id: f.targetId,
			warning_id: 100n + BigInt(index),
			moderator_id: f.authorId,
			reason: `Reason ${index}`,
			created_at: new Date(),
		});
	}
	await f.run(`#warnings ${f.target.userId}`);
	const embed = f.reply()?.embeds?.[0];
	expect(embed?.description).toContain('Reason 11');
	expect(embed?.description).toContain('Reason 2');
	expect(embed?.description).not.toContain('Reason 0');
	expect(embed?.footer?.text).toContain('12');
});

it('#warnings replies omit moderator identities while keeping the date and reason', async () => {
	const f = await fixture();
	const createdAt = new Date('2026-10-03T00:00:00.000Z');
	await f.repository.addWarning({
		guild_id: f.guildId,
		user_id: f.targetId,
		warning_id: 100n,
		moderator_id: f.authorId,
		reason: 'Be kind',
		created_at: createdAt,
	});
	await f.run(`#warnings ${f.target.userId}`);
	const embed = f.reply()?.embeds?.[0];
	expect(embed?.description).toBe(`${createdAt.toISOString()} · Be kind`);
	expect(JSON.stringify(embed)).not.toContain(String(f.authorId));
	expect(embed?.footer?.text).toBe('1');
});

it('a member without MODERATE_MEMBERS cannot #warn or #warnings and sees noPermission', async () => {
	const f = await fixture(0n);
	await f.seedWarning(f.target.userId);
	for (const command of [`#warn ${f.target.userId} Reason`, `#warnings ${f.target.userId}`]) {
		await f.run(command);
		expect(f.reply()?.content).toBe(MICUPBOT_TEXT.noPermission);
		expect(f.reply()?.embeds).toBeUndefined();
	}
	expect(await f.repository.countWarnings(f.guildId, f.targetId)).toBe(1);
});

it('a redelivered #warn writes one warning', async () => {
	const f = await fixture();
	const payload = await f.run(`#warn ${f.target.userId} Reason`);
	f.send.mockClear();
	await f.runner.run(payload);
	expect(await f.repository.countWarnings(f.guildId, f.targetId)).toBe(1);
	expect(f.send).not.toHaveBeenCalled();
});

it('concurrent warnings cannot take the last slot twice', async () => {
	const f = await fixture();
	for (let index = 1; index <= 99; index++) {
		await f.repository.addWarning({
			guild_id: f.guildId,
			user_id: f.targetId,
			warning_id: BigInt(index),
			moderator_id: f.authorId,
			reason: 'Existing',
			created_at: new Date(),
		});
	}
	const first = await f.command(`#warn ${f.target.userId} First`);
	const second = await f.command(`#warn ${f.target.userId} Second`);
	await Promise.all([f.runner.run(first), f.runner.run(second)]);
	expect(await f.repository.countWarnings(f.guildId, f.targetId)).toBe(100);
});
