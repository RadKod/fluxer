// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import styles from '@app/features/cosmetics/components/AvatarUltraFront.module.css';
import {FRONT_SCALE} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import UltraLayouts from '@app/features/cosmetics/state/UltraLayouts';
import {getCosmeticAssetURL, ULTRA_FRONT_MEDIA_MAX_SIZE} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import {loadFrontIdle, preloadFrontFrames} from '@app/features/cosmetics/utils/UltraFrontAssets';
import {
	FRONT_AT_REST,
	FRONT_FRAME_MS,
	isFrontMoving,
	requestFront,
	stepFront,
	type UltraFrontMotion,
} from '@app/features/cosmetics/utils/UltraFrontMotion';
import {useTooltipPortalRoot} from '@app/features/ui/tooltip/Tooltip';
import {
	getTooltipScrollSuppressRemainingMs,
	subscribeTooltipScrollHide,
} from '@app/features/ui/tooltip/TooltipScrollCoordinator';
import {autoUpdate} from '@floating-ui/react-dom';
import type {UltraFront} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {createPortal} from 'react-dom';

// One idle loop (3.4 s): a flickering speaking signal never flaps the wings.
const VOICE_MIN_LOOP_MS = 3_400;
// Only a button or link: the avatar container itself when clickable, a voice tile (three levels up) or a member row
// button (four, five with a nameplate). The walk stops at a list or a scroller: a wider focusable ancestor would open
// every wing under it.
const FOCUS_OWNER = 'button, a[href], [role="button"]';
const FOCUS_OWNER_STOP = '[role="list"], [role="listbox"], [role="log"], [data-fluxer-scroll-container]';
const FOCUS_OWNER_LEVELS = 6;
// The one wing open in the tooltip layer; opening another closes it.
let closeOverlaid: (() => void) | null = null;
// As a tooltip follows its target (Tooltip.tsx TOOLTIP_AUTO_UPDATE_OPTIONS): a layout shift or a resize moves the box;
// an ancestor scroll is left out, since a scroll closes the wings.
const OVERLAY_AUTO_UPDATE_OPTIONS = {
	ancestorScroll: false,
	ancestorResize: true,
	elementResize: true,
	layoutShift: true,
} as const;

export interface AvatarUltraFrontProps {
	itemId: string;
	front: UltraFront;
	size: number;
	animate: boolean;
	surface: 'compact' | 'voice' | 'profile';
}

// The loop download for one URL; blob is null when it failed.
interface LoadedLoop {
	url: string;
	blob: Blob | null;
}

