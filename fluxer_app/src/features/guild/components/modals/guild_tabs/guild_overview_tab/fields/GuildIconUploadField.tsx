// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ANIMATED_IMAGE_FORMATS,
	AVATAR_RECOMMENDED_SIZE_LABEL,
	STATIC_IMAGE_FORMATS,
} from '@app/features/app/config/I18nDisplayConstants';
import {useAnimatedMediaPlaybackAllowed} from '@app/features/app/hooks/useAnimatedMediaPlayback';
import {useViewportPlayback} from '@app/features/app/hooks/useViewportPlayback';
import {GlobalLimits} from '@app/features/app/utils/GlobalLimits';
import {AssetType} from '@app/features/expressions/components/modals/AssetCropModal';
import {formatImageUploadRecommendedHint} from '@app/features/expressions/utils/AssetUploadHintCopy';
import styles from '@app/features/guild/components/modals/guild_tabs/guild_overview_tab/GuildOverviewTab.module.css';
import type {GuildLike} from '@app/features/guild/components/modals/guild_tabs/guild_overview_tab/GuildOverviewTypes';
import {useGuildImageAssetField} from '@app/features/guild/components/modals/guild_tabs/guild_overview_tab/hooks/useGuildImageAssetField';
import {GuildIcon} from '@app/features/guild/components/popouts/GuildIcon';
import type {FormInputs} from '@app/features/guild/utils/guild_tabs/GuildOverviewTabUtils';
import {formatFileSize} from '@app/features/messaging/utils/FileUtils';
import {Button} from '@app/features/ui/button/Button';
import {parseAvatarHash} from '@app/features/user/utils/AvatarUtils';
import {getAcceptString} from '@fluxer/constants/src/AssetFormatPolicy';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import type React from 'react';
import {useState} from 'react';
import type {UseFormReturn} from 'react-hook-form';
import {useWatch} from 'react-hook-form';

const ICON_DESCRIPTOR = msg({
	message: 'Icon',
	comment: 'Short label in the guild icon upload field. Keep it concise.',
});
const ANIMATED_ICON_BOOST_HINT_DESCRIPTOR = msg({
	message: 'Boost to Level 1 to upload animated icons.',
	comment:
		'Upgrade hint and upload error for a community without the animated icon feature. Static uploads remain available.',
});
const CHANGE_ICON_DESCRIPTOR = msg({
	message: 'Change icon',
	comment:
		'Title of the modal where the user picks a community icon source (file upload or GIF provider). Keep it concise.',
});
export const GuildIconUploadField: React.FC<{
	guild: GuildLike;
	form: UseFormReturn<FormInputs>;
	canManageGuild: boolean;
	previewIconUrl: string | null;
	setPreviewIconUrl: React.Dispatch<React.SetStateAction<string | null>>;
	hasClearedIcon: boolean;
	setHasClearedIcon: React.Dispatch<React.SetStateAction<boolean>>;
}> = ({guild, form, canManageGuild, previewIconUrl, setPreviewIconUrl, hasClearedIcon, setHasClearedIcon}) => {
	const {i18n} = useLingui();
	const canUseAnimatedIcon = guild.features.has(GuildFeatures.ANIMATED_ICON);
	const [previewNode, setPreviewNode] = useState<HTMLElement | null>(null);
	const viewportVisible = useViewportPlayback(previewNode);
	const playbackAllowed =
		useAnimatedMediaPlaybackAllowed({
			isAnimated: Boolean(previewIconUrl || guild.icon?.startsWith('a_')),
		}) && viewportVisible;
	const watchedName = useWatch({
		control: form.control,
		name: 'name',
		defaultValue: guild.name,
	});
	const iconName = watchedName ?? guild.name;
	const iconFormats = canUseAnimatedIcon ? ANIMATED_IMAGE_FORMATS : STATIC_IMAGE_FORMATS;
	const controller = useGuildImageAssetField({
		form,
		fieldName: 'icon',
		assetType: AssetType.GUILD_ICON,
		canManage: canManageGuild,
		filePickerAccept: getAcceptString('guild_icon', {animatedAllowed: canUseAnimatedIcon}),
		previewUrl: previewIconUrl,
		setPreviewUrl: setPreviewIconUrl,
		setHasCleared: setHasClearedIcon,
		labelForMessages: i18n._(ICON_DESCRIPTOR),
		gif: {
			mode: 'require-feature',
			isAllowed: () => canUseAnimatedIcon,
			featureMissingMessage: i18n._(ANIMATED_ICON_BOOST_HINT_DESCRIPTOR),
		},
		sourceModalTitle: i18n._(CHANGE_ICON_DESCRIPTOR),
		uploadHint: formatImageUploadRecommendedHint(i18n, {
			formats: iconFormats,
			maxSize: formatFileSize(i18n.locale, GlobalLimits.getAvatarMaxSize()),
			recommendedSize: AVATAR_RECOMMENDED_SIZE_LABEL,
		}),
	});
	const showRemove = (guild.icon || previewIconUrl) && !hasClearedIcon;
	return (
		<div data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.div">
			<div
				className={styles.iconField}
				data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-field"
			>
				<Trans>Icon</Trans>
			</div>
			<div
				ref={setPreviewNode}
				className={styles.iconUploadContainer}
				data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-upload-container"
			>
				{previewIconUrl && (!controller.isPreviewAnimated || (canUseAnimatedIcon && playbackAllowed)) ? (
					<div
						className={styles.iconPreview}
						style={{backgroundImage: `url(${previewIconUrl})`}}
						data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-preview"
					/>
				) : (
					<div
						className={styles.iconPreview}
						data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-preview--2"
					>
						<GuildIcon
							id={guild.id}
							name={iconName}
							icon={
								hasClearedIcon
									? null
									: guild.icon && (!canUseAnimatedIcon || !playbackAllowed)
										? parseAvatarHash(guild.icon).hash
										: guild.icon
							}
							sizePx={80}
							data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.guild-icon"
						/>
					</div>
				)}
				<div
					className={styles.iconUploadActions}
					data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-upload-actions"
				>
					<div
						className={styles.iconUploadButtons}
						data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.icon-upload-buttons"
					>
						<Button
							variant="primary"
							small={true}
							onClick={controller.openSourcePicker}
							disabled={!canManageGuild || controller.isProcessing}
							data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.button.pick-file"
						>
							<Trans>Upload icon</Trans>
						</Button>
						{showRemove && (
							<Button
								variant="secondary"
								small={true}
								onClick={controller.clear}
								disabled={!canManageGuild || controller.isProcessing}
								data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.button.clear"
							>
								<Trans>Remove</Trans>
							</Button>
						)}
					</div>
					{!canUseAnimatedIcon && (
						<p className={styles.iconUploadDescription}>{i18n._(ANIMATED_ICON_BOOST_HINT_DESCRIPTOR)}</p>
					)}
				</div>
			</div>
			{form.formState.errors.icon?.message ? (
				<p
					className={styles.errorMessage}
					data-flx="guild.guild-tabs.guild-overview-tab.fields.guild-icon-upload-field.error-message"
				>
					{form.formState.errors.icon.message}
				</p>
			) : null}
		</div>
	);
};
