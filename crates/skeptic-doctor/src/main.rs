use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use skeptic_config::{filtered_environment, load, ConfigOverrides};
use skeptic_contract::{
    BaselineState, BlockingLevel, CapabilityAvailability, CapabilityExecution, CapabilityRecord,
    Category, Completeness, Diagnostic, EvidenceState, FindingState, Producer, ResponseEnvelope,
    Severity, SideEffects, Span, Surface, TextPosition,
};
use skeptic_doctor::{
    changed_files, definition, read_baseline, refresh_report, scan, why, write_baseline,
    DoctorReport, ScanOptions,
};

static PROCESS_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn analyzer_environment(pass: &[String]) -> BTreeMap<String, String> {
    let mut environment = filtered_environment(pass);
    for name in ["PATH", "PATHEXT", "SystemRoot", "TMPDIR", "TEMP", "TMP"] {
        if let Ok(value) = env::var(name) {
            environment.entry(name.into()).or_insert(value);
        }
    }
    environment
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
    Sarif,
}

#[derive(Debug)]
struct Options {
    root: PathBuf,
    config: Option<PathBuf>,
    output: Option<PathBuf>,
    format: Format,
    scope_changed: bool,
    base: String,
    baseline: Option<PathBuf>,
    update_baseline: bool,
    confidence: Option<f64>,
    custom_pack: Option<PathBuf>,
    deep: bool,
    allow_project_commands: bool,
    blocking: Option<BlockingLevel>,
    ingest: Vec<PathBuf>,
    fix_plan: bool,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut root = None;
    let mut config = None;
    let mut output = None;
    let mut format = Format::Human;
    let mut scope_changed = false;
    let mut base = "main".to_string();
    let mut baseline = None;
    let mut update_baseline = false;
    let mut confidence = None;
    let mut custom_pack = None;
    let mut deep = false;
    let mut allow_project_commands = false;
    let mut blocking = None;
    let mut ingest = Vec::new();
    let mut fix_plan = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => format = Format::Json,
            "--format" => {
                format = match args.get(index + 1).map(String::as_str) {
                    Some("human") => Format::Human,
                    Some("json") => Format::Json,
                    Some("sarif") => Format::Sarif,
                    Some(value) => return Err(format!("unsupported doctor format `{value}`")),
                    None => return Err("--format requires a value".into()),
                };
                index += 1;
            }
            "--output" => {
                output = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--output requires a path".to_string())?,
                ));
                index += 1;
            }
            "--config" => {
                config = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--config requires a path".to_string())?,
                ));
                index += 1;
            }
            "--scope" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--scope requires `all` or `changed`".to_string())?;
                scope_changed = match value.as_str() {
                    "changed" => true,
                    "all" => false,
                    _ => return Err("--scope requires `all` or `changed`".into()),
                };
                index += 1;
            }
            "--base" => {
                base = args
                    .get(index + 1)
                    .ok_or_else(|| "--base requires a git revision".to_string())?
                    .clone();
                index += 1;
            }
            "--baseline" => {
                baseline = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--baseline requires a path".to_string())?,
                ));
                index += 1;
            }
            "--update-baseline" => update_baseline = true,
            "--confidence" => {
                confidence = Some(
                    args.get(index + 1)
                        .ok_or_else(|| "--confidence requires a value".to_string())?
                        .parse::<f64>()
                        .map_err(|_| "--confidence must be 0..1".to_string())?,
                );
                index += 1;
            }
            "--rules" => {
                custom_pack = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--rules requires a YAML path".to_string())?,
                ));
                index += 1;
            }
            "--deep" => deep = true,
            "--allow-project-commands" => allow_project_commands = true,
            "--fix-plan" => fix_plan = true,
            "--blocking" => {
                blocking = Some(match args.get(index + 1).map(String::as_str) {
                    Some("none") => BlockingLevel::None,
                    Some("warning") => BlockingLevel::Warning,
                    Some("error") => BlockingLevel::Error,
                    _ => return Err("--blocking requires none, warning, or error".into()),
                });
                index += 1;
            }
            "--ingest" => {
                ingest.push(PathBuf::from(args.get(index + 1).ok_or_else(|| {
                    "--ingest requires a JSON, NDJSON, or SARIF path".to_string()
                })?));
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown doctor option `{value}`"))
            }
            value => {
                if root.is_some() {
                    return Err("doctor accepts at most one project path".into());
                }
                root = Some(PathBuf::from(value));
            }
        }
        index += 1;
    }
    Ok(Options {
        root: root.unwrap_or_else(|| PathBuf::from(".")),
        config,
        output,
        format,
        scope_changed,
        base,
        baseline,
        update_baseline,
        confidence,
        custom_pack,
        deep,
        allow_project_commands,
        blocking,
        ingest,
        fix_plan,
    })
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

fn sarif(report: &DoctorReport) -> Value {
    let mut rules = BTreeMap::new();
    for diagnostic in &report.diagnostics {
        rules
            .entry(diagnostic.producer.rule_id.clone())
            .or_insert_with(|| {
                json!({
                    "id": diagnostic.producer.rule_id,
                    "shortDescription": {"text": diagnostic.message},
                    "help": {"text": diagnostic.help},
                })
            });
    }
    let results: Vec<_> = report
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let region = diagnostic.span.as_ref().map(|span| json!({
                "startLine": span.start.line,
                "startColumn": span.start.column,
                "endLine": span.end.line,
                "endColumn": span.end.column,
            }));
            json!({
                "ruleId": diagnostic.producer.rule_id,
                "level": match diagnostic.severity { Severity::P0 | Severity::P1 => "error", Severity::P2 => "warning", Severity::P3 => "note" },
                "message": {"text": diagnostic.message},
                "locations": diagnostic.file.as_ref().map(|file| vec![json!({"physicalLocation":{"artifactLocation":{"uri":file},"region":region}})]).unwrap_or_default(),
                "partialFingerprints": {"skepticFingerprint": diagnostic.fingerprint},
                "properties": {"category": diagnostic.category, "confidence": diagnostic.confidence, "baselineState": diagnostic.baseline_state},
            })
        })
        .collect();
    json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {"name": "skeptic-doctor", "version": env!("CARGO_PKG_VERSION"), "rules": rules.into_values().collect::<Vec<_>>() }},
            "results": results,
        }]
    })
}