// Micup: drawn in front of the avatar, still while closed; on interaction the opening frames step
// forward, the loop plays while open, and letting go steps back from the frame it is on. The step lives here, per
// layer, never in a shared store.
export const AvatarUltraFront = observer(function AvatarUltraFront({
	itemId,
	front,
	size,
	animate,
	surface,
}: AvatarUltraFrontProps) {
	const ref = useRef<HTMLSpanElement>(null);
	const focused = useAncestorFocusVisible(ref);
	const wantOpen = useShouldAnimate({
		kind: 'avatar',
		isHovering: (animate || focused) && !Accessibility.useReducedMotion,
	});
	const box = size * FRONT_SCALE;
	const urlOf = (hash: string, animated: boolean) =>
		getCosmeticAssetURL('avatar_ultra', {item_id: itemId, asset: hash}, box, animated, ULTRA_FRONT_MEDIA_MAX_SIZE);
	// Keyed by the URLs: a resize that stays on the same size rung keeps the decoded list.
	const framesKey = front.open.map((hash) => urlOf(hash, false)).join('\n');
	const frames = useMemo(() => framesKey.split('\n'), [framesKey]);
	const lastFrame = frames.length - 1;
	const loopSource = urlOf(front.idle, true);
	const [decoded, setDecoded] = useState<string | null>(null);
	const ready = decoded === framesKey;
	const [loop, setLoop] = useState<LoadedLoop | null>(null);
	const loaded = loop?.url === loopSource ? loop : null;
	const [held, setHeld] = useState(false);
	const open = wantOpen || (surface === 'voice' && held);
	const [motion, setMotion] = useState(FRONT_AT_REST);
	const [loopUrl, setLoopUrl] = useState<string | null>(null);
	const [loopShown, setLoopShown] = useState(false);

	// Nothing loads before the first open; every frame is decoded before the first step.
	useEffect(() => {
		if (!wantOpen || ready) return;
		let live = true;
		preloadFrontFrames(frames).then(
			() => {
				if (live) setDecoded(framesKey);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [wantOpen, ready, frames, framesKey]);

	// The loop downloads once, on the first open; every later open replays that download. Keyed on the held open too:
	// speaking that stops mid-opening must not drop the download the loop is about to play.
	useEffect(() => {
		if (!open || loaded) return;
		let live = true;
		loadFrontIdle(loopSource).then(
			(blob) => {
				if (live) setLoop({url: loopSource, blob});
			},
			() => {
				if (live) setLoop({url: loopSource, blob: null});
			},
		);
		return () => {
			live = false;
		};
	}, [open, loaded, loopSource]);

	// A voice tile that starts opening stays open until one loop has played.
	useEffect(() => {
		if (surface !== 'voice' || !motion.opening) return;
		if (!motion.looping) {
			setHeld(true);
			return;
		}
		const timer = setTimeout(() => setHeld(false), VOICE_MIN_LOOP_MS);
		return () => clearTimeout(timer);
	}, [surface, motion.opening, motion.looping]);

	// The tooltip scroll coordinator counts scrolls only while someone listens. A chat or member row with wings listens
	// while it is on screen, so a scroll is counted even when no row is open, hovered or ready.
	// One Set entry per such avatar; the document listener stays one and passive.
	useEffect(() => (surface === 'compact' ? subscribeTooltipScrollHide(() => {}) : undefined), [surface]);

	// Opening waits for every frame, and on a chat or member row for a scroll to settle, as a tooltip waits: a row a
	// scroll brings under a still pointer must not flap open. Closing never waits.
	useEffect(() => {
		if (!open) {
			setMotion((state) => requestFront(state, false, lastFrame));
			return;
		}
		if (!ready) return;
		if (surface !== 'compact') {
			setMotion((state) => requestFront(state, true, lastFrame));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const start = () => {
			const wait = getTooltipScrollSuppressRemainingMs();
			if (wait > 0) timer = setTimeout(start, wait + 1);
			else setMotion((state) => requestFront(state, true, lastFrame));
		};
		start();
		return () => clearTimeout(timer);
	}, [open, ready, lastFrame, surface]);

	// One timer per run in one direction; each frame is the one due by the time since the run began, so a late timer
	// (Windows fires 33 ms after ~47) skips a frame instead of slowing the whole run.
	const moving = isFrontMoving(motion);
	useEffect(() => {
		if (!moving) return;
		const start = performance.now();
		let stepped = 0;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			const due = Math.floor((performance.now() - start) / FRONT_FRAME_MS);
			// No run is longer than every frame: after a long sleep it lands on its end in one go.
			const steps = Math.min(due - stepped, lastFrame + 1);
			stepped = due;
			if (steps > 0) {
				setMotion((state) =>
					Array.from({length: steps}).reduce<UltraFrontMotion>((next) => stepFront(next, lastFrame), state),
				);
			}
			timer = setTimeout(tick, start + (stepped + 1) * FRONT_FRAME_MS - performance.now());
		};
		timer = setTimeout(tick, FRONT_FRAME_MS);
		return () => clearTimeout(timer);
	}, [moving, motion.opening, lastFrame]);

	// Every open plays the loop from its first frame through a new blob URL over the one download. A failed
	// download plays the plain URL: the first open fetches it, later opens reuse it without restarting it.
	useEffect(() => {
		if (!motion.looping || !loaded) return;
		// TEMPORARY: (ponytail): a blob URL per open makes each playing layer its own image source, so N layers decode the
		// loop N times. Trigger: more than 4 layers looping at once, or dropped frames in a voice room. Upgrade: one shared
		// blob URL per (item, size), or a cap on concurrent loops in voice.
		const url = loaded.blob ? URL.createObjectURL(loaded.blob) : loopSource;
		setLoopUrl(url);
		return () => {
			if (loaded.blob) URL.revokeObjectURL(url);
			setLoopUrl(null);
			setLoopShown(false);
		};
	}, [motion.looping, loaded, loopSource]);

	const atRest = motion.frame === 0 && !motion.opening;
	// Chat and member rows sit in scrollers that cut the open wings: off rest they draw in the
	// tooltip layer over the avatar and follow it through a layout shift. A scroll or resize closes them at once rather
	// than leave them behind. So does a click or a focus moving elsewhere, since a modal, a popout or a context menu opens
	// under that layer, and a window blur, as it hides a tooltip. They stay closed while the row stays hovered
	// (requestFront runs only when `open` changes): a member row keeps its hover through a scroll, a chat row resolves its
	// hover again once a scroll settles (MessageHoverTracking) and so opens again under a still pointer. Only this layer
	// listens, in the avatar's own document. Voice tiles clip the wings by design  and a profile moves with
	// its popout: both keep them in place.
	const overlaid = surface === 'compact' && !atRest;
	const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
	// The box left in place keeps drawing until the tooltip layer's box can show its first frame.
	const [overlayShown, setOverlayShown] = useState(false);
	const showOverlay = useCallback(() => setOverlayShown(true), []);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!overlaid || !node) return;
		const close = () => setMotion(FRONT_AT_REST);
		// The focus coming to the avatar's own row (Tab or an arrow key onto it) keeps the wings open.
		const closeOnFocusElsewhere = (event: FocusEvent) => {
			if (!(event.target instanceof Node && event.target.contains(node))) close();
		};
		closeOverlaid?.();
		closeOverlaid = close;
		setAnchor(node);
		const ownerDocument = node.ownerDocument;
		const ownerWindow = ownerDocument.defaultView ?? window;
		const stopScroll = subscribeTooltipScrollHide(close);
		ownerWindow.addEventListener('resize', close);
		ownerWindow.addEventListener('blur', close);
		ownerDocument.addEventListener('pointerdown', close, true);
		ownerDocument.addEventListener('focusin', closeOnFocusElsewhere, true);
		return () => {
			if (closeOverlaid === close) closeOverlaid = null;
			stopScroll();
			ownerWindow.removeEventListener('resize', close);
			ownerWindow.removeEventListener('blur', close);
			ownerDocument.removeEventListener('pointerdown', close, true);
			ownerDocument.removeEventListener('focusin', closeOnFocusElsewhere, true);
			setAnchor(null);
			setOverlayShown(false);
		};
	}, [overlaid]);

	if (!loopSource) return null;
	const parts = (
		<>
			<FrontHalves
				src={atRest ? urlOf(front.closed, false) : frames[Math.min(motion.frame, lastFrame)]}
				hidden={motion.looping && loopShown}
				// A closed frame that fails to load draws the item behind, as an older app does.
				onError={atRest ? () => UltraLayouts.frontFailed(itemId) : undefined}
				data-flx="cosmetics.avatar-ultra-front.frame"
			/>
			{motion.looping && loopUrl ? (
				<FrontHalves src={loopUrl} onLoad={() => setLoopShown(true)} data-flx="cosmetics.avatar-ultra-front.loop" />
			) : null}
		</>
	);
	const inOverlay = overlaid && anchor;
	return (
		<span ref={ref} className={styles.front} aria-hidden data-flx="cosmetics.avatar-ultra-front.box">
			{inOverlay && overlayShown ? null : parts}
			{inOverlay ? (
				<FrontOverlay
					anchor={anchor}
					shown={overlayShown}
					onShown={showOverlay}
					data-flx="cosmetics.avatar-ultra-front.front-overlay"
				>
					{parts}
				</FrontOverlay>
			) : null}
		</span>
	);
});

