//! The M1-frozen backend contract. Browser, Android, and iOS-simulator
//! implementations share these semantics and the same conformance suite.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use skeptic_contract::Platform;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DriverCapability {
    Navigate,
    Snapshot,
    Click,
    Fill,
    Type,
    Press,
    Hover,
    Check,
    Select,
    Scroll,
    Screenshot,
    Record,
    Console,
    Network,
    Performance,
    Accessibility,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitySet {
    values: BTreeSet<DriverCapability>,
}

impl CapabilitySet {
    pub fn new(values: impl IntoIterator<Item = DriverCapability>) -> Self {
        Self {
            values: values.into_iter().collect(),
        }
    }

    pub fn contains(&self, capability: DriverCapability) -> bool {
        self.values.contains(&capability)
    }

    pub fn iter(&self) -> impl Iterator<Item = DriverCapability> + '_ {
        self.values.iter().copied()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetSpec {
    pub platform: Platform,
    pub location: String,
    pub device: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentIdentity {
    pub document: String,
    pub frame: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementRef {
    pub id: String,
    pub backend_id: String,
    pub identity: DocumentIdentity,
    pub role: Option<String>,
    pub name: Option<String>,
}

pub trait Element: Send + Sync + fmt::Debug {
    fn reference(&self) -> &ElementRef;
}

impl Element for ElementRef {
    fn reference(&self) -> &ElementRef {
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettleState {
    Complete,
    TimedOut,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionResult {
    pub changed: bool,
    pub settle_state: SettleState,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotNode {
    pub role: String,
    pub name: String,
    pub reference: Option<ElementRef>,
    #[serde(default)]
    pub children: Vec<SnapshotNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub identity: DocumentIdentity,
    pub root: SnapshotNode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverErrorCode {
    StaleRef,
    UnsupportedOnPlatform,
    TargetUnreachable,
    Timeout,
    PolicyBlocked,
    Internal,
}

impl DriverErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StaleRef => "E_STALE_REF",
            Self::UnsupportedOnPlatform => "E_UNSUPPORTED_ON_PLATFORM",
            Self::TargetUnreachable => "E_TARGET_UNREACHABLE",
            Self::Timeout => "E_TIMEOUT",
            Self::PolicyBlocked => "E_POLICY_BLOCKED",
            Self::Internal => "E_INTERNAL",
        }
    }
}

#[derive(Debug, Error)]
#[error("{code}: {message}", code = .code.as_str())]
pub struct DriverError {
    pub code: DriverErrorCode,
    pub message: String,
    pub retryable: bool,
    pub hint: Option<String>,
}

impl DriverError {
    pub fn stale(reference: &str) -> Self {
        Self {
            code: DriverErrorCode::StaleRef,
            message: format!("reference {reference} is no longer attached to this document"),
            retryable: true,
            hint: Some("take a fresh snapshot and retry with the new reference".to_string()),
        }
    }

    pub fn unsupported(platform: Platform, capability: DriverCapability) -> Self {
        Self {
            code: DriverErrorCode::UnsupportedOnPlatform,
            message: format!("{capability:?} is unsupported on {platform:?}"),
            retryable: false,
            hint: None,
        }
    }
}

#[async_trait]
pub trait Session: Send {
    fn id(&self) -> &str;
    fn platform(&self) -> Platform;
    fn capabilities(&self) -> &CapabilitySet;
    fn document_identity(&self) -> &DocumentIdentity;

    async fn navigate(&mut self, location: &str) -> Result<ActionResult, DriverError>;
    async fn snapshot(&mut self, interactive_only: bool) -> Result<Snapshot, DriverError>;
    async fn resolve(&mut self, reference: &str) -> Result<Box<dyn Element>, DriverError>;
    async fn click(&mut self, element: &dyn Element) -> Result<ActionResult, DriverError>;
    async fn screenshot(&mut self) -> Result<Vec<u8>, DriverError>;
    async fn close(&mut self) -> Result<(), DriverError>;
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn name(&self) -> &'static str;
    fn platform(&self) -> Platform;
    fn capabilities(&self) -> CapabilitySet;
    async fn open(
        &self,
        session_id: &str,
        target: &TargetSpec,
    ) -> Result<Box<dyn Session>, DriverError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseKind {
    Interactive { idle_ttl: Duration },
    Runner { heartbeat_ttl: Duration },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseClass {
    Interactive,
    Runner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableLease {
    pub class: LeaseClass,
    pub touched_at_ms: u64,
    pub expires_at_ms: u64,
}

impl DurableLease {
    pub fn new(class: LeaseClass, ttl: Duration) -> Self {
        let now = unix_time_ms();
        Self {
            class,
            touched_at_ms: now,
            expires_at_ms: now.saturating_add(ttl.as_millis() as u64),
        }
    }

    pub fn touch(&mut self, ttl: Duration) {
        let now = unix_time_ms();
        self.touched_at_ms = now;
        self.expires_at_ms = now.saturating_add(ttl.as_millis() as u64);
    }

    pub fn is_expired(&self) -> bool {
        self.expires_at_ms <= unix_time_ms()
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn enforce_session_capacity(active_sessions: usize, max_sessions: usize) -> Result<(), String> {
    if max_sessions == 0 {
        return Err("max_sessions must be greater than zero".to_string());
    }
    if active_sessions >= max_sessions {
        return Err(format!(
            "session limit {max_sessions} reached; close an existing session or raise session.maxSessions"
        ));
    }
    Ok(())
}

impl LeaseKind {
    fn ttl(self) -> Duration {
        match self {
            Self::Interactive { idle_ttl } => idle_ttl,
            Self::Runner { heartbeat_ttl } => heartbeat_ttl,
        }
    }
}

#[derive(Debug)]
pub struct SessionLease<T> {
    pub value: T,
    pub kind: LeaseKind,
    last_seen: Instant,
}

impl<T> SessionLease<T> {
    pub fn touch(&mut self) {
        self.last_seen = Instant::now();
    }

    pub fn expired_at(&self, now: Instant) -> bool {
        now.duration_since(self.last_seen) >= self.kind.ttl()
    }
}

#[derive(Debug)]
pub struct SessionRegistry<T> {
    max_sessions: usize,
    sessions: BTreeMap<(String, String), SessionLease<T>>,
}

impl<T> SessionRegistry<T> {
    pub fn new(max_sessions: usize) -> Result<Self, String> {
        if max_sessions == 0 {
            return Err("max_sessions must be greater than zero".to_string());
        }
        Ok(Self {
            max_sessions,
            sessions: BTreeMap::new(),
        })
    }

    pub fn insert(
        &mut self,
        namespace: impl Into<String>,
        name: impl Into<String>,
        kind: LeaseKind,
        value: T,
    ) -> Result<(), String> {
        let key = (namespace.into(), name.into());
        if self.sessions.contains_key(&key) {
            return Err(format!("session {}/{} already exists", key.0, key.1));
        }
        if self.sessions.len() >= self.max_sessions {
            return Err(format!("session limit {} reached", self.max_sessions));
        }
        self.sessions.insert(
            key,
            SessionLease {
                value,
                kind,
                last_seen: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn get_mut(&mut self, namespace: &str, name: &str) -> Option<&mut SessionLease<T>> {
        let lease = self
            .sessions
            .get_mut(&(namespace.to_string(), name.to_string()))?;
        lease.touch();
        Some(lease)
    }

    pub fn remove(&mut self, namespace: &str, name: &str) -> Option<T> {
        self.sessions
            .remove(&(namespace.to_string(), name.to_string()))
            .map(|lease| lease.value)
    }

    pub fn reap_expired_at(&mut self, now: Instant) -> Vec<(String, String, T)> {
        let expired: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, lease)| lease.expired_at(now))
            .map(|(key, _)| key.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|key| {
                self.sessions
                    .remove(&key)
                    .map(|lease| (key.0, key.1, lease.value))
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// Shared conformance scenario. Production backends and deterministic fakes
/// call this same routine so stale-ref and capability semantics cannot drift.
pub async fn run_conformance(driver: &dyn Driver, target: TargetSpec) -> Result<(), DriverError> {
    fn first_reference(node: &SnapshotNode) -> Option<&ElementRef> {
        node.reference
            .as_ref()
            .or_else(|| node.children.iter().find_map(first_reference))
    }

    let mut session = driver.open("conformance", &target).await?;
    if !session.capabilities().contains(DriverCapability::Snapshot) {
        return Err(DriverError::unsupported(
            session.platform(),
            DriverCapability::Snapshot,
        ));
    }
    session.navigate(&target.location).await?;
    let snapshot = session.snapshot(true).await?;
    if let Some(reference) = first_reference(&snapshot.root) {
        let element = session.resolve(&reference.id).await?;
        session.click(element.as_ref()).await?;
        let stale = session.resolve(&reference.id).await;
        if !matches!(
            stale,
            Err(DriverError {
                code: DriverErrorCode::StaleRef,
                ..
            })
        ) {
            return Err(DriverError {
                code: DriverErrorCode::Internal,
                message: "backend retained a ref after an action invalidated its snapshot".into(),
                retryable: false,
                hint: None,
            });
        }
    }
    if session.screenshot().await?.is_empty() {
        return Err(DriverError {
            code: DriverErrorCode::Internal,
            message: "backend returned an empty screenshot".into(),
            retryable: false,
            hint: None,
        });
    }
    session.close().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeDriver;

    struct FakeSession {
        id: String,
        identity: DocumentIdentity,
        refs: BTreeMap<String, ElementRef>,
        capabilities: CapabilitySet,
    }

    #[async_trait]
    impl Driver for FakeDriver {
        fn name(&self) -> &'static str {
            "fake-web"
        }

        fn platform(&self) -> Platform {
            Platform::Web
        }

        fn capabilities(&self) -> CapabilitySet {
            CapabilitySet::new([
                DriverCapability::Navigate,
                DriverCapability::Snapshot,
                DriverCapability::Click,
                DriverCapability::Screenshot,
            ])
        }

        async fn open(
            &self,
            session_id: &str,
            _target: &TargetSpec,
        ) -> Result<Box<dyn Session>, DriverError> {
            Ok(Box::new(FakeSession {
                id: session_id.to_string(),
                identity: DocumentIdentity {
                    document: "doc-1".to_string(),
                    frame: None,
                },
                refs: BTreeMap::new(),
                capabilities: self.capabilities(),
            }))
        }
    }

    #[async_trait]
    impl Session for FakeSession {
        fn id(&self) -> &str {
            &self.id
        }

        fn platform(&self) -> Platform {
            Platform::Web
        }

        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }

        fn document_identity(&self) -> &DocumentIdentity {
            &self.identity
        }

        async fn navigate(&mut self, location: &str) -> Result<ActionResult, DriverError> {
            self.identity.document = format!("doc:{location}");
            self.refs.clear();
            Ok(ActionResult {
                changed: true,
                settle_state: SettleState::Complete,
                data: Value::Null,
            })
        }

        async fn snapshot(&mut self, _interactive_only: bool) -> Result<Snapshot, DriverError> {
            let reference = ElementRef {
                id: "e1".to_string(),
                backend_id: "node-1".to_string(),
                identity: self.identity.clone(),
                role: Some("button".to_string()),
                name: Some("Continue".to_string()),
            };
            self.refs.insert(reference.id.clone(), reference.clone());
            Ok(Snapshot {
                identity: self.identity.clone(),
                root: SnapshotNode {
                    role: "button".to_string(),
                    name: "Continue".to_string(),
                    reference: Some(reference),
                    children: Vec::new(),
                },
            })
        }

        async fn resolve(&mut self, reference: &str) -> Result<Box<dyn Element>, DriverError> {
            self.refs
                .get(reference)
                .cloned()
                .map(|element| Box::new(element) as Box<dyn Element>)
                .ok_or_else(|| DriverError::stale(reference))
        }

        async fn click(&mut self, element: &dyn Element) -> Result<ActionResult, DriverError> {
            if element.reference().identity != self.identity {
                return Err(DriverError::stale(&element.reference().id));
            }
            self.refs.clear();
            Ok(ActionResult {
                changed: true,
                settle_state: SettleState::Complete,
                data: Value::Null,
            })
        }

        async fn screenshot(&mut self) -> Result<Vec<u8>, DriverError> {
            Ok(vec![137, 80, 78, 71])
        }

        async fn close(&mut self) -> Result<(), DriverError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn fake_backend_passes_shared_conformance() {
        run_conformance(
            &FakeDriver,
            TargetSpec {
                platform: Platform::Web,
                location: "https://example.test".to_string(),
                device: None,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn references_are_invalid_after_navigation() {
        let mut session = FakeDriver
            .open(
                "stale",
                &TargetSpec {
                    platform: Platform::Web,
                    location: "about:blank".to_string(),
                    device: None,
                },
            )
            .await
            .unwrap();
        session.navigate("https://one.test").await.unwrap();
        let snapshot = session.snapshot(true).await.unwrap();
        let reference = snapshot.root.reference.unwrap();
        session.navigate("https://two.test").await.unwrap();
        let error = session.resolve(&reference.id).await.unwrap_err();
        assert_eq!(error.code, DriverErrorCode::StaleRef);
    }

    #[test]
    fn registry_enforces_namespaces_limits_and_ttl() {
        let mut registry = SessionRegistry::new(1).unwrap();
        registry
            .insert(
                "repo-a",
                "default",
                LeaseKind::Interactive {
                    idle_ttl: Duration::from_millis(10),
                },
                42,
            )
            .unwrap();
        assert!(registry
            .insert(
                "repo-b",
                "default",
                LeaseKind::Interactive {
                    idle_ttl: Duration::from_secs(1),
                },
                7,
            )
            .is_err());
        let now = Instant::now() + Duration::from_millis(11);
        assert_eq!(registry.reap_expired_at(now)[0].2, 42);
    }

    #[test]
    fn durable_leases_touch_and_capacity_is_fail_closed() {
        let mut lease = DurableLease::new(LeaseClass::Runner, Duration::from_secs(1));
        let initial_expiry = lease.expires_at_ms;
        lease.touch(Duration::from_secs(2));
        assert!(lease.expires_at_ms >= initial_expiry);
        assert!(!lease.is_expired());
        assert!(enforce_session_capacity(7, 8).is_ok());
        assert!(enforce_session_capacity(8, 8).is_err());
        assert!(enforce_session_capacity(0, 0).is_err());
    }
}
