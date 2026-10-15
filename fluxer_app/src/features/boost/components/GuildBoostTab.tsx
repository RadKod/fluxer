// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {GuildBoostActionButton} from '@app/features/boost/components/GuildBoostActionButton';
import {GuildBoostLevelBadge} from '@app/features/boost/components/GuildBoostLevelBadge';
import {GuildBoostPerks} from '@app/features/boost/components/GuildBoostPerks';
import styles from '@app/features/boost/components/GuildBoostTab.module.css';
import {useGuildBoostAction} from '@app/features/boost/hooks/useGuildBoostAction';
import GuildBoosts from '@app/features/boost/state/GuildBoosts';
import {getGuildBoostLevelPerks} from '@app/features/boost/utils/GuildBoostLevels';
import {
	BASE_INCLUDED_DESCRIPTOR,
	BASE_PERKS_DESCRIPTOR,
	BOOST_COUNT_DESCRIPTOR,
	LEVEL_DESCRIPTOR,
	LEVEL_TOTAL_DESCRIPTOR,
	REMAINING_BOOSTS_DESCRIPTOR,
	TOP_LEVEL_DESCRIPTOR,
} from '@app/features/boost/utils/GuildBoostMessages';
import Guilds from '@app/features/guild/state/Guilds';
import {
	CANCEL_DESCRIPTOR,
	NEXT_DESCRIPTOR,
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import * as AvatarUtils from '@app/features/user/utils/AvatarUtils';
import {getFormattedShortDate} from '@app/features/user/utils/DateFormatting';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {WarningIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect} from 'react';

const NO_LEVEL_DESCRIPTOR = msg({
	message: 'No level yet',
	comment: 'Shown in the community boosts settings tab when the community has not reached boost level 1.',
});
const PREVIOUS_DESCRIPTOR = msg({
	message: 'Previous',
	comment: 'Button that shows the previous page of a list.',
});
const REMOVE_BOOST_DESCRIPTOR = msg({
	message: 'Remove boost',
	comment: 'Button and confirmation title for taking your own boost off a community.',
});
const GuildBoostTab: React.FC<{guildId: string}> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const {acting, handleBoost, showError} = useGuildBoostAction();
	useEffect(() => {
		void GuildBoosts.open(guildId);
		return GuildBoosts.close;
	}, [guildId]);
	const handleRemove = useCallback(
		(boostId: string) => {
			ModalCommands.push(
				modal(() => (
					<ConfirmModal
						title={i18n._(REMOVE_BOOST_DESCRIPTOR)}
						description={<Trans>The level of this community can drop when your boost is removed.</Trans>}
						primaryText={i18n._(REMOVE_BOOST_DESCRIPTOR)}
						primaryVariant="danger"
						secondaryText={i18n._(CANCEL_DESCRIPTOR)}
						onPrimary={async () => {
							try {
								await GuildBoosts.removeBoost(boostId);
							} catch {
								showError();
							}
						}}
						data-flx="boost.guild-boost-tab.handle-remove.confirm-modal"
					/>
				)),
			);
		},
		[i18n, showError],
	);
	const {status, ready, failed} = GuildBoosts;
	if (failed) {
		return (
			<StatusSlate
				Icon={WarningIcon}
				title={i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)}
				description={i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR)}
				actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: () => void GuildBoosts.open(guildId)}]}
				data-flx="boost.guild-boost-tab.status-slate"
			/>
		);
	}
	if (!ready || !status) {
		return (
			<div className={styles.spinnerContainer} data-flx="boost.guild-boost-tab.spinner-container">
				<Spinner data-flx="boost.guild-boost-tab.spinner" />
			</div>
		);
	}
	const ownBoostId = GuildBoosts.ownBoostIds[0];
	const boostCount = i18n._(BOOST_COUNT_DESCRIPTOR, {count: status.count});
	return (
		<div className={styles.container} data-flx="boost.guild-boost-tab.container">
			<section className={styles.card} data-flx="boost.guild-boost-tab.status-card">
				<div className={styles.statusRow} data-flx="boost.guild-boost-tab.status-row">
					<span className={styles.level} data-flx="boost.guild-boost-tab.level">
						<GuildBoostLevelBadge level={status.level} size={20} />
						<span>
							{status.level > 0 ? i18n._(LEVEL_DESCRIPTOR, {level: status.level}) : i18n._(NO_LEVEL_DESCRIPTOR)}
						</span>
					</span>
					<span className={styles.muted} data-flx="boost.guild-boost-tab.boost-count">
						{boostCount}
					</span>
				</div>
				<progress
					className={styles.progress}
					value={status.count}
					max={status.next?.boosts ?? status.count}
					aria-label={boostCount}
					data-flx="boost.guild-boost-tab.progress"
				/>
				<span className={styles.muted} data-flx="boost.guild-boost-tab.next-level">
					{status.next
						? i18n._(LEVEL_TOTAL_DESCRIPTOR, {level: status.next.level, count: status.next.boosts})
						: i18n._(TOP_LEVEL_DESCRIPTOR)}
				</span>
				{status.next && (
					<span className={styles.muted}>
						{i18n._(REMAINING_BOOSTS_DESCRIPTOR, {
							count: Math.max(0, status.next.boosts - status.count),
							level: status.next.level,
						})}
					</span>
				)}
				<div className={styles.actions} data-flx="boost.guild-boost-tab.actions">
					{ownBoostId && (
						<Button
							variant="secondary"
							small={true}
							disabled={acting}
							onClick={() => handleRemove(ownBoostId)}
							data-flx="boost.guild-boost-tab.button.remove"
						>
							{i18n._(REMOVE_BOOST_DESCRIPTOR)}
						</Button>
					)}
					<GuildBoostActionButton acting={acting} onBoost={handleBoost} />
				</div>
				{!GuildBoosts.hasFreeSlot && (
					<p className={styles.muted} data-flx="boost.guild-boost-tab.no-free-slot">
						<Trans>You have no free boost slots. Boost slots come with {PREMIUM_PRODUCT_NAME}.</Trans>
					</p>
				)}
			</section>
			<section className={styles.section} data-flx="boost.guild-boost-tab.perks-section">
				<h3 className={styles.heading} data-flx="boost.guild-boost-tab.perks-heading">
					<Trans>Level perks</Trans>
				</h3>
				{getGuildBoostLevelPerks(RuntimeConfig.limits, Guilds.getGuild(guildId)).map((level) => (
					<div key={level.level} className={styles.card} data-flx="boost.guild-boost-tab.level-card">
						<div className={styles.statusRow} data-flx="boost.guild-boost-tab.level-row">
							<span className={styles.level} data-flx="boost.guild-boost-tab.level-name">
								<GuildBoostLevelBadge level={level.level} size={20} />
								<span>
									{level.level === 0 ? i18n._(BASE_PERKS_DESCRIPTOR) : i18n._(LEVEL_DESCRIPTOR, {level: level.level})}
								</span>
							</span>
							<span className={styles.muted} data-flx="boost.guild-boost-tab.level-boosts">
								{level.level === 0
									? i18n._(BASE_INCLUDED_DESCRIPTOR)
									: i18n._(LEVEL_TOTAL_DESCRIPTOR, {level: level.level, count: level.boosts})}
							</span>
						</div>
						<GuildBoostPerks perks={level.perks} />
					</div>
				))}
			</section>
			<section className={styles.section} data-flx="boost.guild-boost-tab.boosters-section">
				<h3 className={styles.heading} data-flx="boost.guild-boost-tab.boosters-heading">
					<Trans>Boosters</Trans>
				</h3>
				{GuildBoosts.page.length === 0 ? (
					<p className={styles.muted} data-flx="boost.guild-boost-tab.empty">
						<Trans>No boosts yet</Trans>
					</p>
				) : (
					<ul className={styles.boosters} data-flx="boost.guild-boost-tab.boosters">
						{GuildBoosts.page.map((boost) => (
							<li key={boost.id} className={styles.booster} data-flx="boost.guild-boost-tab.booster">
								<img
									src={AvatarUtils.getUserAvatarURL(boost.user, false)}
									alt=""
									className={styles.avatar}
									data-flx="boost.guild-boost-tab.avatar"
								/>
								<span className={styles.name} data-flx="boost.guild-boost-tab.name">
									{NicknameUtils.getDisplayName(boost.user)}
								</span>
								<span className={styles.muted} data-flx="boost.guild-boost-tab.boosted-at">
									{getFormattedShortDate(boost.created_at)}
								</span>
							</li>
						))}
					</ul>
				)}
				{(GuildBoosts.hasPrevious || GuildBoosts.hasMore) && (
					<div className={styles.actions} data-flx="boost.guild-boost-tab.pager">
						<Button
							variant="secondary"
							small={true}
							disabled={!GuildBoosts.hasPrevious || GuildBoosts.loading}
							onClick={GuildBoosts.previousPage}
							data-flx="boost.guild-boost-tab.button.previous-page"
						>
							{i18n._(PREVIOUS_DESCRIPTOR)}
						</Button>
						<Button
							variant="secondary"
							small={true}
							disabled={!GuildBoosts.hasMore || GuildBoosts.loading}
							onClick={GuildBoosts.nextPage}
							data-flx="boost.guild-boost-tab.button.next-page"
						>
							{i18n._(NEXT_DESCRIPTOR)}
						</Button>
					</div>
				)}
			</section>
		</div>
	);
});

export default GuildBoostTab;