interface FrontOverlayProps {
	anchor: HTMLElement;
	shown: boolean;
	onShown: () => void;
	children: ReactNode;
}

// The avatar's in-front box, in the tooltip layer: out of every scroller's clip, never taking a click. It is placed
// over the box left in place (the anchor) and moved with it. Only this open box watches, and it reads the layout
// when something moved, never on every frame. It stays hidden until its first image is decoded: a new image element
// draws nothing before that, while the box left in place still does. A decode is rejected when the frame steps on
// before the image loaded; the box then waits for that image's next load (or error), unless it is already complete.
function FrontOverlay({anchor, shown, onShown, children}: FrontOverlayProps) {
	const root = useTooltipPortalRoot(true, anchor.ownerDocument);
	const boxRef = useRef<HTMLSpanElement>(null);
	const [place, setPlace] = useState<DOMRect | null>(null);
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		return autoUpdate(anchor, box, () => setPlace(anchor.getBoundingClientRect()), OVERLAY_AUTO_UPDATE_OPTIONS);
	}, [anchor, root]);
	useLayoutEffect(() => {
		const first = boxRef.current?.querySelector('img');
		if (!first || shown) return;
		let live = true;
		const show = () => {
			if (live) onShown();
		};
		const showWhenLoaded = () => {
			if (!live) return;
			if (first.complete) {
				show();
				return;
			}
			first.addEventListener('load', show, {once: true});
			first.addEventListener('error', show, {once: true});
		};
		first.decode().then(show, showWhenLoaded);
		return () => {
			live = false;
			first.removeEventListener('load', show);
			first.removeEventListener('error', show);
		};
	}, [root, shown, onShown]);
	if (!root) return null;
	return createPortal(
		<span
			ref={boxRef}
			className={styles.floating}
			style={{
				...(place && {left: place.left, top: place.top, width: place.width, height: place.height}),
				visibility: place && shown ? undefined : 'hidden',
			}}
			aria-hidden
			data-flx="cosmetics.avatar-ultra-front.floating"
		>
			{children}
		</span>,
		root,
	);
}

