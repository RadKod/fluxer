// SPDX-License-Identifier: AGPL-3.0-or-later

pub use fluxer_common::user_partial::ApiUserPartial;

use serde::{Deserialize, Serialize};

fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

mod serde_id {
    use serde::Deserialize;
    use serde::de::{self, Deserializer};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrI64 {
        String(String),
        I64(i64),
        U64(u64),
    }

    impl StringOrI64 {
        fn into_i64<E: de::Error>(self) -> Result<i64, E> {
            match self {
                Self::String(value) => value.parse::<i64>().map_err(E::custom),
                Self::I64(value) => Ok(value),
                Self::U64(value) => i64::try_from(value).map_err(E::custom),
            }
        }
    }

    pub fn i64_from_string_or_number<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        StringOrI64::deserialize(deserializer)?.into_i64()
    }

    pub fn opt_i64_from_string_or_number<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<StringOrI64>::deserialize(deserializer)?
            .map(StringOrI64::into_i64)
            .transpose()
    }

    pub fn vec_i64_from_strings_or_numbers<'de, D>(deserializer: D) -> Result<Vec<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<Vec<StringOrI64>>::deserialize(deserializer)?
            .unwrap_or_default()
            .into_iter()
            .map(StringOrI64::into_i64)
            .collect()
    }

    pub fn i32_or_null_as_default<'de, D>(deserializer: D) -> Result<i32, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Option::<i32>::deserialize(deserializer)?.unwrap_or_default())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
#[allow(clippy::enum_variant_names, clippy::large_enum_variant)]
pub enum MessageRequest {
    GetResponseById {
        channel_id: String,
        message_id: String,
        viewer_user_id: String,
        source_guild_id: Option<String>,
        message_history_cutoff_ms: Option<i64>,
        can_read_message_history: bool,
        media_endpoint: String,
        media_proxy_secret_key: String,
        #[serde(default)]
        attachment_url_secret_base64: Option<String>,
        include_reactions: Option<bool>,
        attachment_decay: Option<bool>,
        nonce: Option<String>,
        tts: Option<bool>,
        #[serde(default)]
        include_hidden: bool,
        #[serde(default)]
        threads_mask: bool,
    },
    BuildResponse {
        message: Message,
        viewer_user_id: String,
        source_guild_id: Option<String>,
        message_history_cutoff_ms: Option<i64>,
        can_read_message_history: bool,
        media_endpoint: String,
        media_proxy_secret_key: String,
        #[serde(default)]
        attachment_url_secret_base64: Option<String>,
        include_reactions: Option<bool>,
        attachment_decay: Option<bool>,
        nonce: Option<String>,
        tts: Option<bool>,
        #[serde(default)]
        include_hidden: bool,
        #[serde(default)]
        threads_mask: bool,
    },
    BuildResponses {
        messages: Vec<Message>,
        viewer_user_id: String,
        source_guild_id: Option<String>,
        message_history_cutoff_ms: Option<i64>,
        can_read_message_history: bool,
        media_endpoint: String,
        media_proxy_secret_key: String,
        #[serde(default)]
        attachment_url_secret_base64: Option<String>,
        include_reactions: Option<bool>,
        attachment_decay: Option<bool>,
        #[serde(default)]
        include_hidden: bool,
        #[serde(default)]
        threads_mask: bool,
    },
    ListResponses {
        channel_id: String,
        viewer_user_id: String,
        limit: u32,
        before_id: Option<String>,
        after_id: Option<String>,
        around_id: Option<String>,
        source_guild_id: Option<String>,
        message_history_cutoff_ms: Option<i64>,
        can_read_message_history: bool,
        media_endpoint: String,
        media_proxy_secret_key: String,
        #[serde(default)]
        attachment_url_secret_base64: Option<String>,
        include_reactions: Option<bool>,
        attachment_decay: Option<bool>,
        #[serde(default)]
        include_hidden: bool,
        #[serde(default)]
        threads_mask: bool,
        #[serde(default)]
        exclude_types: Vec<i32>,
    },
    ExtractMentions {
        contents: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
pub enum MessageResponse {
    FoundApi(ApiMessageResponse),
    FoundApiMany(Vec<ApiMessageResponse>),
    FoundMentions(Vec<ExtractedMentionsResponse>),
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    #[serde(deserialize_with = "serde_id::i64_from_string_or_number")]
    pub message_id: i64,
    #[serde(deserialize_with = "serde_id::i64_from_string_or_number")]
    pub channel_id: i64,
    pub bucket: i32,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub author_id: Option<i64>,
    #[serde(
        rename = "type",
        default,
        deserialize_with = "serde_id::i32_or_null_as_default"
    )]
    pub message_type: i32,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub webhook_id: Option<i64>,
    pub webhook_name: Option<String>,
    pub webhook_avatar_hash: Option<String>,
    pub content: Option<String>,
    pub edited_timestamp: Option<i64>,
    pub pinned: Option<bool>,
    pub flags: Option<i64>,
    pub mention_everyone: Option<bool>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_users: Vec<i64>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_roles: Vec<i64>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_channels: Vec<i64>,
    pub has_reaction: Option<bool>,
    #[serde(default, deserialize_with = "serde_id::i32_or_null_as_default")]
    pub version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<MessageEmbed>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker_items: Option<Vec<MessageStickerItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_reference: Option<MessageReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<MessageCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_snapshots: Option<Vec<MessageSnapshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub micup_components: Option<Vec<MessageActionRow>>,
}

