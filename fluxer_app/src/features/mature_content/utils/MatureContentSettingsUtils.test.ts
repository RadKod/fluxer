// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {Guild} from '@app/features/guild/models/Guild';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const limits = vi.hoisted((): Record<string, number> => ({}));
const parents = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key, fallback}: {key: string; fallback: number}) => limits[key] ?? fallback,
	},
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: (id: string) => parents[id]}}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const {shouldShowChannelMatureContentSettings, shouldShowGuildMatureContentSettings} = await import(
	'@app/features/mature_content/utils/MatureContentSettingsUtils'
);

function channel(overrides: Partial<Channel> = {}): Channel {
	return {
		type: ChannelTypes.GUILD_TEXT,
		parentId: null,
		nsfwOverride: null,
		contentWarningLevel: ContentWarningLevel.INHERIT,
		contentWarningText: null,
		...overrides,
	} as Channel;
}

function guild(overrides: Partial<Guild> = {}): Guild {
	return {
		nsfw: false,
		contentWarningLevel: ContentWarningLevel.INHERIT,
		contentWarningText: null,
		...overrides,
	} as Guild;
}

describe('mature content settings visibility', () => {
	beforeEach(() => {
		delete limits.feature_mature_content_settings;
		delete parents['10'];
	});

	it('hides the settings when the flag is missing', () => {
		expect(shouldShowChannelMatureContentSettings(channel(), guild())).toBe(false);
		expect(shouldShowGuildMatureContentSettings(guild())).toBe(false);
	});

	it('hides the settings when the flag is 0', () => {
		limits.feature_mature_content_settings = 0;
		expect(shouldShowChannelMatureContentSettings(channel(), guild())).toBe(false);
		expect(shouldShowGuildMatureContentSettings(guild())).toBe(false);
	});

	it('shows the settings when the flag is 1', () => {
		limits.feature_mature_content_settings = 1;
		expect(shouldShowChannelMatureContentSettings(channel(), guild())).toBe(true);
		expect(shouldShowGuildMatureContentSettings(guild())).toBe(true);
	});

	it('keeps the settings where a channel already has one, so it can be changed', () => {
		expect(shouldShowChannelMatureContentSettings(channel({nsfwOverride: true}), guild())).toBe(true);
		expect(shouldShowChannelMatureContentSettings(channel({nsfwOverride: false}), guild())).toBe(true);
		expect(
			shouldShowChannelMatureContentSettings(
				channel({contentWarningLevel: ContentWarningLevel.CONTENT_WARNING}),
				guild(),
			),
		).toBe(true);
	});

	it('keeps the channel settings where the community or category is marked, so a channel can opt out', () => {
		expect(shouldShowChannelMatureContentSettings(channel(), guild({nsfw: true}))).toBe(true);
		expect(
			shouldShowChannelMatureContentSettings(
				channel(),
				guild({contentWarningLevel: ContentWarningLevel.CONTENT_WARNING}),
			),
		).toBe(true);
		parents['10'] = channel({type: ChannelTypes.GUILD_CATEGORY, nsfwOverride: true});
		expect(shouldShowChannelMatureContentSettings(channel({parentId: '10'}), guild())).toBe(true);
	});

	it('keeps the settings where a community already has one, so it can be turned off', () => {
		expect(shouldShowGuildMatureContentSettings(guild({nsfw: true}))).toBe(true);
		expect(
			shouldShowGuildMatureContentSettings(guild({contentWarningLevel: ContentWarningLevel.CONTENT_WARNING})),
		).toBe(true);
	});
});
