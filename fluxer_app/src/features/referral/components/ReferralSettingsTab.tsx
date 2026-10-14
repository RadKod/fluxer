// SPDX-License-Identifier: AGPL-3.0-or-later

import {CopyLinkSection} from '@app/features/app/components/dialogs/shared/CopyLinkSection';
import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import {SettingsTabContainer, SettingsTabContent} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as CosmeticCommands from '@app/features/cosmetics/commands/CosmeticCommands';
import {
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as ReferralCommands from '@app/features/referral/commands/ReferralCommands';
import styles from '@app/features/referral/components/ReferralSettingsTab.module.css';
import * as TextCopyCommands from '@app/features/ui/commands/TextCopyCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {getFormattedShortDate} from '@app/features/user/utils/DateFormatting';
import type {ReferralTierReward} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import type {
	ReferralMeResponse,
	ReferralRewardStatus,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ProhibitIcon, WarningIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useState} from 'react';

const logger = new Logger('ReferralSettingsTab');

const LINK_SECTION_TITLE_DESCRIPTOR = msg({
	message: 'Your referral link',
	comment: 'Referrals settings: title of the section that shows the personal invite link.',
});
const LINK_SECTION_DESCRIPTION_DESCRIPTOR = msg({
	message:
		'A friend counts once they verify their email and stay active for {days, plural, one {# day} other {# days}}.',
	comment: 'Referrals settings: explains when a person who signed up with the link counts. # is a number of days.',
});
const LINK_LABEL_DESCRIPTOR = msg({
	message: 'Share this link',
	comment: 'Referrals settings: label above the referral link field.',
});
const PENDING_DESCRIPTOR = msg({
	message: 'Pending',
	comment: 'Referrals settings: count of signed-up friends who do not count yet. Keep it short.',
});
const VALID_DESCRIPTOR = msg({
	message: 'Valid',
	comment: 'Referrals settings: count of signed-up friends who count toward rewards. Keep it short.',
});
const REJECTED_DESCRIPTOR = msg({
	message: 'Rejected',
	comment: 'Referrals settings: count of signed-up friends who did not count. Keep it short.',
});
const TIERS_TITLE_DESCRIPTOR = msg({
	message: 'Rewards',
	comment: 'Referrals settings: title of the section that lists reward tiers.',
});
const TIERS_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Reach a tier to earn its reward.',
	comment: 'Referrals settings: description of the reward tiers section.',
});
const NO_TIERS_DESCRIPTOR = msg({
	message: 'There are no reward tiers yet.',
	comment: 'Referrals settings: empty state when no reward tier is open.',
});
const TIER_PROGRESS_DESCRIPTOR = msg({
	message: '{valid} / {threshold}',
	comment: 'Referrals settings: progress toward a tier. First number is valid friends, second is the tier threshold.',
});
const TIER_REACHED_DESCRIPTOR = msg({
	message: 'Reached',
	comment: 'Referrals settings: shown on a reward tier the user has reached.',
});
const EARNED_TITLE_DESCRIPTOR = msg({
	message: 'Your rewards',
	comment: 'Referrals settings: title of the section that lists the rewards the user earned.',
});
const OFFSITE_CODE_DESCRIPTOR = msg({
	message: 'Your code',
	comment: 'Referrals settings: label above a code staff handed over for an off-site reward.',
});
const CLOSED_TITLE_DESCRIPTOR = msg({
	message: 'Referrals are closed right now',
	comment: 'Referrals settings: title shown while the referral programme is switched off.',
});
const CLOSED_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Check back later.',
	comment: 'Referrals settings: description shown while the referral programme is switched off.',
});
const COSMETIC_FALLBACK_DESCRIPTOR = msg({
	message: 'Cosmetic item',
	comment: 'Referrals settings: name of a cosmetic reward whose name could not be loaded.',
});
const PREMIUM_DAYS_DESCRIPTOR = msg({
	message: '{days, plural, one {# day of {premiumProductName}} other {# days of {premiumProductName}}}',
	comment: 'Referrals settings: a reward of free Plus time. # is a number of days.',
});
const REWARD_STATUS_DESCRIPTORS: Record<ReferralRewardStatus, MessageDescriptor> = {
	granting: msg({
		message: 'On its way',
		comment: 'Referrals settings: a reward that is being added to the account.',
	}),
	auto_delivered: msg({
		message: 'Added to your account',
		comment: 'Referrals settings: a reward that was added to the account automatically.',
	}),
	pending_admin: msg({
		message: 'Staff will hand it over',
		comment: 'Referrals settings: a reward that staff deliver by hand and have not delivered yet.',
	}),
	delivered: msg({
		message: 'Delivered {date}',
		comment: 'Referrals settings: a reward staff delivered by hand. {date} is a short date.',
	}),
};

