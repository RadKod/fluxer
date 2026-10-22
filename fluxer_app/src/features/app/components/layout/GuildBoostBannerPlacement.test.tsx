// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildBannerPresentation} from '@app/features/app/hooks/useGuildBannerPresentation';
import type {Guild} from '@app/features/guild/models/Guild';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {motionValue} from 'framer-motion';
import {act, createElement, type HTMLAttributes, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const surface = ({children, ...props}: HTMLAttributes<HTMLDivElement>) => createElement('div', props, children);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/app/Routes', () => ({Routes: {guildMembers: (guildId: string) => `/channels/${guildId}/members`}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {showFadedUnreadOnMutedChannels: false},
	setAccessibilityUserSettings: vi.fn(),
}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/activities/components/VoiceChannelActivityLine', () => ({VoiceChannelActivityLine: () => null}));
vi.mock('@app/features/app/components/layout/ChannelItem', () => ({ChannelItem: () => null}));
vi.mock('@app/features/app/components/layout/ChannelItemContent', () => ({ChannelItemContent: () => null}));
vi.mock('@app/features/app/components/layout/CollapsedCategoryVoiceParticipants', () => ({
	CollapsedCategoryVoiceParticipants: () => null,
	CollapsedChannelAvatarStack: () => null,
}));
vi.mock('@app/features/app/components/layout/GenericChannelItem', () => ({GenericChannelItem: surface}));
vi.mock('@app/features/app/components/layout/GuildHeaderShell', () => ({
	GuildHeaderShell: ({children}: {children: (isOpen: boolean) => ReactNode}) => children(false),
}));
vi.mock('@app/features/app/components/layout/NativeDragRegion', () => ({NativeDragRegion: surface}));
vi.mock('@app/features/app/components/layout/NullSpaceDropIndicator', () => ({NullSpaceDropIndicator: () => null}));
vi.mock('@app/features/app/components/layout/ScrollIndicatorOverlay', () => ({ScrollIndicatorOverlay: () => null}));
vi.mock('@app/features/app/components/layout/VoiceParticipantsList', () => ({VoiceParticipantsList: () => null}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({
	reportSkeletonGuildPresentation: vi.fn(),
	reportSkeletonGuildChannelList: vi.fn(),
	SkeletonGuildBannerPlacement: {NONE: 'none', DETACHED: 'detached', INTEGRATED: 'integrated'},
}));
vi.mock('@app/features/app/hooks/useGuildBannerPlayback', () => ({
	useGuildBannerPlayback: ({staticUrl}: {staticUrl: string | null}) => ({imageUrl: staticUrl, hoverRef: () => {}}),
}));
vi.mock('@app/features/app/hooks/useRovingFocusList', () => ({useRovingFocusList: () => () => {}}));
vi.mock('@app/features/app/hooks/useSkeletonLayoutMemoryCapture', () => ({
	useSkeletonLayoutReport: () => {},
	measureSkeletonTextWidthPx: () => 0,
}));
vi.mock('@app/features/boost/components/GuildBoostGoalRow', () => ({
	GuildBoostGoalRow: ({guildId}: {guildId: string}) =>
		createElement('button', {type: 'button', 'data-flx': 'boost.goal-row.button', 'data-guild-id': guildId}, 'Boost'),
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getGuildChannels: () => []}}));
vi.mock('@app/features/guild/commands/GuildCommands', () => ({}));
vi.mock('@app/features/guild/components/bottomsheets/GuildHeaderBottomSheet', () => ({
	GuildHeaderBottomSheet: () => null,
}));
vi.mock('@app/features/guild/components/GuildBadge', () => ({GuildBadge: () => null}));
vi.mock('@app/features/guild/components/popouts/GuildHeaderPopout', () => ({GuildHeaderPopout: () => null}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({MEMBERS_DESCRIPTOR: {message: 'Members'}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {getGuildPermissions: () => 0n}}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: '/channels/guild'}),
}));
vi.mock('@app/features/platform/utils/ResponseInspection', () => ({failureCode: vi.fn()}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {version: 0}}));
vi.mock('@app/features/threads/components/SidebarThreadList', () => ({SidebarThreadList: () => null}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => false}}));
vi.mock('@app/features/ui/action_menu/ChannelListContextMenu', () => ({ChannelListContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/GuildContextMenu', () => ({GuildContextMenu: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({}));
vi.mock('@app/features/ui/commands/DimensionCommands', () => ({}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({}));
vi.mock('@app/features/ui/components/Scroller', () => ({
	Scroller: ({children, className}: HTMLAttributes<HTMLDivElement>) => createElement('div', {className}, children),
}));
vi.mock('@app/features/ui/hooks/useDragAutoScroll', () => ({useDragAutoScroll: () => {}}));
vi.mock('@app/features/ui/state/Dimension', () => ({default: {guildDimensionsFor: () => ({})}}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false, isMobileLayout: () => false}}));
vi.mock('@app/features/ui/state/Popout', () => ({default: {popouts: {}}}));
vi.mock('@app/features/user/commands/UserGuildSettingsCommands', () => ({}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {getSettingsForScope: () => null}}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({
	getGuildBannerURL: ({banner}: {banner: string | null}) => (banner ? 'https://cdn.test/banner.png' : null),
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {channelId: null}}));
vi.mock('react-dnd', () => ({useDragLayer: () => false}));

const {GuildHeader} = await import('./GuildHeader');
const {ChannelListContent} = await import('./ChannelListContent');

describe('guild boost row placement', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(placement: 'integrated' | 'detached' | 'none') {
		const hasBanner = placement !== 'none';
		const integrated = placement === 'integrated';
		const guild = {
			id: 'guild',
			name: 'Community',
			banner: hasBanner ? 'banner' : null,
			features: new Set(placement === 'detached' ? [GuildFeatures.DETACHED_BANNER] : []),
		} as unknown as Guild;
		const banner: GuildBannerPresentation = {
			channelList: {hoverRef: () => {}, collapsible: integrated, collapseDistance: integrated ? 102 : 0},
			headerRowRef: () => {},
			hoverRef: () => {},
			imageUrl: integrated ? 'https://cdn.test/banner.png' : null,
			hasBanner,
			isDetached: placement === 'detached',
			aspectRatio: 2,
			bannerHeight: integrated ? 150 : 48,
			collapseDistance: integrated ? 102 : 0,
			collapsible: integrated,
			centerCrop: false,
			frosted: false,
			collapsed: false,
			clipShift: motionValue(0),
			imageShift: motionValue(0),
			imageOpacity: motionValue(1),
			glassOpacity: motionValue(0),
			scrimOpacity: motionValue(1),
		};
		act(() =>
			root.render(
				createElement(
					'div',
					null,
					createElement(GuildHeader, {guild, banner}),
					createElement(ChannelListContent, {guild, banner, scrollY: motionValue(0)}),
				),
			),
		);
	}
	function node(dataFlx: string) {
		const element = container.querySelector(`[data-flx="${dataFlx}"]`);
		expect(element, dataFlx).not.toBeNull();
		return element!;
	}
	function boostRow() {
		expect(container.querySelectorAll('[data-flx="boost.goal-row.button"]')).toHaveLength(1);
		return node('boost.goal-row.button');
	}

	it('places the boost row after the entire integrated banner spacer', () => {
		render('integrated');
		const spacer = node('app.channel-list-content.banner-spacer');
		expect(spacer.getAttribute('style')).toContain('102px');
		expect(spacer.nextElementSibling).toBe(boostRow());
	});
	it('places the boost row after the detached banner', () => {
		render('detached');
		expect(node('app.guild-detached-banner.container').nextElementSibling).toBe(boostRow());
	});
	it('places the boost row directly after the header when there is no banner', () => {
		render('none');
		expect(node('app.channel-list-content.navigation-container.context-menu').firstElementChild).toBe(boostRow());
		expect(node('app.guild-header.header-wrapper').contains(boostRow())).toBe(false);
	});
});
