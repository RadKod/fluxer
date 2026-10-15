// SPDX-License-Identifier: AGPL-3.0-or-later

import {NameStyleText} from '@app/features/name_style/components/NameStyleText';
import {colorToHex} from '@app/features/name_style/NameStyle';
import {requestNameStyleFont} from '@app/features/name_style/NameStyleFontLoader';
import {nameStyleFontFamily} from '@app/features/name_style/NameStyleFonts';
import {getPremiumProductName} from '@app/features/premium/utils/PremiumUtils';
import {Button} from '@app/features/ui/button/Button';
import {ColorPickerField} from '@app/features/ui/components/form/ColorPickerField';
import {PlutoniumUpsell} from '@app/features/ui/plutonium_upsell/PlutoniumUpsell';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import myProfileTabStyles from '@app/features/user/components/modals/tabs/MyProfileTab.module.css';
import {
	DEFAULT_NAME_COLOR,
	DEFAULT_SECOND_NAME_COLOR,
	isNameStyleReadable,
	type NameColorMode,
	type PlusAppearanceAccess,
	type PlusAppearanceValues,
	PROFILE_THEME_PRESETS,
	withNameColor,
	withNameColorMode,
	withNameFont,
	withThemeColor,
} from '@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceForm';
import styles from '@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceSettings.module.css';
import {profileGradientSurface} from '@app/features/user/components/profile/ProfileGradientSurface';
import {nameReadsOnProfileTheme} from '@app/features/user/utils/ProfileGradient';
import {isNameColorsReadableOnLight} from '@fluxer/constants/src/ColorContrast';
import {NAME_STYLE_FONTS, type NameStyleFont, type NameStyleFontId} from '@fluxer/constants/src/NameStyleConstants';
import type {NameStyle, ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useRef} from 'react';

