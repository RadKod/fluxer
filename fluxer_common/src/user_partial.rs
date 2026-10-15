// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::user_flags::{USER_FLAG_STAFF, public_user_flags};
use serde::{Deserialize, Serialize};

pub const FLUXER_SYSTEM_USER_ID: i64 = 0;
pub const FLUXER_SYSTEM_USERNAME: &str = "sanalyer";
pub const FLUXER_SYSTEM_DISCRIMINATOR: i32 = 0;

/// Micup: a worn cosmetic, the catalog item and the image hash copied onto the user row when it was put on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiCosmeticAssetData {
    pub asset: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiUserPartial {
    pub id: String,
    pub username: String,
    pub discriminator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_version: Option<String>,
    pub global_name: Option<String>,
    pub avatar: Option<String>,
    pub avatar_color: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<bool>,
    pub flags: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_flags: Option<i32>,
    // Micup: always serialized, as null when nothing is worn: the client keeps a field a payload leaves out and the
    // gateway compares these, so they must match the API's own partial user field for field.
    pub avatar_decoration_data: Option<ApiCosmeticAssetData>,
    pub avatar_ultra_data: Option<ApiCosmeticAssetData>,
    pub nameplate_data: Option<ApiCosmeticAssetData>,
}

pub struct UserPartialFields {
    pub user_id: i64,
    pub username: String,
    pub discriminator: i32,
    pub identity_version: Option<i64>,
    pub global_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub avatar_color: Option<i32>,
    pub bot: Option<bool>,
    pub system: Option<bool>,
    pub flags: Option<i64>,
    pub premium_type: Option<i32>,
    pub premium_flags: Option<i32>,
    pub mention_flags: Option<i32>,
    pub avatar_decoration_id: Option<i64>,
    pub avatar_decoration_asset: Option<String>,
    pub avatar_ultra_id: Option<i64>,
    pub avatar_ultra_asset: Option<String>,
    pub nameplate_id: Option<i64>,
    pub nameplate_asset: Option<String>,
}

impl From<UserPartialFields> for ApiUserPartial {
    fn from(partial: UserPartialFields) -> Self {
        if partial.user_id == FLUXER_SYSTEM_USER_ID {
            return fluxer_system_user();
        }
        Self {
            id: partial.user_id.to_string(),
            username: partial.username,
            discriminator: format!("{:04}", partial.discriminator),
            identity_version: partial.identity_version.map(|version| version.to_string()),
            global_name: partial.global_name,
            avatar: partial.avatar_hash,
            avatar_color: partial.avatar_color,
            bot: partial.bot.filter(|bot| *bot),
            system: partial.system.filter(|system| *system),
            flags: public_user_flags(
                partial.flags.unwrap_or_default(),
                partial.bot.unwrap_or_default(),
                partial.premium_type,
                partial.premium_flags,
            ),
            mention_flags: partial.mention_flags.filter(|flags| *flags != 0),
            avatar_decoration_data: cosmetic_asset_data(
                partial.avatar_decoration_id,
                partial.avatar_decoration_asset,
            ),
            avatar_ultra_data: cosmetic_asset_data(
                partial.avatar_ultra_id,
                partial.avatar_ultra_asset,
            ),
            nameplate_data: cosmetic_asset_data(partial.nameplate_id, partial.nameplate_asset),
        }
    }
}

// Micup: an item id without its image is not worn.
fn cosmetic_asset_data(
    item_id: Option<i64>,
    asset: Option<String>,
) -> Option<ApiCosmeticAssetData> {
    Some(ApiCosmeticAssetData {
        asset: asset?,
        item_id: item_id?.to_string(),
    })
}

pub fn fluxer_system_user() -> ApiUserPartial {
    ApiUserPartial {
        id: FLUXER_SYSTEM_USER_ID.to_string(),
        username: FLUXER_SYSTEM_USERNAME.to_owned(),
        discriminator: format!("{:04}", FLUXER_SYSTEM_DISCRIMINATOR),
        identity_version: None,
        global_name: None,
        avatar: None,
        avatar_color: None,
        bot: Some(true),
        system: Some(true),
        flags: USER_FLAG_STAFF as i32,
        mention_flags: None,
        avatar_decoration_data: None,
        avatar_ultra_data: None,
        nameplate_data: None,
    }
}
