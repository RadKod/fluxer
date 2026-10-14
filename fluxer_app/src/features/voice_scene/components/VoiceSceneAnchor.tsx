// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import type {Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {
	type CameraCard,
	type CameraCardViewport,
	cameraCardPlacement,
} from '@app/features/voice_scene/utils/CameraCardLayout';
import {wheelStaysInside} from '@app/features/voice_scene/utils/SceneWheel';
import {clsx} from 'clsx';
import type React from 'react';
import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

// project().scale is 1 at the cam_home distance; bounded so a near seat does not swallow its neighbours.
const MIN_SCALE = 0.6;
const MAX_SCALE = 1.8;
// Above every anchor stacked by distance (z = scale × 100 ≤ 180): a table label wins over the seats around it.
const ON_TOP_Z = 1000;
// Above the table labels too (z ≤ ON_TOP_Z + 180): no one's bubble or chip covers the TV's buttons.
const CONTROLS_Z = 2 * ON_TOP_Z;
// ask for occlusion after the camera rests, keeping ≤ 6 ms slices and cancellation on camera movement.
// BVHs are now built once per room in a worker (KW-PERF-bvh); these slices remain a safety net for main-thread rays.
// ponytail (TEMPORARY): visible meshes are still traversed per check. At 8× CPU, total > 100 ms or one ray > 16 ms
// triggers a room visibility cache / worker ray batches; see the renderer's occluder() for measured limits.
const OCCLUSION_REST_MS = 150;
const OCCLUSION_SLICE_MS = 6;

interface AnchorEntry {
	point: Vec3;
	onTop: boolean;
	controls: boolean;
	fixedScale: boolean;
	concealed: boolean;
	dimensions?: {width: number; height: number};
	cameraCard?: CameraCard;
	viewport: CameraCardViewport;
	avoid?: HTMLElement | null;
}

interface AnchorRegistry {
	add(element: HTMLElement, entry: AnchorEntry): () => void;
}

const AnchorContext = createContext<AnchorRegistry | null>(null);

export function anchorScale(projectedScale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, projectedScale));
}

// Written straight to the element: a camera frame moves every anchor without a React render.
function place(
	handle: VoiceSceneHandle,
	element: HTMLElement,
	{point, onTop, controls, fixedScale, cameraCard, viewport}: AnchorEntry,
	covered: boolean,
	occupied?: CameraCardViewport['occupied'],
): ReturnType<typeof cameraCardPlacement> | null {
	const projected = handle.project(point);
	const card = cameraCard ? cameraCardPlacement(handle, projected, cameraCard, {...viewport, occupied}) : null;
	const placed = card ?? projected;
	element.hidden = !placed.visible || (covered && cameraCard?.mode !== 'seat');
	if (!placed.visible) return null;
	const scale = anchorScale(projected.scale);
	if (card) {
		element.style.width = `${card.width}px`;
		element.style.height = `${card.height}px`;
	} else {
		element.style.removeProperty('width');
		element.style.removeProperty('height');
	}
	element.style.transform = `translate3d(${placed.x}px, ${placed.y}px, 0) translate(-50%, -50%) scale(${fixedScale || cameraCard ? 1 : scale})`;
	element.style.zIndex = String(Math.round(scale * 100) + (controls ? CONTROLS_Z : onTop ? ON_TOP_Z : 0));
	return element.hidden ? null : card;
}

