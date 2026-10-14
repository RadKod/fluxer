// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {TableGamesEntry} from '@app/features/table_game/components/TableGamesEntry';
import TableGames from '@app/features/table_game/state/TableGames';
import {
	useVoiceParticipantAvatarEntries,
	type VoiceParticipantAvatarEntry,
} from '@app/features/voice/components/VoiceParticipantAvatarList';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {parseVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import {takeVoiceSeat} from '@app/features/voice_scene/commands/VoiceSeatCommands';
import {VoiceSceneAnchor, VoiceSceneAnchors} from '@app/features/voice_scene/components/VoiceSceneAnchor';
import {hasShownCamera, VoiceSceneAvatar} from '@app/features/voice_scene/components/VoiceSceneAvatar';
import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import {VoiceSceneSeatHud} from '@app/features/voice_scene/components/VoiceSceneSeatHud';
import {VoiceSceneSeatMarker} from '@app/features/voice_scene/components/VoiceSceneSeatMarker';
import {VoiceSceneStanding} from '@app/features/voice_scene/components/VoiceSceneStanding';
import {VoiceSceneTv} from '@app/features/voice_scene/components/VoiceSceneTv';
import {useSceneEscape} from '@app/features/voice_scene/hooks/useSceneEscape';
import {useSeatAssignments} from '@app/features/voice_scene/hooks/useSeatAssignments';
import {useSeatFallback} from '@app/features/voice_scene/hooks/useSeatFallback';
import {useSeatView} from '@app/features/voice_scene/hooks/useSeatView';
import {useSpatialAudioSync} from '@app/features/voice_scene/hooks/useSpatialAudioSync';
import {useTableGameScene} from '@app/features/voice_scene/hooks/useTableGameScene';
import {useWatchSeatSpectate} from '@app/features/voice_scene/hooks/useWatchSeatSpectate';
import type {RoomLayout, RoomSeat, Vec3, VoiceSceneOverlayProps} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSeatView from '@app/features/voice_scene/state/VoiceSceneSeatView';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import VoiceSceneTvRequest from '@app/features/voice_scene/state/VoiceSceneTvRequest';
import {type CameraCard, isTableCameraSeat} from '@app/features/voice_scene/utils/CameraCardLayout';
import {freeLoungeSeatCount} from '@app/features/voice_scene/utils/SeatAssignment';
import {useRoomCameras} from '@app/features/voice_scene/video/useRoomCameras';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useCallback, useLayoutEffect, useMemo, useState} from 'react';

const BACK_TO_TABLE_DESCRIPTOR = msg({
	message: 'Back to table',
	comment:
		'3D voice room: button on the label of the table you sit at, while you look at the room; returns to the close-up table view.',
});

// Disc sizes; useRoomCameras plans camera quality from the same numbers (keep them together).
const SEATED_AVATAR_SIZE = 40;
// In the room a table player is drawn smaller and further out than the chair so neither the table label nor the drawn
// table top is covered. Only the picture moves: 3D audio keeps the seat itself.
const TABLE_AVATAR_SIZE = 32;
// In the seat view the other players sit across a metre or two of table: a bigger base keeps their faces readable.
const SEAT_VIEW_TABLE_AVATAR_SIZE = 72;
const TABLE_AVATAR_PUSH_M = 0.45;

function avatarPoint(seat: RoomSeat, layout: RoomLayout): Vec3 {
	const table = seat.table ? layout.tables.find((entry) => entry.slot === seat.table?.slot) : undefined;
	if (!table) return seat.position;
	const dx = seat.position.x - table.center.x;
	const dz = seat.position.z - table.center.z;
	const distance = Math.hypot(dx, dz);
	if (distance === 0) return seat.position;
	const push = TABLE_AVATAR_PUSH_M / distance;
	return {x: seat.position.x + dx * push, y: seat.position.y, z: seat.position.z + dz * push};
}

interface ScenePerson {
	userId: string;
	connectionId: string;
	isLocal: boolean;
	hasScreenShare: boolean;
}

const personKey = (person: {userId: string; connectionId: string}): string => `${person.userId}:${person.connectionId}`;

// Seats and audio follow who is in the call, not who is speaking: a speaking change re-renders only the rings.
function useScenePeople(entries: ReadonlyArray<VoiceParticipantAvatarEntry>): ReadonlyArray<ScenePerson> {
	const signature = entries
		.map((entry) => `${personKey(entry)}:${entry.isLocal ? 1 : 0}${entry.hasScreenShare ? 1 : 0}`)
		.join('|');
	// The signature stands for these fields: the array changes only when one of them does.
	return useMemo(
		() =>
			entries.map(({userId, connectionId, isLocal, hasScreenShare}) => ({
				userId,
				connectionId,
				isLocal,
				hasScreenShare,
			})),
		[signature],
	);
}

