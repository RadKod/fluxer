// SPDX-License-Identifier: AGPL-3.0-or-later

import ActivityViewDock, {type ActivityViewPlacement} from '@app/features/activities/components/ActivityViewDock';
import styles from '@app/features/activities/components/ActivityViewSlot.module.css';
import {clsx} from 'clsx';
import {useLayoutEffect, useState} from 'react';

// A place the activity's View can sit in. It renders nothing of its own: the dock moves the View's element in while
// this is the best place on screen, and out again when it unmounts. Keep it free of React children, which would
// share the element with a node React does not know about.
export function ActivityViewSlot({
	placement,
	className,
}: {
	readonly placement: ActivityViewPlacement;
	readonly className?: string;
}) {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() => (element ? ActivityViewDock.register(element, placement) : undefined), [element, placement]);
	return (
		<div
			ref={setElement}
			className={clsx(styles.slot, className)}
			data-activity-view-slot={placement}
			data-flx="activities.activity-view-slot.slot"
		/>
	);
}
