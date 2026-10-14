// SPDX-License-Identifier: AGPL-3.0-or-later

// three.js and three-mesh-bvh from fluxer_app's node_modules (the tools have no package of their own).
export * from '../../../fluxer_app/node_modules/three/build/three.module.js';
export {RoundedBoxGeometry} from '../../../fluxer_app/node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
export {
	mergeGeometries,
	mergeVertices,
} from '../../../fluxer_app/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
export {MeshBVH} from '../../../fluxer_app/node_modules/three-mesh-bvh/src/index.js';
