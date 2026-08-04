use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use skeptic_config::{filtered_environment, load, ConfigOverrides};
use skeptic_contract::{
    CapabilityAvailability, CapabilityExecution, CapabilityRecord, Completeness, Platform, Project,
    RedactionState, ResponseEnvelope, RunConfig, RunManifest, RunOutcome, Sensitivity, SideEffects,
    SourceInfo, SourceKind, Target, TestResult, TestStatus, RUN_SCHEMA,
};
use skeptic_evidence::{atomic_write_json, evidence_ref, run_directory, update_latest, Journal};
use skeptic_runner::{
    execute_file, ExecuteOptions, WorkerEvidence, WorkerResult, WorkerTarget, WorkerTestResult,
};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
    Ndjson,
    Junit,
}

impl Format {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "human" => Ok(Self::Human),
            "json" => Ok(Self::Json),
            "ndjson" => Ok(Self::Ndjson),
            "junit" => Ok(Self::Junit),
            _ => Err(format!(
                "run supports --format human, json, ndjson, or junit (got `{value}`)"
            )),
        }
    }
}

#[derive(Debug)]
struct RunOptions {
    files: Vec<PathBuf>,
    format: Format,
    output: Option<PathBuf>,
    config: Option<PathBuf>,
    retries: Option<u32>,
    shard: Option<(usize, usize)>,
}

enum ProgressDestination {
    Stdout,
    File(fs::File),
}

#[derive(Clone)]
struct NdjsonProgress {
    destination: Arc<Mutex<ProgressDestination>>,
}

impl NdjsonProgress {
    fn new(path: Option<&Path>) -> Result<Self, String> {
        let destination = if let Some(path) = path {
            if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            ProgressDestination::File(fs::File::create(path).map_err(|error| error.to_string())?)
        } else {
            ProgressDestination::Stdout
        };
        Ok(Self {
            destination: Arc::new(Mutex::new(destination)),
        })
    }

    fn write_value(&self, value: &impl serde::Serialize) -> Result<(), String> {
        let mut destination = self
            .destination
            .lock()
            .map_err(|_| "NDJSON output lock poisoned".to_string())?;
        match &mut *destination {
            ProgressDestination::Stdout => {
                let stdout = std::io::stdout();
                let mut writer = stdout.lock();
                serde_json::to_writer(&mut writer, value).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(|error| error.to_string())?;
                writer.flush().map_err(|error| error.to_string())
            }
            ProgressDestination::File(writer) => {
                serde_json::to_writer(&mut *writer, value).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(|error| error.to_string())?;
                writer.flush().map_err(|error| error.to_string())
            }
        }
    }

    fn append_event(
        &self,
        journal: &Journal,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        // Hold the destination lock across journal append + output so concurrent
        // workers cannot publish sequence N+1 before sequence N.
        let mut destination = self
            .destination
            .lock()
            .map_err(|_| "NDJSON output lock poisoned".to_string())?;
        let event = journal.append(event_type, payload, None)?;
        match &mut *destination {
            ProgressDestination::Stdout => {
                let stdout = std::io::stdout();
                let mut writer = stdout.lock();
                serde_json::to_writer(&mut writer, &event).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(|error| error.to_string())?;
                writer.flush().map_err(|error| error.to_string())
            }
            ProgressDestination::File(writer) => {
                serde_json::to_writer(&mut *writer, &event).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(|error| error.to_string())?;
                writer.flush().map_err(|error| error.to_string())
            }
        }
    }
}

fn publish_event(
    progress: Option<&NdjsonProgress>,
    journal: &Journal,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    if let Some(progress) = progress {
        progress.append_event(journal, event_type, payload)
    } else {
        journal.append(event_type, payload, None).map(|_| ())
    }
}

fn parse_shard(value: &str) -> Result<(usize, usize), String> {
    let (index, total) = value
        .split_once('/')
        .ok_or_else(|| "--shard must be INDEX/TOTAL".to_string())?;
    let index = index
        .parse::<usize>()
        .map_err(|_| "shard index must be an integer".to_string())?;
    let total = total
        .parse::<usize>()
        .map_err(|_| "shard total must be an integer".to_string())?;
    if index == 0 || total == 0 || index > total {
        return Err("shard must satisfy 1 <= INDEX <= TOTAL".to_string());
    }
    Ok((index, total))
}