impl Message {
    /// Micup: the stored button rows as the API `components` field; no rows (or an empty list) leaves it out.
    pub fn components_response(&self) -> Option<Vec<ApiMessageActionRowResponse>> {
        let rows = self
            .micup_components
            .as_deref()
            .filter(|rows| !rows.is_empty())?;
        Some(
            rows.iter()
                .map(|row| ApiMessageActionRowResponse {
                    component_type: row.component_type.unwrap_or_default(),
                    components: row
                        .components
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .map(|button| ApiMessageButtonResponse {
                            component_type: button.component_type.unwrap_or_default(),
                            style: button.style.unwrap_or_default(),
                            label: button.label.clone(),
                            emoji: button.emoji_name.clone().map(|name| {
                                ApiComponentEmojiResponse {
                                    name,
                                    id: button.emoji_id.map(|id| id.to_string()),
                                    animated: button.emoji_animated.unwrap_or(false),
                                }
                            }),
                            custom_id: button.custom_id.clone(),
                            disabled: button.disabled.unwrap_or(false),
                        })
                        .collect(),
                })
                .collect(),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageAttachmentResponse {
    pub id: String,
    pub filename: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub content_hash: Option<String>,
    pub size: i64,
    pub url: Option<String>,
    pub proxy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    pub flags: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform: Option<String>,
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEmbedAuthorResponse {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEmbedProviderResponse {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEmbedFooterResponse {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEmbedMediaResponse {
    pub url: String,
    pub proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEmbedFieldResponse {
    pub name: String,
    pub value: String,
    #[serde(rename = "inline")]
    pub is_inline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageEmbedChildResponse {
    #[serde(rename = "type")]
    pub embed_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<ApiEmbedAuthorResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<ApiEmbedProviderResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<ApiEmbedMediaResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ApiEmbedMediaResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<ApiEmbedMediaResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<ApiEmbedMediaResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<ApiEmbedFooterResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<ApiEmbedFieldResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageEmbedResponse {
    #[serde(flatten)]
    pub base: ApiMessageEmbedChildResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ApiMessageEmbedChildResponse>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageStickerResponse {
    pub id: String,
    pub name: String,
    pub animated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageReferenceResponse {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<String>,
    #[serde(rename = "type")]
    pub reference_type: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiChannelMentionResponse {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiReactionEmojiResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageReactionResponse {
    pub emoji: ApiReactionEmojiResponse,
    pub count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub me: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageSnapshotResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_channels: Option<Vec<ApiChannelMentionResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<ApiMessageEmbedResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<ApiMessageAttachmentResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stickers: Option<Vec<ApiMessageStickerResponse>>,
    #[serde(rename = "type")]
    pub snapshot_type: i32,
    pub flags: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageCallResponse {
    pub participants: Vec<String>,
    pub ended_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageResponse {
    pub id: String,
    pub channel_id: String,
    pub author: ApiUserPartial,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_id: Option<String>,
    #[serde(rename = "type")]
    pub message_type: i32,
    pub flags: i64,
    pub content: String,
    pub timestamp: String,
    pub edited_timestamp: Option<String>,
    pub pinned: bool,
    pub mention_everyone: bool,
    pub tts: bool,
    pub mentions: Vec<ApiUserPartial>,
    pub mention_roles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_channels: Option<Vec<ApiChannelMentionResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<ApiUserPartial>>,
    pub embeds: Vec<ApiMessageEmbedResponse>,
    pub attachments: Vec<ApiMessageAttachmentResponse>,
    pub stickers: Vec<ApiMessageStickerResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<ApiMessageReactionResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_reference: Option<ApiMessageReferenceResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_snapshots: Option<Vec<ApiMessageSnapshotResponse>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<ApiMessageCallResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<Vec<ApiMessageActionRowResponse>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_double_option"
    )]
    pub referenced_message: Option<Option<Box<ApiMessageResponse>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageActionRowResponse {
    #[serde(rename = "type")]
    pub component_type: i32,
    pub components: Vec<ApiMessageButtonResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessageButtonResponse {
    #[serde(rename = "type")]
    pub component_type: i32,
    pub style: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<ApiComponentEmojiResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiComponentEmojiResponse {
    pub name: String,
    pub id: Option<String>,
    pub animated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedMentionsResponse {
    pub users: Vec<String>,
    pub roles: Vec<String>,
    pub channels: Vec<String>,
    pub everyone: bool,
    pub here: bool,
}

impl From<crate::mention_extractor::MessageMentions> for ExtractedMentionsResponse {
    fn from(mentions: crate::mention_extractor::MessageMentions) -> Self {
        Self {
            users: mentions
                .users
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            roles: mentions
                .roles
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            channels: mentions
                .channels
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            everyone: mentions.everyone,
            here: mentions.here,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageAttachment {
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub attachment_id: Option<i64>,
    pub filename: Option<String>,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub size: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration: Option<i32>,
    pub content_type: Option<String>,
    pub content_hash: Option<String>,
    pub placeholder: Option<String>,
    pub flags: Option<i32>,
    pub nsfw: Option<bool>,
    pub duration_secs: Option<i32>,
    pub waveform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedAuthor {
    pub name: Option<String>,
    pub url: Option<String>,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedField {
    pub name: Option<String>,
    pub value: Option<String>,
    #[serde(rename = "inline")]
    pub is_inline: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedFooter {
    pub text: Option<String>,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedMedia {
    pub url: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration: Option<i32>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub content_hash: Option<String>,
    pub placeholder: Option<String>,
    pub flags: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedProvider {
    pub name: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbedChild {
    #[serde(rename = "type")]
    pub embed_type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub timestamp: Option<i64>,
    pub color: Option<i32>,
    pub author: Option<MessageEmbedAuthor>,
    pub provider: Option<MessageEmbedProvider>,
    pub thumbnail: Option<MessageEmbedMedia>,
    pub image: Option<MessageEmbedMedia>,
    pub video: Option<MessageEmbedMedia>,
    pub footer: Option<MessageEmbedFooter>,
    pub fields: Option<Vec<MessageEmbedField>>,
    pub nsfw: Option<bool>,
    pub audio: Option<MessageEmbedMedia>,
    pub html: Option<String>,
    pub html_width: Option<i32>,
    pub html_height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEmbed {
    #[serde(rename = "type")]
    pub embed_type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub timestamp: Option<i64>,
    pub color: Option<i32>,
    pub author: Option<MessageEmbedAuthor>,
    pub provider: Option<MessageEmbedProvider>,
    pub thumbnail: Option<MessageEmbedMedia>,
    pub image: Option<MessageEmbedMedia>,
    pub video: Option<MessageEmbedMedia>,
    pub footer: Option<MessageEmbedFooter>,
    pub fields: Option<Vec<MessageEmbedField>>,
    pub nsfw: Option<bool>,
    pub children: Option<Vec<MessageEmbedChild>>,
    pub audio: Option<MessageEmbedMedia>,
    pub html: Option<String>,
    pub html_width: Option<i32>,
    pub html_height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStickerItem {
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub sticker_id: Option<i64>,
    pub name: Option<String>,
    pub format_type: Option<i32>,
    pub animated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReference {
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub channel_id: Option<i64>,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub message_id: Option<i64>,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub guild_id: Option<i64>,
    #[serde(rename = "type")]
    pub reference_type: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCall {
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub participant_ids: Vec<i64>,
    pub ended_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSnapshot {
    pub content: Option<String>,
    pub timestamp: Option<i64>,
    pub edited_timestamp: Option<i64>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_users: Vec<i64>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_roles: Vec<i64>,
    #[serde(
        default,
        deserialize_with = "serde_id::vec_i64_from_strings_or_numbers"
    )]
    pub mention_channels: Vec<i64>,
    pub attachments: Option<Vec<MessageAttachment>>,
    pub embeds: Option<Vec<MessageEmbed>>,
    pub sticker_items: Option<Vec<MessageStickerItem>>,
    #[serde(rename = "type")]
    pub snapshot_type: Option<i32>,
    pub flags: Option<i32>,
}

/// Micup: a button row as the TypeScript message row carries it (`micup_components`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageActionRow {
    #[serde(rename = "type")]
    pub component_type: Option<i32>,
    pub components: Option<Vec<MessageComponent>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageComponent {
    #[serde(rename = "type")]
    pub component_type: Option<i32>,
    pub style: Option<i32>,
    pub label: Option<String>,
    pub emoji_name: Option<String>,
    #[serde(default, deserialize_with = "serde_id::opt_i64_from_string_or_number")]
    pub emoji_id: Option<i64>,
    pub emoji_animated: Option<bool>,
    pub custom_id: Option<String>,
    pub disabled: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_deserializes_service_payload_ids_from_strings() {
        let message: Message = serde_json::from_value(json!({
            "message_id": "1509197195776110592",
            "channel_id": "1497639278555484216",
            "bucket": 416,
            "author_id": "1472426752046002208",
            "type": 0,
            "webhook_id": null,
            "content": "hello <@1472426752046002208>",
            "edited_timestamp": null,
            "pinned": false,
            "flags": 0,
            "mention_everyone": false,
            "mention_users": ["1472426752046002208"],
            "mention_roles": [],
            "mention_channels": [],
            "has_reaction": false,
            "version": 1,
            "attachments": [{
                "attachment_id": "1509197195776110593",
                "filename": "a.png",
                "size": "12345",
                "content_type": "image/png",
                "flags": 0
            }],
            "sticker_items": [{
                "sticker_id": "1509197195776110594",
                "name": "sticker"
            }],
            "message_reference": {
                "channel_id": "1497639278555484216",
                "message_id": "1509197195776110590",
                "guild_id": "1497639278555484210",
                "type": 0
            },
            "call": {
                "participant_ids": ["1472426752046002208"],
                "ended_timestamp": null
            },
            "message_snapshots": [{
                "content": "snapshot",
                "timestamp": 1779891051001i64,
                "mention_users": ["1472426752046002208"],
                "mention_roles": [],
                "mention_channels": [],
                "type": 0,
                "flags": 0
            }]
        }))
        .expect("message payload should deserialize");

        assert_eq!(message.message_id, 1_509_197_195_776_110_592);
        assert_eq!(message.author_id, Some(1_472_426_752_046_002_208));
        assert_eq!(message.mention_users, vec![1_472_426_752_046_002_208]);
        assert_eq!(
            message.attachments.unwrap()[0].attachment_id,
            Some(1_509_197_195_776_110_593)
        );
        assert_eq!(
            message.message_reference.unwrap().message_id,
            Some(1_509_197_195_776_110_590)
        );
        assert_eq!(
            message.call.unwrap().participant_ids,
            vec![1_472_426_752_046_002_208]
        );
    }

    fn minimal_api_message(
        referenced: Option<Option<Box<ApiMessageResponse>>>,
    ) -> ApiMessageResponse {
        let author = ApiUserPartial {
            id: "1".to_string(),
            username: "user".to_string(),
            discriminator: "0001".to_string(),
            identity_version: None,
            global_name: None,
            avatar: None,
            avatar_color: None,
            bot: None,
            system: None,
            flags: 0,
            mention_flags: None,
            avatar_decoration_data: None,
            avatar_ultra_data: None,
            nameplate_data: None,
            name_style: None,
        };
        ApiMessageResponse {
            id: "2".to_string(),
            channel_id: "3".to_string(),
            author,
            webhook_id: None,
            message_type: 0,
            flags: 0,
            content: String::new(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            edited_timestamp: None,
            pinned: false,
            mention_everyone: false,
            tts: false,
            mentions: Vec::new(),
            mention_roles: Vec::new(),
            mention_channels: None,
            users: None,
            embeds: Vec::new(),
            attachments: Vec::new(),
            stickers: Vec::new(),
            reactions: None,
            message_reference: None,
            message_snapshots: None,
            nonce: None,
            call: None,
            components: None,
            referenced_message: referenced,
        }
    }

    fn ts_row(micup_components: Option<serde_json::Value>) -> Message {
        let mut row = json!({
            "message_id": "1509197195776110592",
            "channel_id": "1497639278555484216",
            "bucket": 416,
            "type": 0,
            "version": 1
        });
        if let Some(components) = micup_components {
            row["micup_components"] = components;
        }
        serde_json::from_value(row).expect("message row should deserialize")
    }

    fn roster_buttons() -> serde_json::Value {
        json!([{
            "type": 1,
            "components": [
                {
                    "type": 2, "style": 3, "label": "Join", "emoji_name": "✅", "emoji_id": null,
                    "emoji_animated": null, "custom_id": "roster:join", "disabled": null
                },
                {
                    "type": 2, "style": 4, "label": "Leave", "emoji_name": "party",
                    "emoji_id": "1509197195776110599", "emoji_animated": true,
                    "custom_id": "roster:leave", "disabled": true
                }
            ]
        }])
    }

    #[test]
    fn a_row_with_components_builds_button_rows_in_the_response() {
        let rows = ts_row(Some(roster_buttons()))
            .components_response()
            .expect("button rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].component_type, 1);
        let [join, leave] = rows[0].components.as_slice() else {
            panic!("two buttons expected");
        };
        assert_eq!(
            (join.component_type, join.style, join.label.as_deref()),
            (2, 3, Some("Join"))
        );
        assert_eq!(join.custom_id.as_deref(), Some("roster:join"));
        assert!(!join.disabled);
        let join_emoji = join.emoji.as_ref().expect("emoji");
        assert_eq!(
            (join_emoji.name.as_str(), join_emoji.id.as_deref()),
            ("✅", None)
        );
        assert!(!join_emoji.animated);
        assert!(leave.disabled);
        let leave_emoji = leave.emoji.as_ref().expect("emoji");
        assert_eq!(leave_emoji.id.as_deref(), Some("1509197195776110599"));
        assert!(leave_emoji.animated);
    }

    #[test]
    fn a_row_without_components_builds_a_response_without_the_key() {
        assert!(ts_row(None).components_response().is_none());
        assert!(
            ts_row(Some(serde_json::Value::Null))
                .components_response()
                .is_none()
        );
        let response = serde_json::to_value(minimal_api_message(None)).expect("serialises");
        assert!(response.get("components").is_none());
    }

    #[test]
    fn an_empty_component_list_is_left_out() {
        assert!(ts_row(Some(json!([]))).components_response().is_none());
    }

    #[test]
    fn a_button_without_an_emoji_has_no_emoji_field() {
        let rows = ts_row(Some(json!([{
            "type": 1,
            "components": [{
                "type": 2, "style": 1, "label": "Open", "emoji_name": null,
                "emoji_id": "1509197195776110599", "custom_id": "support:open"
            }]
        }])))
        .components_response()
        .expect("button rows");
        let button = serde_json::to_value(&rows[0].components[0]).expect("serialises");
        assert!(button.get("emoji").is_none());
        assert_eq!(button["disabled"], json!(false));
    }

    #[test]
    fn emoji_ids_arrive_as_strings_or_numbers() {
        let message = ts_row(Some(json!([{
            "type": 1,
            "components": [
                {"type": 2, "style": 1, "emoji_name": "a", "emoji_id": "1509197195776110599", "custom_id": "x:a"},
                {"type": 2, "style": 1, "emoji_name": "b", "emoji_id": 1509197195776110599i64, "custom_id": "x:b"}
            ]
        }])));
        let stored = message.micup_components.as_ref().expect("rows")[0]
            .components
            .as_ref()
            .expect("buttons");
        assert_eq!(stored[0].emoji_id, Some(1_509_197_195_776_110_599));
        assert_eq!(stored[1].emoji_id, Some(1_509_197_195_776_110_599));
        let rows = message.components_response().expect("button rows");
        for button in &rows[0].components {
            assert_eq!(
                button.emoji.as_ref().and_then(|emoji| emoji.id.as_deref()),
                Some("1509197195776110599")
            );
        }
    }

    #[test]
    fn a_ts_row_with_micup_components_builds_the_components_field() {
        let mut response = minimal_api_message(None);
        response.components = ts_row(Some(roster_buttons())).components_response();
        let value = serde_json::to_value(response).expect("serialises");
        assert!(value.get("micup_components").is_none());
        assert_eq!(
            value["components"],
            json!([{
                "type": 1,
                "components": [
                    {
                        "type": 2, "style": 3, "label": "Join",
                        "emoji": {"name": "✅", "id": null, "animated": false},
                        "custom_id": "roster:join", "disabled": false
                    },
                    {
                        "type": 2, "style": 4, "label": "Leave",
                        "emoji": {"name": "party", "id": "1509197195776110599", "animated": true},
                        "custom_id": "roster:leave", "disabled": true
                    }
                ]
            }])
        );
    }

    fn msgpack_round_trip(
        referenced: Option<Option<Box<ApiMessageResponse>>>,
    ) -> Option<Option<Box<ApiMessageResponse>>> {
        let encoded =
            rmp_serde::to_vec_named(&minimal_api_message(referenced)).expect("encodes to msgpack");
        rmp_serde::from_slice::<ApiMessageResponse>(&encoded)
            .expect("decodes from msgpack")
            .referenced_message
    }

    #[test]
    fn referenced_message_null_survives_the_msgpack_round_trip() {
        assert!(msgpack_round_trip(None).is_none());
        assert!(matches!(msgpack_round_trip(Some(None)), Some(None)));
        assert!(matches!(
            msgpack_round_trip(Some(Some(Box::new(minimal_api_message(None))))),
            Some(Some(_))
        ));
    }

    #[test]
    fn referenced_message_null_serialises_as_json_null_not_an_absent_key() {
        let deleted = serde_json::to_value(minimal_api_message(Some(None))).expect("serialises");
        assert_eq!(
            deleted.get("referenced_message"),
            Some(&serde_json::Value::Null)
        );

        let absent = serde_json::to_value(minimal_api_message(None)).expect("serialises");
        assert!(absent.get("referenced_message").is_none());
    }
}
