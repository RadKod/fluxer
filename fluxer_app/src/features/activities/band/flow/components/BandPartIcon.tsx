// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';

// Line icons drawn for the band game; the icon set has no drum kit and only one guitar shape.
const PART_PATHS: Readonly<Record<BandPart, ReadonlyArray<string>>> = {
	guitar: [
		'M13.2 10.8L20 4M18.6 2.6l2.8 2.8',
		'M10.6 9.2c-1.4-.6-3-.1-3.8 1.1-.5.8-1.4 1.1-2.3 1.4-1.7.6-2.4 2.4-1.8 4.2.7 2 2.6 3.9 4.6 4.6 1.8.6 3.6-.1 4.2-1.8.3-.9.6-1.8 1.4-2.3 1.2-.8 1.7-2.4 1.1-3.8',
		'M8.2 15.8l2-2',
	],
	bass: [
		'M12.6 11.4L21.5 2.5',
		'M19.6 1.8l2.6 2.6M18 3.4l2.6 2.6',
		'M10 10c-1.3-.5-2.8 0-3.5 1.1-.4.7-1.2 1-2 1.3-1.6.6-2.2 2.2-1.6 3.9.6 1.8 2.4 3.6 4.2 4.2 1.7.6 3.3 0 3.9-1.6.3-.8.6-1.6 1.3-2 1.1-.7 1.6-2.2 1.1-3.5',
		'M7.6 16.4l2-2',
	],
	drums: [
		'M4 10.5a8 3 0 1 0 16 0a8 3 0 1 0-16 0',
		'M4 10.5v5.5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5.5',
		'M7 2.8l4 6.2M17 2.8l-4 6.2',
	],
	keys: ['M3 5.5h18v13H3z', 'M8 5.5v13M13 5.5v13M18 5.5v13', 'M6.5 5.5v7.5M11 5.5v7.5M15.5 5.5v7.5'],
	vocals: [
		'M10.5 8.5a5 5 0 1 0 10 0a5 5 0 1 0-10 0',
		'M12.4 12.4l-7.6 8a1.3 1.3 0 0 1-1.8-1.8l8-7.6',
		'M12.3 5.3l6.4 6.4',
	],
};

export function BandPartIcon({part, className}: {readonly part: BandPart; readonly className?: string}) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			data-flx="activities.band.flow.band-part-icon.svg"
		>
			{PART_PATHS[part].map((path) => (
				<path key={path} d={path} data-flx="activities.band.flow.band-part-icon.path" />
			))}
		</svg>
	);
}