fn parse_run_options(args: &[String]) -> Result<RunOptions, String> {
    let mut options = RunOptions {
        files: Vec::new(),
        format: Format::Human,
        output: None,
        config: None,
        retries: None,
        shard: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => options.format = Format::Json,
            "--format" => {
                options.format = Format::parse(
                    args.get(index + 1)
                        .ok_or_else(|| "--format requires a value".to_string())?,
                )?;
                index += 1;
            }
            "--output" => {
                options.output = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--output requires a path".to_string())?,
                ));
                index += 1;
            }
            "--config" => {
                options.config = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--config requires a path".to_string())?,
                ));
                index += 1;
            }
            "--retries" => {
                options.retries = Some(
                    args.get(index + 1)
                        .ok_or_else(|| "--retries requires a value".to_string())?
                        .parse()
                        .map_err(|_| "--retries must be an unsigned integer".to_string())?,
                );
                index += 1;
            }
            "--shard" => {
                options.shard =
                    Some(parse_shard(args.get(index + 1).ok_or_else(|| {
                        "--shard requires INDEX/TOTAL".to_string()
                    })?)?);
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown run option `{value}`"));
            }
            value => options.files.push(PathBuf::from(value)),
        }
        index += 1;
    }
    Ok(options)
}

fn project_root(start: &Path) -> PathBuf {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        let Some(parent) = current.parent() else {
            return start.to_path_buf();
        };
        current = parent.to_path_buf();
    }
}

fn is_spec(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    [
        ".spec.ts",
        ".spec.tsx",
        ".spec.js",
        ".spec.jsx",
        ".spec.mjs",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

fn discover(root: &Path, requested: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let starts = if requested.is_empty() {
        vec![root.to_path_buf()]
    } else {
        requested
            .iter()
            .map(|path| {
                if path.is_absolute() {
                    path.clone()
                } else {
                    root.join(path)
                }
            })
            .collect()
    };
    let mut files = Vec::new();
    for start in starts {
        if start.is_file() {
            if !is_spec(&start) {
                return Err(format!("{} is not a supported spec file", start.display()));
            }
            files.push(start);
            continue;
        }
        if !start.exists() {
            return Err(format!("{} does not exist", start.display()));
        }
        files.extend(
            WalkDir::new(&start)
                .into_iter()
                .filter_entry(|entry| {
                    !matches!(
                        entry.file_name().to_str(),
                        Some(".git" | ".skeptic" | "node_modules" | "target")
                    )
                })
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && is_spec(entry.path()))
                .map(|entry| entry.into_path()),
        );
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn sibling_binary(name: &str) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(if name == "skeptic" {
        "SKEPTIC_BIN"
    } else {
        "SKEPTIC_RUNNER_BIN"
    }) {
        return Ok(PathBuf::from(path));
    }
    let current = env::current_exe().map_err(|error| error.to_string())?;
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let sibling = current.with_file_name(filename);
    if sibling.is_file() {
        Ok(sibling)
    } else {
        Err(format!(
            "cannot find {name} next to {}; set {}",
            current.display(),
            if name == "skeptic" {
                "SKEPTIC_BIN"
            } else {
                "SKEPTIC_RUNNER_BIN"
            }
        ))
    }
}

fn test_status(status: &str) -> TestStatus {
    match status {
        "passed" => TestStatus::Passed,
        "skipped" => TestStatus::Skipped,
        "timed-out" => TestStatus::TimedOut,
        "errored" => TestStatus::Errored,
        _ => TestStatus::Failed,
    }
}

fn manifest_target(target: &WorkerTarget) -> Result<Target, String> {
    let platform = match target.platform.as_str() {
        "web" => Platform::Web,
        "android" => Platform::Android,
        "ios" | "ios-sim" => Platform::IosSim,
        value => return Err(format!("unsupported worker target platform `{value}`")),
    };
    Ok(Target {
        platform,
        url: None,
        app: target.app.clone(),
        device: target.device.clone(),
    })
}

fn file_key(path: &Path) -> String {
    hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))[..12].to_string()
}

