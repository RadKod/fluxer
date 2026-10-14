// SPDX-License-Identifier: AGPL-3.0-or-later

import {redactRequestLogPath} from '@fluxer/errors/src/error_handling/RequestLogRedaction';
import {createInfoRequestLogger, type LogFunction} from '@fluxer/hono/src/middleware/RequestLogger';

export function createRedactedInfoRequestLogger(logger: {
	info(obj: Record<string, unknown>, msg: string): void;
}): LogFunction {
	const log = createInfoRequestLogger(logger);
	return (data) => log({...data, path: redactRequestLogPath(data.path)});
}
