// SPDX-License-Identifier: AGPL-3.0-or-later

pub(in crate::server) fn parse_soundboard_path(path: &str) -> Option<String> {
    let key = path.strip_prefix('/')?;
    let mut parts = key.split('/');
    if parts.next()? != "soundboard-sounds" {
        return None;
    }
    let guild_id = parts.next()?;
    if guild_id.starts_with('0') || !guild_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if guild_id.parse::<u64>().ok()? == 0 {
        return None;
    }
    let (hash, extension) = parts.next()?.split_once('.')?;
    if parts.next().is_some()
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !matches!(extension, "mp3" | "ogg")
    {
        return None;
    }
    Some(key.to_owned())
}

#[cfg(test)]
mod tests {
    use super::parse_soundboard_path;

    #[test]
    fn soundboard_paths_require_canonical_guild_hash_and_audio_extension() {
        for ext in ["mp3", "ogg"] {
            let key = format!(
                "soundboard-sounds/1130650140672000000/{}.{ext}",
                "ab12".repeat(16)
            );
            assert_eq!(parse_soundboard_path(&format!("/{key}")), Some(key));
        }
        for id in ["", "0", "01", "-1", "18446744073709551616", "a", "%34%32"] {
            assert_eq!(
                parse_soundboard_path(&format!("/soundboard-sounds/{id}/{}.mp3", "a".repeat(64))),
                None
            );
        }
        for file in [
            "a.mp3".to_owned(),
            format!("{}.mp3", "A".repeat(64)),
            format!("{}.mp3", "g".repeat(64)),
            format!("{}.wav", "a".repeat(64)),
            format!("{}.mp3/extra", "a".repeat(64)),
            "../secret.mp3".to_owned(),
            "%2e%2e%2fsecret.mp3".to_owned(),
            "..\\secret.mp3".to_owned(),
        ] {
            assert_eq!(
                parse_soundboard_path(&format!("/soundboard-sounds/42/{file}")),
                None
            );
        }
        assert_eq!(
            parse_soundboard_path(&format!("//soundboard-sounds/42/{}.mp3", "a".repeat(64))),
            None
        );
    }
}