interface FrontHalvesProps {
	src: string;
	hidden?: boolean;
	onLoad?: () => void;
	onError?: () => void;
}

// Every part is the left half; the right half is the same URL mirrored.
function FrontHalves({src, hidden = false, onLoad, onError}: FrontHalvesProps) {
	const className = clsx(styles.half, hidden && styles.hidden);
	return (
		<>
			<img
				className={className}
				src={src}
				alt=""
				decoding="sync"
				draggable={false}
				onLoad={onLoad}
				onError={onError}
				data-flx="cosmetics.avatar-ultra-front.left"
			/>
			<img
				className={clsx(className, styles.mirror)}
				src={src}
				alt=""
				decoding="sync"
				draggable={false}
				data-flx="cosmetics.avatar-ultra-front.right"
			/>
		</>
	);
}

// Keyboard focus on the button or link the avatar sits in opens the wings too.
function useAncestorFocusVisible(ref: RefObject<HTMLElement | null>): boolean {
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		const target = focusOwner(ref.current?.parentElement ?? null);
		if (!target) return;
		const onIn = (event: FocusEvent) =>
			setFocused(event.target instanceof Element && event.target.matches(':focus-visible'));
		const onOut = () => setFocused(false);
		target.addEventListener('focusin', onIn);
		target.addEventListener('focusout', onOut);
		return () => {
			target.removeEventListener('focusin', onIn);
			target.removeEventListener('focusout', onOut);
		};
	}, [ref]);
	return focused;
}

function focusOwner(avatar: HTMLElement | null): HTMLElement | null {
	let node = avatar;
	for (
		let level = 0;
		node && level <= FOCUS_OWNER_LEVELS && !node.matches(FOCUS_OWNER_STOP);
		level++, node = node.parentElement
	) {
		if (node.matches(FOCUS_OWNER)) return node;
	}
	return null;
}
