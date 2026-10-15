// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import {parse} from '@babel/parser';
import {transformSync} from 'esbuild';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({features: [] as Array<string>, traits: [] as Array<string>}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => ({
			limits: {
				traitDefinitions: [],
				rules: [
					{id: 'base', limits: {feature_role_icons: 0, feature_role_gradient: 0}},
					{id: 'level1', filters: {guildFeatures: ['BOOST_LEVEL_1']}, limits: {feature_role_icons: 1}},
					{id: 'level2', filters: {guildFeatures: ['BOOST_LEVEL_2']}, limits: {feature_role_gradient: 1}},
				],
			},
		}),
	},
}));
vi.mock('@app/features/app/state/InstanceSnapshotStore', () => ({default: {}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => null}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: null}}));
vi.mock('@app/features/navigation/state/SelectedGuild', () => ({default: {selectedGuildId: 'other-guild'}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => ({traits: state.traits})}}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {getGuild: (id: string) => ({features: id === 'edited-guild' ? state.features : []})},
}));

const source = readFileSync(new URL(/* @vite-ignore */ './GuildRolesTab.tsx', import.meta.url), 'utf8');
const declaration = parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx']})
	.program.body.filter((node) => node.type === 'VariableDeclaration')
	.flatMap((node) => node.declarations)
	.find((node) => node.id.type === 'Identifier' && node.id.name === 'GuildRolesTab');
const component = declaration?.init;
const render = component?.type === 'CallExpression' ? component.arguments[0] : null;
if (render?.type !== 'ArrowFunctionExpression' || render.body.type !== 'BlockStatement') {
	throw new Error('GuildRolesTab render not found');
}
const expressions = render.body.body
	.filter((node) => node.type === 'VariableDeclaration')
	.flatMap((node) => node.declarations)
	.filter((node) => node.id.type === 'Identifier' && ['canSetRoleIcons', 'canSetRoleGradient'].includes(node.id.name))
	.map((node) => source.slice(node.init!.start!, node.init!.end!));
if (expressions.length !== 2) throw new Error('Role entitlement expressions not found');
// Evaluate the production call expressions without mounting unrelated role settings stores and dialogs.
const evaluate = new Function(
	'LimitResolver',
	'guildId',
	transformSync(`return [${expressions.join(',')}];`, {loader: 'ts'}).code,
) as (resolver: typeof LimitResolver, guildId: string) => [boolean, boolean];

beforeEach(() => {
	state.features = [];
	state.traits = [];
});

describe('role editor guild entitlements', () => {
	it.each([
		{features: [], expected: [false, false]},
		{features: ['BOOST_LEVEL_1'], expected: [true, false]},
		{features: ['BOOST_LEVEL_1', 'BOOST_LEVEL_2'], expected: [true, true]},
	])('uses the edited guild features: $features', ({features, expected}) => {
		state.features = features;
		expect(evaluate(LimitResolver, 'edited-guild')).toEqual(expected);
	});

	it('removes both role controls after the guild loses its boost features', () => {
		state.features = ['BOOST_LEVEL_1', 'BOOST_LEVEL_2'];
		expect(evaluate(LimitResolver, 'edited-guild')).toEqual([true, true]);
		state.features = [];
		expect(evaluate(LimitResolver, 'edited-guild')).toEqual([false, false]);
	});

	it.each(['free', 'premium'])('preserves the default user evaluation for a %s account', (account) => {
		state.features = ['BOOST_LEVEL_1', 'BOOST_LEVEL_2'];
		state.traits = account === 'premium' ? ['premium'] : [];
		for (const key of ['feature_role_icons', 'feature_role_gradient'] as const) {
			expect(LimitResolver.resolve({key, fallback: 0, context: {guildId: 'edited-guild'}})).toBe(0);
		}
	});
});
