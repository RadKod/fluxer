// SPDX-License-Identifier: AGPL-3.0-or-later

use super::client::{AdminApiClient, ApiResult};

impl AdminApiClient {
    pub async fn delete_feed_post(&self, post_id: &str) -> ApiResult<()> {
        let path = format!("/admin/feed/posts/{}", urlencoding::encode(post_id));
        self.delete_void(&path, None).await
    }

    pub async fn delete_feed_comment(&self, post_id: &str, comment_id: &str) -> ApiResult<()> {
        let path = format!(
            "/admin/feed/posts/{}/comments/{}",
            urlencoding::encode(post_id),
            urlencoding::encode(comment_id)
        );
        self.delete_void(&path, None).await
    }
}
