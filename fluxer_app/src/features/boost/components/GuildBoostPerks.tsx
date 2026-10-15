// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/boost/components/GuildBoostPanel.module.css';
import type {GuildBoostPerk} from '@app/features/boost/utils/GuildBoostLevels';
import {guildBoostPerkLabel} from '@app/features/boost/utils/GuildBoostMessages';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {
	FileIcon,
	ImageIcon,
	LinkIcon,
	PaletteIcon,
	SmileyIcon,
	SpeakerHighIcon,
	SquaresFourIcon,
	StickerIcon,
	VideoCameraIcon,
} from '@phosphor-icons/react';

const PERK_DETAILS = {
	animated_icon: {
		Icon: ImageIcon,
		description: msg({
			message: 'Use an animated logo for your community.',
			comment: 'Explanation of the animated community icon perk.',
		}),
	},
	animated_banner: {
		Icon: ImageIcon,
		description: msg({
			message: 'Use an animated community banner.',
			comment: 'Explanation of the animated community banner perk.',
		}),
	},
	static_banner: {
		Icon: ImageIcon,
		description: msg({
			message: 'Static images are included without boosts.',
			comment: 'Explanation of free static community banner and invite background.',
		}),
	},
	video: {
		Icon: VideoCameraIcon,
		description: msg({
			message: 'In this community’s voice channels. Your personal video allowance still applies.',
			comment: 'Community video profile does not reduce personal streaming or camera rights.',
		}),
	},
	soundboard: {
		Icon: SpeakerHighIcon,
		description: msg({
			message: 'Total sounds in the community soundboard.',
			comment: 'Explanation of total community soundboard capacity.',
		}),
	},
	role_icons: {
		Icon: SmileyIcon,
		description: msg({
			message: 'Use Unicode or an emoji from this community as a role icon.',
			comment: 'Role icon perk accepts Unicode or same-community emoji only.',
		}),
	},
	role_gradient: {
		Icon: PaletteIcon,
		description: msg({
			message: 'Give roles a static gradient with two colors.',
			comment: 'Explanation of the static two-color role gradient perk.',
		}),
	},
	file: {
		Icon: FileIcon,
		description: msg({
			message: 'Your personal upload allowance always applies.',
			comment: 'Community file rights never reduce personal upload rights.',
		}),
	},
	capacity: {
		Icon: SquaresFourIcon,
		description: msg({
			message: 'Total channels and roles available to this community.',
			comment: 'Explanation of total community channel and role capacities.',
		}),
	},
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
					<li key={perk.type} className={styles.perk} data-perk={perk.type} data-flx="boost.perks.item">
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
