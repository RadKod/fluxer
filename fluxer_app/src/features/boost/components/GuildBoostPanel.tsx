// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Limits} from '@app/features/app/utils/UserLimits';
import {openGuildBoostSettings} from '@app/features/boost/commands/GuildBoostPanelCommands';
import {BoostGemIcon} from '@app/features/boost/components/BoostGemIcon';
import {GuildBoostActionButton} from '@app/features/boost/components/GuildBoostActionButton';
import {GuildBoostLevelBadge} from '@app/features/boost/components/GuildBoostLevelBadge';
import styles from '@app/features/boost/components/GuildBoostPanel.module.css';
import {GuildBoostPerks} from '@app/features/boost/components/GuildBoostPerks';
import {useGuildBoostAction} from '@app/features/boost/hooks/useGuildBoostAction';
import GuildBoosts from '@app/features/boost/state/GuildBoosts';
import {getGuildBoostLevelPerks} from '@app/features/boost/utils/GuildBoostLevels';
import {
	BASE_INCLUDED_DESCRIPTOR,
	BASE_PERKS_DESCRIPTOR,
	BOOST_COUNT_DESCRIPTOR,
	LEVEL_DESCRIPTOR,
	LEVEL_TOTAL_DESCRIPTOR,
	NEXT_LEVEL_DESCRIPTOR,
	PERKS_DESCRIPTOR,
	PROGRESS_DESCRIPTOR,
	REMAINING_BOOSTS_DESCRIPTOR,
	TOP_LEVEL_DESCRIPTOR,
	UNLOCKED_DESCRIPTOR,
} from '@app/features/boost/utils/GuildBoostMessages';
import Guilds from '@app/features/guild/state/Guilds';
import {SOMETHING_WENT_WRONG_DESCRIPTOR, TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Spinner} from '@app/features/ui/components/Spinner';
import {DEFAULT_STOCK_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const SLOT_EXPLANATION_DESCRIPTOR = msg({
	message:
		'{premiumProductName} includes {count, plural, one {# boost slot} other {# boost slots}}. Each boost uses one free slot.',
	comment: 'Explains Plus boost capacity from the instance max_boost_slots limit. Never assume a fixed slot count.',
});
const NO_SLOTS_DESCRIPTOR = msg({
	message: 'You have no free boost slots.',
	comment: 'Current user has no unassigned boost slot. The Plus button opens the existing Plus flow.',
});
const WHAT_IS_BOOST_DESCRIPTOR = msg({
	message: 'What is a boost?',
	comment: 'Heading explaining community boosts in the perks dialog.',
});
const BOOST_EXPLANATION_DESCRIPTOR = msg({
	message: 'A boost helps this community reach the next level and unlock perks for everyone here.',
	comment: 'Explains that community boost levels unlock the listed perks for the community.',
});
const MANAGE_BOOSTS_DESCRIPTOR = msg({
	message: 'Manage boosts',
	comment: 'Opens the existing community boosts settings to view boosters or remove your boost.',
});

export const GuildBoostPanel = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const {acting, handleBoost} = useGuildBoostAction();
	useEffect(() => {
		void GuildBoosts.open(guildId);
		return GuildBoosts.close;
	}, [guildId]);
	const levels = getGuildBoostLevelPerks(RuntimeConfig.limits, Guilds.getGuild(guildId));
	const {status, ready, failed} = GuildBoosts;
	const goal = status?.next?.boosts ?? levels[levels.length - 1].boosts;
	const slots = Limits.getStockValue('max_boost_slots', DEFAULT_STOCK_LIMITS.max_boost_slots);
	return (
		<Modal.Root size="medium" centered data-flx="boost.panel.modal-root">
			<Modal.Header title={i18n._(PERKS_DESCRIPTOR)} icon={<BoostGemIcon size={24} />} data-flx="boost.panel.header" />
			<Modal.Content data-flx="boost.panel.content">
				{failed ? (
					<div className={styles.loading} role="alert">
						<p>{i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)}</p>
						<Button onClick={() => void GuildBoosts.open(guildId)}>{i18n._(TRY_AGAIN_DESCRIPTOR)}</Button>
					</div>
				) : !ready || !status ? (
					<div className={styles.loading}>
						<Spinner />
					</div>
				) : (
					<div className={styles.body}>
						<div>
							<h2 className={styles.explanationHeading}>{i18n._(WHAT_IS_BOOST_DESCRIPTOR)}</h2>
							<p className={styles.muted}>{i18n._(BOOST_EXPLANATION_DESCRIPTOR)}</p>
						</div>
						<div className={styles.summary}>
							<span className={styles.currentLevel}>
								<GuildBoostLevelBadge level={status.level} size={24} />
								{i18n._(LEVEL_DESCRIPTOR, {level: status.level})}
							</span>
							<span className={styles.muted}>{i18n._(BOOST_COUNT_DESCRIPTOR, {count: status.count})}</span>
						</div>
						<progress
							className={styles.progress}
							value={status.next ? Math.min(status.count, goal) : goal}
							max={goal}
							aria-label={i18n._(PROGRESS_DESCRIPTOR, {count: status.count, goal})}
						/>
						{!status.next && <p className={styles.muted}>{i18n._(TOP_LEVEL_DESCRIPTOR)}</p>}
						{status.next && (
							<p className={styles.muted}>
								{i18n._(REMAINING_BOOSTS_DESCRIPTOR, {
									count: Math.max(0, status.next.boosts - status.count),
									level: status.next.level,
								})}
							</p>
						)}
						<div className={styles.levels}>
							{levels.map((level) => (
								<section
									key={level.level}
									className={styles.levelCard}
									data-level={level.level}
									data-unlocked={status.level >= level.level}
									data-next={status.next?.level === level.level}
									data-flx="boost.panel.level-card"
								>
									<div className={styles.cardHeading}>
										<h2>
											<GuildBoostLevelBadge level={level.level} size={20} />
											<span>
												{level.level === 0
													? i18n._(BASE_PERKS_DESCRIPTOR)
													: i18n._(LEVEL_DESCRIPTOR, {level: level.level})}
											</span>
										</h2>
										<span className={styles.muted}>
											{level.level === 0
												? i18n._(BASE_INCLUDED_DESCRIPTOR)
												: i18n._(LEVEL_TOTAL_DESCRIPTOR, {level: level.level, count: level.boosts})}
										</span>
									</div>
									{level.level === 0 ? null : status.level >= level.level ? (
										<span className={styles.mark}>
											<CheckCircleIcon size={16} aria-hidden="true" />
											{i18n._(UNLOCKED_DESCRIPTOR)}
										</span>
									) : status.next?.level === level.level ? (
										<span className={styles.next}>{i18n._(NEXT_LEVEL_DESCRIPTOR)}</span>
									) : null}
									<GuildBoostPerks perks={level.perks} />
								</section>
							))}
						</div>
						<p className={styles.muted}>
							{i18n._(SLOT_EXPLANATION_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME, count: slots})}
						</p>
						{!GuildBoosts.hasFreeSlot && <p className={styles.muted}>{i18n._(NO_SLOTS_DESCRIPTOR)}</p>}
					</div>
				)}
			</Modal.Content>
			{ready && !failed && status && (
				<Modal.Footer data-flx="boost.panel.footer">
					<Button variant="secondary" small onClick={() => openGuildBoostSettings(guildId)}>
						{i18n._(MANAGE_BOOSTS_DESCRIPTOR)}
					</Button>
					<GuildBoostActionButton acting={acting} onBoost={handleBoost} />
				</Modal.Footer>
			)}
		</Modal.Root>
	);
});