const MAX_ITEM_IDS = 50;

function cosmeticItemIds(me: ReferralMeResponse): Array<string> {
	const rewards = [...me.tiers.map((tier) => tier.reward), ...me.rewards.map((reward) => reward.reward)];
	const ids = rewards.flatMap((reward) => (reward.type === 'cosmetic' ? [reward.item_id] : []));
	// The items endpoint takes at most 50 IDs.
	return [...new Set(ids)].slice(0, MAX_ITEM_IDS);
}

const ReferralSettingsTab = observer(function ReferralSettingsTab() {
	const {i18n} = useLingui();
	const [me, setMe] = useState<ReferralMeResponse | null>(null);
	const [failed, setFailed] = useState(false);
	const [itemNames, setItemNames] = useState<ReadonlyMap<string, string>>(new Map());
	const load = useCallback(async () => {
		setFailed(false);
		try {
			const next = await ReferralCommands.fetchReferral();
			setMe(next);
			const ids = cosmeticItemIds(next);
			if (ids.length > 0) {
				// A missing name only costs a generic label, so a failed lookup does not fail the tab.
				CosmeticCommands.fetchItems(ids)
					.then((items) => setItemNames(new Map(items.map((item) => [item.id, item.name]))))
					.catch((error) => logger.warn('Failed to load reward item names', error));
			}
		} catch (error) {
			logger.error('Failed to load referral state', error);
			setFailed(true);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	if (failed) {
		return (
			<StatusSlate
				Icon={WarningIcon}
				title={i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)}
				description={i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR)}
				actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: () => void load()}]}
				data-flx="referral.referral-settings-tab.status-slate.failed"
			/>
		);
	}
	if (!me) {
		return (
			<div className={styles.spinnerContainer} data-flx="referral.referral-settings-tab.spinner-container">
				<Spinner data-flx="referral.referral-settings-tab.spinner" />
			</div>
		);
	}
	const rewardLabel = (reward: ReferralTierReward): string => {
		switch (reward.type) {
			case 'cosmetic':
				return itemNames.get(reward.item_id) ?? i18n._(COSMETIC_FALLBACK_DESCRIPTOR);
			case 'premium_days':
				return i18n._(PREMIUM_DAYS_DESCRIPTOR, {days: reward.days, premiumProductName: PREMIUM_PRODUCT_NAME});
			case 'offsite':
				return reward.description;
		}
	};
	const copy = (text: string) => TextCopyCommands.copy(i18n, text, true);
	// Shown while the programme is closed too: earned rewards and off-site codes were already handed out.
	const earned = me.rewards.length > 0 && (
		<SettingsSection
			id="referral-earned"
			linkable={false}
			title={i18n._(EARNED_TITLE_DESCRIPTOR)}
			data-flx="referral.referral-settings-tab.settings-section.earned"
		>
			<ul className={styles.list} data-flx="referral.referral-settings-tab.reward-list">
				{me.rewards.map((reward) => (
					<li key={reward.tier_id} className={styles.row} data-flx="referral.referral-settings-tab.reward">
						<div className={styles.rowHeader} data-flx="referral.referral-settings-tab.reward-header">
							<span className={styles.rowTitle} data-flx="referral.referral-settings-tab.reward-title">
								{rewardLabel(reward.reward)}
							</span>
							<span className={styles.rowMeta} data-flx="referral.referral-settings-tab.reward-status">
								{i18n._(REWARD_STATUS_DESCRIPTORS[reward.status], {
									date: reward.delivered_at ? getFormattedShortDate(reward.delivered_at) : '',
								})}
							</span>
						</div>
						{reward.code !== null && (
							<CopyLinkSection
								label={i18n._(OFFSITE_CODE_DESCRIPTOR)}
								value={reward.code}
								onCopy={() => copy(reward.code ?? '')}
								onInputClick={(event) => event.currentTarget.select()}
								data-flx="referral.referral-settings-tab.reward-code"
							/>
						)}
					</li>
				))}
			</ul>
		</SettingsSection>
	);
	if (!me.enabled || me.code === null) {
		const closed = (
			<StatusSlate
				Icon={ProhibitIcon}
				title={i18n._(CLOSED_TITLE_DESCRIPTOR)}
				description={i18n._(CLOSED_DESCRIPTION_DESCRIPTOR)}
				data-flx="referral.referral-settings-tab.status-slate.closed"
			/>
		);
		if (!earned) return closed;
		return (
			<SettingsTabContainer data-flx="referral.referral-settings-tab.settings-tab-container.closed">
				<SettingsTabContent data-flx="referral.referral-settings-tab.settings-tab-content.closed">
					<div className={styles.layout} data-flx="referral.referral-settings-tab.layout.closed">
						{closed}
						{earned}
					</div>
				</SettingsTabContent>
			</SettingsTabContainer>
		);
	}
	const link = `${RuntimeConfig.webAppEndpoint}/r/${me.code}`;
	const stats: Array<[string, MessageDescriptor, number]> = [
		['pending', PENDING_DESCRIPTOR, me.counts.pending],
		['valid', VALID_DESCRIPTOR, me.counts.valid],
		['rejected', REJECTED_DESCRIPTOR, me.counts.rejected],
	];
	return (
		<SettingsTabContainer data-flx="referral.referral-settings-tab.settings-tab-container">
			<SettingsTabContent data-flx="referral.referral-settings-tab.settings-tab-content">
				<div className={styles.layout} data-flx="referral.referral-settings-tab.layout">
					<SettingsSection
						id="referral-link"
						linkable={false}
						title={i18n._(LINK_SECTION_TITLE_DESCRIPTOR)}
						description={i18n._(LINK_SECTION_DESCRIPTION_DESCRIPTOR, {days: me.min_active_days})}
						data-flx="referral.referral-settings-tab.settings-section.link"
					>
						<CopyLinkSection
							label={i18n._(LINK_LABEL_DESCRIPTOR)}
							value={link}
							onCopy={() => copy(link)}
							onInputClick={(event) => event.currentTarget.select()}
							data-flx="referral.referral-settings-tab.copy-link-section"
						/>
						<div className={styles.stats} data-flx="referral.referral-settings-tab.stats">
							{stats.map(([key, label, count]) => (
								<div key={key} className={styles.stat} data-flx="referral.referral-settings-tab.stat">
									<span className={styles.statValue} data-flx="referral.referral-settings-tab.stat-value">
										{count}
									</span>
									<span className={styles.statLabel} data-flx="referral.referral-settings-tab.stat-label">
										{i18n._(label)}
									</span>
								</div>
							))}
						</div>
					</SettingsSection>
					<SettingsSection
						id="referral-tiers"
						linkable={false}
						title={i18n._(TIERS_TITLE_DESCRIPTOR)}
						description={i18n._(TIERS_DESCRIPTION_DESCRIPTOR)}
						data-flx="referral.referral-settings-tab.settings-section.tiers"
					>
						{me.tiers.length === 0 ? (
							<p className={styles.empty} data-flx="referral.referral-settings-tab.no-tiers">
								{i18n._(NO_TIERS_DESCRIPTOR)}
							</p>
						) : (
							<ul className={styles.list} data-flx="referral.referral-settings-tab.tier-list">
								{me.tiers.map((tier) => {
									const reached = me.counts.valid >= tier.threshold;
									return (
										<li
											key={tier.id}
											className={clsx(styles.row, reached && styles.rowReached)}
											data-flx="referral.referral-settings-tab.tier"
										>
											<div className={styles.rowHeader} data-flx="referral.referral-settings-tab.tier-header">
												<span className={styles.rowTitle} data-flx="referral.referral-settings-tab.tier-title">
													{rewardLabel(tier.reward)}
												</span>
												<span className={styles.rowMeta} data-flx="referral.referral-settings-tab.tier-meta">
													{reached
														? i18n._(TIER_REACHED_DESCRIPTOR)
														: i18n._(TIER_PROGRESS_DESCRIPTOR, {valid: me.counts.valid, threshold: tier.threshold})}
												</span>
											</div>
											<div
												className={styles.bar}
												role="progressbar"
												aria-label={rewardLabel(tier.reward)}
												aria-valuemin={0}
												aria-valuemax={tier.threshold}
												aria-valuenow={Math.min(me.counts.valid, tier.threshold)}
												data-flx="referral.referral-settings-tab.tier-bar"
											>
												<div
													className={styles.barFill}
													style={{width: `${Math.min(100, (me.counts.valid / tier.threshold) * 100)}%`}}
													data-flx="referral.referral-settings-tab.tier-bar-fill"
												/>
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</SettingsSection>
					{earned}
				</div>
			</SettingsTabContent>
		</SettingsTabContainer>
	);
});

export default ReferralSettingsTab;
