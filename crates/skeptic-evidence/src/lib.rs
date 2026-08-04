//! Durable evidence primitives shared by interactive sessions, deterministic
//! spec runs, analyzers, and reports.

#![forbid(unsafe_code)]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use skeptic_contract::{EventEnvelope, EvidenceRef, RedactionState, Sensitivity, EVENT_SCHEMA};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarkerKind {
    StepStart,
    StepDone,
    AssertionFailed,
    RunCompleted,
}

impl MarkerKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "STEP_START" => Ok(Self::StepStart),
            "STEP_DONE" => Ok(Self::StepDone),
            "ASSERTION_FAILED" => Ok(Self::AssertionFailed),
            "RUN_COMPLETED" => Ok(Self::RunCompleted),
            _ => Err(format!(
                "unknown marker `{value}`; expected STEP_START, STEP_DONE, ASSERTION_FAILED, or RUN_COMPLETED"
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkerPayload {
    pub kind: MarkerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
    run_id: Option<String>,
    session_id: Option<String>,
}

impl Journal {
    pub fn for_session(path: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            run_id: None,
            session_id: Some(session_id.into()),
        }
    }

    pub fn for_run(path: impl Into<PathBuf>, run_id: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            run_id: Some(run_id.into()),
            session_id: None,
        }
    }

    pub fn for_run_session(
        path: impl Into<PathBuf>,
        run_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            run_id: Some(run_id.into()),
            session_id: Some(session_id.into()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(
        &self,
        event_type: impl Into<String>,
        payload: Value,
        correlation_id: Option<String>,
    ) -> Result<EventEnvelope, String> {
        ensure_parent(&self.path)?;
        let mut file = secure_append_file(&self.path)?;
        file.lock_exclusive()
            .map_err(|error| format!("cannot lock {}: {error}", self.path.display()))?;

        let existing = read_events(&file)?;
        let stream_id = existing
            .first()
            .map(|event| event.stream_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let sequence = existing.last().map_or(1, |event| event.sequence + 1);
        let event = EventEnvelope {
            schema: EVENT_SCHEMA.to_string(),
            stream_id,
            sequence,
            event_type: event_type.into(),
            run_id: self.run_id.clone(),
            session_id: self.session_id.clone(),
            timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            correlation_id,
            payload,
        };
        event.validate().map_err(|error| error.to_string())?;
        let encoded = serde_json::to_vec(&event)
            .map_err(|error| format!("cannot serialize journal event: {error}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("cannot append {}: {error}", self.path.display()))?;
        file.unlock()
            .map_err(|error| format!("cannot unlock {}: {error}", self.path.display()))?;
        Ok(event)
    }

    pub fn append_marker(&self, marker: MarkerPayload) -> Result<EventEnvelope, String> {
        self.append(
            "marker",
            serde_json::to_value(marker)
                .map_err(|error| format!("cannot serialize marker: {error}"))?,
            None,
        )
    }

    pub fn events(&self) -> Result<Vec<EventEnvelope>, String> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(&self.path)
            .map_err(|error| format!("cannot read {}: {error}", self.path.display()))?;
        read_events(&file)
    }
}

fn read_events(file: &File) -> Result<Vec<EventEnvelope>, String> {
    let reader = BufReader::new(
        file.try_clone()
            .map_err(|error| format!("cannot clone journal handle: {error}"))?,
    );
    reader
        .lines()
        .enumerate()
        .filter_map(|(index, line)| match line {
            Ok(line) if line.trim().is_empty() => None,
            other => Some((index, other)),
        })
        .map(|(index, line)| {
            let line = line.map_err(|error| format!("cannot read journal: {error}"))?;
            let event: EventEnvelope = serde_json::from_str(&line)
                .map_err(|error| format!("invalid journal line {}: {error}", index + 1))?;
            event.validate().map_err(|error| error.to_string())?;
            Ok(event)
        })
        .collect()
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot secure {}: {error}", parent.display()))?;
    }
    Ok(())
}

fn secure_append_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))
}

