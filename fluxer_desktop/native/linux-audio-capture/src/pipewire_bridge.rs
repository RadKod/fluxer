// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use fluxer_screen_frame_bus::NativeScreenFrameSinkHandleRef;
use pipewire as pw;
use pw::channel::{Sender as PwSender, channel as pw_channel};

use fluxer_rt_thread::{MonotonicClock, SystemMonotonicClock};

use crate::audio_contract::DIRECT_CAPTURE_MAX_READ_SAMPLES;
use crate::backend::{CaptureBridge, CapturedFrame, DirectCapture, RoutingGraphSnapshot};
use crate::direct_buffer::DirectAudioBuffer;
use crate::pipewire::common::{
    InventorySnapshot, LinkKey, READY_TIMEOUT_MS, build_routing_graph_snapshot,
    daemon_reachable as common_daemon_reachable, next_direct_sink_name,
};
use crate::pipewire::event_loop::{
    BridgeCommand, DirectCommand, DirectWorkerInputs, run_bridge_worker, run_direct_worker,
};
use crate::pipewire::stream_ops::ScreenAudioSinkSlot;
use crate::routing::{PropMap, RoutingRule, SelfIdentity};

pub fn daemon_reachable() -> bool {
    common_daemon_reachable()
}

pub struct PipeWireBridge {
    snapshot: Arc<Mutex<InventorySnapshot>>,
    owned_link_snapshot: Arc<Mutex<Vec<LinkKey>>>,
    tx: PwSender<BridgeCommand>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl PipeWireBridge {
    pub fn open() -> Option<Self> {
        if !daemon_reachable() {
            return None;
        }
        let snapshot = Arc::new(Mutex::new(InventorySnapshot::default()));
        let owned_link_snapshot = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = pw_channel::<BridgeCommand>();
        let snap_for_thread = snapshot.clone();
        let links_for_thread = owned_link_snapshot.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<bool>(1);
        let handle = thread::Builder::new()
            .name("fluxer-pipewire-bridge".into())
            .spawn(move || {
                run_bridge_worker(snap_for_thread, links_for_thread, rx, ready_tx);
            })
            .ok()?;
        match ready_rx.recv_timeout(Duration::from_millis(READY_TIMEOUT_MS)) {
            Ok(true) => Some(Self {
                snapshot,
                owned_link_snapshot,
                tx,
                thread: Mutex::new(Some(handle)),
            }),
            _ => {
                let _ = tx.send(BridgeCommand::Shutdown);
                let _ = handle.join();
                None
            }
        }
    }
}

impl Drop for PipeWireBridge {
    fn drop(&mut self) {
        let _ = self.tx.send(BridgeCommand::Shutdown);
        if let Ok(mut thread) = self.thread.lock()
            && let Some(handle) = thread.take()
        {
            let _ = handle.join();
        }
    }
}

impl CaptureBridge for PipeWireBridge {
    fn inventory(&self) -> Vec<PropMap> {
        match self.snapshot.lock() {
            Ok(guard) => guard.enriched_node_values(),
            Err(_) => Vec::new(),
        }
    }

    fn apply(&self, rule: RoutingRule) -> bool {
        self.tx.send(BridgeCommand::Apply(rule)).is_ok()
    }

    fn release(&self) {
        let _ = self.tx.send(BridgeCommand::Release);
    }

    fn populate_self_identity(&self, identity: SelfIdentity) {
        let _ = self.tx.send(BridgeCommand::SetIdentity(identity));
    }

    fn backend_name(&self) -> &'static str {
        "pipewire"
    }

    fn routing_graph(&self) -> RoutingGraphSnapshot {
        build_routing_graph_snapshot("pipewire", &self.snapshot, &self.owned_link_snapshot)
    }
}

pub struct PipeWireDirectCapture {
    samples: Arc<Mutex<DirectAudioBuffer>>,
    inventory: Arc<Mutex<InventorySnapshot>>,
    owned_link_snapshot: Arc<Mutex<Vec<LinkKey>>>,
    tx: PwSender<DirectCommand>,
    thread: Mutex<Option<JoinHandle<()>>>,
    identity: Mutex<SelfIdentity>,
    #[allow(dead_code)]
    last_push_ns: Arc<AtomicU64>,
    screen_audio_sink: ScreenAudioSinkSlot,
}