#[allow(clippy::too_many_arguments)]
fn analyzer_diagnostic(
    rule: &str,
    category: Category,
    severity: Severity,
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    message: String,
    config_hash: &str,
) -> Diagnostic {
    let fingerprint = hex::encode(Sha256::digest(format!("{rule}\0{message}").as_bytes()));
    let occurrence_id = hex::encode(Sha256::digest(
        format!("{fingerprint}\0{file:?}\0{line:?}\0{column:?}").as_bytes(),
    ));
    let span = line.map(|line| Span {
        start: TextPosition {
            line,
            column: column.unwrap_or(1),
            byte_offset: None,
        },
        end: TextPosition {
            line,
            column: column.unwrap_or(1) + 1,
            byte_offset: None,
        },
    });
    Diagnostic {
        fingerprint: fingerprint.clone(),
        occurrence_id,
        producer: Producer {
            tool: "skeptic-doctor".into(),
            tool_version: env!("CARGO_PKG_VERSION").into(),
            rule_id: rule.into(),
            rule_version: Some("1".into()),
            config_hash: Some(config_hash.into()),
        },
        severity,
        category,
        confidence: 1.0,
        file,
        span,
        route: None,
        subject: None,
        message,
        help: None,
        related_locations: Vec::new(),
        state: FindingState::Open,
        evidence_state: EvidenceState::Unobserved,
        baseline_state: BaselineState::New,
        suppression: None,
        fix_group_id: None,
        links: Vec::new(),
    }
}

fn capability(
    id: impl Into<String>,
    availability: CapabilityAvailability,
    execution: CapabilityExecution,
    required: bool,
    reason: Option<String>,
    backend: impl Into<String>,
    version: Option<String>,
) -> CapabilityRecord {
    CapabilityRecord {
        id: id.into(),
        availability,
        execution,
        required,
        reason,
        backend: Some(backend.into()),
        version,
    }
}

fn record_optional_analyzer_failure(
    report: &mut DoctorReport,
    id: &str,
    backend: &str,
    error: String,
) {
    let execution = if error.contains("E_TIMEOUT") {
        CapabilityExecution::TimedOut
    } else {
        CapabilityExecution::Failed
    };
    report.capabilities.push(capability(
        id,
        CapabilityAvailability::Degraded,
        execution,
        false,
        Some(error.clone()),
        backend,
        None,
    ));
    report.completeness = Completeness::Partial;
    report.warnings.push(format!(
        "Optional analyzer `{backend}` did not complete: {error}"
    ));
}

fn run_tsc(
    report: &mut DoctorReport,
    root: &Path,
    config_hash: &str,
    child_env: &BTreeMap<String, String>,
    timeout: u64,
) -> Result<(), String> {
    if !root.join("tsconfig.json").is_file() {
        report.capabilities.push(capability(
            "analyzer/tsc",
            CapabilityAvailability::Available,
            CapabilityExecution::NotRequested,
            false,
            Some("no tsconfig.json detected".into()),
            "tsc",
            None,
        ));
        return Ok(());
    }
    let binary = root
        .join("node_modules/.bin")
        .join(if cfg!(windows) { "tsc.cmd" } else { "tsc" });
    if !binary.is_file() {
        report.capabilities.push(capability(
            "analyzer/tsc",
            CapabilityAvailability::Unavailable,
            CapabilityExecution::Skipped,
            false,
            Some("tsconfig.json exists but local TypeScript is not installed".into()),
            "tsc",
            None,
        ));
        report.completeness = Completeness::Partial;
        report.warnings.push(
            "TypeScript analysis skipped: install the project's `typescript` dependency".into(),
        );
        return Ok(());
    }
    let version = run_supervised(
        &[binary.to_string_lossy().to_string(), "--version".into()],
        root,
        child_env,
        5_000,
    )
    .ok()
    .map(|output| output.stdout.trim().to_string())
    .filter(|version| !version.is_empty());
    let output = run_supervised(
        &[
            binary.to_string_lossy().to_string(),
            "--noEmit".into(),
            "--pretty".into(),
            "false".into(),
        ],
        root,
        child_env,
        timeout,
    )?;
    let pattern = Regex::new(r"(?m)^([^\r\n(]+)\((\d+),(\d+)\): error (TS\d+): (.+)$").unwrap();
    let text = format!("{}\n{}", output.stdout, output.stderr);
    let diagnostics: Vec<_> = pattern
        .captures_iter(&text)
        .map(|captures| {
            analyzer_diagnostic(
                &format!("tsc/{}", &captures[4]),
                Category::Correctness,
                Severity::P1,
                Some(captures[1].replace('\\', "/")),
                captures[2].parse().ok(),
                captures[3].parse().ok(),
                captures[5].to_string(),
                config_hash,
            )
        })
        .collect();
    if !output.success && diagnostics.is_empty() {
        return Err(format!(
            "E_ANALYZER_FAILED: tsc exited without valid diagnostics: {}",
            output.stderr.trim()
        ));
    }
    for diagnostic in &diagnostics {
        diagnostic
            .validate()
            .map_err(|error| format!("E_ANALYZER_FAILED: invalid tsc diagnostic: {error}"))?;
    }
    report.diagnostics.extend(diagnostics);
    report.capabilities.push(capability(
        "analyzer/tsc",
        CapabilityAvailability::Available,
        CapabilityExecution::Succeeded,
        false,
        None,
        "tsc",
        version,
    ));
    Ok(())
}

