// SPDX-License-Identifier: AGPL-3.0-or-later

import {DEVELOPER_DOCUMENTATION_DESCRIPTOR} from '@app/features/bots/utils/BotMessageDescriptors';
import {openExternalUrlWithWarning} from '@app/features/messaging/utils/ExternalLinkUtils';
import {Button} from '@app/features/ui/button/Button';
import {useLingui} from '@lingui/react/macro';
import {BookOpenIcon} from '@phosphor-icons/react';

export const BOT_DOCUMENTATION_URL = 'https://micup.gg/docs';

export function DeveloperDocumentationButton() {
	const {i18n} = useLingui();
	return (
		<Button
			variant="secondary"
			fitContent
			leftIcon={<BookOpenIcon weight="fill" aria-hidden />}
			onClick={() => openExternalUrlWithWarning(BOT_DOCUMENTATION_URL)}
			data-flx="bots.developer-documentation-button"
		>
			{i18n._(DEVELOPER_DOCUMENTATION_DESCRIPTOR)}
		</Button>
	);
}
