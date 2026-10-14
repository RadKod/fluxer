// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::api::generated::{snowflake, types};

use super::client::{AdminApiClient, ApiError, ApiResult};
use super::types::ListGuildThreadsResponse;

impl AdminApiClient {
    pub async fn list_guild_threads(
        &self,
        guild_id: &str,
        cursor: Option<&str>,
    ) -> ApiResult<ListGuildThreadsResponse> {
        let cursor = cursor
            .map(str::parse::<types::ListAdminGuildThreadsCursor>)
            .transpose()
            .map_err(|error| ApiError::Parse(error.to_string()))?;
        let response = self
            .generated()
            .list_admin_guild_threads(&snowflake(guild_id), cursor.as_ref(), Some("100"))
            .await
            .map_err(|e| self.generated_error(e))?;
        self.generated_value(response.into_inner())
    }

    pub async fn delete_thread_channel(&self, channel_id: &str) -> ApiResult<()> {
        self.generated()
            .delete_admin_thread_channel(&snowflake(channel_id))
            .await
            .map_err(|e| self.generated_error(e))?;
        Ok(())
    }
}
