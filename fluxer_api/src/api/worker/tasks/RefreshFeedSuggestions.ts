// SPDX-License-Identifier: AGPL-3.0-or-later

import {getFeedSuggestionService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// the suggestion pool build, once a minute on the batch lane; runs that piled up behind a busy lane end
// at its 50 s gate.
const refreshFeedSuggestions: WorkerTaskHandler = async () => {
	await getFeedSuggestionService().buildSnapshot();
};

export default refreshFeedSuggestions;
