// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::{
    http_headers,
    server::{response::error::text, state::AppState},
};
use axum::{
    Extension,
    body::Body,
    extract::{ConnectInfo, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

const METRICS_ALLOWED_CIDRS_ENV: &str = "FLUXER_METRICS_ALLOWED_CIDRS";

/// Networks allowed to scrape `/_metrics` besides loopback, judged by the socket peer.
/// Same rules as `fluxer_svc::server::MetricsAllowList`; this crate does not depend on fluxer_svc.
#[derive(Debug, Default)]
pub(in crate::server) struct MetricsAllowList {
    networks: Vec<(IpAddr, u8)>,
}

impl MetricsAllowList {
    pub(in crate::server) fn from_env() -> anyhow::Result<Self> {
        Self::parse(&std::env::var(METRICS_ALLOWED_CIDRS_ENV).unwrap_or_default())
    }

    pub(in crate::server) fn parse(value: &str) -> anyhow::Result<Self> {
        let networks = value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(parse_network)
            .collect::<anyhow::Result<_>>()?;
        Ok(Self { networks })
    }

    fn is_metrics_peer_allowed(&self, peer: &SocketAddr) -> bool {
        let ip = peer.ip().to_canonical();
        ip.is_loopback()
            || self
                .networks
                .iter()
                .any(|&(network, prefix)| network_contains(network, prefix, ip))
    }
}

fn parse_network(entry: &str) -> anyhow::Result<(IpAddr, u8)> {
    let invalid =
        || anyhow::anyhow!("{METRICS_ALLOWED_CIDRS_ENV} contains an invalid CIDR: {entry}");
    let (address, prefix) = match entry.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (entry, None),
    };
    let address: IpAddr = address.parse().map_err(|_| invalid())?;
    let max_prefix = if address.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
        // One to three ASCII digits, as in the Node and Erlang parsers; `parse` alone takes "+24".
        Some(prefix) => Some(prefix)
            .filter(|prefix| prefix.len() <= 3 && prefix.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|prefix| prefix.parse::<u8>().ok())
            .filter(|prefix| *prefix <= max_prefix)
            .ok_or_else(invalid)?,
        None => max_prefix,
    };
    Ok((address, prefix))
}

fn network_contains(network: IpAddr, prefix: u8, ip: IpAddr) -> bool {
    let (network, ip, bits) = match (network, ip) {
        (IpAddr::V4(network), IpAddr::V4(ip)) => (
            u128::from(u32::from(network)),
            u128::from(u32::from(ip)),
            32,
        ),
        (IpAddr::V6(network), IpAddr::V6(ip)) => (u128::from(network), u128::from(ip), 128),
        _ => return false,
    };
    prefix == 0 || (network ^ ip) >> (bits - u32::from(prefix)) == 0
}

pub(in crate::server) async fn health(State(app): State<Arc<AppState>>) -> String {
    format!(
        "OK attachment_signature={}",
        app.cfg.attachment_signature.mode.label()
    )
}

pub(in crate::server) async fn metrics_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(allowed): Extension<Arc<MetricsAllowList>>,
    State(app): State<Arc<AppState>>,
) -> Response {
    if !allowed.is_metrics_peer_allowed(&peer) {
        return text(StatusCode::FORBIDDEN, "FORBIDDEN");
    }
    let mut response = Response::new(Body::from(app.metrics.render()));
    http_headers::add_security_headers(response.headers_mut());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::to_bytes;

    fn test_peer(value: &str) -> SocketAddr {
        value.parse().expect("valid socket address")
    }

    fn test_app_state() -> Arc<AppState> {
        let cfg = Config::load_from_iter([("FLUXER_MEDIA_PROXY_SECRET_KEY", "secret")])
            .expect("test config");
        Arc::new(AppState::for_tests(cfg))
    }

    fn allowed(list: &MetricsAllowList, value: &str) -> bool {
        list.is_metrics_peer_allowed(&test_peer(value))
    }

    #[test]
    fn metrics_guard_accepts_loopback_peers() {
        let list = MetricsAllowList::default();
        assert!(allowed(&list, "127.0.0.1:5000"));
        assert!(allowed(&list, "127.0.0.2:5000"));
        assert!(allowed(&list, "[::1]:5000"));
        assert!(allowed(&list, "[::ffff:127.0.0.1]:5000"));
    }

    #[test]
    fn metrics_guard_rejects_remote_peers() {
        let list = MetricsAllowList::default();
        assert!(!allowed(&list, "8.8.8.8:5000"));
        assert!(!allowed(&list, "10.0.0.5:5000"));
        assert!(!allowed(&list, "172.18.0.4:5000"));
        assert!(!allowed(&list, "[fe80::1]:5000"));
        assert!(!allowed(&list, "[::ffff:8.8.8.8]:5000"));
    }

    #[test]
    fn metrics_guard_accepts_peers_inside_configured_networks() {
        let list = MetricsAllowList::parse(" 10.77.0.0/24, ,fd00:77::/64,192.0.2.10 ")
            .expect("valid allow list");
        assert!(allowed(&list, "10.77.0.3:5000"));
        assert!(allowed(&list, "[::ffff:10.77.0.3]:5000"));
        assert!(allowed(&list, "[fd00:77::5]:5000"));
        assert!(allowed(&list, "192.0.2.10:5000"));
        assert!(allowed(&list, "127.0.0.1:5000"));
        assert!(!allowed(&list, "10.77.1.3:5000"));
        assert!(!allowed(&list, "192.0.2.11:5000"));
        assert!(!allowed(&list, "[fd00:78::5]:5000"));
    }

    #[test]
    fn metrics_guard_handles_zero_length_prefixes() {
        let list = MetricsAllowList::parse("0.0.0.0/0,::/0").expect("valid allow list");
        assert!(allowed(&list, "8.8.8.8:5000"));
        assert!(allowed(&list, "[2001:db8::1]:5000"));
    }

    #[test]
    fn metrics_allow_list_rejects_invalid_entries() {
        for entry in [
            "10.77.0.0/33",
            "fd00::/129",
            "not-an-ip/24",
            "10.77.0.0/",
            "10.77.0.0/2x",
            "10.77.0.0/24/1",
            // Refused by the Node and Erlang parsers too.
            "10.0.0.0/24 10.1.0.0/24",
            "10.0.0.0/+24",
            "10.0.0.0/0024",
        ] {
            assert!(
                MetricsAllowList::parse(entry).is_err(),
                "{entry} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn metrics_denial_uses_the_shared_text_shape() {
        let response = metrics_handler(
            ConnectInfo(test_peer("8.8.8.8:5000")),
            Extension(Arc::default()),
            State(test_app_state()),
        )
        .await;

        assert_eq!(StatusCode::FORBIDDEN, response.status());
        assert_eq!(
            "text/plain; charset=utf-8",
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .expect("content type")
        );
        assert_eq!(
            "no-store",
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .expect("cache policy")
        );
        let body = to_bytes(response.into_body(), 64).await.expect("body");
        assert_eq!(b"FORBIDDEN", body.as_ref());
    }
}
