// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::config::{CassandraConsistency, optional_env};
use scylla::client::execution_profile::ExecutionProfile;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::errors::TranslationError;
use scylla::policies::address_translator::{AddressTranslator, UntranslatedPeer};
use scylla::policies::load_balancing::DefaultPolicy;
use scylla::statement::Consistency;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Debug)]
pub struct ScyllaConfig {
    pub hosts: Vec<String>,
    pub keyspace: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ScyllaConfig {
    pub fn from_service_config(config: &crate::config::ServiceConfig) -> Self {
        Self {
            hosts: config.scylla_hosts.clone(),
            keyspace: config.scylla_keyspace.clone(),
            username: config.scylla_username.clone(),
            password: config.scylla_password.clone(),
        }
    }
}

pub async fn connect(config: &ScyllaConfig) -> anyhow::Result<Arc<Session>> {
    if config.hosts.is_empty() {
        anyhow::bail!("at least one ScyllaDB host is required");
    }

    // Unset keeps the driver defaults (LOCAL_QUORUM, no datacenter preference).
    let consistency = optional_env("FLUXER_CASSANDRA_CONSISTENCY")
        .map(|v| v.parse::<CassandraConsistency>())
        .transpose()?;
    let local_dc = optional_env("FLUXER_CASSANDRA_LOCAL_DC");
    let profile = execution_profile(consistency, local_dc.as_deref());

    let mut builder = SessionBuilder::new()
        .known_nodes(config.hosts.iter().map(String::as_str))
        .default_execution_profile_handle(profile.into_handle())
        .use_keyspace(config.keyspace.clone(), false);

    if let Some(username) = &config.username {
        builder = builder.user(username, config.password.as_deref().unwrap_or_default());
    }

    if config.hosts.len() == 1 {
        let target = resolve_contact_point(&config.hosts[0])?;
        builder = builder.address_translator(Arc::new(ContactPointTranslator { target }));
    }

    let session = Arc::new(builder.build().await?);
    tracing::info!(
        keyspace = config.keyspace,
        hosts = ?config.hosts,
        consistency = ?consistency,
        local_dc = ?local_dc,
        request_timeout_ms = REQUEST_TIMEOUT.as_millis(),
        "connected to ScyllaDB"
    );
    Ok(session)
}

fn execution_profile(
    consistency: Option<CassandraConsistency>,
    local_dc: Option<&str>,
) -> ExecutionProfile {
    let mut builder = ExecutionProfile::builder().request_timeout(Some(REQUEST_TIMEOUT));
    if let Some(consistency) = consistency {
        builder = builder.consistency(driver_consistency(consistency));
    }
    if let Some(local_dc) = local_dc {
        builder = builder.load_balancing_policy(
            DefaultPolicy::builder()
                .prefer_datacenter(local_dc.to_owned())
                .build(),
        );
    }
    builder.build()
}

fn driver_consistency(consistency: CassandraConsistency) -> Consistency {
    match consistency {
        CassandraConsistency::LocalOne => Consistency::LocalOne,
        CassandraConsistency::LocalQuorum => Consistency::LocalQuorum,
        CassandraConsistency::Quorum => Consistency::Quorum,
        CassandraConsistency::One => Consistency::One,
    }
}

struct ContactPointTranslator {
    target: SocketAddr,
}

#[async_trait::async_trait]
impl AddressTranslator for ContactPointTranslator {
    async fn translate_address(
        &self,
        _peer: &UntranslatedPeer,
    ) -> Result<SocketAddr, TranslationError> {
        Ok(self.target)
    }
}

fn resolve_contact_point(host: &str) -> anyhow::Result<SocketAddr> {
    host.to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("failed to resolve contact point: {host}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_timeout_stays_below_the_shard_request_budget() {
        assert!(
            REQUEST_TIMEOUT < crate::router::SHARD_REQUEST_TIMEOUT,
            "scylla request timeout {REQUEST_TIMEOUT:?} outlives the shard budget"
        );
    }

    #[test]
    fn execution_profile_bounds_the_request_timeout() {
        assert_eq!(
            Some(REQUEST_TIMEOUT),
            execution_profile(None, None).get_request_timeout()
        );
    }

    #[test]
    fn execution_profile_keeps_the_driver_default_consistency_when_unset() {
        assert_eq!(
            Consistency::LocalQuorum,
            execution_profile(None, None).get_consistency()
        );
    }

    #[test]
    fn execution_profile_uses_the_configured_consistency() {
        for (configured, expected) in [
            (CassandraConsistency::LocalOne, Consistency::LocalOne),
            (CassandraConsistency::LocalQuorum, Consistency::LocalQuorum),
            (CassandraConsistency::Quorum, Consistency::Quorum),
            (CassandraConsistency::One, Consistency::One),
        ] {
            assert_eq!(
                expected,
                execution_profile(Some(configured), None).get_consistency()
            );
        }
    }

    #[test]
    fn execution_profile_prefers_the_local_datacenter() {
        let profile = execution_profile(None, Some("fsn1"));
        let policy = format!("{:?}", profile.get_load_balancing_policy());
        assert!(policy.contains("\"fsn1\""), "{policy}");
        let default_policy = format!(
            "{:?}",
            execution_profile(None, None).get_load_balancing_policy()
        );
        assert!(!default_policy.contains("fsn1"), "{default_policy}");
    }
}
