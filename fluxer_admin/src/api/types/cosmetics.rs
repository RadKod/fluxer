// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CosmeticItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub name: String,
    pub description: Option<String>,
    pub asset: String,
    pub availability: String,
    // Micup (shop): ultra decorations only; absent or null keeps the fixed sizes.
    #[serde(default)]
    pub ultra_layout: Option<UltraLayout>,
    // Micup (angel-wings): ultra decorations only; absent or null draws the item behind the avatar.
    #[serde(default)]
    pub ultra_front: Option<UltraFront>,
}

// Micup (angel-wings): hashes of the images drawn in front of the avatar; each is the left half.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UltraFront {
    pub closed: String,
    pub open: Vec<String>,
    pub idle: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UltraLayout {
    pub compact: Option<UltraLayoutSurface>,
    pub voice: Option<UltraLayoutSurface>,
    pub profile: Option<UltraLayoutSurface>,
}

// Multiples of the avatar diameter, on the scale of the fixed sizes (2.30, 3.20, 3.40).
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct UltraLayoutSurface {
    pub width: f64,
    pub height: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

// Micup (shop): the answer to giving an item to, or taking it back from, one account.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdminUserCosmetic {
    pub item_id: String,
    pub owned: bool,
    pub equipped: bool,
    pub changed: bool,
    pub unequipped: bool,
}
