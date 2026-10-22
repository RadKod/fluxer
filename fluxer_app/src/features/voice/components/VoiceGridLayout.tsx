// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/voice/components/VoiceGridLayout.module.css';
import {
	getVoiceGridRowStyle,
	resolveVoiceGridPackedLayoutMetrics,
	type VoiceGridRowStyle,
} from '@app/features/voice/components/VoiceGridLayoutMetrics';
import type {VoiceGridEntry} from '@app/features/voice/components/VoiceParticipantConsolidation';
import {VoiceTileGroupContext} from '@app/features/voice/components/VoiceTileGroupContext';
import {ParticipantContext, TrackRefContext} from '@livekit/components-react';
import {clsx} from 'clsx';
import type React from 'react';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

interface VoiceGridLayoutProps {
	entries: Array<VoiceGridEntry>;
	children: React.ReactElement;
	// A tile that is not a participant (the running voice activity), placed first and counted like the others.
	leadingTile?: React.ReactNode;
	edgeToEdge?: boolean;
	compact?: boolean;
	onCapacityChange?: (info: {visibleTileCount: number; totalTileCount: number; overflow: boolean}) => void;
	onExpandUser: (userId: string) => void;
}

type GridStyle = React.CSSProperties &
	VoiceGridRowStyle & {
		'--voice-grid-columns'?: string;
		'--voice-grid-rows'?: string;
	};

interface VoiceGridViewportSize {
	width: number;
	height: number;
}

function roundViewportSize(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

function readResizeObserverSize(entry: ResizeObserverEntry): VoiceGridViewportSize {
	return {
		width: roundViewportSize(entry.contentRect.width),
		height: roundViewportSize(entry.contentRect.height),
	};
}

function readElementSize(element: HTMLElement): VoiceGridViewportSize {
	return {
		width: roundViewportSize(element.clientWidth),
		height: roundViewportSize(element.clientHeight),
	};
}

export function VoiceGridLayout({
	entries,
	children,
	leadingTile,
	edgeToEdge = false,
	compact = false,
	onCapacityChange,
	onExpandUser,
}: VoiceGridLayoutProps) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const [viewportSize, setViewportSize] = useState<VoiceGridViewportSize | null>(null);
	useLayoutEffect(() => {
		const viewportNode = viewportRef.current;
		if (!viewportNode) return;
		const ownerWindow = viewportNode.ownerDocument.defaultView ?? window;
		const commitSize = (nextSize: VoiceGridViewportSize) => {
			setViewportSize((previousSize) => {
				if (previousSize?.width === nextSize.width && previousSize.height === nextSize.height) return previousSize;
				return nextSize;
			});
		};
		commitSize(readElementSize(viewportNode));
		if (typeof ownerWindow.ResizeObserver === 'undefined') {
			const handleResize = () => commitSize(readElementSize(viewportNode));
			ownerWindow.addEventListener('resize', handleResize);
			return () => ownerWindow.removeEventListener('resize', handleResize);
		}
		const resizeObserver = new ownerWindow.ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			commitSize(readResizeObserverSize(entry));
		});
		resizeObserver.observe(viewportNode);
		return () => resizeObserver.disconnect();
	}, []);
	const leadingTileCount = leadingTile ? 1 : 0;
	const totalTileCount = entries.length + leadingTileCount;
	const packedMetrics = useMemo(() => {
		if (!viewportSize) return totalTileCount;
		if (viewportSize.width === 0 || viewportSize.height === 0) return totalTileCount;
		return resolveVoiceGridPackedLayoutMetrics({
			tileCount: totalTileCount,
			containerWidth: viewportSize.width,
			containerHeight: viewportSize.height,
			compact,
			edgeToEdge,
		});
	}, [compact, edgeToEdge, totalTileCount, viewportSize]);
	const visibleTileCount = typeof packedMetrics === 'number' ? packedMetrics : packedMetrics.visibleTileCount;
	const visibleEntries = useMemo(
		() => entries.slice(0, Math.max(0, visibleTileCount - leadingTileCount)),
		[entries, leadingTileCount, visibleTileCount],
	);
	const visibleCount = visibleEntries.length + leadingTileCount;
	const hiddenTileCount = Math.max(0, totalTileCount - visibleCount);
	useEffect(() => {
		if (!onCapacityChange) return;
		onCapacityChange({
			visibleTileCount,
			totalTileCount,
			overflow: hiddenTileCount > 0,
		});
	}, [hiddenTileCount, onCapacityChange, totalTileCount, visibleTileCount]);
	const gridStyle = useMemo<GridStyle>(() => {
		const rowStyle = getVoiceGridRowStyle(visibleCount);
		if (typeof packedMetrics === 'number') return rowStyle;
		return {
			...rowStyle,
			'--voice-grid-columns': `${packedMetrics.columns}`,
			'--voice-grid-rows': `${packedMetrics.rows}`,
		};
	}, [packedMetrics, visibleCount]);
	return (
		<div
			ref={viewportRef}
			className={clsx(styles.gridViewport, compact && styles.gridViewportCompact)}
			data-edge-to-edge={edgeToEdge ? 'true' : undefined}
			data-flx="voice.voice-grid-layout.grid-viewport"
		>
			<div
				className={styles.grid}
				data-tile-count={visibleCount}
				data-total-tile-count={totalTileCount}
				data-hidden-tile-count={hiddenTileCount > 0 ? hiddenTileCount : undefined}
				style={gridStyle}
				data-flx="voice.voice-grid-layout.grid"
			>
				{leadingTile && (
					<div className={styles.gridItem} data-flx="voice.voice-grid-layout.grid-item--leading">
						{leadingTile}
					</div>
				)}
				{visibleEntries.map((entry) => {
					const groupValue = {
						hiddenConnectionCount: entry.hiddenConnectionCount,
						deviceConnectionCount: entry.deviceConnectionCount,
						isExpanded: entry.isDeviceGroupExpanded,
						isPrimary: Boolean(entry.isDeviceGroupPrimary),
						userId: entry.userId,
						onExpand: () => {
							if (entry.userId) onExpandUser(entry.userId);
						},
					};
					return (
						<div key={entry.key} className={styles.gridItem} data-flx="voice.voice-grid-layout.grid-item">
							<TrackRefContext.Provider value={entry.trackRef}>
								<ParticipantContext.Provider value={entry.trackRef.participant}>
									<VoiceTileGroupContext.Provider value={groupValue}>{children}</VoiceTileGroupContext.Provider>
								</ParticipantContext.Provider>
							</TrackRefContext.Provider>
						</div>
					);
				})}
			</div>
		</div>
	);
}
