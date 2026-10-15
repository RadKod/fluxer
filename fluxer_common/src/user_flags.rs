pub const USER_FLAG_STAFF: i64 = 1 << 0;
pub const USER_FLAG_PARTNER: i64 = 1 << 2;
const USER_FLAG_BUG_HUNTER: i64 = 1 << 3;
const USER_FLAG_FRIENDLY_BOT: i64 = 1 << 4;
const USER_FLAG_FRIENDLY_BOT_MANUAL_APPROVAL: i64 = 1 << 5;
const USER_FLAG_SPAMMER: i64 = 1 << 6;
pub const USER_FLAG_VERIFIED: i64 = 1 << 29;
pub const USER_FLAG_PROFILE_HIDDEN: i64 = 1 << 7;
const USER_FLAG_DISABLED: i64 = 1 << 38;
pub const USER_FLAG_STAFF_HIDDEN: i64 = 1 << 57;
pub const USER_FLAG_DELETED: i64 = 1 << 34;
// Micup: the old flags bit that UserConstants.ts LEGACY_PREMIUM_FLAG_BITS_TO_NEW maps to PremiumFlags.BADGE_HIDDEN.
const LEGACY_USER_FLAG_PREMIUM_BADGE_HIDDEN: i64 = 1 << 40;
const PREMIUM_FLAG_BADGE_HIDDEN: i32 = 1 << 1;
const PREMIUM_FLAG_PERKS_DISABLED: i32 = 1 << 8;
// Micup: derived on every read and never stored, so it stays out of PUBLIC_USER_FLAGS.
pub const PUBLIC_USER_FLAG_PREMIUM_BADGE: i32 = 1 << 30;
const PUBLIC_USER_FLAGS: i64 = USER_FLAG_STAFF
    | USER_FLAG_PARTNER
    | USER_FLAG_BUG_HUNTER
    | USER_FLAG_FRIENDLY_BOT
    | USER_FLAG_FRIENDLY_BOT_MANUAL_APPROVAL
    | USER_FLAG_SPAMMER
    | USER_FLAG_VERIFIED;
const PUBLIC_USER_FLAGS_WITHOUT_STAFF: i64 = PUBLIC_USER_FLAGS & !USER_FLAG_STAFF;
const NON_ENFORCEMENT_DELETION_REASONS: [i32; 3] = [1, 2, 19];

pub fn visible_user_flags(flags: i64) -> i32 {
    let visible_flags = if (flags & USER_FLAG_STAFF_HIDDEN) != 0 {
        PUBLIC_USER_FLAGS_WITHOUT_STAFF
    } else {
        PUBLIC_USER_FLAGS
    };
    (flags & visible_flags) as i32
}

/// Micup: the flags a partial user shows everyone. On top of the visible stored bits, PREMIUM_BADGE is on for a
/// premium account (any premium_type above 0, trial included) that is not a bot, not deleted, has not hidden the
/// badge and has not disabled its premium perks (PERKS_DISABLED). It reads no clock and no viewer. The API's twin is
/// `mapUserFlagsToPublicBitfield` in `fluxer_api/src/api/user/UserMappers.ts`;
/// `testdata/premium_badge_flag_vectors.json` pins both.
pub fn public_user_flags(
    flags: i64,
    bot: bool,
    premium_type: Option<i32>,
    premium_flags: Option<i32>,
) -> i32 {
    let badge_hidden = (premium_flags.unwrap_or_default() & PREMIUM_FLAG_BADGE_HIDDEN) != 0
        || (flags & LEGACY_USER_FLAG_PREMIUM_BADGE_HIDDEN) != 0;
    if !badge_hidden && premium_perks_visible(flags, bot, premium_type, premium_flags) {
        visible_user_flags(flags) | PUBLIC_USER_FLAG_PREMIUM_BADGE
    } else {
        visible_user_flags(flags)
    }
}

