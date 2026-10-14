// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import {isLimitToggleEnabled} from '@app/features/app/utils/LimitUtils';
import * as PremiumModalCommands from '@app/features/premium/commands/PremiumModalCommands';
import {getPremiumProductName, shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {getUsernameStatus, type UsernamePrivateStatus} from '@app/features/user/commands/UsernameCommands';
import {FluxerTagChangeModal} from '@app/features/user/components/modals/FluxerTagChangeModal';
import styles from '@app/features/user/components/modals/tabs/my_profile_tab/MyProfileTabUsernameSection.module.css';
import type {User} from '@app/features/user/models/User';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {CrownIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const CLAIM_YOUR_ACCOUNT_TO_CHANGE_YOUR_USERNAME_DESCRIPTOR = msg({
	message: 'Claim your account to change your username',
	comment: 'Label in the username section.',
});
const VERIFY_YOUR_EMAIL_TO_CHANGE_YOUR_USERNAME_DESCRIPTOR = msg({
	message: 'Verify your email to change your username',
	comment: 'Label in the username section.',
});
const CUSTOMIZE_YOUR_TAG_TO_YOUR_LIKING_WITH_DESCRIPTOR = msg({
	message: 'Customize your tag ({discriminatorLabel}) to your liking with {premiumProductName}',
	comment:
		'Description text in the username section. Preserve {discriminatorLabel}, {premiumProductName}; they are inserted by code. Keep the tone plain and specific.',
});
const GET_TO_CUSTOMIZE_YOUR_TAG_DESCRIPTOR = msg({
	message: 'Get {premiumProductName} to customize your tag',
	comment:
		'Label in the username section. Preserve {premiumProductName}; it is inserted by code. Keep the tone plain and specific.',
});

interface UsernameSectionProps {
	isClaimed: boolean;
	isEmailVerified: boolean;
	user: User;
}

export const UsernameSection = observer(({isClaimed, isEmailVerified, user}: UsernameSectionProps) => {
	const {i18n} = useLingui();
	const selectingUsername =
		!user.bot &&
		(RuntimeConfig.usernameMigration.state === 'selecting' ||
			user.usernameState === 'selected' ||
			user.usernameState === 'reselect_required');
	const [usernameStatus, setUsernameStatus] = useState<UsernamePrivateStatus | null>(null);
	const [statusFailed, setStatusFailed] = useState(false);
	useEffect(() => {
		if (!selectingUsername) return;
		const controller = new AbortController();
		getUsernameStatus(controller.signal)
			.then((status) => {
				if (!controller.signal.aborted) {
					setUsernameStatus(status);
					setStatusFailed(false);
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) setStatusFailed(true);
			});
		return () => controller.abort();
	}, [selectingUsername, user.id, user.identityVersion]);
	const hasCustomDiscriminator = isLimitToggleEnabled(
		{feature_custom_discriminator: LimitResolver.resolve({key: 'feature_custom_discriminator', fallback: 0})},
		'feature_custom_discriminator',
	);
	const discriminatorLabel = `#${user.discriminator}`;
	return (
		<div data-flx="user.my-profile-tab.username-section.div">
			<div className={styles.label} data-flx="user.my-profile-tab.username-section.label">
				<Trans>Username</Trans>
			</div>
			<div className={styles.actions} data-flx="user.my-profile-tab.username-section.actions">
				{!isClaimed ? (
					<Tooltip
						text={i18n._(CLAIM_YOUR_ACCOUNT_TO_CHANGE_YOUR_USERNAME_DESCRIPTOR)}
						data-flx="user.my-profile-tab.username-section.tooltip"
					>
						<div data-flx="user.my-profile-tab.username-section.div--2">
							<Button variant="primary" small disabled data-flx="user.my-profile-tab.username-section.button">
								<Trans>Change username</Trans>
							</Button>
						</div>
					</Tooltip>
				) : !isEmailVerified ? (
					<Tooltip
						text={i18n._(VERIFY_YOUR_EMAIL_TO_CHANGE_YOUR_USERNAME_DESCRIPTOR)}
						data-flx="user.my-profile-tab.username-section.tooltip--2"
					>
						<div data-flx="user.my-profile-tab.username-section.div--3">
							<Button variant="primary" small disabled data-flx="user.my-profile-tab.username-section.button--2">
								<Trans>Change username</Trans>
							</Button>
						</div>
					</Tooltip>
				) : (
					<Button
						variant="primary"
						small
						onClick={() =>
							ModalCommands.push(
								modal(() => (
									<FluxerTagChangeModal
										user={user}
										data-flx="user.my-profile-tab.username-section.fluxer-tag-change-modal"
									/>
								)),
							)
						}
						data-flx="user.my-profile-tab.username-section.button.push"
					>
						<Trans>Change username</Trans>
					</Button>
				)}
				{!selectingUsername &&
					!RuntimeConfig.usesUniqueUsernames &&
					!hasCustomDiscriminator &&
					shouldShowPremiumFeatures() && (
						<Tooltip
							text={i18n._(CUSTOMIZE_YOUR_TAG_TO_YOUR_LIKING_WITH_DESCRIPTOR, {
								discriminatorLabel,
								premiumProductName: getPremiumProductName(),
							})}
							data-flx="user.my-profile-tab.username-section.tooltip--3"
						>
							<button
								type="button"
								onClick={() => {
									PremiumModalCommands.open();
								}}
								className={styles.premiumButton}
								aria-label={i18n._(GET_TO_CUSTOMIZE_YOUR_TAG_DESCRIPTOR, {premiumProductName: getPremiumProductName()})}
								data-flx="user.my-profile-tab.username-section.premium-button.open"
							>
								<CrownIcon
									weight="fill"
									size={remFromPx(18)}
									data-flx="user.my-profile-tab.username-section.crown-icon"
								/>
							</button>
						</Tooltip>
					)}
			</div>
			{selectingUsername && usernameStatus?.freeChangeAvailable && (
				<p>
					<Trans>Your first change is immediate; then once every 14 days</Trans>
				</p>
			)}
			{selectingUsername &&
				usernameStatus &&
				!usernameStatus.freeChangeAvailable &&
				usernameStatus.changeAvailableAt &&
				new Date(usernameStatus.changeAvailableAt).getTime() > Date.now() && (
					<p>
						<Trans>You can change your username after:</Trans>{' '}
						<time dateTime={usernameStatus.changeAvailableAt}>
							{new Date(usernameStatus.changeAvailableAt).toLocaleString(i18n.locale)}
						</time>
					</p>
				)}
			{statusFailed && (
				<p role="status">
					<Trans>Username status could not be loaded. Please reopen this screen.</Trans>
				</p>
			)}
		</div>
	);
});
