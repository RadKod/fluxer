// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const SOURCE_CODE_DESCRIPTOR = msg({
	message: 'Source code',
	comment:
		'Small link at the bottom of user settings, next to the terms of service and privacy policy links. Opens the page where the instance offers the source code of its software.',
});

export const SourceCodeLink = observer(({className}: {className?: string}) => {
	const {i18n} = useLingui();
	const sourceUrl = RuntimeConfig.sourceUrl;
	if (!sourceUrl) {
		return null;
	}
	return (
		<a
			href={sourceUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={className}
			data-flx="app.source-code-link.a"
		>
			{i18n._(SOURCE_CODE_DESCRIPTOR)}
		</a>
	);
});
