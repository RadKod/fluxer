// SPDX-License-Identifier: AGPL-3.0-or-later

export {MICUPBOT_LIMITS} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';

export const MICUPBOT_BOT_INVITE_PERMISSIONS = 1099780156480n; // ADD_REACTIONS|VIEW_CHANNEL|SEND_MESSAGES|MANAGE_MESSAGES|EMBED_LINKS|READ_MESSAGE_HISTORY|MANAGE_ROLES|MODERATE_MEMBERS
export const MICUPBOT_PREFIX = '#';
export const MICUPBOT_COMMAND_NAMES = [
	'ban',
	'unban',
	'kick',
	'mute',
	'timeout',
	'unmute',
	'warn',
	'warnings',
	'clear',
	'lock',
	'unlock',
	'slowmode',
	'role',
	'nick',
	'move',
	'user',
	'server',
	'avatar',
	'rank',
	'top',
	'help',
] as const;
export const MICUPBOT_HEAVY_COMMANDS = ['ban', 'kick', 'clear', 'lock', 'unlock', 'slowmode'] as const;
export const MICUPBOT_XP_COOLDOWN_SECONDS = 60;
export const MICUPBOT_MESSAGE_XP = {min: 15, max: 25} as const;
export const MICUPBOT_VOICE = {
	xpPerTurn: 10,
	turnMs: 300_000,
	dailyTurns: 144,
	minListeners: 2,
	slotsPerJob: 16,
	slotPage: 500,
	guildConcurrency: 16,
} as const;
export const MICUPBOT_XP_FLUSH_SLICES = 16;
export const MICUPBOT_XP_FLUSH_BUDGET_MS = 45_000;
export const MICUPBOT_SETTINGS_CACHE = {ttlMs: 30_000, maxEntries: 50_000, sharedTtlSeconds: 300} as const;
export const MICUPBOT_HOOK_INFLIGHT_MAX = 1000;
export const MICUPBOT_LIVE_LAG_WARN_MS = 5000;
export const MICUPBOT_SPAM_WINDOW_MS = 5000;
export const MICUPBOT_AUTOMOD_CIRCUIT = {limit: 60, windowMs: 60_000, pauseSeconds: 600} as const;
export const MICUPBOT_RATES = {
	commandUser: [5, 10_000],
	commandGuild: [30, 10_000],
	commandHeavy: [10, 60_000],
	welcome: [10, 1000],
	reactionRole: [10, 10_000],
} as const;
export const MICUPBOT_MODULE_TOGGLE_COOLDOWN_SECONDS = 60;
export const MICUPBOT_EMBED_COLOR = 0x8b5cf6;
export const MICUPBOT_TEXT = {
	defaultWelcome: 'Hoş geldin {user}! **{server}** topluluğuna katıldın.',
	defaultGoodbye: '**{user.name}** aramızdan ayrıldı.',
	defaultLevelUp: '🎉 Tebrikler {user}, **{level}**. seviyeye ulaştın!',
	noPermission: '❌ Bu komut için yetkin yok.',
	mfaRequired: '❌ Bu toplulukta moderasyon için iki adımlı doğrulama gerekli.',
	userNotFound: '❌ Kullanıcı bulunamadı.',
	roleNotFound: '❌ Rol bulunamadı.',
	channelNotFound: '❌ Kanal bulunamadı.',
	failed: '❌ Komut çalıştırılamadı.',
	usage: (usage: string) => `Kullanım: \`${usage}\``,
	banned: (name: string) => `✅ **${name}** yasaklandı.`,
	unbanned: (id: string) => `✅ \`${id}\` kimlikli kullanıcının yasağı kaldırıldı.`,
	kicked: (name: string) => `✅ **${name}** topluluktan atıldı.`,
	muted: (name: string, duration: string) => `🔇 **${name}** ${duration} susturuldu.`,
	unmuted: (name: string) => `🔊 **${name}** artık konuşabilir.`,
	warned: (name: string, count: number) => `⚠️ **${name}** uyarıldı. Toplam uyarı: ${count}.`,
	warningsFull: '❌ Bu üyenin uyarı sınırı (100) doldu; eskileri ayarlardan silin.',
	warningsTitle: (name: string) => `⚠️ ${name} — uyarılar`,
	noWarnings: (name: string) => `**${name}** için uyarı yok.`,
	cleared: (count: number) => `🧹 ${count} mesaj silindi.`,
	locked: '🔒 Kanal kilitlendi.',
	unlocked: '🔓 Kanalın kilidi açıldı.',
	slowmodeOn: (seconds: number) => `🐢 Yavaş mod: ${seconds} saniye.`,
	slowmodeOff: '🐢 Yavaş mod kapatıldı.',
	roleAdded: (role: string, name: string) => `✅ **${name}** üyesine **${role}** rolü verildi.`,
	roleRemoved: (role: string, name: string) => `✅ **${name}** üyesinden **${role}** rolü alındı.`,
	nickChanged: (name: string) => `✏️ **${name}** takma adı değiştirildi.`,
	nickReset: (name: string) => `✏️ **${name}** takma adı sıfırlandı.`,
	moved: (name: string, channel: string) => `🔀 **${name}** <#${channel}> kanalına taşındı.`,
	levelsOff: '❌ Bu toplulukta seviye sistemi kapalı.',
	rank: (name: string, level: number, current: number, next: number, rank: number | null) =>
		`📊 **${name}** — Seviye ${level} · ${current}/${next} XP · Sıra: ${rank ?? '1000+'}`,
	topTitle: '🏆 Sıralama — ilk 10',
	topEmpty: 'Henüz sıralamada kimse yok.',
	helpTitle: 'Komutlar',
	helpLines: [
		'`#ban @üye [süre] [sebep]` — yasakla',
		'`#unban id` — yasağı kaldır',
		'`#kick @üye [sebep]` — topluluktan at',
		'`#mute @üye <süre> [sebep]` — sustur',
		'`#timeout @üye <süre> [sebep]` — sustur',
		'`#unmute @üye` — susturmayı kaldır',
		'`#warn @üye <sebep>` — uyar',
		'`#warnings @üye` — uyarıları göster',
		'`#clear <1-100> [@üye]` — mesaj sil',
		'`#lock [#kanal]` — kanalı kilitle',
		'`#unlock [#kanal]` — kanalın kilidini aç',
		'`#slowmode <saniye|kapat|off|0> [#kanal]` — yavaş modu ayarla',
		'`#role @üye <@rol|id|ad>` — rolü aç veya kapat',
		'`#nick @üye [yeni ad]` — takma adı değiştir',
		'`#move @üye <#ses|id>` — ses kanalına taşı',
		'`#user [@üye]` — kullanıcı bilgisi',
		'`#server` — topluluk bilgisi',
		'`#avatar [@üye]` — avatarı göster',
		'`#rank [@üye]` — seviyeyi göster',
		'`#top` — sıralamayı göster',
		'`#help` — komutları göster',
	],
	userFields: ['Hesap oluşturma', 'Katılma', 'Roller'],
	serverFields: ['Sahip', 'Üye sayısı', 'Oluşturma', 'Kanallar'],
	automodReason: {
		spam: 'çok hızlı mesaj gönderiyorsun',
		invites: 'davet bağlantısı paylaşamazsın',
		links: 'bu bağlantıya izin verilmiyor',
		words: 'yasaklı bir sözcük kullandın',
		mentions: 'çok fazla kişiyi andın',
		caps: 'çok fazla büyük harf kullandın',
	},
	automodWarning: (userId: string, reason: string) => `⚠️ <@${userId}>, ${reason}.`,
	automodPaused: "⚠️ Otomoderasyon 10 dakika durduruldu: dakikada 60'tan fazla işlem yapıldı.",
	audit: {
		autorole: 'Otomatik rol',
		reactionRole: 'Tepki rolü',
		levelReward: 'Seviye ödülü',
		automod: (rule: string) => `Otomod: ${rule}`,
		command: (name: string) => `#${name} komutu`,
	},
	duration: (seconds: number): string => {
		for (const [size, label] of [
			[86400, 'gün'],
			[3600, 'saat'],
			[60, 'dakika'],
		] as const)
			if (seconds >= size) return `${Math.floor(seconds / size)} ${label}`;
		return `${seconds} saniye`;
	},
} as const;
