// SPDX-License-Identifier: AGPL-3.0-or-later

import {type OkeyFace, okeyTileLook} from '@app/features/table_game/components/okey/OkeyRackModel';
import styles from '@app/features/table_game/components/okey/OkeyTile.module.css';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

const COLOR_DESCRIPTORS: Record<OkeyFace['color'], MessageDescriptor> = {
	0: msg({message: 'Yellow {number}', comment: 'Table games: Okey tile name. {number} is 1 to 13.'}),
	1: msg({message: 'Blue {number}', comment: 'Table games: Okey tile name. {number} is 1 to 13.'}),
	2: msg({message: 'Black {number}', comment: 'Table games: Okey tile name. {number} is 1 to 13.'}),
	3: msg({message: 'Red {number}', comment: 'Table games: Okey tile name. {number} is 1 to 13.'}),
};
const WILD_DESCRIPTOR = msg({
	message: 'Okey ({tile})',
	comment: 'Table games: the wild tile of this hand. {tile} is its own name, like Yellow 7.',
});
const FAKE_DESCRIPTOR = msg({
	message: 'Fake okey, plays as {tile}',
	comment: 'Table games: the fake okey tile stands for the okey. {tile} is the okey, like Yellow 7.',
});

// A tile as it sits on the table. The fake okey shows its clover and, small, the face it plays as.
export function OkeyTile({
	token,
	okey,
	size = 'rack',
}: {
	token: string;
	okey: OkeyFace | null;
	size?: 'rack' | 'small';
}) {
	const {i18n} = useLingui();
	const look = okeyTileLook(token, okey);
	if (!look) return null;
	const face = i18n._(COLOR_DESCRIPTORS[look.face.color], {number: look.face.number});
	const label =
		look.okey === 'wild'
			? i18n._(WILD_DESCRIPTOR, {tile: face})
			: look.okey === 'fake'
				? i18n._(FAKE_DESCRIPTOR, {tile: face})
				: face;
	return (
		<span
			className={styles.tile}
			role="img"
			aria-label={label}
			data-tile={token}
			data-size={size}
			data-color={look.face.color}
			data-okey={look.okey ?? undefined}
			data-flx="table-game.okey.okey-tile.tile"
		>
			{look.okey === 'fake' ? (
				<>
					<span className={styles.clover} aria-hidden data-flx="table-game.okey.okey-tile.clover">
						♣
					</span>
					<span className={styles.plays} aria-hidden data-flx="table-game.okey.okey-tile.plays">
						{look.face.number}
					</span>
				</>
			) : (
				<span className={styles.number} aria-hidden data-flx="table-game.okey.okey-tile.number">
					{look.face.number}
				</span>
			)}
			{look.okey === 'wild' && (
				<span className={styles.star} aria-hidden data-flx="table-game.okey.okey-tile.star">
					★
				</span>
			)}
		</span>
	);
}
