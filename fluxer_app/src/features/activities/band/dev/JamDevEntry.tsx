// SPDX-License-Identifier: AGPL-3.0-or-later

// Entry of the jam audio harness (rspack.jam-dev.config.mjs). Nothing from the app's shell is needed: the engine
// runs on its own AudioContext and the page is plain React.

import {JamDevApp} from '@app/features/activities/band/dev/JamDevApp';
import {JamDevHarness, jamAssetUrlFromLocation} from '@app/features/activities/band/dev/JamDevHarness';
import {configure} from 'mobx';
import ReactDOM from 'react-dom/client';

configure({enforceActions: 'observed'});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const harness = new JamDevHarness(jamAssetUrlFromLocation(window.location));
Object.assign(window, {jamDev: harness});
window.addEventListener('pagehide', () => harness.dispose());
ReactDOM.createRoot(container).render(<JamDevApp harness={harness} />);
