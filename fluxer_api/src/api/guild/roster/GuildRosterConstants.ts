// SPDX-License-Identifier: AGPL-3.0-or-later

export const ROSTER_ANNOUNCE_MINUTE = 25;
export const ROSTER_CHECK_MINUTE = 35;
export const ROSTER_SLOTS_PER_JOB = 16;
export const ROSTER_SLOT_PAGE = 500;
export const ROSTER_GUILD_CONCURRENCY = 16;
export const ROSTER_STATE_TTL_SECONDS = 7200;
export const ROSTER_RENDER_WINDOW_MS = 2000;
export const ROSTER_MOVES_PER_SECOND = 10;
export const ROSTER_WAITLIST_MAX = 50;
export const ROSTER_CHECK_SUBS = false;
export const ROSTER_JOIN_EMOJI = '✅';
export const ROSTER_BUTTON_IDS = {join: 'roster:join', leave: 'roster:leave'} as const;
export const ROSTER_BOT_INVITE_PERMISSIONS = 17910848n; // VIEW_CHANNEL|SEND_MESSAGES|EMBED_LINKS|READ_MESSAGE_HISTORY|ADD_REACTIONS|CONNECT|MOVE_MEMBERS
export const ROSTER_LAG_WARN_MS = 30_000;
export const ROSTER_EMBED_COLOR_OPEN = 0xf5a623;
export const ROSTER_EMBED_COLOR_CLOSED = 0x4f545c;
export const ROSTER_TEXT = {
	title: (name: string) => `🚀 ${name} İÇİN KATIL`,
	startsAt: (s: number) => `**Etkinlik başlıyor:** <t:${s}:t> · <t:${s}:R>`,
	howTo: `**Katıl** düğmesiyle ya da ${ROSTER_JOIN_EMOJI} tepkisiyle katıl; **Ayrıl** düğmesiyle ya da tepkini geri alarak ayrıl.`,
	joinButton: 'Katıl',
	leaveButton: 'Ayrıl',
	mainHeader: (n: number, max: number) => `🟢 **Ana Kadro (${n}/${max})**`,
	subHeader: (n: number, max: number) => `🔴 **Yedek Kadro (${n}/${max})**`,
	slot: (i: number, userId: string | null) => `\`${i}.\` ${userId ? `<@${userId}>` : '-'}`,
	closed: '**Bu etkinlik artık aktif değil.**',
	closedAt: (s: number) => `⏰ Etkinlik saati: <t:${s}:t>`,
	moveWarning: (name: string, count: number) =>
		`⚠️ **${name}**: ${count} kişi etkinlik odasına taşınamadı; kadroda bırakıldı. Botun rolünü üyelerin rollerinin üstüne taşıyın ve odada "Üyeleri Taşı" izni verin.`,
	targetPermissionsWarning: (name: string, count: number) =>
		`⚠️ **${name}**: ${count} kişi etkinlik odasına taşınamadı; kadroda bırakıldı. Lütfen üyelerin etkinlik odasını görme ve bağlanma izinlerini kontrol edin.`,
	roomDeletedWarning: (name: string, count: number) =>
		`⚠️ **${name}**: Etkinlik odası silinmiş; ${count} kişi kadroda bırakıldı. Etkinlik ayarlarından yeni bir sesli oda seçin.`,
	auditReason: (name: string) => `Micup Roster: ${name}`,
} as const;
