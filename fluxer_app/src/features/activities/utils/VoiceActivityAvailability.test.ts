// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {autorun, observable, runInAction} from 'mobx';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const fake = observable({
	games: true,
	features: new Map<string, Set<string>>(),
});

vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({
	default: {
		get response() {
			return {poll_interval_seconds: 60, poll_jitter_percent: 0, assignments: {voice_room: {games: fake.games}}};
		},
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {
		getGuild: (guildId: string) => {
			const features = fake.features.get(guildId);
			return features ? {features} : undefined;
		},
	},
}));

const {voiceActivitiesEnabled} = await import('@app/features/activities/utils/VoiceActivityAvailability');

function setGuildFeatures(guildId: string, features: ReadonlyArray<string>): void {
	runInAction(() => fake.features.set(guildId, new Set(features)));
}

beforeEach(() => {
	runInAction(() => {
		fake.games = true;
		fake.features.clear();
	});
});

describe('voiceActivitiesEnabled', () => {
	it('needs both the games switch and the community feature', () => {
		setGuildFeatures('9', [GuildFeatures.VOICE_ACTIVITIES]);
		expect(voiceActivitiesEnabled('9')).toBe(true);
		runInAction(() => {
			fake.games = false;
		});
		expect(voiceActivitiesEnabled('9')).toBe(false);
	});

	it('is off for a community without the feature, an unknown one and DM calls', () => {
		setGuildFeatures('9', [GuildFeatures.VOICE_E2EE]);
		expect(voiceActivitiesEnabled('9')).toBe(false);
		expect(voiceActivitiesEnabled('8')).toBe(false);
		expect(voiceActivitiesEnabled(null)).toBe(false);
	});

	it('follows the feature being switched on and off live', () => {
		const seen: Array<boolean> = [];
		const dispose = autorun(() => seen.push(voiceActivitiesEnabled('9')));
		setGuildFeatures('9', [GuildFeatures.VOICE_ACTIVITIES]);
		setGuildFeatures('9', []);
		runInAction(() => {
			fake.games = false;
		});
		setGuildFeatures('9', [GuildFeatures.VOICE_ACTIVITIES]);
		dispose();
		expect(seen).toEqual([false, true, false, false]);
	});
});
