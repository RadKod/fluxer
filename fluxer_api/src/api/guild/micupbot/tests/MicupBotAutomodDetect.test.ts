// SPDX-License-Identifier: AGPL-3.0-or-later

import {detectMicupBotViolation} from '@app/api/guild/micupbot/MicupBotAutomod';
import {rule} from '@app/api/guild/micupbot/tests/MicupBotHookTestUtils';
import {afterEach, describe, expect, it, vi} from 'vitest';

const base = {
	content: '',
	mentionedUserIds: [],
	mentionedRoleIds: [],
	mentionEveryone: false,
	inviteHosts: ['https://invite.micup.test/', 'https://app.micup.test/invite/'],
};
describe('MicupBotAutomodDetect', () => {
	afterEach(() => vi.restoreAllMocks());
	it('finds Fluxer and Discord invites', () => {
		for (const content of [
			'https://invite.micup.test/abc',
			'https://app.micup.test/invite/abc',
			'discord.gg/abc',
			'https://discord.com/invite/abc',
			'www.discordapp.com/invite/abc',
		]) {
			expect(detectMicupBotViolation({...base, content, rules: [rule({rule: 'invites'})]}), content).toMatchObject({
				rule: 'invites',
			});
		}
		for (const content of [
			'https://discord.com/channels/123',
			'https://discord.gg.evil.test/abc',
			'https://evil.test/?url=discord.gg/abc',
			'https://app.micup.test/other/abc',
		]) {
			expect(detectMicupBotViolation({...base, content, rules: [rule({rule: 'invites'})]}), content).toBeNull();
		}
	});
	it("allows listed domains and Micup's own", () => {
		const rules = [rule({rule: 'links', allowed_domains: new Set(['example.org'])})];
		for (const content of ['https://example.org/a', 'www.example.org/a', 'https://app.micup.test/help']) {
			expect(detectMicupBotViolation({...base, content, rules}), content).toBeNull();
		}
		for (const content of [
			'https://evil.test',
			'www.evil.test',
			'https://example.org.evil.test',
			'https://example.org@evil.test',
		]) {
			expect(detectMicupBotViolation({...base, content, rules}), content).toMatchObject({rule: 'links'});
		}
	});
	it('matches words case-insensitively in Turkish (İ/ı)', () => {
		for (const [content, word] of [
			['İZMİR', 'izmir'],
			['ISPARTA', 'ısparta'],
			['önce YASAK sonra', 'yasak'],
		]) {
			expect(
				detectMicupBotViolation({...base, content: content!, rules: [rule({words: new Set([word!])})]}),
			).toMatchObject({rule: 'words'});
		}
		expect(detectMicupBotViolation({...base, content: 'IZMIR', rules: [rule({words: new Set(['izmir'])})]})).toBeNull();
	});
	it('matches whole words unless * widens the match', () => {
		for (const [word, hits, misses] of [
			['göt', ['göt', 'Göt!', 'bu göt mü', '(göt)', 'kötü söz göt'], ['götürmek', 'götü', 'ögöt', 'göt1']],
			['göt*', ['göt', 'götürmek', 'GÖTÜ'], ['ögöt', 'sögöt']],
			['*göt', ['göt', 'sögöt'], ['götü']],
			['*göt*', ['göt', 'götürmek', 'sögötü'], ['gö t']],
			['kötü söz', ['bu kötü söz!'], ['kötü sözler']],
			['मार', ['मार'], ['कुमार']],
			['🖕🖕', ['lol🖕🖕'], []],
			['a.b-c', ['a.b-c'], ['axb-c']],
		] as const) {
			const rules = [rule({words: new Set([word])})];
			for (const content of hits) {
				expect(detectMicupBotViolation({...base, content, rules}), `${word} ~ ${content}`).toMatchObject({
					rule: 'words',
				});
			}
			for (const content of misses) {
				expect(detectMicupBotViolation({...base, content, rules}), `${word} !~ ${content}`).toBeNull();
			}
		}
	});
	it('allows subdomains of listed domains without allowing lookalikes', () => {
		const rules = [rule({rule: 'links', allowed_domains: new Set(['youtube.com'])})];
		for (const domain of ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'a.b.youtube.com']) {
			expect(detectMicupBotViolation({...base, rules, content: `https://${domain}/watch`}), domain).toBeNull();
		}
		for (const domain of ['notyoutube.com', 'youtube.com.evil.test', 'youtube.com@evil.test']) {
			expect(detectMicupBotViolation({...base, rules, content: `https://${domain}/watch`}), domain).toMatchObject({
				rule: 'links',
			});
		}
	});
	it('reuses normalized domains and words for the same rule snapshot', () => {
		const allowed_domains = new Set(['EXAMPLE.ORG']);
		const words = new Set(['İZMİR']);
		const domainsRead = vi.spyOn(allowed_domains, Symbol.iterator);
		const wordsRead = vi.spyOn(words, Symbol.iterator);
		const rules = [rule({rule: 'links', allowed_domains}), rule({words})];
		for (let i = 0; i < 2; i++) {
			expect(detectMicupBotViolation({...base, rules, content: 'hello'})).toBeNull();
		}
		expect(domainsRead).toHaveBeenCalledTimes(1);
		expect(wordsRead).toHaveBeenCalledTimes(1);
		const updatedRules = [
			rule({rule: 'links', allowed_domains: new Set(['other.test'])}),
			rule({words: new Set(['ANKARA'])}),
		];
		expect(detectMicupBotViolation({...base, rules: updatedRules, content: 'https://example.org'})).toMatchObject({
			rule: 'links',
		});
		expect(detectMicupBotViolation({...base, rules: updatedRules, content: 'ankara'})).toMatchObject({rule: 'words'});
		expect(detectMicupBotViolation({...base, rules: updatedRules, content: 'izmir'})).toBeNull();
	});
	it('counts user, role and everyone mentions', () => {
		const rules = [rule({rule: 'mentions', threshold: 3})];
		for (const mentions of [{mentionedUserIds: ['1', '2'], mentionedRoleIds: ['3']}, {mentionEveryone: true}]) {
			expect(detectMicupBotViolation({...base, ...mentions, rules})).toMatchObject({rule: 'mentions'});
		}
		expect(detectMicupBotViolation({...base, mentionedUserIds: ['1', '1'], mentionedRoleIds: ['2'], rules})).toBeNull();
	});
	it('caps needs 10 letters and the ratio', () => {
		const rules = [rule({rule: 'caps', threshold: 70})];
		for (const [content, hit] of [
			['ABCDEFGHI', false],
			['ABCDEFGhij', true],
			['ABCDEFghij', false],
			['İĞŞÜÖÇABcd', true],
			['1234567890!!', false],
		]) {
			expect(detectMicupBotViolation({...base, content: content as string, rules}) !== null, content as string).toBe(
				hit,
			);
		}
	});
	it('disabled rules do not match and spam is not a pure text rule', () => {
		expect(
			detectMicupBotViolation({...base, content: 'yasak', rules: [rule({enabled: false}), rule({rule: 'spam'})]}),
		).toBeNull();
	});
	it('links next to punctuation or emoji still match', () => {
		for (const content of ['bak:https://evil.test', '🔥https://evil.test', '**www.evil.test**']) {
			expect(detectMicupBotViolation({...base, content, rules: [rule({rule: 'links'})]}), content).toMatchObject({
				rule: 'links',
			});
		}
	});
});