// The layer sits over the canvas: project().visible (in front of the camera, inside the view) places an anchor, and
// The occlusion check hides one the room covers, asked once the camera rests (the last answer stays while it moves; no
// frames, rays only at rest and only for anchors on screen).
export function VoiceSceneAnchors({handle, children}: {handle: VoiceSceneHandle; children: React.ReactNode}) {
	const [anchors] = useState(() => new Map<HTMLElement, AnchorEntry>());
	const [covered] = useState(() => new Set<HTMLElement>());
	const layer = useMemo(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let frame: number | undefined;
		let restAt: number | undefined;
		let resize: ResizeObserver | null = null;
		const observed = new Map<Element, number>();
		const parents = new Map<HTMLElement, {width: number; height: number; dirty: boolean}>();
		const rectangles = new Map<HTMLElement, DOMRect | null>();
		let queue: Array<[HTMLElement, AnchorEntry]> = [];
		let test: ((point: Vec3) => boolean) | null = null;
		// Read the whole dirty layer before any placement writes. Camera frames reuse these sizes.
		const measureAll = (): void => {
			for (const [parent, size] of parents) {
				if (!size.dirty) continue;
				size.width = parent.clientWidth || window.innerWidth;
				size.height = parent.clientHeight || window.innerHeight;
				size.dirty = false;
			}
			for (const [element, rect] of rectangles) if (!rect) rectangles.set(element, element.getBoundingClientRect());
			for (const [element, entry] of anchors) {
				if (entry.onTop && !entry.dimensions)
					entry.dimensions = {width: element.offsetWidth, height: element.offsetHeight};
				const parent = element.parentElement;
				const size = parent && parents.get(parent);
				if (size) entry.viewport = {width: size.width, height: size.height};
				if (entry.avoid && parent) {
					const origin = rectangles.get(parent),
						rect = rectangles.get(entry.avoid);
					if (origin && rect)
						entry.viewport.avoid = {
							left: rect.left - origin.left,
							right: rect.right - origin.left,
							top: rect.top - origin.top,
							bottom: rect.bottom - origin.top,
						};
				}
			}
		};
		const placeAll = (): void => {
			const groups = new Map<string, Array<[HTMLElement, AnchorEntry]>>();
			const labels: Array<NonNullable<CameraCardViewport['occupied']>[number]> = [];
			for (const [element, entry] of anchors) {
				if (!entry.cameraCard) {
					place(handle, element, entry, covered.has(element));
					if (entry.onTop && !entry.concealed && !element.hidden && entry.dimensions) {
						const p = handle.project(entry.point);
						const scale = entry.fixedScale ? 1 : anchorScale(p.scale);
						const width = entry.dimensions.width * scale,
							height = entry.dimensions.height * scale;
						if (width > 0 && height > 0)
							labels.push({
								left: p.x - width / 2,
								right: p.x + width / 2,
								top: p.y - height / 2,
								bottom: p.y + height / 2,
							});
					}
					continue;
				}
				const key = `${entry.cameraCard.mode}:${entry.cameraCard.table.slot}`;
				const group = groups.get(key) ?? [];
				group.push([element, entry]);
				groups.set(key, group);
			}
			// Each table has at most three seated peers (four in the room). Resolve their shared edge clamp together.
			const occupied = [...labels];
			for (const group of groups.values()) {
				group.sort((a, b) => (a[1].cameraCard?.lane ?? 0) - (b[1].cameraCard?.lane ?? 0));
				for (const [element, entry] of group) {
					const card = place(handle, element, entry, covered.has(element), occupied);
					if (card)
						occupied.push({
							left: card.x - card.width / 2,
							right: card.x + card.width / 2,
							top: card.y - card.height / 2,
							bottom: card.y + card.height / 2,
						});
				}
			}
		};
		const flush = (): void => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = undefined;
			measureAll();
			placeAll();
			if (restAt !== undefined) {
				const delay = Math.max(0, restAt - performance.now());
				restAt = undefined;
				schedule(delay);
			}
		};
		const requestPlacement = (): void => {
			if (frame === undefined) frame = requestAnimationFrame(flush);
		};
		const observe = (element: Element): void => {
			if (!resize) {
				const observer = new ResizeObserver((changes) => {
					if (resize !== observer) return; // A late notification from a disposed handle/replay.
					for (const change of changes) {
						const size = parents.get(change.target as HTMLElement);
						if (size) {
							size.dirty = true;
							for (const [element, entry] of anchors)
								if (entry.avoid && element.parentElement === change.target) rectangles.set(entry.avoid, null);
						}
						if (rectangles.has(change.target as HTMLElement)) rectangles.set(change.target as HTMLElement, null);
						const entry = anchors.get(change.target as HTMLElement);
						if (entry?.onTop) entry.dimensions = {width: change.contentRect.width, height: change.contentRect.height};
					}
					requestPlacement();
				});
				resize = observer;
			}
			const references = observed.get(element) ?? 0;
			if (!references) resize.observe(element);
			observed.set(element, references + 1);
		};
		const unobserve = (element: Element): void => {
			const references = observed.get(element) ?? 0;
			if (references > 1) observed.set(element, references - 1);
			else {
				resize?.unobserve(element);
				observed.delete(element);
				parents.delete(element as HTMLElement);
				rectangles.delete(element as HTMLElement);
			}
		};
		const slice = (): void => {
			const start = performance.now();
			while (queue.length > 0 && test) {
				const [element, entry] = queue.shift()!;
				if (!anchors.has(element)) continue;
				if (handle.project(entry.point).visible && test(entry.point)) covered.add(element);
				else covered.delete(element);
				if (performance.now() - start >= OCCLUSION_SLICE_MS) break;
			}
			flush();
			if (queue.length > 0) timer = setTimeout(slice, 0);
		};
		const check = (): void => {
			test = handle.occluder();
			queue = [...anchors];
			slice();
		};
		// A camera move drops what is left of a check (its next slice); the answers so far stay until the next one.
		const schedule = (delay: number): void => {
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(check, delay);
		};
		const requestRest = (): void => {
			if (restAt === undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			restAt = performance.now() + OCCLUSION_REST_MS;
		};
		// an anchor's content takes the pointer; its wheel still zooms the room (towards the TV under a poster).
		const onWheel = (event: WheelEvent): void => {
			if (!(event.currentTarget instanceof Element) || wheelStaysInside(event, event.currentTarget)) return;
			event.preventDefault();
			event.stopPropagation();
			handle.wheel(event);
		};
		const registry: AnchorRegistry = {
			add(element, entry) {
				const parent = element.parentElement;
				if ((entry.cameraCard || entry.onTop) && parent) {
					if (!parents.has(parent)) parents.set(parent, {width: 0, height: 0, dirty: true});
					observe(parent);
				}
				if (entry.onTop) observe(element);
				if (entry.avoid && parent) {
					if (!rectangles.has(parent)) rectangles.set(parent, null);
					if (!rectangles.has(entry.avoid)) rectangles.set(entry.avoid, null);
					observe(entry.avoid);
				}
				anchors.set(element, entry);
				requestRest();
				requestPlacement();
				element.addEventListener('wheel', onWheel, {passive: false});
				return () => {
					if ((entry.cameraCard || entry.onTop) && parent) unobserve(parent);
					if (entry.onTop) unobserve(element);
					if (entry.avoid) unobserve(entry.avoid);
					element.removeEventListener('wheel', onWheel);
					anchors.delete(element);
					covered.delete(element);
					if (anchors.size) requestPlacement();
					else if (frame !== undefined) {
						cancelAnimationFrame(frame);
						frame = undefined;
					}
				};
			},
		};
		return {
			registry,
			viewChanged: () => {
				requestRest();
				flush();
			},
			stop: () => {
				clearTimeout(timer);
				if (frame !== undefined) cancelAnimationFrame(frame);
				frame = undefined;
				restAt = undefined;
				resize?.disconnect();
				resize = null;
				observed.clear();
				parents.clear();
				rectangles.clear();
				queue = [];
				test = null;
			},
		};
	}, [anchors, covered, handle]);
	useEffect(() => {
		const off = handle.onViewChange(() => {
			layer.viewChanged();
		});
		return () => {
			off();
			layer.stop();
		};
	}, [handle, layer]);
	return <AnchorContext.Provider value={layer.registry}>{children}</AnchorContext.Provider>;
}

