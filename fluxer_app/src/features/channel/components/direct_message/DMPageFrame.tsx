// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelHeader} from '@app/features/channel/components/ChannelHeader';
import styles from '@app/features/channel/components/direct_message/DMPageFrame.module.css';
import {Scroller, type ScrollerHandle} from '@app/features/ui/components/Scroller';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {getNextTabIndex, getTabNavigationDirection} from '@app/features/ui/tabs/TabKeyboardNavigation';
import type {Icon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useId, useRef} from 'react';

export interface DMPageTab<T extends string> {
	key: T;
	label: string;
}

interface DMPageFrameProps<T extends string> {
	icon: Icon;
	title: string;
	tabs?: ReadonlyArray<DMPageTab<T>>;
	activeTab?: T;
	onTabChange?: (tab: T) => void;
	// 'panel' (default): each tab shows its own panel. 'anchor': the tabs jump within one long page; the page keeps
	// activeTab in step with the scroll and the tabs carry aria-current instead of tab roles.
	tabsMode?: 'panel' | 'anchor';
	// The button at the right end of the bar.
	action?: React.ReactNode;
	// Replaces the column's default layout (width, padding, gaps) for a page that lays itself out.
	bodyClassName?: string;
	scrollerRef?: React.Ref<ScrollerHandle>;
	children: React.ReactNode;
}

// Micup: the frame of a page beside the DM list (premium, shop), in the Friends page's pattern: a thin bar with the
// icon, the title, tab pills and one action; the page scrolls under it.
function DMPageFrameInner<T extends string>({
	icon: TitleIcon,
	title,
	tabs,
	activeTab,
	onTabChange,
	tabsMode = 'panel',
	action,
	bodyClassName,
	scrollerRef,
	children,
}: DMPageFrameProps<T>) {
	const idPrefix = useId();
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const hasTabs = tabs != null && tabs.length > 0 && activeTab != null && onTabChange != null;
	const panelTabs = hasTabs && tabsMode === 'panel';
	const tabId = (key: T) => `${idPrefix}-tab-${key}`;
	const panelId = `${idPrefix}-panel`;
	// Anchor tabs are plain buttons that mark where the page is; panel tabs are a tablist with roving focus.
	const tabListA11y = panelTabs ? {role: 'tablist' as const, 'aria-label': title} : {};
	const tabA11y = (selected: boolean) =>
		panelTabs
			? {role: 'tab' as const, 'aria-selected': selected, 'aria-controls': panelId, tabIndex: selected ? 0 : -1}
			: {'aria-current': selected ? ('true' as const) : undefined};
	const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
		const direction = getTabNavigationDirection(event.key, 'horizontal');
		if (!panelTabs || !direction) return;
		const nextIndex = getNextTabIndex(index, tabs.length, direction);
		const nextTab = nextIndex == null ? null : tabs[nextIndex];
		if (nextIndex == null || !nextTab) return;
		event.preventDefault();
		event.stopPropagation();
		onTabChange(nextTab.key);
		requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
	};
	const headerContent = (
		<div className={styles.headerContent} data-flx="channel.direct-message.dm-page-frame.header-content">
			{!(MobileLayout.enabled && hasTabs) && (
				<div className={styles.titleSection} data-flx="channel.direct-message.dm-page-frame.title-section">
					<TitleIcon
						weight="fill"
						className={styles.titleIcon}
						data-flx="channel.direct-message.dm-page-frame.title-icon"
					/>
					<span className={styles.titleText} data-flx="channel.direct-message.dm-page-frame.title-text">
						{title}
					</span>
				</div>
			)}
			{hasTabs && (
				<>
					{!MobileLayout.enabled && (
						<div className={styles.divider} data-flx="channel.direct-message.dm-page-frame.divider" />
					)}
					<div className={styles.tabsWrapper} data-flx="channel.direct-message.dm-page-frame.tabs-wrapper">
						<Scroller
							className={styles.tabsScroller}
							orientation="horizontal"
							overflow="auto"
							fade={false}
							key="dm-page-frame-tabs-scroller"
							data-flx="channel.direct-message.dm-page-frame.tabs-scroller"
						>
							<div
								className={styles.tabsInner}
								{...tabListA11y}
								data-flx="channel.direct-message.dm-page-frame.tabs-inner"
							>
								{tabs.map((tab, index) => {
									const selected = tab.key === activeTab;
									return (
										<FocusRing
											key={tab.key}
											within
											offset={-2}
											data-flx="channel.direct-message.dm-page-frame.tab-focus-ring"
										>
											<button
												ref={(element) => {
													tabRefs.current[index] = element;
												}}
												id={tabId(tab.key)}
												type="button"
												{...tabA11y(selected)}
												className={clsx(styles.tabButton, selected && styles.tabButtonActive)}
												onClick={() => onTabChange(tab.key)}
												onKeyDown={(event) => handleKeyDown(event, index)}
												data-flx="channel.direct-message.dm-page-frame.tab-button.click"
											>
												{tab.label}
											</button>
										</FocusRing>
									);
								})}
							</div>
						</Scroller>
					</div>
				</>
			)}
			{action && (
				<div className={styles.action} data-flx="channel.direct-message.dm-page-frame.action">
					{action}
				</div>
			)}
		</div>
	);
	return (
		<div className={styles.container} data-flx="channel.direct-message.dm-page-frame.container">
			<ChannelHeader
				leftContent={headerContent}
				showMembersToggle={false}
				showPins={false}
				data-flx="channel.direct-message.dm-page-frame.channel-header"
			/>
			<Scroller
				ref={scrollerRef}
				className={styles.scroller}
				key="dm-page-frame-scroller"
				data-flx="channel.direct-message.dm-page-frame.scroller"
			>
				{panelTabs ? (
					<div
						id={panelId}
						role="tabpanel"
						aria-labelledby={tabId(activeTab)}
						className={bodyClassName ?? styles.body}
						data-flx="channel.direct-message.dm-page-frame.tab-panel"
					>
						{children}
					</div>
				) : (
					<div className={bodyClassName ?? styles.body} data-flx="channel.direct-message.dm-page-frame.body">
						{children}
					</div>
				)}
			</Scroller>
		</div>
	);
}

export const DMPageFrame = observer(DMPageFrameInner) as typeof DMPageFrameInner;
