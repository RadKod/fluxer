// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentUdt {
    pub attachment_id: Option<i64>,
    pub filename: Option<String>,
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

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedAuthorUdt {
    pub name: Option<String>,
    pub url: Option<String>,
    pub icon_url: Option<String>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedFieldUdt {
    pub name: Option<String>,
    pub value: Option<String>,
    #[cfg_attr(feature = "scylla", scylla(rename = "inline"))]
    pub is_inline: Option<bool>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedFooterUdt {
    pub text: Option<String>,
    pub icon_url: Option<String>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedMediaUdt {
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

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedProviderUdt {
    pub name: Option<String>,
    pub url: Option<String>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedChildUdt {
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub embed_type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
    pub color: Option<i32>,
    pub author: Option<EmbedAuthorUdt>,
    pub provider: Option<EmbedProviderUdt>,
    pub thumbnail: Option<EmbedMediaUdt>,
    pub image: Option<EmbedMediaUdt>,
    pub video: Option<EmbedMediaUdt>,
    pub footer: Option<EmbedFooterUdt>,
    pub fields: Option<Vec<EmbedFieldUdt>>,
    pub nsfw: Option<bool>,
    pub audio: Option<EmbedMediaUdt>,
    pub html: Option<String>,
    pub html_width: Option<i32>,
    pub html_height: Option<i32>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedUdt {
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub embed_type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
    pub color: Option<i32>,
    pub author: Option<EmbedAuthorUdt>,
    pub provider: Option<EmbedProviderUdt>,
    pub thumbnail: Option<EmbedMediaUdt>,
    pub image: Option<EmbedMediaUdt>,
    pub video: Option<EmbedMediaUdt>,
    pub footer: Option<EmbedFooterUdt>,
    pub fields: Option<Vec<EmbedFieldUdt>>,
    pub nsfw: Option<bool>,
    pub children: Option<Vec<EmbedChildUdt>>,
    pub audio: Option<EmbedMediaUdt>,
    pub html: Option<String>,
    pub html_width: Option<i32>,
    pub html_height: Option<i32>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StickerItemUdt {
    pub sticker_id: Option<i64>,
    pub name: Option<String>,
    pub format_type: Option<i32>,
    pub animated: Option<bool>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReferenceUdt {
    pub channel_id: Option<i64>,
    pub message_id: Option<i64>,
    pub guild_id: Option<i64>,
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub reference_type: Option<i32>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCallUdt {
    pub participant_ids: Option<HashSet<i64>>,
    pub ended_timestamp: Option<DateTime<Utc>>,
}

#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSnapshotUdt {
    pub content: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
    pub edited_timestmap: Option<DateTime<Utc>>,
    pub mention_users: Option<HashSet<i64>>,
    pub mention_roles: Option<HashSet<i64>>,
    pub mention_channels: Option<HashSet<i64>>,
    pub attachments: Option<Vec<AttachmentUdt>>,
    pub embeds: Option<Vec<EmbedUdt>>,
    pub sticker_items: Option<Vec<StickerItemUdt>>,
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub snapshot_type: Option<i32>,
    pub flags: Option<i32>,
    pub edited_timestamp: Option<DateTime<Utc>>,
}

/// Micup: Cassandra `micup_message_component` (the driver maps UDTs by field name, not type name).
#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageComponentUdt {
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub component_type: Option<i32>,
    pub style: Option<i32>,
    pub label: Option<String>,
    pub emoji_name: Option<String>,
    pub emoji_id: Option<i64>,
    pub emoji_animated: Option<bool>,
    pub custom_id: Option<String>,
    pub disabled: Option<bool>,
}

/// Micup: Cassandra `micup_message_action_row`.
#[cfg_attr(
    feature = "scylla",
    derive(scylla::DeserializeValue, scylla::SerializeValue)
)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageActionRowUdt {
    #[cfg_attr(feature = "scylla", scylla(rename = "type"))]
    pub component_type: Option<i32>,
    pub components: Option<Vec<MessageComponentUdt>>,
}

#[cfg(all(test, feature = "scylla"))]
mod tests {
    use super::*;
    use scylla::cluster::metadata::{CollectionType, ColumnType, NativeType, UserDefinedType};
    use scylla::deserialize::value::DeserializeValue;
    use std::borrow::Cow;
    use std::sync::Arc;

    fn udt(name: &'static str, fields: Vec<(&'static str, NativeType)>) -> ColumnType<'static> {
        ColumnType::UserDefinedType {
            frozen: true,
            definition: Arc::new(UserDefinedType {
                name: Cow::Borrowed(name),
                keyspace: Cow::Borrowed("fluxer"),
                field_types: fields
                    .into_iter()
                    .map(|(field, typ)| (Cow::Borrowed(field), ColumnType::Native(typ)))
                    .collect(),
            }),
        }
    }

    #[test]
    fn micup_udts_are_matched_by_field_names_not_the_type_name() {
        let component = udt(
            "micup_message_component",
            vec![
                ("type", NativeType::Int),
                ("style", NativeType::Int),
                ("label", NativeType::Text),
                ("emoji_name", NativeType::Text),
                ("emoji_id", NativeType::BigInt),
                ("emoji_animated", NativeType::Boolean),
                ("custom_id", NativeType::Text),
                ("disabled", NativeType::Boolean),
            ],
        );
        <MessageComponentUdt as DeserializeValue>::type_check(&component)
            .expect("micup_message_component maps by field names");

        let mut row = udt("micup_message_action_row", vec![("type", NativeType::Int)]);
        if let ColumnType::UserDefinedType { definition, .. } = &mut row {
            Arc::make_mut(definition).field_types.push((
                Cow::Borrowed("components"),
                ColumnType::Collection {
                    frozen: true,
                    typ: CollectionType::List(Box::new(component)),
                },
            ));
        }
        <MessageActionRowUdt as DeserializeValue>::type_check(&row)
            .expect("micup_message_action_row maps by field names");
    }
}
