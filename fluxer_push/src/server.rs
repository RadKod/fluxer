// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::config::{Config, DeliveryConfig};
use crate::delivery;
use crate::metrics::Metrics;
use crate::relay;
use crate::relay_consent::{self, RelayConsentStore};
use crate::rpc::RpcClient;
use crate::secret::SecretString;
use crate::tokens::TokenCache;
use crate::vendor;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use fluxer_svc::server::MetricsAllowList;
use fluxer_svc::shutdown::{DEFAULT_DRAIN_TIMEOUT, drain_with_timeout, wait_for_shutdown};
use fluxer_svc::transport::NatsTransport;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tracing::info;

const JOB_DRAIN_TIMEOUT: Duration = Duration::from_secs(25);

pub struct Sidecar {
    metrics: Arc<Metrics>,
    serving: AtomicBool,
}

impl Sidecar {
    pub fn new(metrics: Arc<Metrics>) -> Self {
        Self {
            metrics,
            serving: AtomicBool::new(false),
        }
    }

    pub fn set_serving(&self, serving: bool) {
        self.serving.store(serving, Ordering::SeqCst);
    }
}

pub fn sidecar_router(sidecar: Arc<Sidecar>) -> Router {
    Router::new()
        .route("/_health", get(readiness))
        .route("/_healthz", get(async || "OK"))
        .route("/_metrics", get(metrics_handler))
        .with_state(sidecar)
}

pub struct Serving {
    stop: oneshot::Sender<()>,
    served: JoinHandle<std::io::Result<()>>,
}

impl Serving {
    pub async fn stop(self) {
        let _ = self.stop.send(());
        drain_with_timeout(
            async {
                let _ = self.served.await;
            },
            DEFAULT_DRAIN_TIMEOUT,
        )
        .await;
    }
}

pub async fn serve(addr: SocketAddr, router: Router) -> anyhow::Result<Serving> {
    let router = router.layer(Extension(Arc::new(MetricsAllowList::from_env()?)));
    let listener = TcpListener::bind(addr).await?;
    let (stop, stopped) = oneshot::channel::<()>();
    let served = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stopped.await;
        })
        .await
    });
    Ok(Serving { stop, served })
}

pub struct AppState {
    pub(crate) cfg: DeliveryConfig,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) sidecar: Arc<Sidecar>,
    pub(crate) relay_consent: RelayConsentStore,
    pub(crate) rpc: RpcClient,
    pub(crate) http: reqwest::Client,
    pub(crate) web_push_http: reqwest::Client,
    pub(crate) apns_http: reqwest::Client,
    pub(crate) tokens: TokenCache,
    pub(crate) draining: watch::Sender<bool>,
}

impl AppState {
    pub(crate) fn try_new(cfg: DeliveryConfig) -> anyhow::Result<Self> {
        let metrics = Arc::new(Metrics::new());
        let relay_consent = RelayConsentStore::new(cfg.relay_consent_accepted);
        metrics.record_relay_consent_accepted(relay_consent.accepted());
        let http = vendor::http_client()?;
        Ok(Self {
            rpc: RpcClient::new(&cfg.rpc, http.clone(), Arc::clone(&metrics)),
            relay_consent,
            sidecar: Arc::new(Sidecar::new(Arc::clone(&metrics))),
            web_push_http: vendor::web_push_http_client(&cfg.private_hosts)?,
            apns_http: vendor::apns_http_client()?,
            tokens: TokenCache::new(),
            draining: watch::Sender::new(false),
            cfg,
            metrics,
            http,
        })
    }
}

pub async fn run(cfg: Config) -> anyhow::Result<()> {
    match cfg {
        Config::Delivery(cfg) => run_delivery(*cfg).await,
        Config::Relay(cfg) => relay::run(*cfg).await,
    }
}

async fn run_delivery(cfg: DeliveryConfig) -> anyhow::Result<()> {
    let state = Arc::new(AppState::try_new(cfg)?);
    let addr = state.cfg.bind_addr;
    let serving = serve(addr, sidecar_router(Arc::clone(&state.sidecar))).await?;
    info!(%addr, vapid_subject = state.cfg.vapid.email, "push sidecar listening");

    let transport = NatsTransport::connect(
        &state.cfg.nats.url,
        state.cfg.nats.auth_token.as_ref().map(SecretString::expose),
    )
    .await?;

    state.sidecar.set_serving(true);

    let subscriber = tokio::spawn({
        let transport = transport.clone();
        let state = Arc::clone(&state);
        async move {
            relay_consent::run_subscriber(
                transport,
                &state.rpc,
                &state.relay_consent,
                &state.metrics,
                relay_consent::RECONCILE_INTERVAL,
            )
            .await
        }
    });
    let jobs = tokio::spawn(delivery::run_job_subscribers(transport, Arc::clone(&state)));

    wait_for_shutdown().await;
    state.sidecar.set_serving(false);
    subscriber.abort();
    drain_jobs(&state, jobs, JOB_DRAIN_TIMEOUT).await;
    serving.stop().await;
    Ok(())
}

async fn drain_jobs(state: &AppState, jobs: JoinHandle<()>, timeout: Duration) {
    state.draining.send_replace(true);
    let running = jobs.abort_handle();
    drain_with_timeout(
        async {
            let _ = jobs.await;
        },
        timeout,
    )
    .await;
    running.abort();
}

async fn readiness(State(sidecar): State<Arc<Sidecar>>) -> impl IntoResponse {
    if sidecar.serving.load(Ordering::SeqCst) {
        (StatusCode::OK, "OK")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "NOT READY")
    }
}

async fn metrics_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(allowed): Extension<Arc<MetricsAllowList>>,
    State(sidecar): State<Arc<Sidecar>>,
) -> Response {
    if !allowed.is_metrics_peer_allowed(&peer) {
        return (StatusCode::FORBIDDEN, "FORBIDDEN").into_response();
    }
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        sidecar.metrics.render(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn metrics_status(allowed: &str, peer: &str) -> StatusCode {
        let sidecar = Arc::new(Sidecar::new(Arc::new(Metrics::new())));
        let allowed = Arc::new(MetricsAllowList::parse(allowed).expect("valid allow list"));
        let peer = peer.parse().expect("valid socket address");
        metrics_handler(ConnectInfo(peer), Extension(allowed), State(sidecar))
            .await
            .status()
    }

    #[tokio::test]
    async fn metrics_are_served_to_loopback_and_allowed_networks_only() {
        assert_eq!(StatusCode::OK, metrics_status("", "127.0.0.1:5000").await);
        assert_eq!(
            StatusCode::FORBIDDEN,
            metrics_status("", "10.77.0.3:5000").await
        );
        assert_eq!(
            StatusCode::OK,
            metrics_status("10.77.0.0/24", "10.77.0.3:5000").await
        );
        assert_eq!(
            StatusCode::FORBIDDEN,
            metrics_status("10.77.0.0/24", "10.77.1.3:5000").await
        );
    }

    #[tokio::test]
    async fn serve_installs_the_metrics_allow_list() {
        let addr = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .expect("free loopback port");
        let sidecar = Arc::new(Sidecar::new(Arc::new(Metrics::new())));
        let serving = serve(addr, sidecar_router(sidecar))
            .await
            .expect("sidecar serves");
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connects to the sidecar");
        stream
            .write_all(b"GET /_metrics HTTP/1.1\r\nHost: sidecar\r\nConnection: close\r\n\r\n")
            .await
            .expect("sends the request");
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .await
            .expect("reads the response");
        serving.stop().await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }
}
