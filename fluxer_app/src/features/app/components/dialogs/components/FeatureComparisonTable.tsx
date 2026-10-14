// SPDX-License-Identifier: AGPL-3.0-or-later

import {ComparisonCheckRow} from '@app/features/app/components/dialogs/components/ComparisonCheckRow';
import {ComparisonRow} from '@app/features/app/components/dialogs/components/ComparisonRow';
import styles from '@app/features/app/components/dialogs/components/FeatureComparisonTable.module.css';
import {Limits} from '@app/features/app/utils/UserLimits';
import {COMMUNITIES_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {formatFileSize} from '@app/features/messaging/utils/FileUtils';
import {getPremiumProductName} from '@app/features/premium/utils/PremiumUtils';
import {
	isBooleanTierPerk,
	isNumericTierPerk,
	isTextTierPerk,
	LIMIT_TIER_PERKS,
	type LimitTierPerk,
} from '@fluxer/constants/src/LimitTierPerks';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {formatNumber} from '@pkgs/number_utils/src/NumberFormatting';
import {observer} from 'mobx-react-lite';
import {useMemo} from 'react';

const PER_COMMUNITY_PROFILES_DESCRIPTOR = msg({
	message: 'Per-community profiles',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const PROFILE_BADGE_DESCRIPTOR = msg({
	message: 'Profile badge',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const CUSTOM_VIDEO_BACKGROUNDS_DESCRIPTOR = msg({
	message: 'Custom video backgrounds',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const ENTRANCE_SOUNDS_DESCRIPTOR = msg({
	message: 'Entrance sounds',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const MESSAGE_CHARACTER_LIMIT_DESCRIPTOR = msg({
	message: 'Message character limit',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const BOOKMARKED_MESSAGES_DESCRIPTOR = msg({
	message: 'Bookmarked messages',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const FILE_UPLOAD_SIZE_DESCRIPTOR = msg({
	message: 'File upload size',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const SAVED_MEDIA_DESCRIPTOR = msg({
	message: 'Saved media',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const USE_ANIMATED_EMOJIS_DESCRIPTOR = msg({
	message: 'Use animated emojis',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const GLOBAL_EMOJI_STICKER_ACCESS_DESCRIPTOR = msg({
	message: 'Global emoji & sticker access',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const VIDEO_QUALITY_DESCRIPTOR = msg({
	message: 'Video quality',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const ANIMATED_AVATARS_PROFILE_BANNERS_DESCRIPTOR = msg({
	message: 'Animated avatars & profile banners',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const EARLY_ACCESS_TO_NEW_FEATURES_DESCRIPTOR = msg({
	message: 'Early access to new features',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const CUSTOM_THEMES_DESCRIPTOR = msg({
	message: 'Custom themes',
	comment: 'Feature comparison table perk label. Shown as the row name comparing restricted vs stock limits.',
});
const VIDEO_QUALITY_4K_60FPS_DESCRIPTOR = msg({
	message: 'Up to 4K/60fps',
	comment:
		'Feature comparison table value label. Shown in the restricted or stock column for a text-valued perk. Format includes a resolution token (4K) and a framerate token that should not be translated.',
});
// Micup: the premium sales page's perk tiles read the same labels and values; there is no second copy.
const PERK_LABELS: Record<string, MessageDescriptor | string> = {
	per_community_profiles: PER_COMMUNITY_PROFILES_DESCRIPTOR,
	profile_badge: PROFILE_BADGE_DESCRIPTOR,
	custom_video_backgrounds: CUSTOM_VIDEO_BACKGROUNDS_DESCRIPTOR,
	entrance_sounds: ENTRANCE_SOUNDS_DESCRIPTOR,
	communities: COMMUNITIES_DESCRIPTOR,
	message_character_limit: MESSAGE_CHARACTER_LIMIT_DESCRIPTOR,
	bookmarked_messages: BOOKMARKED_MESSAGES_DESCRIPTOR,
	file_upload_size: FILE_UPLOAD_SIZE_DESCRIPTOR,
	saved_media: SAVED_MEDIA_DESCRIPTOR,
	use_animated_emojis: USE_ANIMATED_EMOJIS_DESCRIPTOR,
	global_emoji_sticker_access: GLOBAL_EMOJI_STICKER_ACCESS_DESCRIPTOR,
	video_quality: VIDEO_QUALITY_DESCRIPTOR,
	animated_avatars_and_banners: ANIMATED_AVATARS_PROFILE_BANNERS_DESCRIPTOR,
	early_access: EARLY_ACCESS_TO_NEW_FEATURES_DESCRIPTOR,
	custom_themes: CUSTOM_THEMES_DESCRIPTOR,
	video_quality_restricted: '720p/30fps',
	video_quality_stock: VIDEO_QUALITY_4K_60FPS_DESCRIPTOR,
};

export function getPerkLabel(i18n: I18n, key: string): string {
	const label = PERK_LABELS[key];
	if (label === undefined) return key;
	return typeof label === 'string' ? label : i18n._(label);
}

export function formatPerkValue(i18n: I18n, perk: LimitTierPerk, value: number, isStock: boolean): string {
	if (!isNumericTierPerk(perk)) return String(value);
	const resolvedValue = perk.limitKey
		? isStock
			? Limits.getStockValue(perk.limitKey, value)
			: Limits.getRestrictedValue(perk.limitKey, value)
		: value;
	if (perk.unit === 'bytes') {
		return formatFileSize(i18n.locale, resolvedValue);
	}
	return formatNumber(resolvedValue, i18n.locale);
}

export const FeatureComparisonTable = observer(() => {
	const {i18n} = useLingui();
	const availablePerks = useMemo(
		() => LIMIT_TIER_PERKS.filter((perk) => perk.status === 'available' && perk.id !== 'custom_discriminator'),
		[],
	);
	const renderPerkRow = (perk: LimitTierPerk) => {
		const label = getPerkLabel(i18n, perk.i18nKey);
		if (isBooleanTierPerk(perk)) {
			return (
				<ComparisonCheckRow
					key={perk.id}
					feature={label}
					restrictedHas={perk.restrictedValue}
					stockHas={perk.stockValue}
					data-flx="app.feature-comparison-table.render-perk-row.comparison-check-row"
				/>
			);
		}
		if (isNumericTierPerk(perk)) {
			return (
				<ComparisonRow
					key={perk.id}
					feature={label}
					restrictedValue={formatPerkValue(i18n, perk, perk.restrictedValue, false)}
					stockValue={formatPerkValue(i18n, perk, perk.stockValue, true)}
					data-flx="app.feature-comparison-table.render-perk-row.comparison-row"
				/>
			);
		}
		if (isTextTierPerk(perk)) {
			const restrictedLabel = getPerkLabel(i18n, perk.restrictedValueI18nKey);
			const stockLabel = getPerkLabel(i18n, perk.stockValueI18nKey);
			return (
				<ComparisonRow
					key={perk.id}
					feature={label}
					restrictedValue={restrictedLabel}
					stockValue={stockLabel}
					data-flx="app.feature-comparison-table.render-perk-row.comparison-row--2"
				/>
			);
		}
		return null;
	};
	return (
		<div className={styles.table} data-flx="app.feature-comparison-table.table">
			<div className={styles.header} data-flx="app.feature-comparison-table.header">
				<div className={styles.headerFeature} data-flx="app.feature-comparison-table.header-feature">
					<p className={styles.headerFeatureText} data-flx="app.feature-comparison-table.header-feature-text">
						<Trans>Feature</Trans>
					</p>
				</div>
				<div className={styles.headerValues} data-flx="app.feature-comparison-table.header-values">
					<div className={styles.headerRestricted} data-flx="app.feature-comparison-table.header-restricted">
						<Trans>Free</Trans>
					</div>
					<div className={styles.headerStock} data-flx="app.feature-comparison-table.header-stock">
						{getPremiumProductName()}
					</div>
				</div>
			</div>
			<div className={styles.rows} data-flx="app.feature-comparison-table.rows">
				{availablePerks.map(renderPerkRow)}
			</div>
		</div>
	);
});