#[allow(clippy::too_many_arguments)]
fn execute_worker(
    runner_bin: &Path,
    skeptic_bin: &Path,
    root: &Path,
    config: Option<&Path>,
    file: &Path,
    session: &str,
    result_path: &Path,
    hard_timeout_ms: u64,
) -> Result<WorkerResult, String> {
    let mut command = Command::new(runner_bin);
    command
        .arg("__worker")
        .arg(file)
        .arg("--root")
        .arg(root)
        .arg("--skeptic-bin")
        .arg(skeptic_bin)
        .arg("--session")
        .arg(session)
        .arg("--result")
        .arg(result_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(config) = config {
        command.arg("--config").arg(config);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_millis(hard_timeout_ms + 1_000);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            if !result_path.is_file() {
                return Err(format!("spec worker exited {status} without a result"));
            }
            let bytes = fs::read(result_path).map_err(|error| error.to_string())?;
            return serde_json::from_slice(&bytes).map_err(|error| error.to_string());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(WorkerResult {
                tests: vec![WorkerTestResult {
                    title: file.display().to_string(),
                    status: "timed-out".to_string(),
                    duration_ms: hard_timeout_ms,
                    error: Some(format!("hard timeout after {hard_timeout_ms}ms")),
                    assertion: None,
                    session: None,
                    target: WorkerTarget::default(),
                    evidence: Vec::new(),
                }],
                console: Vec::new(),
                sidecars: Vec::new(),
            });
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_file_attempts(
    runner_bin: &Path,
    skeptic_bin: &Path,
    root: &Path,
    config: Option<&Path>,
    file: &Path,
    relative: &str,
    run_id: &str,
    run_dir: &Path,
    journal: &Journal,
    progress: Option<&NdjsonProgress>,
    retries: u32,
    hard_timeout_ms: u64,
) -> Result<WorkerResult, String> {
    let mut final_result = None;
    for attempt in 0..=retries {
        let session = format!(
            "run-{}-{}-{}",
            &run_id[run_id.len().saturating_sub(8)..],
            file_key(file),
            attempt + 1
        );
        let result_path =
            run_dir
                .join("worker")
                .join(format!("{}-{}.json", file_key(file), attempt + 1));
        publish_event(
            progress,
            journal,
            "attempt-start",
            json!({"file": relative, "attempt": attempt + 1, "session": session}),
        )?;
        let result = execute_worker(
            runner_bin,
            skeptic_bin,
            root,
            config,
            file,
            &session,
            &result_path,
            hard_timeout_ms,
        )?;
        let passed = result
            .tests
            .iter()
            .all(|test| matches!(test.status.as_str(), "passed" | "skipped"));
        for test in &result.tests {
            publish_event(
                progress,
                journal,
                "test-complete",
                json!({"file": relative, "attempt": attempt + 1, "test": test}),
            )?;
        }
        publish_event(
            progress,
            journal,
            "attempt-complete",
            json!({"file": relative, "attempt": attempt + 1, "passed": passed, "tests": result.tests}),
        )?;
        final_result = Some(result);
        if passed {
            break;
        }
    }
    final_result.ok_or_else(|| "worker did not execute an attempt".to_string())
}

fn redact_console_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                    let sensitive = [
                        "authorization",
                        "cookie",
                        "password",
                        "passwd",
                        "secret",
                        "accesstoken",
                        "refreshtoken",
                        "apikey",
                    ]
                    .iter()
                    .any(|candidate| normalized.contains(candidate));
                    (
                        key,
                        if sensitive {
                            serde_json::Value::String("[REDACTED]".into())
                        } else {
                            redact_console_value(value)
                        },
                    )
                })
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(redact_console_value).collect())
        }
        serde_json::Value::String(mut text) => {
            let bearer = Regex::new(r"(?i)bearer\s+[a-z0-9._~+/-]+=*").expect("valid regex");
            text = bearer.replace_all(&text, "Bearer [REDACTED]").into_owned();
            let query = Regex::new(
                r"(?i)([?&](?:token|access_token|refresh_token|api_key|apikey|password|secret)=)[^&#\s]+",
            )
            .expect("valid regex");
            serde_json::Value::String(query.replace_all(&text, "$1[REDACTED]").into_owned())
        }
        value => value,
    }
}

fn routed_action(
    skeptic_bin: &Path,
    session: &str,
    target: &WorkerTarget,
    args: &[&str],
    output: Option<&Path>,
) -> bool {
    let mut command = Command::new(skeptic_bin);
    command
        .arg("--session")
        .arg(session)
        .arg("--format")
        .arg("json");
    if let Some(output) = output {
        command.arg("--output").arg(output);
    }
    command.args(args);
    if target.platform != "web" {
        command.arg("--platform").arg(&target.platform);
    }
    if let Some(device) = target.device.as_deref() {
        command.arg("--device").arg(device);
    }
    let succeeded = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    succeeded && output.is_none_or(Path::is_file)
}

