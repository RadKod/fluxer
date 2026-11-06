// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::app_attest::{AgeFloor, AppAttestRejection, ChallengePurpose};
use crate::play_integrity::PlayIntegrityRejection;
use crate::pseudonym::pseudonym;
use fluxer_common::user_flags::AccountStanding;
#[cfg(test)]
use fluxer_common::user_flags::{USER_FLAG_STAFF, USER_FLAG_VERIFIED};
pub use fluxer_common::user_partial::ApiUserPartial;
use fluxer_common::user_partial::{
    FLUXER_SYSTEM_USER_ID, UserPartialFields, default_instance_name,
};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum UserRequest {
    GetPartialsByIds {
        user_ids: Vec<i64>,
        #[serde(default = "default_instance_name")]
        instance_name: String,
    },
    GetApiPartialsByIds {
        user_ids: Vec<String>,
        #[serde(default = "default_instance_name")]
        instance_name: String,
    },
    Invalidate {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
    },
    AppAttestCreateChallenge {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
        purpose: ChallengePurpose,
    },
    AppAttestRegisterKey {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
        key_id: String,
        attestation_base64: String,
        challenge: String,
    },
    AppAttestSubmitAge {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
        key_id: String,
        assertion_base64: String,
        client_data_base64: String,
    },
    PlayIntegrityCreateChallenge {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
    },
    PlayIntegritySubmitAge {
        #[serde(deserialize_with = "deserialize_i64_from_number_or_string")]
        user_id: i64,
        package_name: String,
        integrity_token: String,
        client_data_base64: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
pub enum UserResponse {
    FoundPartials(Vec<UserPartial>),
    FoundApiPartials(Vec<ApiUserPartial>),
    Invalidated,
    AppAttestChallenge {
        challenge: String,
        expires_at: String,
    },
    AppAttestKeyRegistered,
    AppAttestAgeAccepted {
        age_floor: AgeFloor,
        attested_at: String,
    },
    AppAttestRejected {
        code: AppAttestRejection,
    },
    PlayIntegrityRejected {
        code: PlayIntegrityRejection,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPartial {
    pub user_id: i64,
    pub username: String,
    pub discriminator: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_version: Option<i64>,
    pub global_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub bot: Option<bool>,
    pub system: Option<bool>,
    pub flags: Option<i64>,
    pub premium_type: Option<i32>,
    pub premium_flags: Option<i32>,
    pub banner_hash: Option<String>,
    pub banner_color: Option<i32>,
    pub accent_color: Option<i32>,
    pub avatar_color: Option<i32>,
    pub mention_flags: Option<i32>,
    pub avatar_decoration_id: Option<i64>,
    pub avatar_decoration_asset: Option<String>,
    pub avatar_ultra_id: Option<i64>,
    pub avatar_ultra_asset: Option<String>,
    pub nameplate_id: Option<i64>,
    pub nameplate_asset: Option<String>,
    pub name_font: Option<i32>,
    pub name_color: Option<i32>,
    pub name_color_2: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hidden_since: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_profile_badges: Vec<String>,
}

impl UserPartial {
    pub fn visible_to_others(self, standing: &AccountStanding, now_ms: i64) -> UserPartial {
        if self.user_id == FLUXER_SYSTEM_USER_ID || !standing.profile_hidden(now_ms) {
            return self;
        }
        let pseudonym = pseudonym(self.user_id);
        UserPartial {
            username: pseudonym.username,
            discriminator: pseudonym.discriminator,
            global_name: None,
            avatar_hash: None,
            banner_hash: None,
            banner_color: None,
            accent_color: None,
            avatar_color: None,
            premium_type: None,
            premium_flags: None,
            avatar_decoration_id: None,
            avatar_decoration_asset: None,
            avatar_ultra_id: None,
            avatar_ultra_asset: None,
            nameplate_id: None,
            nameplate_asset: None,
            name_font: None,
            name_color: None,
            name_color_2: None,
            ..self
        }
    }

    pub fn to_api_partial(&self) -> ApiUserPartial {
        ApiUserPartial::from(UserPartialFields {
            user_id: self.user_id,
            username: self.username.clone(),
            discriminator: self.discriminator,
            identity_version: self.identity_version,
            global_name: self.global_name.clone(),
            avatar_hash: self.avatar_hash.clone(),
            avatar_color: self.avatar_color,
            bot: self.bot,
            system: self.system,
            flags: self.flags,
            premium_type: self.premium_type,
            premium_flags: self.premium_flags,
            hidden_profile_badges: self.hidden_profile_badges.clone(),
            mention_flags: self.mention_flags,
            avatar_decoration_id: self.avatar_decoration_id,
            avatar_decoration_asset: self.avatar_decoration_asset.clone(),
            avatar_ultra_id: self.avatar_ultra_id,
            avatar_ultra_asset: self.avatar_ultra_asset.clone(),
            nameplate_id: self.nameplate_id,
            nameplate_asset: self.nameplate_asset.clone(),
            name_font: self.name_font,
            name_color: self.name_color,
            name_color_2: self.name_color_2,
        })
    }
}

fn deserialize_i64_from_number_or_string<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum I64OrString {
        Number(i64),
        String(String),
    }

    match I64OrString::deserialize(deserializer)? {
        I64OrString::Number(value) => Ok(value),
        I64OrString::String(value) => value.parse::<i64>().map_err(serde::de::Error::custom),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_partial_preserves_identity_version_without_private_username_state() {
        let mut value = serde_json::to_value(partial_with_flags(42, 0).to_api_partial()).unwrap();
        value["identity_version"] = json!("9223372036854775808");
        value["username_state"] = json!("selected");
        value["username_change_available_at"] = json!(123);
        value["username_free_change_available"] = json!(true);
        let partial: ApiUserPartial = serde_json::from_value(value).unwrap();
        let serialized = serde_json::to_value(partial).unwrap();
        assert_eq!(serialized["identity_version"], json!("9223372036854775808"));
        for key in [
            "username_state",
            "username_change_available_at",
            "username_free_change_available",
        ] {
            assert!(serialized.get(key).is_none());
        }
    }

    #[test]
    fn api_partial_does_not_invent_identity_version_for_legacy_rows() {
        let value = serde_json::to_value(partial_with_flags(42, 0).to_api_partial()).unwrap();
        assert!(value.get("identity_version").is_none());
    }

    #[test]
    fn api_partial_serializes_projected_bigint_version_as_decimal() {
        let mut partial = partial_with_flags(42, 0);
        partial.identity_version = Some(i64::MAX);
        let value = serde_json::to_value(partial.to_api_partial()).unwrap();
        assert_eq!(value["identity_version"], json!("9223372036854775807"));
    }

    fn partial_with_flags(user_id: i64, flags: i64) -> UserPartial {
        UserPartial {
            user_id,
            username: "Ada".to_owned(),
            discriminator: 7,
            identity_version: None,
            global_name: Some("Ada Lovelace".to_owned()),
            avatar_hash: Some("avatar_hash".to_owned()),
            bot: Some(false),
            system: Some(false),
            flags: Some(flags),
            premium_type: None,
            premium_flags: None,
            banner_hash: None,
            banner_color: None,
            accent_color: None,
            avatar_color: Some(0x336699),
            mention_flags: Some(0),
            avatar_decoration_id: None,
            avatar_decoration_asset: None,
            avatar_ultra_id: None,
            avatar_ultra_asset: None,
            nameplate_id: None,
            nameplate_asset: None,
            name_font: None,
            name_color: None,
            name_color_2: None,
            content_hidden_since: None,
            hidden_profile_badges: Vec::new(),
        }
    }

    #[test]
    fn api_partial_requests_use_string_snowflakes() {
        let request: UserRequest = serde_json::from_value(json!({
            "op": "GetApiPartialsByIds",
            "user_ids": ["9007199254740993", "9223372036854775807"],
            "instance_name": "Example Chat"
        }))
        .unwrap();

        match request {
            UserRequest::GetApiPartialsByIds {
                user_ids,
                instance_name,
            } => {
                assert_eq!(user_ids, vec!["9007199254740993", "9223372036854775807"]);
                assert_eq!(instance_name, "Example Chat");
            }
            other => panic!("unexpected request: {other:?}"),
        }
    }

    #[test]
    fn invalidate_accepts_number_or_string_snowflakes() {
        let string_request: UserRequest =
            serde_json::from_value(json!({"op": "Invalidate", "user_id": "9007199254740993"}))
                .unwrap();
        let numeric_request: UserRequest =
            serde_json::from_value(json!({"op": "Invalidate", "user_id": 42})).unwrap();

        assert!(matches!(
            string_request,
            UserRequest::Invalidate {
                user_id: 9007199254740993
            }
        ));
        assert!(matches!(
            numeric_request,
            UserRequest::Invalidate { user_id: 42 }
        ));
    }

    #[test]
    fn api_partial_response_serializes_for_the_api_client() {
        let response = UserResponse::FoundApiPartials(vec![
            partial_with_flags(123, USER_FLAG_STAFF).to_api_partial(),
        ]);

        let serialized = serde_json::to_value(response).unwrap();

        assert_eq!(
            serialized,
            json!({
                "FoundApiPartials": [{
                    "id": "123",
                    "username": "Ada",
                    "discriminator": "0007",
                    "global_name": "Ada Lovelace",
                    "avatar": "avatar_hash",
                    "avatar_color": 0x336699,
                    "flags": 1,
                    "avatar_decoration_data": null,
                    "avatar_ultra_data": null,
                    "nameplate_data": null,
                    "name_style": null
                }]
            })
        );
    }

    #[test]
    fn api_partial_carries_the_verified_flag() {
        let api_partial = partial_with_flags(123, USER_FLAG_VERIFIED).to_api_partial();

        assert_eq!(api_partial.flags, 1 << 29);
    }

    #[test]
    fn app_attest_messages_match_the_api_contract() {
        let request: UserRequest = serde_json::from_value(json!({
            "op": "AppAttestSubmitAge",
            "user_id": "9007199254740993",
            "key_id": "a2V5",
            "assertion_base64": "YXNzZXJ0aW9u",
            "client_data_base64": "e30="
        }))
        .unwrap();
        assert!(matches!(
            request,
            UserRequest::AppAttestSubmitAge {
                user_id: 9007199254740993,
                ..
            }
        ));
        let request: UserRequest = serde_json::from_value(json!({
            "op": "AppAttestCreateChallenge",
            "user_id": 42,
            "purpose": "assert"
        }))
        .unwrap();
        assert!(matches!(
            request,
            UserRequest::AppAttestCreateChallenge {
                user_id: 42,
                purpose: ChallengePurpose::Assert
            }
        ));
        assert_eq!(
            serde_json::to_value(UserResponse::AppAttestAgeAccepted {
                age_floor: AgeFloor::UnderMinimum,
                attested_at: "2026-11-05T12:00:00.000Z".to_owned(),
            })
            .unwrap(),
            json!({"AppAttestAgeAccepted": {"age_floor": "under_minimum", "attested_at": "2026-11-05T12:00:00.000Z"}})
        );
        assert_eq!(
            serde_json::to_value(UserResponse::AppAttestKeyRegistered).unwrap(),
            json!("AppAttestKeyRegistered")
        );
        assert_eq!(
            serde_json::to_value(UserResponse::AppAttestRejected {
                code: AppAttestRejection::NotConfigured,
            })
            .unwrap(),
            json!({"AppAttestRejected": {"code": "not_configured"}})
        );
    }
}