fn has_entry(root: &Path, predicate: impl Fn(&Path) -> bool) -> bool {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| predicate(&entry.path()))
}

fn has_apple_project(root: &Path) -> bool {
    root.join("Package.swift").is_file()
        || has_entry(root, |path| {
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("xcodeproj" | "xcworkspace")
            )
        })
}

fn has_android_project(root: &Path) -> bool {
    root.join("gradlew").is_file()
        || root.join("gradlew.bat").is_file()
        || root.join("settings.gradle").is_file()
        || root.join("settings.gradle.kts").is_file()
}

fn parse_dart_machine(text: &str, config_hash: &str) -> Vec<Diagnostic> {
    text.lines()
        .filter_map(|line| {
            let fields = line.splitn(8, '|').collect::<Vec<_>>();
            if fields.len() < 8 {
                return None;
            }
            let severity = match fields[0] {
                "ERROR" => Severity::P1,
                "WARNING" => Severity::P2,
                _ => Severity::P3,
            };
            Some(analyzer_diagnostic(
                &format!("dart/{}", fields[2]),
                Category::Correctness,
                severity,
                Some(fields[3].replace('\\', "/")),
                fields[4].parse().ok(),
                fields[5].parse().ok(),
                fields[7].replace("\\|", "|"),
                config_hash,
            ))
        })
        .collect()
}

fn run_dart(
    report: &mut DoctorReport,
    root: &Path,
    config_hash: &str,
    child_env: &BTreeMap<String, String>,
    timeout: u64,
) -> Result<(), String> {
    if !root.join("pubspec.yaml").is_file() {
        report.capabilities.push(capability(
            "analyzer/dart",
            CapabilityAvailability::Available,
            CapabilityExecution::NotRequested,
            false,
            Some("no pubspec.yaml detected".into()),
            "dart analyze",
            None,
        ));
        return Ok(());
    }
    let binary = resolve_executable("dart");
    if !binary.is_file() {
        report.capabilities.push(capability(
            "analyzer/dart",
            CapabilityAvailability::Unavailable,
            CapabilityExecution::Skipped,
            false,
            Some("pubspec.yaml exists but Dart is not installed".into()),
            "dart analyze",
            None,
        ));
        report.completeness = Completeness::Partial;
        report
            .warnings
            .push("Dart analysis skipped: install the Dart SDK".into());
        return Ok(());
    }
    let version = run_supervised(
        &[binary.to_string_lossy().into_owned(), "--version".into()],
        root,
        child_env,
        5_000,
    )
    .ok()
    .map(|output| {
        format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string()
    })
    .filter(|value| !value.is_empty());
    let output = run_supervised(
        &[
            binary.to_string_lossy().into_owned(),
            "analyze".into(),
            "--format".into(),
            "machine".into(),
        ],
        root,
        child_env,
        timeout,
    )?;
    let diagnostics = parse_dart_machine(
        &format!("{}\n{}", output.stdout, output.stderr),
        config_hash,
    );
    if !output.success && diagnostics.is_empty() {
        return Err(format!(
            "E_ANALYZER_FAILED: Dart Analyzer exited without valid diagnostics: {}",
            output.stderr.trim()
        ));
    }
    report.diagnostics.extend(diagnostics);
    report.capabilities.push(capability(
        "analyzer/dart",
        CapabilityAvailability::Available,
        CapabilityExecution::Succeeded,
        false,
        None,
        "dart analyze",
        version,
    ));
    Ok(())
}

fn parse_swiftlint_json(text: &str, config_hash: &str) -> Result<Vec<Diagnostic>, String> {
    let values: Vec<Value> = serde_json::from_str(text)
        .map_err(|error| format!("E_ANALYZER_FAILED: invalid SwiftLint JSON: {error}"))?;
    Ok(values
        .into_iter()
        .map(|value| {
            let rule = value
                .get("rule_id")
                .and_then(Value::as_str)
                .unwrap_or("external");
            let severity = match value.get("severity").and_then(Value::as_str) {
                Some("Error" | "error") => Severity::P1,
                _ => Severity::P2,
            };
            analyzer_diagnostic(
                &format!("swiftlint/{rule}"),
                Category::Correctness,
                severity,
                value
                    .get("file")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                value
                    .get("line")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                value
                    .get("character")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("SwiftLint finding")
                    .to_string(),
                config_hash,
            )
        })
        .collect())
}

