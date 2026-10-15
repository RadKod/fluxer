// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/name_style/components/NameStyleText.module.css';
import {type GuildRoleColors, resolveNameStyleView} from '@app/features/name_style/NameStyle';
import {requestNameStyleFont} from '@app/features/name_style/NameStyleFontLoader';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {clsx} from 'clsx';
import type React from 'react';
import {forwardRef, useEffect} from 'react';

type NameStyleTextProps = React.HTMLAttributes<HTMLSpanElement> & {
	nameStyle: NameStyle | null | undefined;
	// The roles of the guild the name is drawn in: colours that could pass for one of its coloured roles are not drawn.
	guildRoles?: GuildRoleColors;
	// The surface keeps its own colour (a profile theme the colours cannot be read on); only the font is drawn.
	fontOnly?: boolean;
	'data-flx'?: string;
};

type NameStyleVars = React.CSSProperties & {
	'--name-style-font'?: string;
	'--name-style-1'?: string;
	'--name-style-2'?: string;
};

// One text node, no decorative copies: screen readers read the name once and text-overflow keeps working. It reads no
// store: the light theme and the "Show name styles" setting act through classes on the root element (see the CSS).
export const NameStyleText = forwardRef<HTMLSpanElement, NameStyleTextProps>(
	({nameStyle, guildRoles, fontOnly = false, className, style, children, ...rest}, ref) => {
		const view = nameStyle ? resolveNameStyleView(nameStyle, {fontOnly, guildRoles}) : null;
		const fontKey = view?.fontKey ?? null;
		useEffect(() => {
			requestNameStyleFont(fontKey);
		}, [fontKey]);
		if (!view) {
			return (
				<span ref={ref} className={className} style={style} {...rest}>
					{children}
				</span>
			);
		}
		const vars: NameStyleVars = {
			...style,
			'--name-style-font': view.fontFamily ?? undefined,
			'--name-style-1': view.gradient?.[0] ?? view.solid ?? undefined,
			'--name-style-2': view.gradient?.[1],
		};
		return (
			<span
				ref={ref}
				className={clsx(
					className,
					view.fontFamily && styles.font,
					view.solid && styles.solid,
					view.gradient && styles.gradient,
					view.defaultOnLight && styles.defaultOnLight,
				)}
				style={vars}
				data-name-style={view.fontKey ?? undefined}
				{...rest}
			>
				{children}
			</span>
		);
	},
);