pub fn safe_path_component(value: &str) -> String {
    let filtered: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if filtered.is_empty() || filtered == "." || filtered == ".." {
        "default".to_string()
    } else {
        filtered
    }
}

pub fn session_journal_path(project_root: &Path, namespace: &str, session: &str) -> PathBuf {
    project_root
        .join(".skeptic")
        .join("sessions")
        .join(safe_path_component(namespace))
        .join(safe_path_component(session))
        .join("events.ndjson")
}

pub fn run_directory(project_root: &Path, run_id: &str) -> PathBuf {
    project_root
        .join(".skeptic")
        .join("runs")
        .join(safe_path_component(run_id))
}

pub fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    ensure_parent(path)?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("cannot serialize {}: {error}", path.display()))?;
    bytes.push(b'\n');
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("cannot open {}: {error}", temporary.display()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| {
        format!(
            "cannot atomically replace {} with {}: {error}",
            path.display(),
            temporary.display()
        )
    })
}

pub fn evidence_ref(
    run_dir: &Path,
    path: &Path,
    kind: impl Into<String>,
    media_type: impl Into<String>,
    producer: impl Into<String>,
    sensitivity: Sensitivity,
    redaction: RedactionState,
) -> Result<EvidenceRef, String> {
    let rel_path = path
        .strip_prefix(run_dir)
        .map_err(|_| format!("{} is outside {}", path.display(), run_dir.display()))?;
    if rel_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("evidence path must be run-directory-relative".to_string());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("cannot read evidence {}: {error}", path.display()))?;
    let reference = EvidenceRef {
        kind: kind.into(),
        rel_path: rel_path.to_string_lossy().replace('\\', "/"),
        media_type: media_type.into(),
        bytes: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(&bytes)),
        producer: producer.into(),
        test_id: None,
        sensitivity,
        redaction,
    };
    reference.validate().map_err(|error| error.to_string())?;
    Ok(reference)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LatestRun {
    pub schema: String,
    pub run_id: String,
    pub manifest: String,
}

pub fn update_latest(project_root: &Path, run_id: &str) -> Result<(), String> {
    atomic_write_json(
        &project_root.join(".skeptic/runs/latest.json"),
        &LatestRun {
            schema: "skeptic.latest/1".to_string(),
            run_id: run_id.to_string(),
            manifest: format!("{}/manifest.json", safe_path_component(run_id)),
        },
    )
}

pub fn action_payload(action: &str, target: Option<&str>, outcome: &str) -> Value {
    json!({
        "action": action,
        "target": target,
        "outcome": outcome,
        "settleState": "complete"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_sequence_is_monotonic_across_handles() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.ndjson");
        let first = Journal::for_session(&path, "default");
        let second = Journal::for_session(&path, "default");
        assert_eq!(first.append("action", json!({}), None).unwrap().sequence, 1);
        assert_eq!(
            second.append("action", json!({}), None).unwrap().sequence,
            2
        );
        let events = first.events().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].stream_id, events[1].stream_id);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_json_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state/session.json");
        atomic_write_json(&path, &json!({"token":"private"})).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn evidence_hashes_and_rejects_outside_paths() {
        let temp = tempfile::tempdir().unwrap();
        let run = temp.path().join("run");
        fs::create_dir(&run).unwrap();
        let file = run.join("console.json");
        fs::write(&file, b"[]\n").unwrap();
        let reference = evidence_ref(
            &run,
            &file,
            "console",
            "application/json",
            "skeptic",
            Sensitivity::Normal,
            RedactionState::Redacted,
        )
        .unwrap();
        assert_eq!(reference.rel_path, "console.json");
        assert_eq!(reference.bytes, 3);
        assert_eq!(reference.sha256.len(), 64);
        assert!(evidence_ref(
            &run,
            temp.path(),
            "bad",
            "text/plain",
            "skeptic",
            Sensitivity::Normal,
            RedactionState::None,
        )
        .is_err());
    }

    #[test]
    fn marker_names_are_strict() {
        assert_eq!(
            MarkerKind::parse("STEP_START").unwrap(),
            MarkerKind::StepStart
        );
        assert!(MarkerKind::parse("step-start").is_err());
    }
}