fn run_swiftlint(
    report: &mut DoctorReport,
    root: &Path,
    config_hash: &str,
    child_env: &BTreeMap<String, String>,
    timeout: u64,
) -> Result<(), String> {
    if !has_apple_project(root) {
        report.capabilities.push(capability(
            "analyzer/swiftlint",
            CapabilityAvailability::Available,
            CapabilityExecution::NotRequested,
            false,
            Some("no Swift package or Xcode project detected".into()),
            "swiftlint",
            None,
        ));
        return Ok(());
    }
    let binary = resolve_executable("swiftlint");
    if !binary.is_file() {
        report.capabilities.push(capability(
            "analyzer/swiftlint",
            CapabilityAvailability::Unavailable,
            CapabilityExecution::Skipped,
            false,
            Some("Apple project detected but SwiftLint is not installed".into()),
            "swiftlint",
            None,
        ));
        report.completeness = Completeness::Partial;
        report
            .warnings
            .push("Swift analysis skipped: install SwiftLint".into());
        return Ok(());
    }
    let version = run_supervised(
        &[binary.to_string_lossy().into_owned(), "version".into()],
        root,
        child_env,
        5_000,
    )
    .ok()
    .map(|output| output.stdout.trim().to_string())
    .filter(|value| !value.is_empty());
    let output = run_supervised(
        &[
            binary.to_string_lossy().into_owned(),
            "lint".into(),
            "--reporter".into(),
            "json".into(),
            "--quiet".into(),
        ],
        root,
        child_env,
        timeout,
    )?;
    let diagnostics = parse_swiftlint_json(&output.stdout, config_hash)?;
    if !output.success && diagnostics.is_empty() {
        return Err(format!(
            "E_ANALYZER_FAILED: SwiftLint exited without valid diagnostics: {}",
            output.stderr.trim()
        ));
    }
    report.diagnostics.extend(diagnostics);
    report.capabilities.push(capability(
        "analyzer/swiftlint",
        CapabilityAvailability::Available,
        CapabilityExecution::Succeeded,
        false,
        None,
        "swiftlint",
        version,
    ));
    Ok(())
}

fn discovered_sarif_reports(root: &Path, family: &str) -> Vec<PathBuf> {
    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git" | ".skeptic" | "node_modules" | "target")
            )
        })
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("sarif")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.to_ascii_lowercase().contains(family))
        })
        .take(64)
        .collect()
}

fn ingest_native_reports(
    report: &mut DoctorReport,
    root: &Path,
    config_hash: &str,
) -> Result<(), String> {
    let families = [
        ("android-lint", "lint", has_android_project(root)),
        ("detekt", "detekt", has_android_project(root)),
    ];
    for (adapter, pattern, detected) in families {
        let paths = if detected {
            discovered_sarif_reports(root, pattern)
        } else {
            Vec::new()
        };
        if paths.is_empty() {
            report.capabilities.push(capability(
                format!("analyzer/{adapter}"),
                CapabilityAvailability::Available,
                CapabilityExecution::NotRequested,
                false,
                Some(if detected {
                    format!("no existing {adapter} SARIF report found; configure a supervised analyzer command to generate one")
                } else {
                    "no Android Gradle project detected".into()
                }),
                adapter,
                None,
            ));
            continue;
        }
        for path in &paths {
            let text = fs::read_to_string(path)
                .map_err(|error| format!("E_ANALYZER_FAILED: {}: {error}", path.display()))?;
            report
                .diagnostics
                .extend(ingest_sarif(&text, adapter, config_hash)?);
        }
        report.capabilities.push(capability(
            format!("analyzer/{adapter}"),
            CapabilityAvailability::Available,
            CapabilityExecution::Succeeded,
            false,
            Some(format!("ingested {} existing SARIF report(s)", paths.len())),
            adapter,
            None,
        ));
    }
    Ok(())
}

struct ProcessOutput {
    stdout: String,
    stderr: String,
    success: bool,
}

fn resolve_executable(program: &str) -> PathBuf {
    let path = PathBuf::from(program);
    if path.components().count() > 1 {
        return path;
    }
    env::var_os("PATH")
        .and_then(|paths| {
            env::split_paths(&paths)
                .map(|directory| directory.join(program))
                .find(|candidate| candidate.is_file())
        })
        .unwrap_or(path)
}

