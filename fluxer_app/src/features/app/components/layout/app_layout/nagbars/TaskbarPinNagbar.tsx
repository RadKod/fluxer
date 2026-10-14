// SPDX-License-Identifier: AGPL-3.0-or-later

import {Nagbar} from '@app/features/app/components/layout/Nagbar';
import {NagbarButton} from '@app/features/app/components/layout/NagbarButton';
import {NagbarContent} from '@app/features/app/components/layout/NagbarContent';
import {NAGBAR_TONES, NagbarToneKind} from '@app/features/app/components/layout/NagbarTones';
import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import TaskbarPin from '@app/features/platform/state/TaskbarPin';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const PIN_DESCRIPTION = msg({
	message: 'Pin {productName} to your taskbar',
	comment: 'One-time Windows taskbar pin suggestion. {productName} is the app name.',
});
const PIN_ACTION = msg({
	message: 'Pin',
	comment: 'Button that opens the Windows taskbar pin confirmation.',
});

export const TaskbarPinNagbar = observer(({isMobile}: {isMobile: boolean}) => {
	const {i18n} = useLingui();
	return (
		<Nagbar
			isMobile={isMobile}
			backgroundColor={NAGBAR_TONES[NagbarToneKind.BRAND].backgroundColor}
			textColor={NAGBAR_TONES[NagbarToneKind.BRAND].textColor}
			dismissible
			onDismiss={TaskbarPin.dismiss}
			data-flx="app.app-layout.nagbars.taskbar-pin-nagbar.nagbar"
		>
			<NagbarContent
				isMobile={isMobile}
				onDismiss={TaskbarPin.dismiss}
				message={i18n._(PIN_DESCRIPTION, {productName: PRODUCT_NAME})}
				actions={
					<NagbarButton
						isMobile={isMobile}
						onClick={() => {
							void TaskbarPin.requestPin();
						}}
						submitting={TaskbarPin.busy}
						data-flx="app.app-layout.nagbars.taskbar-pin-nagbar.pin"
					>
						{i18n._(PIN_ACTION)}
					</NagbarButton>
				}
				data-flx="app.app-layout.nagbars.taskbar-pin-nagbar.content"
			/>
		</Nagbar>
	);
});