// The DOM layer over the 3D room: avatars on seats and stand points, empty seat markers, table labels and the TV;
// in the seat view also the seat HUD. Non-camera anchors are inert there: pieces keep the pointer while
// the camera cards beside the table can still open their profiles.
export const VoiceSceneOverlay = observer(function VoiceSceneOverlay({handle, channel}: VoiceSceneOverlayProps) {
	const {i18n} = useLingui();
	const {layout} = handle;
	const [layer, setLayer] = useState<HTMLDivElement | null>(null);
	const [seatHud, setSeatHud] = useState<HTMLDivElement | null>(null);
	const guildId = channel.guildId ?? null;
	const entries = useVoiceParticipantAvatarEntries({guildId, channelId: channel.id});
	const connected = MediaEngine.channelId === channel.id;
	const room = connected ? MediaEngine.room : null;
	const connectionId = connected ? MediaEngine.connectionId : null;
	const me = Authentication.currentUserId;
	const games = readVoiceRoomAssignment(ExperimentAssignments.response).games;
	const people = useScenePeople(entries);
	const {assignment, seatOf} = useSeatAssignments({channelId: channel.id, room, layout, participants: people});
	// A seat name missing from this layout (the theme changed) is not a seat: the fallback asks and the server reseats.
	const mySeated =
		me !== null &&
		[...seatOf].some(
			([identity, seat]) =>
				parseVoiceParticipantIdentity(identity).userId === me && layout.seats.some((entry) => entry.name === seat),
		);
	useSeatFallback({
		channelId: channel.id,
		connectionId,
		seated: mySeated,
		hasFreeSeat: freeLoungeSeatCount(layout, seatOf) > 0,
	});
	useSpatialAudioSync({
		handle,
		room,
		assignment,
		participants: people,
		myUserId: me,
		enabled: VoiceSceneSettings.spatialAudio,
	});
	const mySeat = me !== null ? (assignment.placements.get(me)?.seat ?? null) : null;
	// The room view itself only opens where WebGL and the desktop layout allow (RoomViewAvailability).
	const seatTarget = useSeatView({handle, channelId: channel.id, seatName: mySeat, available: games, container: layer});
	const watchSlot = (mySeat && layout.seats.find((seat) => seat.name === mySeat)?.watch?.slot) || null;
	useWatchSeatSpectate({channelId: channel.id, watchSlot: games ? watchSlot : null, userId: me});
	const tableScene = useTableGameScene({handle, channelId: channel.id, target: seatTarget});
	useSceneEscape(handle);
	const seatView = seatTarget !== null;
	useLayoutEffect(() => {
		const active = layer?.ownerDocument.activeElement;
		if (seatView && active?.matches('[data-seat]') && layer?.contains(active)) (active as HTMLButtonElement).blur();
	}, [layer, seatView]);
	// In the seat view everyone at the table sits on their own seat point: pushed out, the side players leave the frame.
	const avatarPoints = useMemo(
		() => new Map(layout.seats.map((seat) => [seat.name, seatView ? seat.position : avatarPoint(seat, layout)])),
		[layout, seatView],
	);
	useRoomCameras({
		handle,
		room,
		channelId: channel.id,
		assignment,
		entries,
		avatarPoints,
		container: layer,
		tv: VoiceSceneTvRequest.watchedCamera(channel.id),
	});
	const entryByKey = useMemo(() => new Map(entries.map((entry) => [personKey(entry), entry])), [entries]);
	const entryOf = (person: ScenePerson | undefined) => (person ? entryByKey.get(personKey(person)) : undefined);
	// A lounge or watch seat asks the server for it; a table seat opens that table's panel.
	const handleSeatSelect = useCallback(
		(seat: RoomSeat) => {
			if (seat.table) TableGames.requestPanel(channel.id, seat.table.slot);
			else void takeVoiceSeat(channel.id, seat.name);
		},
		[channel.id],
	);
	const standing = assignment.standing.flatMap((person) => entryOf(person) ?? []);
	const tableAvatarSize = seatView ? SEAT_VIEW_TABLE_AVATAR_SIZE : TABLE_AVATAR_SIZE;
	const cameraCards = useMemo(
		() =>
			new Map(
				layout.seats.flatMap((seat) => {
					if (!isTableCameraSeat(seat)) return [];
					const table = layout.tables.find((table) => table.slot === seat.table?.slot);
					if (!table || (seatTarget && (seatTarget.role !== 'player' || seatTarget.slot !== table.slot))) return [];
					const lane = seatTarget ? ((seat.table!.position - seatTarget.seat.table!.position + 4) % 4) - 2 : undefined;
					return [[seat.name, {mode: seatView ? 'seat' : 'room', table, lane} as CameraCard] as const];
				}),
			),
		[layout, seatView, seatTarget],
	);
	return (
		<VoiceSceneAnchors handle={handle} data-flx="voice-scene.voice-scene-overlay.voice-scene-anchors">
			<div ref={setLayer} className={styles.overlay} data-flx="voice-scene.voice-scene-overlay.overlay">
				{layout.seats.map((seat) => {
					const entry = entryOf(assignment.seated.get(seat.name));
					// First person: I am the camera.
					if (entry && seatView && entry.userId === me) return null;
					if (entry) {
						const cameraCard = hasShownCamera(entry, channel.id) ? cameraCards.get(seat.name) : undefined;
						return (
							<VoiceSceneAnchor
								key={`user:${entry.userId}`}
								point={avatarPoints.get(seat.name) ?? seat.position}
								cameraCard={cameraCard}
								inert={seatView && !cameraCard}
								avoid={cameraCard?.mode === 'seat' ? seatHud : null}
								data-flx="voice-scene.voice-scene-overlay.voice-scene-anchor"
							>
								<VoiceSceneAvatar
									entry={entry}
									guildId={guildId}
									channelId={channel.id}
									size={seat.table ? tableAvatarSize : SEATED_AVATAR_SIZE}
									cameraCard={cameraCard?.mode}
									data-flx="voice-scene.voice-scene-overlay.voice-scene-avatar"
								/>
							</VoiceSceneAnchor>
						);
					}
					// Table seats are taken only through a game, watch seats watch one; without games both are furniture.
					// Keep empty-seat tooltips mounted across camera modes, hidden and inactive at the table.
					if ((seat.table || seat.watch) && !games) return null;
					return (
						<VoiceSceneAnchor
							key={`seat:${seat.name}`}
							point={seat.position}
							concealed={seatView}
							inert={seatView}
							data-flx="voice-scene.voice-scene-overlay.voice-scene-anchor--2"
						>
							<VoiceSceneSeatMarker
								seat={seat}
								disabled={connectionId === null || seatView}
								onSelect={handleSeatSelect}
								data-flx="voice-scene.voice-scene-overlay.voice-scene-seat-marker"
							/>
						</VoiceSceneAnchor>
					);
				})}
				{games
					? layout.tables.map((table) => {
							const mine = VoiceSceneSeatView.isAt(channel.id, table.slot);
							// In the seat view only my own label stays mounted, unseen: the HUD's panel button opens it.
							if (seatView && !mine) return null;
							return (
								<VoiceSceneAnchor
									key={`table:${table.slot}`}
									point={table.center}
									onTop
									fixedScale
									concealed={seatView}
									inert={seatView}
									data-flx="voice-scene.voice-scene-overlay.voice-scene-anchor--3"
								>
									<div className={styles.tableLabel} data-flx="voice-scene.voice-scene-overlay.table-label">
										<TableGamesEntry
											channel={channel}
											placement="scene"
											slot={table.slot}
											panelAnchor={seatView ? seatHud : null}
											data-flx="voice-scene.voice-scene-overlay.table-games-entry"
										/>
										{mine && VoiceSceneSeatView.dismissed ? (
											<button
												type="button"
												className={styles.backToTable}
												data-back-to-table={table.slot}
												onClick={VoiceSceneSeatView.returnToTable}
												data-flx="voice-scene.voice-scene-overlay.back-to-table.return-to-table"
											>
												{i18n._(BACK_TO_TABLE_DESCRIPTOR)}
											</button>
										) : null}
									</div>
								</VoiceSceneAnchor>
							);
						})
					: null}
				<div inert={seatView} className={styles.nonCameraLayer}>
					<VoiceSceneStanding
						entries={standing}
						overflow={assignment.overflow}
						placements={assignment.placements}
						standCount={layout.stands.length}
						guildId={guildId}
						channelId={channel.id}
						data-flx="voice-scene.voice-scene-overlay.voice-scene-standing"
					/>
					<VoiceSceneTv
						handle={handle}
						channel={channel}
						room={room}
						entries={entries}
						data-flx="voice-scene.voice-scene-overlay.voice-scene-tv"
					/>
				</div>
			</div>
			{seatTarget ? (
				<VoiceSceneSeatHud
					ref={setSeatHud}
					hud={tableScene}
					channelId={channel.id}
					slot={seatTarget.slot}
					onExit={() => handle.exitToOrbit()}
					data-flx="voice-scene.voice-scene-overlay.voice-scene-seat-hud"
				/>
			) : null}
		</VoiceSceneAnchors>
	);
});