fn run_supervised(
    command: &[String],
    root: &Path,
    child_env: &BTreeMap<String, String>,
    timeout_ms: u64,
) -> Result<ProcessOutput, String> {
    let program = command
        .first()
        .ok_or_else(|| "analyzer command is empty".to_string())?;
    let resolved_program = resolve_executable(program);
    if !resolved_program.is_file() {
        return Err(format!(
            "E_ENV_MISSING: analyzer executable `{program}` was not found"
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = PROCESS_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let scratch = root
        .join(".skeptic/cache/processes")
        .join(format!("{}-{nonce}-{sequence}", std::process::id()));
    let stdout_file = scratch.join("stdout");
    let stderr_file = scratch.join("stderr");
    if let Some(parent) = stdout_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let stdout = fs::File::create(&stdout_file).map_err(|error| error.to_string())?;
    let stderr = fs::File::create(&stderr_file).map_err(|error| error.to_string())?;
    let mut child = Command::new(resolved_program)
        .args(&command[1..])
        .current_dir(root)
        .env_clear()
        .envs(child_env)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("E_ANALYZER_FAILED: could not start `{program}`: {error}"))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&scratch);
            return Err(format!(
                "E_TIMEOUT: analyzer timed out after {timeout_ms}ms"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = ProcessOutput {
        stdout: fs::read_to_string(&stdout_file).unwrap_or_default(),
        stderr: fs::read_to_string(&stderr_file).unwrap_or_default(),
        success: status.success(),
    };
    let _ = fs::remove_dir_all(&scratch);
    Ok(output)
}

fn ingest_ndjson(text: &str) -> Result<Vec<Diagnostic>, String> {
    let diagnostics: Vec<Diagnostic> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: Value = serde_json::from_str(line)
                .map_err(|error| format!("E_ANALYZER_FAILED: invalid NDJSON: {error}"))?;
            let payload = value.get("data").cloned().unwrap_or(value);
            serde_json::from_value(payload)
                .map_err(|error| format!("E_ANALYZER_FAILED: invalid diagnostic: {error}"))
        })
        .collect::<Result<_, _>>()?;
    for diagnostic in &diagnostics {
        diagnostic
            .validate()
            .map_err(|error| format!("E_ANALYZER_FAILED: invalid analyzer diagnostic: {error}"))?;
    }
    Ok(diagnostics)
}

fn ingest_sarif(text: &str, analyzer: &str, config_hash: &str) -> Result<Vec<Diagnostic>, String> {
    let document: Value = serde_json::from_str(text)
        .map_err(|error| format!("E_ANALYZER_FAILED: invalid SARIF: {error}"))?;
    if document.get("version").and_then(Value::as_str) != Some("2.1.0")
        || document.get("runs").and_then(Value::as_array).is_none()
    {
        return Err("E_ANALYZER_FAILED: analyzer output is not SARIF 2.1.0".into());
    }
    let mut diagnostics = Vec::new();
    for result in document
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|run| {
            run.get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
    {
        let rule = result
            .get("ruleId")
            .and_then(Value::as_str)
            .unwrap_or("external");
        let message = result
            .pointer("/message/text")
            .and_then(Value::as_str)
            .unwrap_or("external analyzer finding")
            .to_string();
        let file = result
            .pointer("/locations/0/physicalLocation/artifactLocation/uri")
            .and_then(Value::as_str)
            .map(str::to_string);
        let line = result
            .pointer("/locations/0/physicalLocation/region/startLine")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let column = result
            .pointer("/locations/0/physicalLocation/region/startColumn")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let severity = match result.get("level").and_then(Value::as_str) {
            Some("error") => Severity::P1,
            Some("warning") => Severity::P2,
            _ => Severity::P3,
        };
        let category = result
            .pointer("/properties/category")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or(Category::Correctness);
        diagnostics.push(analyzer_diagnostic(
            &format!("{analyzer}/{rule}"),
            category,
            severity,
            file,
            line,
            column,
            message,
            config_hash,
        ));
    }
    for diagnostic in &diagnostics {
        diagnostic
            .validate()
            .map_err(|error| format!("E_ANALYZER_FAILED: invalid SARIF diagnostic: {error}"))?;
    }
    Ok(diagnostics)
}

fn source_digest(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git" | ".skeptic" | "node_modules" | "target" | "dist" | "build")
            )
        })
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
    {
        let path = entry.path();
        if !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some(
                "js" | "jsx"
                    | "mjs"
                    | "cjs"
                    | "ts"
                    | "tsx"
                    | "json"
                    | "rs"
                    | "kt"
                    | "kts"
                    | "java"
                    | "swift"
                    | "dart"
                    | "lock"
            )
        ) {
            continue;
        }
        hasher.update(
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(fs::read(path).map_err(|error| error.to_string())?);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let sequence = PROCESS_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp-{}-{sequence}", std::process::id()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn run_configured_analyzers(
    report: &mut DoctorReport,
    root: &Path,
    resolved: &skeptic_config::ResolvedConfig,
    allowed: bool,
) -> Result<(), String> {
    if resolved.config.analyzers.is_empty() {
        return Ok(());
    }
    if !allowed {
        return Err("E_POLICY_BLOCKED: configured analyzers require --allow-project-commands in non-interactive runs".into());
    }
    let child_env = analyzer_environment(&resolved.config.env.pass);
    let inputs = source_digest(root)?;
    for (name, analyzer) in &resolved.config.analyzers {
        let program = analyzer
            .command
            .first()
            .ok_or_else(|| format!("E_ANALYZER_FAILED: analyzer `{name}` has an empty command"))?;
        let version = run_supervised(
            &[program.clone(), "--version".into()],
            root,
            &child_env,
            5_000,
        )
        .ok()
        .map(|output| {
            format!("{}{}", output.stdout, output.stderr)
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty());
        let key = hex::encode(Sha256::digest(
            format!(
                "{}:{name}:{:?}:{version:?}:{inputs}",
                resolved.config_hash, analyzer.command
            )
            .as_bytes(),
        ));
        let cache = root
            .join(".skeptic/cache/analyzers")
            .join(format!("{key}.json"));
        let execution = || -> Result<Vec<Diagnostic>, String> {
            if cache.is_file() {
                let diagnostics: Vec<Diagnostic> =
                    serde_json::from_slice(&fs::read(&cache).map_err(|error| error.to_string())?)
                        .map_err(|error| {
                        format!("E_ANALYZER_FAILED: corrupt analyzer cache: {error}")
                    })?;
                for diagnostic in &diagnostics {
                    diagnostic.validate().map_err(|error| {
                        format!("E_ANALYZER_FAILED: invalid cached diagnostic: {error}")
                    })?;
                }
                return Ok(diagnostics);
            }
            let output = run_supervised(&analyzer.command, root, &child_env, analyzer.timeout_ms)?;
            if !output.success {
                return Err(format!(
                    "E_ANALYZER_FAILED: analyzer `{name}` exited unsuccessfully: {}",
                    output.stderr.trim()
                ));
            }
            let diagnostics = match analyzer.format {
                skeptic_contract::AnalyzerFormat::Ndjson => ingest_ndjson(&output.stdout)?,
                skeptic_contract::AnalyzerFormat::Sarif => {
                    ingest_sarif(&output.stdout, name, &resolved.config_hash)?
                }
            };
            if let Some(parent) = cache.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            atomic_write(
                &cache,
                &serde_json::to_vec(&diagnostics).map_err(|error| error.to_string())?,
            )?;
            Ok(diagnostics)
        };
        match execution() {
            Ok(diagnostics) => {
                report.diagnostics.extend(diagnostics);
                report.capabilities.push(capability(
                    format!("analyzer/{name}"),
                    CapabilityAvailability::Available,
                    CapabilityExecution::Succeeded,
                    analyzer.required,
                    None,
                    name,
                    version,
                ));
            }
            Err(error) if analyzer.required => return Err(error),
            Err(error) => {
                let (availability, execution) = if error.starts_with("E_ENV_MISSING") {
                    (
                        CapabilityAvailability::Unavailable,
                        CapabilityExecution::Skipped,
                    )
                } else if error.starts_with("E_TIMEOUT") {
                    (
                        CapabilityAvailability::Available,
                        CapabilityExecution::TimedOut,
                    )
                } else {
                    (
                        CapabilityAvailability::Degraded,
                        CapabilityExecution::Failed,
                    )
                };
                report.capabilities.push(capability(
                    format!("analyzer/{name}"),
                    availability,
                    execution,
                    false,
                    Some(error.clone()),
                    name,
                    version,
                ));
                report.completeness = Completeness::Partial;
                report.warnings.push(error);
            }
        }
    }
    Ok(())
}

fn env_report(root: &Path, config: Option<&Path>) -> Result<Value, String> {
    let resolved =
        load(root, config, ConfigOverrides::default()).map_err(|error| error.to_string())?;
    Ok(json!({
        "schema": "skeptic.doctor-env/1",
        "root": root,
        "configHash": resolved.config_hash,
        "configSources": resolved.sources,
        "config": resolved.config,
        "tools": {
            "git": resolve_executable("git").is_file(),
            "node": resolve_executable("node").is_file(),
            "tsc": root.join("node_modules/.bin").join(if cfg!(windows) { "tsc.cmd" } else { "tsc" }).is_file(),
            "dart": resolve_executable("dart").is_file(),
            "swiftlint": resolve_executable("swiftlint").is_file(),
            "osv-scanner": resolve_executable("osv-scanner").is_file(),
            "adb": resolve_executable("adb").is_file(),
            "xcrun": resolve_executable("xcrun").is_file(),
            "ffmpeg": resolve_executable("ffmpeg").is_file(),
        }
    }))
}

fn ingest_file(path: &Path, config_hash: &str) -> Result<Vec<Diagnostic>, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("E_ANALYZER_FAILED: {}: {error}", path.display()))?;
    if path.extension().and_then(|value| value.to_str()) == Some("ndjson") {
        return ingest_ndjson(&text);
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("E_ANALYZER_FAILED: invalid ingest JSON: {error}"))?;
    if value.get("version").and_then(Value::as_str) == Some("2.1.0") {
        return ingest_sarif(&text, "ingest", config_hash);
    }
    let payload = value.get("data").unwrap_or(&value);
    let values = payload
        .get("diagnostics")
        .or_else(|| payload.get("findings"))
        .and_then(Value::as_array)
        .ok_or("E_ANALYZER_FAILED: ingest JSON has no diagnostics/findings array")?;
    let mut output = Vec::new();
    for value in values {
        if let Ok(diagnostic) = serde_json::from_value::<Diagnostic>(value.clone()) {
            diagnostic.validate().map_err(|error| {
                format!("E_ANALYZER_FAILED: invalid ingested diagnostic: {error}")
            })?;
            output.push(diagnostic);
            continue;
        }
        let rule = value
            .get("ruleId")
            .or_else(|| value.get("rule"))
            .and_then(Value::as_str)
            .unwrap_or("external");
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("external analyzer finding")
            .to_string();
        let file = value
            .get("file")
            .or_else(|| value.get("filePath"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let line = value
            .get("line")
            .and_then(Value::as_u64)
            .map(|line| line as u32);
        let column = value
            .get("column")
            .and_then(Value::as_u64)
            .map(|column| column as u32);
        let severity = match value.get("severity").and_then(Value::as_str) {
            Some("P0" | "error") => Severity::P0,
            Some("P1" | "warning") => Severity::P1,
            Some("P3" | "info") => Severity::P3,
            _ => Severity::P2,
        };
        output.push(analyzer_diagnostic(
            &format!("ingest/{rule}"),
            Category::Correctness,
            severity,
            file,
            line,
            column,
            message,
            config_hash,
        ));
    }
    Ok(output)
}

fn render_human(report: &DoctorReport, fix_plan: bool) -> String {
    let open = report
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.state == FindingState::Open)
        .count();
    let issue_word = if open == 1 { "issue" } else { "issues" };
    let file_word = if report.files_scanned == 1 {
        "file"
    } else {
        "files"
    };
    let coverage_note = match report.completeness {
        Completeness::Complete => String::new(),
        Completeness::Partial => " · partial (some checks did not run)".to_string(),
        Completeness::Failed => " · analysis failed".to_string(),
    };
    let headline = if open == 0 {
        format!(
            "Skeptic Doctor — no issues across {} {file_word}{coverage_note}\n\n",
            report.files_scanned
        )
    } else {
        format!(
            "Skeptic Doctor — {open} {issue_word} across {} {file_word}{coverage_note}\n\n",
            report.files_scanned
        )
    };
    let mut output = headline;
    let mut grouped: BTreeMap<Category, Vec<&Diagnostic>> = BTreeMap::new();
    for diagnostic in &report.diagnostics {
        grouped
            .entry(diagnostic.category)
            .or_default()
            .push(diagnostic);
    }
    for (category, diagnostics) in grouped {
        output.push_str(&format!("{category} ({})\n", diagnostics.len()));
        for diagnostic in diagnostics {
            let location = diagnostic.file.as_deref().unwrap_or("project").to_string()
                + &diagnostic
                    .span
                    .as_ref()
                    .map(|span| format!(":{}:{}", span.start.line, span.start.column))
                    .unwrap_or_default();
            let state = match diagnostic.state {
                FindingState::Open => "",
                FindingState::Suppressed => " [suppressed]",
                FindingState::Fixed => " [fixed]",
            };
            output.push_str(&format!(
                "  {} {}{}{}  {}\n    {}\n",
                diagnostic.severity,
                format_args!("({}) ", diagnostic.severity.word()),
                location,
                state,
                diagnostic.message,
                diagnostic.producer.rule_id
            ));
        }
        output.push('\n');
    }
    if !report.warnings.is_empty() {
        output.push_str("Partial analysis warnings\n");
        for warning in &report.warnings {
            output.push_str(&format!("  - {warning}\n"));
        }
        output.push('\n');
    }
    if fix_plan {
        output.push_str("Fix plan\n");
        let mut groups: BTreeMap<&str, usize> = BTreeMap::new();
        for diagnostic in report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.state == FindingState::Open)
        {
            *groups.entry(&diagnostic.producer.rule_id).or_default() += 1;
        }
        for (rule, count) in groups {
            output.push_str(&format!(
                "  1. {} — one fix · {} site(s); run `skeptic doctor why {}`\n",
                rule, count, rule
            ));
        }
    }
    output
}