fn collect_worker_evidence(
    skeptic_bin: &Path,
    session: &str,
    target: &WorkerTarget,
    result_path: &Path,
    suffix: &str,
    failed: bool,
) -> Vec<WorkerEvidence> {
    let directory = result_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = result_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("worker");
    let mut evidence = Vec::new();
    if target.platform == "web" {
        for (kind, arguments) in [
            ("network", vec!["network", "requests"]),
            ("browser-console", vec!["console"]),
            ("a11y", vec!["audit"]),
            ("performance", vec!["vitals"]),
        ] {
            let path = directory.join(format!("{stem}-{suffix}-{kind}.json"));
            if routed_action(skeptic_bin, session, target, &arguments, Some(&path)) {
                evidence.push(WorkerEvidence {
                    kind: kind.into(),
                    path,
                    media_type: "application/json".into(),
                    sensitive: false,
                    redacted: true,
                    session: Some(session.to_string()),
                    target: Some(target.clone()),
                });
            }
        }
        let har = directory.join(format!("{stem}-{suffix}.har"));
        let har_value = har.to_string_lossy().to_string();
        if routed_action(
            skeptic_bin,
            session,
            target,
            &["network", "har", "stop", &har_value],
            None,
        ) && har.is_file()
        {
            evidence.push(WorkerEvidence {
                kind: "har".into(),
                path: har,
                media_type: "application/har+json".into(),
                sensitive: false,
                redacted: true,
                session: Some(session.to_string()),
                target: Some(target.clone()),
            });
        }
    }
    if failed {
        let snapshot = directory.join(format!("{stem}-{suffix}-failure-snapshot.json"));
        if routed_action(
            skeptic_bin,
            session,
            target,
            &["snapshot", "-i"],
            Some(&snapshot),
        ) {
            evidence.push(WorkerEvidence {
                kind: "snapshot".into(),
                path: snapshot,
                media_type: "application/json".into(),
                sensitive: false,
                redacted: true,
                session: Some(session.to_string()),
                target: Some(target.clone()),
            });
        }
        let screenshot = directory.join(format!("{stem}-{suffix}-failure.png"));
        let metadata = directory.join(format!("{stem}-{suffix}-failure-screenshot.json"));
        let screenshot_value = screenshot.to_string_lossy().to_string();
        if routed_action(
            skeptic_bin,
            session,
            target,
            &["screenshot", &screenshot_value],
            Some(&metadata),
        ) && screenshot.is_file()
        {
            evidence.push(WorkerEvidence {
                kind: "screenshot".into(),
                path: screenshot,
                media_type: "image/png".into(),
                sensitive: true,
                redacted: false,
                session: Some(session.to_string()),
                target: Some(target.clone()),
            });
        }
    }
    evidence
}

fn attach_failure_evidence(
    result: &mut WorkerResult,
    result_path: &Path,
    default_session: &str,
) -> Result<(), String> {
    let run_dir = result_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "worker result path must be nested under the run directory".to_string())?;
    for test in result
        .tests
        .iter_mut()
        .filter(|test| !matches!(test.status.as_str(), "passed" | "skipped"))
    {
        let session = test.session.as_deref().unwrap_or(default_session);
        let mut references = Vec::new();
        for sidecar in result.sidecars.iter().filter(|sidecar| {
            matches!(sidecar.kind.as_str(), "snapshot" | "screenshot")
                && sidecar.session.as_deref() == Some(session)
                && sidecar.target.as_ref() == Some(&test.target)
        }) {
            references.push(evidence_ref(
                run_dir,
                &sidecar.path,
                &sidecar.kind,
                &sidecar.media_type,
                "skeptic-runner",
                if sidecar.sensitive {
                    Sensitivity::Sensitive
                } else {
                    Sensitivity::Normal
                },
                if sidecar.redacted {
                    RedactionState::Redacted
                } else {
                    RedactionState::None
                },
            )?);
        }
        test.evidence = references.clone();
        if let Some(assertion) = test.assertion.as_mut() {
            assertion.evidence = references.clone();
        }
    }
    Ok(())
}

fn source_info(root: &Path) -> SourceInfo {
    let revision = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    if revision.is_none() {
        return SourceInfo {
            kind: SourceKind::None,
            revision: None,
            dirty: None,
            branch: None,
        };
    }
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .output()
        .ok()
        .map(|output| !output.stdout.is_empty());
    let branch = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(root)
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|branch| !branch.is_empty());
    SourceInfo {
        kind: SourceKind::Git,
        revision,
        dirty,
        branch,
    }
}

