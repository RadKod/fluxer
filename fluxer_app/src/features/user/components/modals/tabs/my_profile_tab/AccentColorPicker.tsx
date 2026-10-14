// SPDX-License-Identifier: AGPL-3.0-or-later

import {getDefaultPickerHex} from '@app/features/app/components/floating/ColorPickerMath';
import Theme from '@app/features/theme/state/Theme';
import {ColorPickerField} from '@app/features/ui/components/form/ColorPickerField';
import myProfileTabStyles from '@app/features/user/components/modals/tabs/MyProfileTab.module.css';
import styles from '@app/features/user/components/modals/tabs/my_profile_tab/AccentColorPicker.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const ACCENT_COLOR_DESCRIPTOR = msg({
	message: 'Accent color',
	comment: 'Short label in the accent color picker. Keep it concise.',
});
const CUSTOMIZES_THE_BORDER_AND_BANNER_COLOR_ON_YOUR_DESCRIPTOR = msg({
	message: 'Customizes the border and banner color on your profile',
	comment: 'Label in the accent color picker. Keep the tone plain and specific.',
});

interface AccentColorPickerProps {
	value: number | null;
	onChange: (value: number | null) => void;
	disabled?: boolean;
	errorMessage?: string;
}

export const AccentColorPicker = observer(({value, onChange, disabled, errorMessage}: AccentColorPickerProps) => {
	const {i18n} = useLingui();
	const defaultAccentColor = Number.parseInt(getDefaultPickerHex(Theme.effectiveTheme).slice(1), 16);
	return (
		<div data-flx="user.my-profile-tab.accent-color-picker.div">
			<ColorPickerField
				label={i18n._(ACCENT_COLOR_DESCRIPTOR)}
				description={i18n._(CUSTOMIZES_THE_BORDER_AND_BANNER_COLOR_ON_YOUR_DESCRIPTOR)}
				descriptionClassName={myProfileTabStyles.inputFooter}
				value={value ?? defaultAccentColor}
				onChange={onChange}
				defaultValue={defaultAccentColor}
				isDefaultValue={value === null}
				onReset={() => onChange(null)}
				disabled={disabled}
				data-flx="user.my-profile-tab.accent-color-picker.color-picker-field.change"
			/>
			{errorMessage && (
				<p className={styles.errorMessage} data-flx="user.my-profile-tab.accent-color-picker.error-message">
					{errorMessage}
				</p>
			)}
		</div>
	);
});
