// SPDX-License-Identifier: AGPL-3.0-or-later

import {createDamaEngine} from '@app/api/table_game/engine/dama/Dama';
import {DAMA_NORMAL_RULES} from '@app/api/table_game/engine/dama/DamaRules';

export const DamaNormal = createDamaEngine('dama_normal', DAMA_NORMAL_RULES);