fn run(options: Options) -> Result<i32, String> {
    let requested = options
        .root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let (root, explicit_file) = if requested.is_file() {
        let parent = requested
            .parent()
            .ok_or_else(|| "source file has no parent directory".to_string())?
            .to_path_buf();
        let relative = requested
            .strip_prefix(&parent)
            .unwrap_or(&requested)
            .to_string_lossy()
            .replace('\\', "/");
        (parent, Some(BTreeSet::from([relative])))
    } else {
        (requested, None)
    };
    let resolved = load(&root, options.config.as_deref(), ConfigOverrides::default())
        .map_err(|error| error.to_string())?;
    let baseline_path = options
        .baseline
        .clone()
        .unwrap_or_else(|| root.join(".skeptic/doctor-baseline.json"));
    let selected = if explicit_file.is_some() {
        explicit_file
    } else {
        options
            .scope_changed
            .then(|| changed_files(&root, &options.base))
            .transpose()?
    };
    let mut report = scan(
        &root,
        ScanOptions {
            files: selected,
            baseline: read_baseline(&baseline_path)?,
            confidence_threshold: options
                .confidence
                .unwrap_or(resolved.config.doctor.confidence_threshold),
            custom_pack: options.custom_pack,
        },
    )?;
    let child_env = analyzer_environment(&resolved.config.env.pass);
    if options.deep {
        if let Err(error) = run_tsc(
            &mut report,
            &root,
            &resolved.config_hash,
            &child_env,
            120_000,
        ) {
            record_optional_analyzer_failure(&mut report, "analyzer/tsc", "tsc", error);
        }
        if let Err(error) = run_dart(
            &mut report,
            &root,
            &resolved.config_hash,
            &child_env,
            120_000,
        ) {
            record_optional_analyzer_failure(&mut report, "analyzer/dart", "dart analyze", error);
        }
        if let Err(error) = run_swiftlint(
            &mut report,
            &root,
            &resolved.config_hash,
            &child_env,
            120_000,
        ) {
            record_optional_analyzer_failure(&mut report, "analyzer/swiftlint", "swiftlint", error);
        }
        if let Err(error) = ingest_native_reports(&mut report, &root, &resolved.config_hash) {
            record_optional_analyzer_failure(
                &mut report,
                "analyzer/native-sarif",
                "native SARIF",
                error,
            );
        }
        run_configured_analyzers(
            &mut report,
            &root,
            &resolved,
            options.allow_project_commands,
        )?;
    }
    for path in &options.ingest {
        report
            .diagnostics
            .extend(ingest_file(path, &resolved.config_hash)?);
        report.capabilities.push(capability(
            format!("analyzer/ingest/{}", path.display()),
            CapabilityAvailability::Available,
            CapabilityExecution::Succeeded,
            false,
            None,
            "ingest",
            None,
        ));
    }
    refresh_report(&mut report)?;
    if options.update_baseline {
        write_baseline(&baseline_path, &report)?;
    }
    let bytes = match options.format {
        Format::Human => render_human(&report, options.fix_plan).into_bytes(),
        Format::Json => {
            let mut envelope = ResponseEnvelope::success(
                serde_json::to_value(&report).map_err(|error| error.to_string())?,
                "skeptic.doctor-report/2",
                0,
            );
            envelope.meta.side_effects = if options.update_baseline {
                SideEffects::Committed
            } else {
                SideEffects::None
            };
            let mut bytes = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            bytes
        }
        Format::Sarif => {
            let mut bytes =
                serde_json::to_vec_pretty(&sarif(&report)).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            bytes
        }
    };
    write_output(options.output.as_deref(), &bytes)?;
    let blocking = options.blocking.unwrap_or(resolved.config.doctor.blocking);
    let confidence_threshold = options
        .confidence
        .unwrap_or(resolved.config.doctor.confidence_threshold);
    let has_blocking = report.diagnostics.iter().any(|diagnostic| {
        diagnostic.baseline_state == BaselineState::New
            && diagnostic.state == FindingState::Open
            && diagnostic.confidence >= confidence_threshold
            && definition(&diagnostic.producer.rule_id)
                .is_none_or(|definition| definition.surfaces.contains(&Surface::CiFailure))
            && match blocking {
                BlockingLevel::None => false,
                BlockingLevel::Warning => true,
                BlockingLevel::Error => matches!(diagnostic.severity, Severity::P0 | Severity::P1),
            }
    });
    Ok(if has_blocking { 1 } else { 0 })
}