// `concealed`: kept in place and mounted (a popout may open from it) but never seen. `controls`: above every other
// anchor, labels included. `fixedScale`: screen-sized content; distance still determines its stacking order.
export function VoiceSceneAnchor({
	point,
	onTop = false,
	controls = false,
	fixedScale = false,
	concealed = false,
	cameraCard,
	avoid,
	inert = false,
	className,
	children,
}: {
	point: Vec3;
	onTop?: boolean;
	controls?: boolean;
	fixedScale?: boolean;
	concealed?: boolean;
	cameraCard?: CameraCard;
	avoid?: HTMLElement | null;
	inert?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	const registry = useContext(AnchorContext);
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		if (!registry || !ref.current) return;
		return registry.add(ref.current, {
			point,
			onTop,
			controls,
			fixedScale,
			concealed,
			cameraCard,
			avoid,
			viewport: {width: 0, height: 0},
		});
	}, [registry, point, onTop, controls, fixedScale, concealed, cameraCard, avoid]);
	return (
		<div
			ref={ref}
			inert={inert}
			className={clsx(styles.anchor, className)}
			style={concealed ? {visibility: 'hidden'} : undefined}
			data-scene-anchor=""
			data-camera-card-anchor={cameraCard ? '' : undefined}
			data-flx="voice-scene.voice-scene-anchor.anchor"
		>
			{children}
		</div>
	);
}