const PLUS_APPEARANCE_DESCRIPTOR = msg({
	message: '{premiumProductName} appearance',
	comment: 'Profile settings section title for the name style and profile theme. Preserve {premiumProductName}.',
});
const PLUS_APPEARANCE_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Give your name a font and color, and your profile card a two-color theme.',
	comment: 'Profile settings section description for the name style and profile theme. Keep the tone plain.',
});
const PLUS_APPEARANCE_UPSELL_DESCRIPTOR = msg({
	message: 'Name styles and profile themes are part of {premiumProductName}.',
	comment: 'Upsell shown in the profile settings to accounts without Plus. Preserve {premiumProductName}.',
});
const PROFILE_PREVIEW_DESCRIPTOR = msg({
	message: 'Profile preview',
	comment: 'Label above the small live preview of the name style on the profile theme in the profile settings.',
});
const NAME_FONT_DESCRIPTOR = msg({
	message: 'Name font',
	comment: 'Label above the list of fonts for the display name. Keep it concise.',
});
const FONT_ROUNDED_DESCRIPTOR = msg({
	message: 'Rounded',
	comment:
		'Accessible name of a name font option: a soft, rounded typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_PLAYFUL_HANDWRITING_DESCRIPTOR = msg({
	message: 'Playful handwriting',
	comment:
		'Accessible name of a name font option: a casual, playful handwritten typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_RETRO_SCRIPT_DESCRIPTOR = msg({
	message: 'Retro script',
	comment:
		'Accessible name of a name font option: a retro, flowing script typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_HANDWRITING_DESCRIPTOR = msg({
	message: 'Handwriting',
	comment:
		'Accessible name of a name font option: a natural handwritten typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_PIXEL_DESCRIPTOR = msg({
	message: 'Pixel',
	comment:
		'Accessible name of a name font option: a pixel-art typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_ARCADE_PIXEL_DESCRIPTOR = msg({
	message: 'Arcade pixel',
	comment:
		'Accessible name of a name font option: a wide pixel typeface from arcade games. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_TERMINAL_DESCRIPTOR = msg({
	message: 'Terminal',
	comment:
		'Accessible name of a name font option: a typeface from old computer terminals. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_TECHNO_DESCRIPTOR = msg({
	message: 'Techno',
	comment:
		'Accessible name of a name font option: a wide, futuristic techno typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_GOTHIC_DESCRIPTOR = msg({
	message: 'Gothic',
	comment:
		'Accessible name of a name font option: a blackletter, gothic typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_ROCK_DESCRIPTOR = msg({
	message: 'Rock',
	comment:
		'Accessible name of a name font option: a heavy rock-poster typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_BOLD_BLOCK_DESCRIPTOR = msg({
	message: 'Bold block',
	comment:
		'Accessible name of a name font option: a heavy, blocky display typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_RETRO_MODERN_DESCRIPTOR = msg({
	message: 'Retro modern',
	comment:
		'Accessible name of a name font option: a rounded retro-modern display typeface. The option shows the user’s own name in that font. Keep it short.',
});
const FONT_STYLE_DESCRIPTORS: Record<NameStyleFont['key'], MessageDescriptor> = {
	baloo: FONT_ROUNDED_DESCRIPTOR,
	playpen: FONT_PLAYFUL_HANDWRITING_DESCRIPTOR,
	pacifico: FONT_RETRO_SCRIPT_DESCRIPTOR,
	caveat: FONT_HANDWRITING_DESCRIPTOR,
	pixelify: FONT_PIXEL_DESCRIPTOR,
	pressstart: FONT_ARCADE_PIXEL_DESCRIPTOR,
	vt323: FONT_TERMINAL_DESCRIPTOR,
	audiowide: FONT_TECHNO_DESCRIPTOR,
	grenze: FONT_GOTHIC_DESCRIPTOR,
	newrocker: FONT_ROCK_DESCRIPTOR,
	bungee: FONT_BOLD_BLOCK_DESCRIPTOR,
	righteous: FONT_RETRO_MODERN_DESCRIPTOR,
};
const NAME_COLOR_DESCRIPTOR = msg({
	message: 'Name color',
	comment: 'Label for the display name color controls. Keep it concise.',
});
const SOLID_DESCRIPTOR = msg({
	message: 'Solid',
	comment: 'Option for a single-color display name. Keep it concise.',
});
const GRADIENT_DESCRIPTOR = msg({
	message: 'Gradient',
	comment: 'Option for a two-color gradient display name. Keep it concise.',
});
const START_COLOR_DESCRIPTOR = msg({
	message: 'Start color',
	comment: 'Label for the first color of the display name. Keep it concise.',
});
const END_COLOR_DESCRIPTOR = msg({
	message: 'End color',
	comment: 'Label for the second color of a gradient display name. Keep it concise.',
});
const PICK_A_FONT_FIRST_DESCRIPTOR = msg({
	message: 'Pick a font first, then choose the colors.',
	comment: 'Hint under the name color controls before a font is chosen. Keep the tone plain.',
});
const NAME_COLORS_READABLE_DESCRIPTOR = msg({
	message: 'Easy to read on dark backgrounds.',
	comment: 'Contrast check result under the display name colors when they pass.',
});
const NAME_COLORS_UNREADABLE_DESCRIPTOR = msg({
	message: 'These colors are hard to read on dark backgrounds. Pick lighter colors to save.',
	comment: 'Contrast check result under the display name colors when they fail; saving is blocked. Keep it specific.',
});
const PROFILE_THEME_DESCRIPTOR = msg({
	message: 'Profile theme',
	comment: 'Label for the two-color profile card theme controls. Keep it concise.',
});
const PROFILE_THEME_PRESET_DESCRIPTOR = msg({
	message: 'Use {top} to {bottom}',
	comment: 'Accessible name of a preset profile theme swatch. {top} and {bottom} are hex colors inserted by code.',
});
const TOP_COLOR_DESCRIPTOR = msg({
	message: 'Top color',
	comment: 'Label for the top color of the profile card theme. Keep it concise.',
});
const BOTTOM_COLOR_DESCRIPTOR = msg({
	message: 'Bottom color',
	comment: 'Label for the bottom color of the profile card theme. Keep it concise.',
});
const RESET_PLUS_APPEARANCE_DESCRIPTOR = msg({
	message: 'Reset name style and theme',
	comment: 'Button that clears the name style and the profile theme; the change is saved with the save bar.',
});