fn write_output(path: Option<&Path>, bytes: &[u8]) -> Result<(), String> {
    if let Some(path) = path {
        if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(path, bytes).map_err(|error| error.to_string())
    } else {
        std::io::stdout()
            .lock()
            .write_all(bytes)
            .map_err(|error| error.to_string())
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn junit(manifest: &RunManifest) -> String {
    let failures = manifest
        .tests
        .iter()
        .filter(|test| {
            matches!(
                test.status,
                TestStatus::Failed | TestStatus::Errored | TestStatus::TimedOut
            )
        })
        .count();
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"skeptic\" tests=\"{}\" failures=\"{}\" time=\"{:.3}\">\n",
        manifest.tests.len(), failures, manifest.duration_ms as f64 / 1000.0
    );
    for test in &manifest.tests {
        xml.push_str(&format!(
            "  <testcase name=\"{}\" classname=\"{}\" time=\"{:.3}\">",
            xml_escape(&test.title),
            xml_escape(&test.file),
            test.duration_ms as f64 / 1000.0
        ));
        match test.status {
            TestStatus::Skipped => xml.push_str("<skipped/>"),
            TestStatus::Failed | TestStatus::Errored | TestStatus::TimedOut => {
                xml.push_str(&format!("<failure message=\"{:?}\"/>", test.status));
            }
            TestStatus::Passed => {}
        }
        xml.push_str("</testcase>\n");
    }
    xml.push_str("</testsuite>\n");
    xml
}

fn run_parent(options: RunOptions) -> Result<i32, String> {
    let cwd = env::current_dir().map_err(|error| error.to_string())?;
    let root = project_root(&cwd);
    let resolved = load(&cwd, options.config.as_deref(), ConfigOverrides::default())
        .map_err(|error| error.to_string())?;
    let retries = options.retries.unwrap_or(resolved.config.runner.retries);
    let shard = options.shard.or_else(|| {
        resolved
            .config
            .runner
            .shard
            .as_deref()
            .map(parse_shard)
            .transpose()
            .ok()
            .flatten()
    });
    let mut files = discover(&root, &options.files)?;
    if let Some((index, total)) = shard {
        files = files
            .into_iter()
            .enumerate()
            .filter_map(|(position, file)| (position % total == index - 1).then_some(file))
            .collect();
    }
    if files.is_empty() {
        return Err("no Skeptic spec files found".to_string());
    }

    let started = Instant::now();
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let run_id = format!(
        "{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        &Uuid::new_v4().to_string()[..8]
    );
    let run_dir = run_directory(&root, &run_id);
    fs::create_dir_all(run_dir.join("worker")).map_err(|error| error.to_string())?;
    let journal_path = run_dir.join("events.ndjson");
    let journal = Journal::for_run(&journal_path, &run_id);
    let progress = if options.format == Format::Ndjson {
        Some(NdjsonProgress::new(options.output.as_deref())?)
    } else {
        None
    };
    publish_event(
        progress.as_ref(),
        &journal,
        "run-start",
        json!({"files": files, "configHash": resolved.config_hash}),
    )?;

    let runner_bin = sibling_binary("skeptic-runner")?;
    let skeptic_bin = sibling_binary("skeptic")?;
    let next_file = AtomicUsize::new(0);
    let completed = Mutex::new(Vec::<(usize, String, WorkerResult)>::new());
    let failure = Mutex::new(None::<String>);
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| loop {
                if failure.lock().expect("failure lock").is_some() {
                    return;
                }
                let index = next_file.fetch_add(1, Ordering::Relaxed);
                let Some(file) = files.get(index) else {
                    return;
                };
                let relative = file
                    .strip_prefix(&root)
                    .unwrap_or(file)
                    .to_string_lossy()
                    .replace('\\', "/");
                match execute_file_attempts(
                    &runner_bin,
                    &skeptic_bin,
                    &root,
                    options.config.as_deref(),
                    file,
                    &relative,
                    &run_id,
                    &run_dir,
                    &journal,
                    progress.as_ref(),
                    retries,
                    resolved.config.runner.hard_timeout_ms,
                ) {
                    Ok(result) => completed
                        .lock()
                        .expect("completed lock")
                        .push((index, relative, result)),
                    Err(error) => *failure.lock().expect("failure lock") = Some(error),
                }
            });
        }
    });
    if let Some(error) = failure.into_inner().map_err(|_| "failure lock poisoned")? {
        return Err(error);
    }
    let mut completed = completed
        .into_inner()
        .map_err(|_| "completed lock poisoned")?;
    completed.sort_by_key(|(index, _, _)| *index);

    let mut tests = Vec::new();
    let mut targets = Vec::new();
    let mut console = Vec::new();
    let mut worker_sidecars = Vec::new();
    for (_, relative, result) in completed {
        worker_sidecars.extend(result.sidecars.clone());
        console.extend(
            result
                .console
                .into_iter()
                .map(redact_console_value)
                .map(|entry| json!({"file": relative, "entry": entry})),
        );
        for (index, test) in result.tests.into_iter().enumerate() {
            let target = manifest_target(&test.target)?;
            let target_index = targets
                .iter()
                .position(|value| value == &target)
                .unwrap_or_else(|| {
                    targets.push(target);
                    targets.len() - 1
                });
            tests.push(TestResult {
                id: format!(
                    "{}:{}:{}",
                    file_key(Path::new(&relative)),
                    index + 1,
                    &hex::encode(Sha256::digest(test.title.as_bytes()))[..8]
                ),
                title: test.title,
                file: relative.clone(),
                status: test_status(&test.status),
                duration_ms: test.duration_ms,
                target: target_index,
                error: test.error,
                assertion: test.assertion,
                artifacts: test.evidence,
            });
        }
    }
    let failed = tests
        .iter()
        .any(|test| !matches!(test.status, TestStatus::Passed | TestStatus::Skipped));
    publish_event(
        progress.as_ref(),
        &journal,
        "run-complete",
        json!({"outcome": if failed { "failed" } else { "passed" }, "tests": tests.len()}),
    )?;

    let console_path = run_dir.join("console.json");
    atomic_write_json(&console_path, &console)?;
    let journal_ref = evidence_ref(
        &run_dir,
        &journal_path,
        "journal",
        "application/x-ndjson",
        "skeptic-runner",
        Sensitivity::Normal,
        RedactionState::Redacted,
    )?;
    let console_ref = evidence_ref(
        &run_dir,
        &console_path,
        "console",
        "application/json",
        "skeptic-runner",
        Sensitivity::Normal,
        RedactionState::Redacted,
    )?;
    let mut sidecars = vec![console_ref];
    let mut capability_ids = std::collections::BTreeSet::new();
    let mut capability_backends = BTreeMap::new();
    for sidecar in worker_sidecars {
        if !sidecar.path.is_file() {
            continue;
        }
        let sensitivity = if sidecar.sensitive {
            Sensitivity::Sensitive
        } else {
            Sensitivity::Normal
        };
        let redaction = if sidecar.redacted {
            RedactionState::Redacted
        } else {
            RedactionState::None
        };
        sidecars.push(evidence_ref(
            &run_dir,
            &sidecar.path,
            &sidecar.kind,
            &sidecar.media_type,
            "skeptic-runner",
            sensitivity,
            redaction,
        )?);
        let (capability_id, backend) = match sidecar
            .target
            .as_ref()
            .map(|target| target.platform.as_str())
        {
            Some("android") => (format!("mobile/android/{}", sidecar.kind), "android-adb"),
            Some("ios" | "ios-sim") => {
                (format!("mobile/ios-sim/{}", sidecar.kind), "ios-simulator")
            }
            _ => (sidecar.kind.clone(), "chromium-cdp"),
        };
        capability_backends.insert(capability_id.clone(), backend.to_string());
        capability_ids.insert(capability_id);
    }
    let mut capabilities = vec![
        CapabilityRecord {
            id: "runner/embedded-v8".into(),
            availability: CapabilityAvailability::Available,
            execution: CapabilityExecution::Succeeded,
            required: true,
            reason: None,
            backend: Some("deno_core".into()),
            version: Some("0.408.0".into()),
        },
        CapabilityRecord {
            id: "runner-console".into(),
            availability: CapabilityAvailability::Available,
            execution: CapabilityExecution::Succeeded,
            required: false,
            reason: None,
            backend: Some("embedded-v8".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
        },
    ];
    let has_web_target = targets
        .iter()
        .any(|target| target.platform == Platform::Web);
    let mut missing_browser_evidence = false;
    if has_web_target {
        for id in ["network", "browser-console", "a11y", "performance", "har"] {
            let succeeded = capability_ids.contains(id);
            missing_browser_evidence |= !succeeded;
            capabilities.push(CapabilityRecord {
                id: id.into(),
                availability: if succeeded {
                    CapabilityAvailability::Available
                } else {
                    CapabilityAvailability::Degraded
                },
                execution: if succeeded {
                    CapabilityExecution::Succeeded
                } else {
                    CapabilityExecution::Failed
                },
                required: false,
                reason: (!succeeded).then(|| {
                    "browser evidence collection did not produce an artifact for this run".into()
                }),
                backend: Some("chromium-cdp".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            });
        }
    }
    for id in capability_ids.into_iter().filter(|id| {
        !matches!(
            id.as_str(),
            "network" | "browser-console" | "a11y" | "performance" | "har"
        )
    }) {
        let backend = capability_backends.get(&id).cloned();
        capabilities.push(CapabilityRecord {
            id,
            availability: CapabilityAvailability::Available,
            execution: CapabilityExecution::Succeeded,
            required: false,
            reason: None,
            backend,
            version: Some(env!("CARGO_PKG_VERSION").into()),
        });
    }
    let finished_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut versions = BTreeMap::new();
    versions.insert("skeptic".to_string(), env!("CARGO_PKG_VERSION").to_string());
    versions.insert("deno_core".to_string(), "0.408.0".to_string());
    versions.insert("oxc".to_string(), "0.100.0".to_string());
    let manifest = RunManifest {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.clone(),
        started_at,
        finished_at,
        duration_ms: started.elapsed().as_millis() as u64,
        outcome: if failed {
            RunOutcome::Failed
        } else {
            RunOutcome::Passed
        },
        source: source_info(&root),
        config: RunConfig {
            config_hash: resolved.config_hash,
            tool_versions: versions,
        },
        completeness: if missing_browser_evidence {
            Completeness::Partial
        } else {
            Completeness::Complete
        },
        capabilities,
        projects: vec![Project {
            name: root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project")
                .to_string(),
            root: root.to_string_lossy().to_string(),
        }],
        targets,
        score: None,
        tests,
        sidecars,
        mobile: None,
        visual: None,
        journal: journal_ref,
        diagnostics: None,
        transcripts: None,
    };
    manifest.validate().map_err(|error| error.to_string())?;
    atomic_write_json(&run_dir.join("manifest.json"), &manifest)?;
    update_latest(&root, &run_id)?;

    let bytes = match options.format {
        Format::Human => {
            let passed = manifest
                .tests
                .iter()
                .filter(|test| test.status == TestStatus::Passed)
                .count();
            let failed_count = manifest
                .tests
                .iter()
                .filter(|test| {
                    matches!(
                        test.status,
                        TestStatus::Failed | TestStatus::Errored | TestStatus::TimedOut
                    )
                })
                .count();
            format!(
                "Skeptic run {}: {} passed, {} failed, {} total\nmanifest: {}\n",
                manifest.run_id,
                passed,
                failed_count,
                manifest.tests.len(),
                run_dir.join("manifest.json").display()
            )
            .into_bytes()
        }
        Format::Json => {
            let mut envelope = ResponseEnvelope::success(
                serde_json::to_value(&manifest).map_err(|error| error.to_string())?,
                RUN_SCHEMA,
                manifest.duration_ms,
            );
            envelope.meta.side_effects = SideEffects::Committed;
            let mut bytes = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            bytes
        }
        Format::Ndjson => {
            progress
                .as_ref()
                .expect("NDJSON progress writer must exist")
                .write_value(&json!({"type":"run","manifest":manifest}))?;
            Vec::new()
        }
        Format::Junit => junit(&manifest).into_bytes(),
    };
    if options.format != Format::Ndjson {
        write_output(options.output.as_deref(), &bytes)?;
    }
    Ok(if failed { 1 } else { 0 })
}

fn value_after(args: &[String], flag: &str) -> Result<String, String> {
    args.iter()
        .position(|value| value == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn worker(args: &[String]) -> Result<i32, String> {
    let file = args
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| "worker requires a spec file".to_string())?;
    let root = PathBuf::from(value_after(args, "--root")?);
    let skeptic_bin = PathBuf::from(value_after(args, "--skeptic-bin")?);
    let session = value_after(args, "--session")?;
    let result_path = PathBuf::from(value_after(args, "--result")?);
    let config = args
        .iter()
        .position(|value| value == "--config")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from);
    let resolved = load(&root, config.as_deref(), ConfigOverrides::default())
        .map_err(|error| error.to_string())?;
    let env = filtered_environment(&resolved.config.env.pass);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let mut result = match runtime.block_on(execute_file(ExecuteOptions {
        file: &file,
        project_root: &root,
        skeptic_bin: &skeptic_bin,
        session: &session,
        test_timeout_ms: resolved.config.runner.test_timeout_ms,
        hard_timeout_ms: resolved.config.runner.hard_timeout_ms,
        assertion_timeout_ms: resolved.config.runner.assertion_timeout_ms,
        poll_interval_ms: resolved.config.runner.poll_interval_ms,
        allowed_domains: resolved.config.policy.allowed_domains,
        env,
    })) {
        Ok(result) => result,
        Err(error) => WorkerResult {
            tests: vec![WorkerTestResult {
                title: file.display().to_string(),
                status: if error.contains("execution terminated") {
                    "timed-out"
                } else {
                    "errored"
                }
                .to_string(),
                duration_ms: resolved.config.runner.hard_timeout_ms,
                error: Some(error),
                assertion: None,
                session: None,
                target: WorkerTarget::default(),
                evidence: Vec::new(),
            }],
            console: Vec::new(),
            sidecars: Vec::new(),
        },
    };
    let mut contexts = Vec::<(String, WorkerTarget, bool)>::new();
    for test in &result.tests {
        let actual_session = test.session.clone().unwrap_or_else(|| session.clone());
        let failed = !matches!(test.status.as_str(), "passed" | "skipped");
        if let Some(context) = contexts.iter_mut().find(|(candidate_session, target, _)| {
            candidate_session == &actual_session && target == &test.target
        }) {
            context.2 |= failed;
        } else {
            contexts.push((actual_session, test.target.clone(), failed));
        }
    }
    result.sidecars = contexts
        .iter()
        .enumerate()
        .flat_map(|(index, (actual_session, target, failed))| {
            collect_worker_evidence(
                &skeptic_bin,
                actual_session,
                target,
                &result_path,
                &format!("session-{}", index + 1),
                *failed,
            )
        })
        .collect();
    attach_failure_evidence(&mut result, &result_path, &session)?;
    atomic_write_json(&result_path, &result)?;
    if contexts
        .iter()
        .any(|(actual_session, _, _)| actual_session == &session)
    {
        let _ = Command::new(&skeptic_bin)
            .args(["--session", &session, "close"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(
        if result
            .tests
            .iter()
            .all(|test| matches!(test.status.as_str(), "passed" | "skipped"))
        {
            0
        } else {
            1
        },
    )
}

fn scaffold(args: &[String]) -> Result<i32, String> {
    let path = args
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/example.spec.ts"));
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &path,
        r#"import { test, expect } from "skeptic-cli";

test("page is usable", async ({ page }) => {
  await page.open("http://localhost:3000");
  await expect(page.locator("body")).toBeVisible();
});
"#,
    )
    .map_err(|error| error.to_string())?;
    println!("created {}", path.display());
    Ok(0)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("__worker") => worker(&args[1..]),
        Some("run") => parse_run_options(&args[1..]).and_then(run_parent),
        Some("scaffold") => scaffold(&args[1..]),
        _ => Err("usage: skeptic-runner <run|scaffold> [options]".to_string()),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shard_validation_is_strict() {
        assert_eq!(parse_shard("2/3").unwrap(), (2, 3));
        assert!(parse_shard("0/3").is_err());
        assert!(parse_shard("4/3").is_err());
    }

    #[test]
    fn console_redaction_covers_structured_and_inline_secrets() {
        let value = redact_console_value(json!({
            "authorization": "Bearer visible",
            "nested": {"api_key": "visible"},
            "message": "GET /?token=visible Authorization: Bearer abc.def"
        }));
        assert_eq!(value["authorization"], "[REDACTED]");
        assert_eq!(value["nested"]["api_key"], "[REDACTED]");
        assert!(!value["message"].as_str().unwrap().contains("visible"));
        assert!(!value["message"].as_str().unwrap().contains("abc.def"));
    }

    #[test]
    fn failure_evidence_is_attached_only_to_its_session_and_target() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("run");
        let worker_dir = run_dir.join("worker");
        fs::create_dir_all(&worker_dir).unwrap();
        let result_path = worker_dir.join("result.json");
        let web_target = WorkerTarget::default();
        let mobile_target = WorkerTarget {
            platform: "android".into(),
            device: Some("emulator-5554".into()),
            app: Some("dev.skeptic.fixture".into()),
        };
        let mut sidecars = Vec::new();
        for (name, session, target) in [
            ("web-snapshot.json", "web", web_target.clone()),
            ("web.png", "web", web_target.clone()),
            ("mobile-snapshot.json", "mobile", mobile_target.clone()),
            ("mobile.png", "mobile", mobile_target.clone()),
        ] {
            let path = worker_dir.join(name);
            fs::write(&path, b"evidence").unwrap();
            sidecars.push(WorkerEvidence {
                kind: if name.ends_with(".png") {
                    "screenshot".into()
                } else {
                    "snapshot".into()
                },
                path,
                media_type: if name.ends_with(".png") {
                    "image/png".into()
                } else {
                    "application/json".into()
                },
                sensitive: name.ends_with(".png"),
                redacted: !name.ends_with(".png"),
                session: Some(session.into()),
                target: Some(target),
            });
        }
        let failed_test = |title: &str, session: &str, target: WorkerTarget| WorkerTestResult {
            title: title.into(),
            status: "failed".into(),
            duration_ms: 1,
            error: Some("failed".into()),
            assertion: None,
            session: Some(session.into()),
            target,
            evidence: Vec::new(),
        };
        let mut result = WorkerResult {
            tests: vec![
                failed_test("web", "web", web_target),
                failed_test("mobile", "mobile", mobile_target),
            ],
            console: Vec::new(),
            sidecars,
        };

        attach_failure_evidence(&mut result, &result_path, "default").unwrap();

        assert_eq!(result.tests[0].evidence.len(), 2);
        assert_eq!(result.tests[1].evidence.len(), 2);
        assert!(result.tests[0]
            .evidence
            .iter()
            .all(|reference| reference.rel_path.contains("web")));
        assert!(result.tests[1]
            .evidence
            .iter()
            .all(|reference| reference.rel_path.contains("mobile")));
    }

    #[test]
    fn ndjson_progress_writes_ordered_events_and_terminal_manifest_line() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("progress.ndjson");
        let journal = Journal::for_run(temp.path().join("events.ndjson"), "run-1");
        let progress = NdjsonProgress::new(Some(&output)).unwrap();
        progress
            .append_event(&journal, "run-start", json!({"files":1}))
            .unwrap();
        progress
            .append_event(&journal, "run-complete", json!({"outcome":"passed"}))
            .unwrap();
        progress
            .write_value(&json!({"type":"run","manifest":{"runId":"run-1"}}))
            .unwrap();

        let lines = fs::read_to_string(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["sequence"], 1);
        assert_eq!(lines[1]["sequence"], 2);
        assert_eq!(lines[2]["type"], "run");
    }
}
