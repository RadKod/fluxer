// SPDX-License-Identifier: AGPL-3.0-or-later

import Emoji from '@app/features/emoji/state/Emoji';
import type {GuildEmoji} from '@app/features/expressions/models/GuildEmoji';
import {buildCustomEmojiURL} from '@app/features/expressions/utils/CustomEmojiImageUrl';
import styles from '@app/features/guild/components/RoleAppearance.module.css';
import type {GuildRole} from '@app/features/guild/models/GuildRole';
import type {GuildMember} from '@app/features/member/models/GuildMember';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import {int2hex} from '@app/features/theme/utils/ColorUtils';
import {roleColorOnDark} from '@fluxer/constants/src/ColorContrast';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, type ReactNode, useSyncExternalStore} from 'react';

const EMPTY_ROLE_EMOJIS: ReadonlyArray<GuildEmoji> = Object.freeze([]);
const emojiUpdateListeners = new Set<() => void>();
let unsubscribeEmojiUpdates: (() => void) | null = null;

function subscribeRoleEmojiUpdates(listener: () => void): () => void {
	emojiUpdateListeners.add(listener);
	if (emojiUpdateListeners.size === 1) {
		unsubscribeEmojiUpdates = ComponentBus.subscribe('EMOJI_PICKER_RERENDER', () => {
			for (const notify of emojiUpdateListeners) notify();
		});
	}
	return () => {
		emojiUpdateListeners.delete(listener);
		if (emojiUpdateListeners.size === 0) {
			unsubscribeEmojiUpdates?.();
			unsubscribeEmojiUpdates = null;
		}
	};
}

const subscribeWithoutEmojiUpdates = () => () => {};

export function useGuildRoleEmojis(guildId: string | undefined): ReadonlyArray<GuildEmoji> {
	const getSnapshot = () => {
		const emojis = guildId ? Emoji.getGuildEmoji(guildId) : EMPTY_ROLE_EMOJIS;
		return emojis.length > 0 ? emojis : EMPTY_ROLE_EMOJIS;
	};
	return useSyncExternalStore(
		guildId ? subscribeRoleEmojiUpdates : subscribeWithoutEmojiUpdates,
		getSnapshot,
		getSnapshot,
	);
}

export const RoleIcon = observer(({role}: {role?: GuildRole | null}) => {
	const iconEmojiId = role?.iconEmojiId;
	const getSnapshot = () => (iconEmojiId ? Emoji.getEmojiById(iconEmojiId) : undefined);
	const emoji = useSyncExternalStore(
		iconEmojiId ? subscribeRoleEmojiUpdates : subscribeWithoutEmojiUpdates,
		getSnapshot,
		getSnapshot,
	);
	if (role && iconEmojiId) {
		if (!emoji || emoji.guildId !== role.guildId) return null;
		return (
			<img
				className={styles.icon}
				src={buildCustomEmojiURL({id: iconEmojiId, animated: false})}
				alt=""
				aria-hidden="true"
				draggable={false}
			/>
		);
	}
	return role?.unicodeEmoji ? (
		<span className={styles.icon} aria-hidden="true">
			{role.unicodeEmoji}
		</span>
	) : null;
});

// sanalyer: the colour a role name is drawn in on the dark themes when its stored colour fails the contrast floor
// there (a CSS rule on html.theme-dark/coal/dark_legacy picks it, so a theme switch re-renders nothing). Stored role
// colours are never changed.
const onDarkCache = new Map<number, string | undefined>();

export function roleColorOnDarkHex(color: string | undefined): string | undefined {
	const match = color ? /^#([0-9a-f]{6})$/i.exec(color) : null;
	if (!match) return undefined;
	const value = Number.parseInt(match[1]!, 16);
	if (onDarkCache.has(value)) return onDarkCache.get(value);
	const lifted = roleColorOnDark(value);
	const hex = lifted === value ? undefined : int2hex(lifted);
	if (onDarkCache.size >= 512) onDarkCache.clear();
	onDarkCache.set(value, hex);
	return hex;
}

export const RoleAppearance = observer(
	({member, colorOverride, children}: {member?: GuildMember; colorOverride?: string; children: ReactNode}) => {
		const colorRole = member?.getColorRole();
		const color = colorOverride || (colorRole ? int2hex(colorRole.color) : undefined);
		const secondary =
			!colorOverride && colorRole?.colorSecondary != null ? int2hex(colorRole.colorSecondary) : undefined;
		const style = {
			'--role-color': color,
			'--role-color-secondary': secondary,
			'--role-color-on-dark': roleColorOnDarkHex(color),
			'--role-color-secondary-on-dark': roleColorOnDarkHex(secondary),
		} as CSSProperties;
		return (
			<>
				<span className={clsx(color && styles.colored, secondary && styles.gradient)} style={style}>
					{children}
				</span>
				<RoleIcon role={member?.getIconRole()} />
			</>
		);
	},
);