/// Micup: whether others see a premium account's Plus perks (the badge, unless hidden, and the Plus appearance): any
/// premium_type above 0, not a bot, not deleted, PERKS_DISABLED off. Stored perk data is never cleared when premium
/// ends; reads hide it. `testdata/plus_appearance_vectors.json` pins the appearance side against the API.
pub fn premium_perks_visible(
    flags: i64,
    bot: bool,
    premium_type: Option<i32>,
    premium_flags: Option<i32>,
) -> bool {
    !bot && (flags & USER_FLAG_DELETED) == 0
        && premium_type.unwrap_or_default() > 0
        && (premium_flags.unwrap_or_default() & PREMIUM_FLAG_PERKS_DISABLED) == 0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccountStanding {
    pub flags: i64,
    pub temp_banned_until_ms: Option<i64>,
    pub pending_deletion_at_ms: Option<i64>,
    pub deletion_reason_code: Option<i32>,
}

impl AccountStanding {
    pub fn deleted_for_display(&self) -> bool {
        self.flags & USER_FLAG_DELETED != 0 && self.pending_deletion_at_ms.is_none()
    }

    pub fn profile_hidden(&self, now_ms: i64) -> bool {
        let banned = self.flags & USER_FLAG_DISABLED != 0
            && self
                .temp_banned_until_ms
                .is_some_and(|until| until > now_ms);
        let deleting = self.pending_deletion_at_ms.is_some()
            && self
                .deletion_reason_code
                .is_some_and(|code| !NON_ENFORCEMENT_DELETION_REASONS.contains(&code));
        !self.deleted_for_display()
            && (self.flags & (USER_FLAG_PROFILE_HIDDEN | USER_FLAG_SPAMMER) != 0
                || banned
                || deleting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_is_bit_29_and_public() {
        assert_eq!(USER_FLAG_VERIFIED, 1 << 29);
        assert_eq!(visible_user_flags(USER_FLAG_VERIFIED), 1 << 29);
    }

    #[test]
    fn staff_hidden_keeps_verified() {
        let flags =
            USER_FLAG_STAFF | USER_FLAG_STAFF_HIDDEN | USER_FLAG_VERIFIED | USER_FLAG_SPAMMER;
        assert_eq!(
            visible_user_flags(flags),
            (USER_FLAG_VERIFIED | USER_FLAG_SPAMMER) as i32
        );
    }

    const STORED_USER_FLAGS: [i64; 8] = [
        USER_FLAG_STAFF,
        USER_FLAG_PARTNER,
        USER_FLAG_BUG_HUNTER,
        USER_FLAG_FRIENDLY_BOT,
        USER_FLAG_FRIENDLY_BOT_MANUAL_APPROVAL,
        USER_FLAG_SPAMMER,
        USER_FLAG_VERIFIED,
        USER_FLAG_STAFF_HIDDEN,
    ];

    // packages/constants/src/UserConstants.test.ts pins the same public bits; change both together.
    #[test]
    fn flags_are_distinct_bits_and_public_mask_matches() {
        let mut seen: i64 = 0;
        for flag in STORED_USER_FLAGS {
            assert_eq!(flag.count_ones(), 1);
            assert_eq!(seen & flag, 0);
            seen |= flag;
        }
        let expected = [0, 2, 3, 4, 5, 6, 29]
            .iter()
            .fold(0i64, |mask, bit| mask | (1i64 << bit));
        assert_eq!(PUBLIC_USER_FLAGS, expected);
    }

    // Micup: packages/constants/src/UserConstants.test.ts pins the same bit for PublicUserFlags.PREMIUM_BADGE.
    #[test]
    fn premium_badge_is_bit_30_outside_the_stored_masks() {
        let bit = PUBLIC_USER_FLAG_PREMIUM_BADGE;
        assert_eq!(bit, 1 << 30);
        assert!(bit > 0);
        assert_eq!(i64::from(bit) & PUBLIC_USER_FLAGS, 0);
        for stored in STORED_USER_FLAGS
            .into_iter()
            .chain([USER_FLAG_DELETED, LEGACY_USER_FLAG_PREMIUM_BADGE_HIDDEN])
        {
            assert_eq!(i64::from(bit) & stored, 0);
        }
    }

    // Micup: the API's mapUserFlagsToPublicBitfield reads the same vectors (PremiumBadgeFlag.test.ts), so the TS and
    // Rust partial users agree on the premium badge bit.
    #[test]
    fn premium_badge_vectors_match_the_rule() {
        let raw = include_str!("testdata/premium_badge_flag_vectors.json");
        let vectors: serde_json::Value = serde_json::from_str(raw).expect("vectors parse as json");
        let vectors = vectors.as_array().expect("vectors are an array");
        assert!(!vectors.is_empty());
        for vector in vectors {
            let row = &vector["row"];
            let int = |field: &str| row[field].as_i64().map(|value| value as i32);
            let flags = public_user_flags(
                row["flags"].as_i64().expect("vector carries flags"),
                row["bot"].as_bool().expect("vector carries bot"),
                int("premium_type"),
                int("premium_flags"),
            );
            assert_eq!(
                Some(i64::from(flags)),
                vector["public_flags"].as_i64(),
                "{}",
                vector["name"]
            );
        }
    }

    const NOW: i64 = 1_790_000_000_000;

    fn standing(flags: i64) -> AccountStanding {
        AccountStanding {
            flags,
            ..AccountStanding::default()
        }
    }

    #[test]
    fn profile_hidden_follows_enforcement_state() {
        assert!(!standing(0).profile_hidden(NOW));
        assert!(standing(USER_FLAG_PROFILE_HIDDEN).profile_hidden(NOW));
        assert!(standing(USER_FLAG_SPAMMER).profile_hidden(NOW));
        assert!(!standing(USER_FLAG_DISABLED).profile_hidden(NOW));
        let banned = AccountStanding {
            temp_banned_until_ms: Some(NOW + 1),
            ..standing(USER_FLAG_DISABLED)
        };
        assert!(banned.profile_hidden(NOW));
        assert!(!banned.profile_hidden(NOW + 1));
        let deleting = |code| AccountStanding {
            pending_deletion_at_ms: Some(NOW),
            deletion_reason_code: Some(code),
            ..standing(USER_FLAG_DELETED)
        };
        assert!(deleting(3).profile_hidden(NOW));
        assert!(deleting(20).profile_hidden(NOW));
        for code in NON_ENFORCEMENT_DELETION_REASONS {
            assert!(!deleting(code).profile_hidden(NOW), "{code}");
        }
        assert!(!standing(USER_FLAG_DELETED | USER_FLAG_SPAMMER).profile_hidden(NOW));
    }

    #[test]
    fn the_hidden_bit_is_never_public() {
        assert_eq!(
            visible_user_flags(USER_FLAG_PROFILE_HIDDEN | USER_FLAG_DISABLED | USER_FLAG_PARTNER),
            USER_FLAG_PARTNER as i32
        );
    }
}