impl PipeWireDirectCapture {
    pub fn open() -> Option<Self> {
        Self::open_with_clock(Arc::new(SystemMonotonicClock::new()))
    }

    pub fn open_with_clock(clock: Arc<dyn MonotonicClock>) -> Option<Self> {
        if !daemon_reachable() {
            return None;
        }
        let samples = Arc::new(Mutex::new(DirectAudioBuffer::default_format()));
        let inventory = Arc::new(Mutex::new(InventorySnapshot::default()));
        let owned_link_snapshot = Arc::new(Mutex::new(Vec::new()));
        let last_push_ns = Arc::new(AtomicU64::new(u64::MAX));
        let screen_audio_sink: ScreenAudioSinkSlot = Arc::new(RwLock::new(None));
        let (tx, rx) = pw_channel::<DirectCommand>();
        let sink_node_name = next_direct_sink_name();
        let inputs = DirectWorkerInputs {
            samples: samples.clone(),
            inventory: inventory.clone(),
            owned_link_snapshot: owned_link_snapshot.clone(),
            sink_node_name,
            last_push_ns: last_push_ns.clone(),
            clock,
            screen_audio_sink: screen_audio_sink.clone(),
        };
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<bool>(1);
        let handle = thread::Builder::new()
            .name("fluxer-pipewire-direct".into())
            .spawn(move || {
                run_direct_worker(inputs, rx, ready_tx);
            })
            .ok()?;
        match ready_rx.recv_timeout(Duration::from_millis(READY_TIMEOUT_MS)) {
            Ok(true) => Some(Self {
                samples,
                inventory,
                owned_link_snapshot,
                tx,
                thread: Mutex::new(Some(handle)),
                identity: Mutex::new(SelfIdentity::default()),
                last_push_ns,
                screen_audio_sink,
            }),
            _ => {
                let _ = tx.send(DirectCommand::Shutdown);
                let _ = handle.join();
                None
            }
        }
    }

    #[allow(dead_code)]
    pub fn last_push_ns(&self) -> u64 {
        self.last_push_ns.load(std::sync::atomic::Ordering::Acquire)
    }
}

impl Drop for PipeWireDirectCapture {
    fn drop(&mut self) {
        let _ = self.tx.send(DirectCommand::Shutdown);
        if let Ok(mut thread) = self.thread.lock()
            && let Some(handle) = thread.take()
        {
            let _ = handle.join();
        }
    }
}

impl DirectCapture for PipeWireDirectCapture {
    fn start(&self, rule: RoutingRule) -> bool {
        let Ok(identity) = self.identity.lock().map(|guard| guard.clone()) else {
            return false;
        };
        self.tx
            .send(DirectCommand::Start {
                rule,
                identity: Box::new(identity),
            })
            .is_ok()
    }

    fn set_rule(&self, rule: RoutingRule) -> bool {
        self.tx.send(DirectCommand::UpdateRule { rule }).is_ok()
    }

    fn read(&self) -> Option<CapturedFrame> {
        let mut out = Vec::with_capacity(DIRECT_CAPTURE_MAX_READ_SAMPLES);
        let meta = {
            let Ok(mut guard) = self.samples.lock() else {
                return None;
            };
            guard.read_into(&mut out)?
        };
        Some(CapturedFrame {
            samples: out,
            sample_rate: meta.sample_rate,
            channels: meta.channels,
            timestamp_us: meta.timestamp_us,
        })
    }

    fn stop(&self) {
        let _ = self.tx.send(DirectCommand::Stop);
    }

    fn set_screen_audio_sink(&self, sink: Arc<NativeScreenFrameSinkHandleRef>) {
        if let Ok(mut guard) = self.screen_audio_sink.write() {
            *guard = Some(sink);
        }
    }

    fn clear_screen_audio_sink(&self) {
        if let Ok(mut guard) = self.screen_audio_sink.write() {
            *guard = None;
        }
    }

    fn populate_self_identity(&self, identity: SelfIdentity) {
        if let Ok(mut guard) = self.identity.lock() {
            *guard = identity;
        }
    }

    fn routing_graph(&self) -> RoutingGraphSnapshot {
        build_routing_graph_snapshot("pipewire", &self.inventory, &self.owned_link_snapshot)
    }

    fn last_push_ns_arc(&self) -> Option<Arc<AtomicU64>> {
        Some(Arc::clone(&self.last_push_ns))
    }
}
