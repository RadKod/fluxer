// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::metrics::ServiceMetrics;
use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::net::TcpListener;

pub const METRICS_ALLOWED_CIDRS_ENV: &str = "FLUXER_METRICS_ALLOWED_CIDRS";

/// Networks allowed to scrape `/_metrics` besides loopback, judged by the socket peer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MetricsAllowList {
    networks: Vec<(IpAddr, u8)>,
}

impl MetricsAllowList {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::parse(
            crate::config::optional_env(METRICS_ALLOWED_CIDRS_ENV)
                .as_deref()
                .unwrap_or_default(),
        )
    }

    pub fn parse(value: &str) -> anyhow::Result<Self> {
        let networks = value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(parse_network)
            .collect::<anyhow::Result<_>>()?;
        Ok(Self { networks })
    }

    pub fn is_metrics_peer_allowed(&self, peer: &SocketAddr) -> bool {
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

#[derive(Clone)]
pub struct HttpState {
    pub is_serving: Arc<AtomicBool>,
    pub metrics: Arc<ServiceMetrics>,
    pub service_name: String,
    pub metrics_allowed: Arc<MetricsAllowList>,
}

pub async fn run_http(
    addr: SocketAddr,
    is_serving: Arc<AtomicBool>,
    metrics: Arc<ServiceMetrics>,
    service_name: String,
) -> anyhow::Result<()> {
    let state = HttpState {
        is_serving,
        metrics,
        service_name,
        metrics_allowed: Arc::new(MetricsAllowList::from_env()?),
    };
    let app = Router::new()
        .route("/_health", get(readiness_check))
        .route("/_healthz", get(|| async { "OK" }))
        .route("/_metrics", get(metrics_handler))
        .with_state(state)
        .layer(middleware::from_fn(add_version_header));
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(addr = %addr, "health HTTP server listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn readiness_check(State(state): State<HttpState>) -> impl IntoResponse {
    if state.is_serving.load(Ordering::SeqCst) {
        (StatusCode::OK, "OK")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "NOT READY")
    }
}

async fn metrics_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<HttpState>,
) -> Response {
    if !state.metrics_allowed.is_metrics_peer_allowed(&peer) {
        return (StatusCode::FORBIDDEN, "FORBIDDEN").into_response();
    }
    let body = state.metrics.render_prometheus(&state.service_name);
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        body,
    )
        .into_response()
}

fn build_version() -> &'static str {
    static BUILD_VERSION: OnceLock<String> = OnceLock::new();
    BUILD_VERSION
        .get_or_init(|| {
            crate::config::optional_env("BUILD_VERSION").unwrap_or_else(|| "dev".to_owned())
        })
        .as_str()
}

async fn add_version_header(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(build_version()) {
        response.headers_mut().insert("x-fluxer-version", value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::MetricsAllowList;
    use std::net::SocketAddr;

    fn peer(value: &str) -> SocketAddr {
        value.parse().expect("valid socket address")
    }

    fn allowed(list: &MetricsAllowList, value: &str) -> bool {
        list.is_metrics_peer_allowed(&peer(value))
    }

    #[test]
    fn is_metrics_peer_allowed_accepts_loopback_with_an_empty_list() {
        let list = MetricsAllowList::default();
        assert!(allowed(&list, "127.0.0.1:5000"));
        assert!(allowed(&list, "127.0.0.2:5000"));
        assert!(allowed(&list, "[::1]:5000"));
        assert!(allowed(&list, "[::ffff:127.0.0.1]:5000"));
    }

    #[test]
    fn is_metrics_peer_allowed_rejects_remote_peers_with_an_empty_list() {
        let list = MetricsAllowList::default();
        assert!(!allowed(&list, "8.8.8.8:5000"));
        assert!(!allowed(&list, "10.77.0.3:5000"));
        assert!(!allowed(&list, "172.18.0.4:5000"));
        assert!(!allowed(&list, "[fe80::1]:5000"));
        assert!(!allowed(&list, "[::ffff:8.8.8.8]:5000"));
    }

    #[test]
    fn is_metrics_peer_allowed_accepts_peers_inside_configured_networks() {
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
    fn is_metrics_peer_allowed_handles_zero_length_prefixes() {
        let list = MetricsAllowList::parse("0.0.0.0/0,::/0").expect("valid allow list");
        assert!(allowed(&list, "8.8.8.8:5000"));
        assert!(allowed(&list, "[2001:db8::1]:5000"));
    }

    #[test]
    fn blank_allow_list_matches_the_default() {
        assert_eq!(
            MetricsAllowList::default(),
            MetricsAllowList::parse(" , ").expect("blank list")
        );
    }

    #[test]
    fn rejects_invalid_allow_list_entries() {
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
}