fn help() -> &'static str {
    "skeptic doctor — scope-aware static QA\n\n\
Usage:\n  skeptic doctor [path] [options]\n  skeptic doctor why <rule-id>\n  skeptic doctor env\n  skeptic doctor baseline update [path]\n  skeptic doctor analyzers list [path]\n\n\
Options:\n  --scope all|changed       Scan all source or the git delta\n  --base <revision>         Base revision for changed scope\n  --deep                    Run detected tsc, Dart, SwiftLint, native SARIF, and configured analyzers\n  --allow-project-commands  Explicitly trust configured analyzer commands\n  --ingest <path>           Ingest canonical JSON/NDJSON/SARIF or React Doctor findings\n  --baseline <path>         Baseline file path\n  --update-baseline         Replace the baseline with current findings\n  --blocking none|warning|error\n  --confidence <0..1>       Score/CI confidence threshold (findings remain visible)\n  --fix-plan                Append one-fix/many-sites guidance\n  --format human|json|sarif\n  --output <path>\n"
}

fn analyzers_list(root: &Path) -> Result<Value, String> {
    let resolved =
        load(root, None, ConfigOverrides::default()).map_err(|error| error.to_string())?;
    let configured: Vec<_> = resolved
        .config
        .analyzers
        .iter()
        .map(|(name, analyzer)| {
            json!({"name": name, "command": analyzer.command, "format": analyzer.format, "required": analyzer.required, "timeoutMs": analyzer.timeout_ms})
        })
        .collect();
    Ok(json!({
        "schema": "skeptic.analyzers/1",
        "builtIn": [
            {"name":"tsc","detected":root.join("tsconfig.json").is_file(),"available":root.join("node_modules/.bin").join(if cfg!(windows) { "tsc.cmd" } else { "tsc" }).is_file(),"mode":"execute"},
            {"name":"dart","detected":root.join("pubspec.yaml").is_file(),"available":resolve_executable("dart").is_file(),"mode":"execute"},
            {"name":"swiftlint","detected":has_apple_project(root),"available":resolve_executable("swiftlint").is_file(),"mode":"execute"},
            {"name":"android-lint","detected":has_android_project(root),"available":!discovered_sarif_reports(root, "lint").is_empty(),"mode":"ingest-existing-sarif"},
            {"name":"detekt","detected":has_android_project(root),"available":!discovered_sarif_reports(root, "detekt").is_empty(),"mode":"ingest-existing-sarif"},
            {"name":"xcresult","detected":has_apple_project(root),"available":resolve_executable("xcrun").is_file(),"mode":"--ingest exported-json-or-sarif"},
            {"name":"osv-scanner","detected":has_entry(root, |path| matches!(path.file_name().and_then(|value| value.to_str()), Some("package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "Cargo.lock" | "Podfile.lock" | "pubspec.lock"))),"available":resolve_executable("osv-scanner").is_file(),"mode":"configured-supervised-command"}
        ],
        "configured": configured,
    }))
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--help" | "-h" | "help") => {
            print!("{}", help());
            Ok(0)
        }
        Some("why") => match args.get(1).and_then(|rule| why(rule)) {
            Some((definition, explanation, help)) => {
                println!("{}\n\nWhy: {}\n\nFix: {}", definition.id, explanation, help);
                Ok(0)
            }
            None => Err("unknown rule; run doctor to see emitted rule ids".into()),
        },
        Some("env") => {
            let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            env_report(&root, None).and_then(|value| {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
                );
                Ok(0)
            })
        }
        Some("baseline") if args.get(1).map(String::as_str) == Some("update") => {
            let mut scan_args = args[2..].to_vec();
            scan_args.push("--update-baseline".into());
            parse(&scan_args).and_then(run)
        }
        Some("analyzers") if args.get(1).map(String::as_str) == Some("list") => {
            let root = args
                .get(2)
                .filter(|value| !value.starts_with('-'))
                .map(PathBuf::from)
                .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            analyzers_list(&root).and_then(|value| {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
                );
                Ok(0)
            })
        }
        _ => parse(&args).and_then(run),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            let code = if error.contains("E_POLICY_BLOCKED") {
                7
            } else if error.contains("E_TIMEOUT") {
                5
            } else if error.contains("E_ENV_MISSING") {
                6
            } else if error.contains("E_ANALYZER_FAILED") {
                8
            } else {
                2
            };
            std::process::exit(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dart_machine_diagnostics() {
        let values = parse_dart_machine(
            "ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|lib/main.dart|4|9|3|Undefined name 'foo'.",
            "config",
        );
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].producer.rule_id, "dart/UNDEFINED_IDENTIFIER");
        assert_eq!(values[0].span.as_ref().unwrap().start.line, 4);
        assert_eq!(values[0].severity, Severity::P1);
    }

    #[test]
    fn parses_swiftlint_json_diagnostics() {
        let values = parse_swiftlint_json(
            r#"[{"character":3,"file":"Sources/App.swift","line":8,"reason":"Use let","rule_id":"prefer_let","severity":"Warning"}]"#,
            "config",
        )
        .unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].producer.rule_id, "swiftlint/prefer_let");
        assert_eq!(values[0].severity, Severity::P2);
    }
}
