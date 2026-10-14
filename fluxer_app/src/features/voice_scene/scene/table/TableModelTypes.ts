// SPDX-License-Identifier: AGPL-3.0-or-later

// three types live here; import this file only from voice_scene/scene/** (KW-LAZY).
import type {TableScene3DInput, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {BufferGeometry, Material, Object3D} from 'three';

export type TablePartName =
	| 'piece_k'
	| 'piece_q'
	| 'piece_r'
	| 'piece_b'
	| 'piece_n'
	| 'piece_p'
	| 'piece_dm'
	| 'piece_dk'
	| 'tavla_board'
	| 'tavla_checker'
	| 'tavla_die'
	| 'okey_face'
	| 'okey_body'
	| 'okey_rack';

export interface TableParts {
	geometry(name: TablePartName): BufferGeometry;
	material(name: string): Material;
	node(name: string): Object3D | null;
}

export interface TableGame3DModel {
	// At the table centre; +Z is the perspective edge.
	readonly root: Object3D;
	// The same game never recreates its meshes (diff).
	update(input: TableScene3DInput): void;
	// userData.source: TableDragSource
	pickables(): ReadonlyArray<Object3D>;
	// Invisible; userData.target: TableDropTarget
	dropZones(): ReadonlyArray<Object3D>;
	// True while an animation runs (the draw loop asks).
	animating(): boolean;
	dispose(): void;
}

// Registry (TableGame3DHost): okey, okey101 → createOkeyTableModel; chess, dama, dama_normal → createBoardTableModel;
// tavla → createTavlaTableModel.
export type TableGame3DModelFactory = (p: {
	parts: TableParts;
	table: {center: Vec3; topSize: number};
	game: TableGameKind;
	requestRender(): void;
}) => TableGame3DModel;
