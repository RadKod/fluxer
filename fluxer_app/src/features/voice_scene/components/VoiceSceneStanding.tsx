// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {VoiceSceneAnchor} from '@app/features/voice_scene/components/VoiceSceneAnchor';
import {VoiceSceneAvatar} from '@app/features/voice_scene/components/VoiceSceneAvatar';
import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import type {SeatPlacement} from '@app/features/voice_scene/utils/SeatAssignment';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

const MORE_STANDING_DESCRIPTOR = msg({
	message: '{count} more people standing',
	comment: '3D voice room: label on the "+N" badge for people beyond the drawn standing avatars. {count} is a number.',
});

const STANDING_AVATAR_SIZE = 32;
// Stand points fill up in turns; later turns sit beside the first one (right, then left).
const ROW_SHIFT = [0, 75, -75];

export function VoiceSceneStanding({
	entries,
	overflow,
	placements,
	standCount,
	guildId,
	channelId,
}: {
	entries: ReadonlyArray<VoiceParticipantAvatarEntry>;
	overflow: number;
	placements: ReadonlyMap<string, SeatPlacement>;
	standCount: number;
	guildId: string | null;
	channelId: string;
}) {
	const {i18n} = useLingui();
	return (
		<>
			{entries.map((entry, index) => {
				const placement = placements.get(entry.userId);
				if (!placement) return null;
				const shift = ROW_SHIFT[Math.floor(index / Math.max(standCount, 1))] ?? 0;
				return (
					<VoiceSceneAnchor
						key={entry.userId}
						point={placement.position}
						data-flx="voice-scene.voice-scene-standing.voice-scene-anchor"
					>
						<div
							className={styles.standing}
							style={shift ? {transform: `translateX(${shift}%)`} : undefined}
							data-standing=""
							data-flx="voice-scene.voice-scene-standing.standing"
						>
							<VoiceSceneAvatar
								entry={entry}
								guildId={guildId}
								channelId={channelId}
								size={STANDING_AVATAR_SIZE}
								data-flx="voice-scene.voice-scene-standing.voice-scene-avatar"
							/>
						</div>
					</VoiceSceneAnchor>
				);
			})}
			{overflow > 0 ? (
				<div
					className={styles.overflow}
					role="note"
					aria-label={i18n._(MORE_STANDING_DESCRIPTOR, {count: overflow})}
					data-standing-overflow=""
					data-flx="voice-scene.voice-scene-standing.overflow"
				>
					+{i18n.number(overflow)}
				</div>
			) : null}
		</>
	);
}
