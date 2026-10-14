// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/boost/components/GuildBoostPanel.module.css';
import type {GuildBoostPerk} from '@app/features/boost/utils/GuildBoostLevels';
import {guildBoostPerkLabel} from '@app/features/boost/utils/GuildBoostMessages';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {LinkIcon, SmileyIcon, SpeakerHighIcon, StickerIcon} from '@phosphor-icons/react';

const PERK_DETAILS = {
	bitrate: {
		Icon: SpeakerHighIcon,
		description: msg({
			message: 'Clearer audio in voice channels.',
			comment: 'Explanation of the community voice bitrate boost perk.',
		}),
	},
	emoji: {
		Icon: SmileyIcon,
		description: msg({
			message: 'More custom emoji for your community.',
			comment: 'Explanation of community emoji capacity boost perk.',
		}),
	},
	stickers: {
		Icon: StickerIcon,
		description: msg({
			message: 'More custom stickers for your community.',
			comment: 'Explanation of community sticker capacity boost perk.',
		}),
	},
	vanity_url: {
		Icon: LinkIcon,
		description: msg({
			message: 'Choose a memorable invite link.',
			comment: 'Explanation of the community vanity URL boost perk.',
		}),
	},
};

export function GuildBoostPerks({perks}: {perks: ReadonlyArray<GuildBoostPerk>}) {
	const {i18n} = useLingui();
	return (
		<ul className={styles.perks} data-flx="boost.perks.list">
			{perks.map((perk) => {
				const {Icon, description} = PERK_DETAILS[perk.type];
				return (
					<li key={perk.type} className={styles.perk} data-flx="boost.perks.item">
						<Icon size={20} aria-hidden="true" />
						<div>
							<span>{guildBoostPerkLabel(i18n, perk)}</span>
							<p className={styles.muted}>{i18n._(description)}</p>
						</div>
					</li>
				);
			})}
		</ul>
	);
}