interface PlusAppearanceSettingsProps {
	displayName: string;
	value: PlusAppearanceValues;
	access: PlusAppearanceAccess;
	disabled?: boolean;
	errorMessage?: string;
	onNameStyleChange: (nameStyle: NameStyle | null) => void;
	onThemeColorsChange: (themeColors: ThemeColors | null) => void;
}

type NamePreviewVars = React.CSSProperties & {'--plus-name-1'?: string; '--plus-name-2'?: string};

function namePreviewStyle(fontKey: string, colors: ReadonlyArray<number>): NamePreviewVars {
	return {
		fontFamily: nameStyleFontFamily(fontKey),
		'--plus-name-1': colorToHex(colors[0]),
		'--plus-name-2': colors[1] === undefined ? undefined : colorToHex(colors[1]),
	};
}

export const PlusAppearanceSettings = observer(
	({
		displayName,
		value,
		access,
		disabled = false,
		errorMessage,
		onNameStyleChange,
		onThemeColorsChange,
	}: PlusAppearanceSettingsProps) => {
		const {i18n} = useLingui();
		const premiumProductName = getPremiumProductName();
		const nameStyle = value.name_style;
		const nameColors = nameStyle?.colors ?? [DEFAULT_NAME_COLOR];
		const nameMode: NameColorMode = nameColors.length === 2 ? 'gradient' : 'solid';
		const lastSecondColor = useRef(DEFAULT_SECOND_NAME_COLOR);
		if (nameColors[1] !== undefined) lastSecondColor.current = nameColors[1];
		const themeColors = value.theme_colors ?? PROFILE_THEME_PRESETS[0];
		const nameLocked = disabled || !access.nameStyle;
		const themeLocked = disabled || !access.profileTheme;
		const readable = isNameStyleReadable(nameStyle);
		const defaultOnLight = !isNameColorsReadableOnLight(nameColors);
		const previewSurface = profileGradientSurface(value.theme_colors);
		useEffect(() => {
			for (const font of NAME_STYLE_FONTS) requestNameStyleFont(font.key);
		}, []);
		const fontOptions = NAME_STYLE_FONTS.map((font) => ({
			value: font.id as NameStyleFontId,
			name: i18n._(FONT_STYLE_DESCRIPTORS[font.key]),
		}));
		return (
			<div className={styles.section} data-flx="user.my-profile-tab.plus-appearance-settings.section">
				<div data-flx="user.my-profile-tab.plus-appearance-settings.header">
					<h2 className={styles.title} data-flx="user.my-profile-tab.plus-appearance-settings.title">
						{i18n._(PLUS_APPEARANCE_DESCRIPTOR, {premiumProductName})}
					</h2>
					<p className={styles.description} data-flx="user.my-profile-tab.plus-appearance-settings.description">
						{i18n._(PLUS_APPEARANCE_DESCRIPTION_DESCRIPTOR)}
					</p>
				</div>
				<div className={styles.preview} data-flx="user.my-profile-tab.plus-appearance-settings.preview">
					<div className={styles.label} data-flx="user.my-profile-tab.plus-appearance-settings.preview-label">
						{i18n._(PROFILE_PREVIEW_DESCRIPTOR)}
					</div>
					<div
						className={clsx(styles.previewCard, previewSurface?.className)}
						style={previewSurface?.style}
						data-flx="user.my-profile-tab.plus-appearance-settings.preview-card"
					>
						<NameStyleText
							nameStyle={nameStyle}
							fontOnly={!nameReadsOnProfileTheme(nameStyle, value.theme_colors)}
							className={styles.previewName}
							data-flx="user.my-profile-tab.plus-appearance-settings.preview-name"
						>
							{displayName}
						</NameStyleText>
					</div>
				</div>
				{(!access.nameStyle || !access.profileTheme) && (
					<PlutoniumUpsell data-flx="user.my-profile-tab.plus-appearance-settings.plutonium-upsell">
						{i18n._(PLUS_APPEARANCE_UPSELL_DESCRIPTOR, {premiumProductName})}
					</PlutoniumUpsell>
				)}
				<div data-flx="user.my-profile-tab.plus-appearance-settings.fonts">
					<div className={styles.label} data-flx="user.my-profile-tab.plus-appearance-settings.fonts-label">
						{i18n._(NAME_FONT_DESCRIPTOR)}
					</div>
					<div data-font-grid="" data-flx="user.my-profile-tab.plus-appearance-settings.font-grid">
						<RadioGroup
							className={styles.fontGrid}
							options={fontOptions}
							value={nameStyle?.font_id ?? null}
							disabled={nameLocked}
							optionAlign="center"
							onChange={(fontId) => onNameStyleChange(withNameFont(nameStyle, fontId))}
							aria-label={i18n._(NAME_FONT_DESCRIPTOR)}
							renderContent={(option) => {
								const font = NAME_STYLE_FONTS.find(({id}) => id === option.value);
								if (!font) return null;
								return (
									<>
										<span className={myProfileTabStyles.srOnly}>{option.name}</span>
										<span
											className={clsx(
												styles.fontSample,
												nameMode === 'gradient' && styles.fontSampleGradient,
												defaultOnLight && styles.fontSampleDefaultOnLight,
											)}
											style={namePreviewStyle(font.key, nameColors)}
											aria-hidden={true}
											data-flx="user.my-profile-tab.plus-appearance-settings.font-sample"
										>
											{displayName}
										</span>
									</>
								);
							}}
							data-flx="user.my-profile-tab.plus-appearance-settings.radio-group.font"
						/>
					</div>
				</div>
				<div className={styles.group} data-flx="user.my-profile-tab.plus-appearance-settings.name-color">
					<div className={styles.label} data-flx="user.my-profile-tab.plus-appearance-settings.name-color-label">
						{i18n._(NAME_COLOR_DESCRIPTOR)}
					</div>
					<RadioGroup
						className={styles.modeGroup}
						options={[
							{value: 'solid' as NameColorMode, name: i18n._(SOLID_DESCRIPTOR)},
							{value: 'gradient' as NameColorMode, name: i18n._(GRADIENT_DESCRIPTOR)},
						]}
						value={nameMode}
						disabled={nameLocked || !nameStyle}
						onChange={(mode) =>
							nameStyle && onNameStyleChange(withNameColorMode(nameStyle, mode, lastSecondColor.current))
						}
						aria-label={i18n._(NAME_COLOR_DESCRIPTOR)}
						data-flx="user.my-profile-tab.plus-appearance-settings.radio-group.mode"
					/>
					<div className={styles.colorRow} data-flx="user.my-profile-tab.plus-appearance-settings.name-colors">
						<ColorPickerField
							label={i18n._(nameMode === 'gradient' ? START_COLOR_DESCRIPTOR : NAME_COLOR_DESCRIPTOR)}
							value={nameColors[0]}
							onChange={(color) => nameStyle && onNameStyleChange(withNameColor(nameStyle, 0, color))}
							disabled={nameLocked || !nameStyle}
							hideHelperText={true}
							data-flx="user.my-profile-tab.plus-appearance-settings.color-picker-field.name-1"
						/>
						{nameMode === 'gradient' && (
							<ColorPickerField
								label={i18n._(END_COLOR_DESCRIPTOR)}
								value={nameColors[1]}
								onChange={(color) => nameStyle && onNameStyleChange(withNameColor(nameStyle, 1, color))}
								disabled={nameLocked}
								hideHelperText={true}
								data-flx="user.my-profile-tab.plus-appearance-settings.color-picker-field.name-2"
							/>
						)}
					</div>
					<p
						className={clsx(styles.contrast, !readable && styles.contrastWarning)}
						data-readable={readable}
						role={readable ? undefined : 'alert'}
						data-flx="user.my-profile-tab.plus-appearance-settings.contrast"
					>
						{nameStyle
							? i18n._(readable ? NAME_COLORS_READABLE_DESCRIPTOR : NAME_COLORS_UNREADABLE_DESCRIPTOR)
							: i18n._(PICK_A_FONT_FIRST_DESCRIPTOR)}
					</p>
				</div>
				<div className={styles.group} data-flx="user.my-profile-tab.plus-appearance-settings.theme">
					<div className={styles.label} data-flx="user.my-profile-tab.plus-appearance-settings.theme-label">
						{i18n._(PROFILE_THEME_DESCRIPTOR)}
					</div>
					<div className={styles.presets} data-flx="user.my-profile-tab.plus-appearance-settings.presets">
						{PROFILE_THEME_PRESETS.map(([top, bottom]) => {
							const selected = value.theme_colors?.[0] === top && value.theme_colors?.[1] === bottom;
							return (
								<button
									key={`${top}-${bottom}`}
									type="button"
									className={clsx(styles.preset, selected && styles.presetSelected)}
									style={{backgroundImage: `linear-gradient(180deg, ${colorToHex(top)}, ${colorToHex(bottom)})`}}
									aria-pressed={selected}
									aria-label={i18n._(PROFILE_THEME_PRESET_DESCRIPTOR, {
										top: colorToHex(top).toUpperCase(),
										bottom: colorToHex(bottom).toUpperCase(),
									})}
									disabled={themeLocked}
									onClick={() => onThemeColorsChange([top, bottom])}
									data-flx="user.my-profile-tab.plus-appearance-settings.preset.button"
								/>
							);
						})}
					</div>
					<div className={styles.colorRow} data-flx="user.my-profile-tab.plus-appearance-settings.theme-colors">
						<ColorPickerField
							label={i18n._(TOP_COLOR_DESCRIPTOR)}
							value={themeColors[0]}
							onChange={(color) => onThemeColorsChange(withThemeColor(value.theme_colors, 0, color))}
							disabled={themeLocked}
							hideHelperText={true}
							data-flx="user.my-profile-tab.plus-appearance-settings.color-picker-field.theme-1"
						/>
						<ColorPickerField
							label={i18n._(BOTTOM_COLOR_DESCRIPTOR)}
							value={themeColors[1]}
							onChange={(color) => onThemeColorsChange(withThemeColor(value.theme_colors, 1, color))}
							disabled={themeLocked}
							hideHelperText={true}
							data-flx="user.my-profile-tab.plus-appearance-settings.color-picker-field.theme-2"
						/>
					</div>
				</div>
				<div data-flx="user.my-profile-tab.plus-appearance-settings.actions">
					<Button
						variant="secondary"
						small={true}
						onClick={() => {
							onNameStyleChange(null);
							onThemeColorsChange(null);
						}}
						disabled={disabled || (nameStyle === null && value.theme_colors === null)}
						data-flx="user.my-profile-tab.plus-appearance-settings.button.reset"
					>
						{i18n._(RESET_PLUS_APPEARANCE_DESCRIPTOR)}
					</Button>
				</div>
				{errorMessage && (
					<p className={styles.errorMessage} data-flx="user.my-profile-tab.plus-appearance-settings.error-message">
						{errorMessage}
					</p>
				)}
			</div>
		);
	},
);
