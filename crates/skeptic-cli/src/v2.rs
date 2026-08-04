//! M1-frozen, daemon-independent commands. Keeping discovery, marker writes,
//! and config validation out of the browser process makes them deterministic.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use skeptic_config::{load, ConfigOverrides};
use skeptic_contract::{
    ApiError, ResponseEnvelope, SideEffects, CONFIG_SCHEMA, DIAGNOSTIC_SCHEMA, ENVELOPE_SCHEMA,
    EVENT_SCHEMA, EXIT_TABLE, RUN_SCHEMA,
};
use skeptic_evidence::{
    safe_path_component, session_journal_path, Journal, MarkerKind, MarkerPayload,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
    Ndjson,
    Sarif,
    Junit,
}

impl Format {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "human" => Ok(Self::Human),
            "json" => Ok(Self::Json),
            "ndjson" => Ok(Self::Ndjson),
            "sarif" => Ok(Self::Sarif),
            "junit" => Ok(Self::Junit),
            _ => Err(format!(
                "unsupported format `{value}`; expected human, json, ndjson, sarif, or junit"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Json => "json",
            Self::Ndjson => "ndjson",
            Self::Sarif => "sarif",
            Self::Junit => "junit",
        }
    }
}

#[derive(Debug)]
struct Invocation {
    format: Format,
    output: Option<PathBuf>,
    config: Option<PathBuf>,
    namespace: Option<String>,
    session: String,
    command: Vec<String>,
}

fn parse_invocation(args: &[String]) -> Result<Invocation, String> {
    let mut format = if args.iter().any(|arg| arg == "--json") {
        Format::Json
    } else {
        Format::Human
    };
    let mut output = None;
    let mut config = None;
    let mut namespace = None;
    let mut session = env::var("SKEPTIC_SESSION").unwrap_or_else(|_| "default".to_string());
    let mut command = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => {}
            "--format" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--format requires a value".to_string())?;
                format = Format::parse(value)?;
                index += 1;
            }
            value if value.starts_with("--format=") => {
                format = Format::parse(value.trim_start_matches("--format="))?;
            }
            "--output" => {
                output = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--output requires a path".to_string())?,
                ));
                index += 1;
            }
            value if value.starts_with("--output=") => {
                output = Some(PathBuf::from(value.trim_start_matches("--output=")));
            }
            "--config" => {
                config = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "--config requires a path".to_string())?,
                ));
                index += 1;
            }
            "--namespace" => {
                namespace = Some(
                    args.get(index + 1)
                        .ok_or_else(|| "--namespace requires a value".to_string())?
                        .clone(),
                );
                index += 1;
            }
            "--session" => {
                session = args
                    .get(index + 1)
                    .ok_or_else(|| "--session requires a value".to_string())?
                    .clone();
                index += 1;
            }
            value => command.push(value.to_string()),
        }
        index += 1;
    }
    Ok(Invocation {
        format,
        output,
        config,
        namespace,
        session,
        command,
    })
}

fn runner_binary() -> Result<PathBuf, String> {
    sibling_tool("skeptic-runner", "SKEPTIC_RUNNER_BIN")
}

fn sibling_tool(name: &str, env_name: &str) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os(env_name) {
        return Ok(PathBuf::from(path));
    }
    let current = env::current_exe().map_err(|error| error.to_string())?;
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let sibling = current.with_file_name(filename);
    sibling.is_file().then_some(sibling).ok_or_else(|| {
        format!(
            "{name} is missing next to {}; reinstall Skeptic or set {env_name}",
            current.display(),
        )
    })
}

fn run_runner(invocation: &Invocation, subcommand: &str) -> i32 {
    if invocation
        .command
        .iter()
        .any(|value| value == "--help" || value == "-h")
    {
        if subcommand == "run" {
            println!(
                "skeptic run — execute isolated TypeScript QA specs\n\n\
Usage: skeptic run [paths...] [--retries N] [--shard INDEX/TOTAL]\n\
                   [--format human|json|ndjson|junit] [--output PATH]"
            );
        } else {
            println!("skeptic scaffold — create a starter Skeptic TypeScript spec\n\nUsage: skeptic scaffold [path]");
        }
        return 0;
    }
    if subcommand == "run"
        && !matches!(
            invocation.format,
            Format::Human | Format::Json | Format::Ndjson | Format::Junit
        )
    {
        return failure(
            invocation,
            "run supports human, json, ndjson, or junit output",
            "E_USAGE",
            2,
        );
    }
    let binary = match runner_binary() {
        Ok(binary) => binary,
        Err(error) => return failure(invocation, error, "E_ENV_MISSING", 6),
    };
    let mut command = std::process::Command::new(binary);
    command.arg(subcommand);
    if subcommand == "run" {
        command.arg("--format").arg(invocation.format.as_str());
        if let Some(output) = invocation.output.as_ref() {
            command.arg("--output").arg(output);
        }
        if let Some(config) = invocation.config.as_ref() {
            command.arg("--config").arg(config);
        }
    }
    command.args(invocation.command.iter().skip(1));
    command.env(
        "SKEPTIC_BIN",
        env::current_exe().unwrap_or_else(|_| PathBuf::from("skeptic")),
    );
    match command.status() {
        Ok(status) => status.code().unwrap_or(10),
        Err(error) => failure(invocation, error.to_string(), "E_INTERNAL", 10),
    }
}

fn run_doctor(invocation: &Invocation) -> i32 {
    if !matches!(
        invocation.format,
        Format::Human | Format::Json | Format::Sarif
    ) {
        return failure(
            invocation,
            "doctor supports human, json, or sarif output",
            "E_USAGE",
            2,
        );
    }
    let binary = match sibling_tool("skeptic-doctor", "SKEPTIC_DOCTOR_BIN") {
        Ok(binary) => binary,
        Err(error) => return failure(invocation, error, "E_ENV_MISSING", 6),
    };
    let mut command = std::process::Command::new(binary);
    command.args(invocation.command.iter().skip(1));
    if !matches!(
        invocation.command.get(1).map(String::as_str),
        Some("why" | "env")
    ) {
        command.arg("--format").arg(invocation.format.as_str());
        if let Some(output) = invocation.output.as_ref() {
            command.arg("--output").arg(output);
        }
        if let Some(config) = invocation.config.as_ref() {
            command.arg("--config").arg(config);
        }
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(10),
        Err(error) => failure(invocation, error.to_string(), "E_INTERNAL", 10),
    }
}

fn run_mobile(invocation: &Invocation) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "mobile supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let binary = match sibling_tool("skeptic-mobile", "SKEPTIC_MOBILE_BIN") {
        Ok(binary) => binary,
        Err(error) => return failure(invocation, error, "E_ENV_MISSING", 6),
    };
    let mut command = std::process::Command::new(binary);
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let root = project_root(&cwd);
    let namespace = namespace_for(invocation, &root);
    let resolved = match load(
        &cwd,
        invocation.config.as_deref(),
        ConfigOverrides::default(),
    ) {
        Ok(resolved) => resolved,
        Err(error) => return failure(invocation, error.to_string(), "E_USAGE", 2),
    };
    command.arg("--format").arg(invocation.format.as_str());
    command
        .env("SKEPTIC_NAMESPACE", namespace)
        .env(
            "SKEPTIC_SESSION_IDLE_TTL_MS",
            resolved.config.session.idle_ttl_ms.to_string(),
        )
        .env(
            "SKEPTIC_MAX_SESSIONS",
            resolved.config.session.max_sessions.to_string(),
        );
    if let Some(output) = invocation.output.as_ref() {
        command.arg("--output").arg(output);
    }
    if invocation.command.first().map(String::as_str) == Some("mobile") {
        command.args(invocation.command.iter().skip(1));
    } else {
        command.args(&invocation.command);
    }
    command.arg("--session").arg(&invocation.session);
    match command.status() {
        Ok(status) => status.code().unwrap_or(10),
        Err(error) => failure(invocation, error.to_string(), "E_INTERNAL", 10),
    }
}

fn is_browser_hot_command(command: &str) -> bool {
    matches!(
        command,
        "open"
            | "snapshot"
            | "audit"
            | "a11y"
            | "click"
            | "dblclick"
            | "type"
            | "fill"
            | "press"
            | "keyboard"
            | "hover"
            | "focus"
            | "check"
            | "uncheck"
            | "select"
            | "drag"
            | "upload"
            | "download"
            | "scroll"
            | "scrollintoview"
            | "wait"
            | "screenshot"
            | "pdf"
            | "eval"
            | "connect"
            | "close"
            | "back"
            | "forward"
            | "reload"
            | "get"
            | "is"
            | "find"
            | "mouse"
            | "set"
            | "network"
            | "cookies"
            | "storage"
            | "tab"
            | "frame"
            | "diff"
            | "trace"
            | "profiler"
            | "record"
            | "console"
            | "errors"
            | "highlight"
            | "inspect"
            | "clipboard"
            | "react"
            | "vitals"
            | "pushstate"
            | "batch"
            | "state"
            | "auth"
            | "visual"
            | "read"
    )
}

fn browser_side_effects(command: &str) -> SideEffects {
    match command {
        "snapshot" | "get" | "is" | "console" | "errors" | "vitals" | "read" => SideEffects::None,
        "click" | "dblclick" | "type" | "fill" | "press" | "keyboard" | "check" | "uncheck"
        | "select" | "drag" | "upload" | "scroll" | "scrollintoview" | "open" | "back"
        | "forward" | "reload" | "close" | "visual" => SideEffects::Committed,
        _ => SideEffects::Possible,
    }
}

fn raw_browser_args(args: &[String]) -> Vec<String> {
    let mut output = Vec::new();
    let mut index = 0;
    let mut json = false;
    while index < args.len() {
        match args[index].as_str() {
            "--format" => {
                json |= args.get(index + 1).is_some_and(|value| value == "json");
                index += 1;
            }
            value if value.starts_with("--format=") => {
                json |= value.trim_start_matches("--format=") == "json";
            }
            "--output" => index += 1,
            value if value.starts_with("--output=") => {}
            "--json" => json = true,
            value => output.push(value.to_string()),
        }
        index += 1;
    }
    if json {
        output.push("--json".into());
    }
    output
}

fn classify_browser_error(message: &str, fallback_exit: i32) -> (&'static str, i32, bool) {
    let lower = message.to_ascii_lowercase();
    if lower.contains("stale") && lower.contains("ref") {
        ("E_STALE_REF", 4, true)
    } else if lower.contains("timeout") || lower.contains("timed out") {
        ("E_TIMEOUT", 5, true)
    } else if lower.contains("policy") || lower.contains("not allowed") {
        ("E_POLICY_BLOCKED", 7, false)
    } else if lower.contains("connect") || lower.contains("unreachable") {
        ("E_TARGET_UNREACHABLE", 3, true)
    } else if fallback_exit == 2 {
        ("E_USAGE", 2, false)
    } else {
        ("E_TARGET_UNREACHABLE", 3, true)
    }
}

fn run_browser_json(invocation: &Invocation, original_args: &[String]) -> i32 {
    let current = match env::current_exe() {
        Ok(path) => path,
        Err(error) => return failure(invocation, error.to_string(), "E_INTERNAL", 10),
    };
    let output = match std::process::Command::new(current)
        .args(raw_browser_args(original_args))
        .env("SKEPTIC_V2_RAW_BROWSER", "1")
        .output()
    {
        Ok(output) => output,
        Err(error) => return failure(invocation, error.to_string(), "E_INTERNAL", 10),
    };
    if !output.stderr.is_empty() {
        let _ = std::io::stderr().lock().write_all(&output.stderr);
    }
    let legacy: Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => {
            return failure(
                invocation,
                format!(
                    "browser command returned invalid JSON: {error}; stdout: {}",
                    String::from_utf8_lossy(&output.stdout)
                ),
                "E_INTERNAL",
                10,
            )
        }
    };
    let command = invocation.command.first().map(String::as_str).unwrap_or("");
    let side_effects = browser_side_effects(command);
    let ok = legacy
        .get("ok")
        .or_else(|| legacy.get("success"))
        .and_then(Value::as_bool)
        .unwrap_or(output.status.success());
    if ok {
        let data = legacy.get("data").cloned().unwrap_or(legacy);
        let envelope = ResponseEnvelope::success(data, "skeptic.browser/1", 0);
        return match emit_json(invocation, envelope, side_effects) {
            Ok(()) => output.status.code().unwrap_or(0),
            Err(error) => failure(invocation, error, "E_INTERNAL", 10),
        };
    }
    let message = legacy
        .pointer("/error/message")
        .or_else(|| legacy.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("browser action failed")
        .to_string();
    let fallback = output.status.code().unwrap_or(10);
    let (code, exit, retryable) = classify_browser_error(&message, fallback);
    let envelope = ResponseEnvelope::<Value>::failure(
        ApiError {
            code: code.into(),
            message,
            retryable,
            hint: (code == "E_STALE_REF")
                .then(|| "take a fresh snapshot and retry with its ref".into()),
        },
        0,
        side_effects,
    );
    match emit_json(invocation, envelope, side_effects) {
        Ok(()) => exit,
        Err(error) => failure(invocation, error, "E_INTERNAL", 10),
    }
}

fn mobile_binding_exists(invocation: &Invocation, cwd: &Path) -> bool {
    let root = project_root(cwd);
    let namespace = namespace_for(invocation, &root);
    root.join(".skeptic/mobile-sessions")
        .join(safe_path_component(&namespace))
        .join(format!("{}.json", invocation.session))
        .is_file()
}

fn explicit_mobile_platform(command: &[String]) -> bool {
    command
        .iter()
        .position(|value| value == "--platform")
        .and_then(|index| command.get(index + 1))
        .is_some_and(|value| matches!(value.as_str(), "android" | "ios" | "ios-sim"))
}

fn is_mobile_hot_loop(invocation: &Invocation, cwd: &Path) -> bool {
    let Some(command) = invocation.command.first().map(String::as_str) else {
        return false;
    };
    matches!(
        command,
        "open"
            | "snapshot"
            | "click"
            | "tap"
            | "fill"
            | "swipe"
            | "scroll"
            | "type"
            | "press"
            | "screenshot"
            | "screenrecord"
            | "recordVideo"
            | "close"
    ) && (explicit_mobile_platform(&invocation.command) || mobile_binding_exists(invocation, cwd))
}

fn run_report(invocation: &Invocation) -> i32 {
    let command_name = invocation
        .command
        .first()
        .map(String::as_str)
        .unwrap_or("report");
    if invocation
        .command
        .iter()
        .any(|value| value == "--help" || value == "-h")
    {
        if command_name == "score" {
            println!(
                "skeptic score — show the deterministic coverage-aware QA score\n\n\
Usage: skeptic score [--explain] [--manifest PATH] [--diagnostics PATH]\n\
                     [--format human|json] [--output PATH]"
            );
        } else {
            println!(
                "skeptic report — fold a run manifest and diagnostics into a report\n\n\
Usage: skeptic report [--manifest PATH] [--diagnostics PATH]\n\
                      [--format human|json|sarif] [--output PATH]"
            );
        }
        return 0;
    }
    let supported = if command_name == "score" {
        matches!(invocation.format, Format::Human | Format::Json)
    } else {
        matches!(
            invocation.format,
            Format::Human | Format::Json | Format::Sarif
        )
    };
    if !supported {
        return failure(invocation, "unsupported report format", "E_USAGE", 2);
    }
    let binary = match sibling_tool("skeptic-report", "SKEPTIC_REPORT_BIN") {
        Ok(binary) => binary,
        Err(error) => return failure(invocation, error, "E_ENV_MISSING", 6),
    };
    let mut command = std::process::Command::new(binary);
    command
        .arg(command_name)
        .arg("--format")
        .arg(invocation.format.as_str());
    if let Some(output) = invocation.output.as_ref() {
        command.arg("--output").arg(output);
    }
    command.args(invocation.command.iter().skip(1));
    match command.status() {
        Ok(status) => status.code().unwrap_or(10),
        Err(error) => failure(invocation, error.to_string(), "E_INTERNAL", 10),
    }
}

fn run_skills(invocation: &Invocation, started: Instant) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "skills supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let action = invocation
        .command
        .get(1)
        .map(String::as_str)
        .unwrap_or("list");
    let full = invocation.command.iter().any(|value| value == "--full");
    let data = match action {
        "list" => crate::skills::embedded_skill_catalog(),
        "get" => {
            let all = invocation.command.iter().any(|value| value == "--all");
            let names = if all {
                crate::skills::embedded_skill_catalog()
                    .into_iter()
                    .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_owned))
                    .collect::<Vec<_>>()
            } else {
                invocation
                    .command
                    .iter()
                    .skip(2)
                    .filter(|value| !value.starts_with('-'))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if names.is_empty() {
                return failure(
                    invocation,
                    "usage: skeptic skills get <name>|--all [--full]",
                    "E_USAGE",
                    2,
                );
            }
            let mut items = Vec::new();
            for name in names {
                let Some(item) = crate::skills::embedded_skill_bundle(&name, full) else {
                    return failure(
                        invocation,
                        format!("skill `{name}` was not found"),
                        "E_USAGE",
                        2,
                    );
                };
                items.push(item);
            }
            items
        }
        _ => return failure(invocation, "usage: skeptic skills <list|get>", "E_USAGE", 2),
    };
    if invocation.format == Format::Json {
        let envelope = ResponseEnvelope::success(
            Value::Array(data),
            "skeptic.skills/1",
            started.elapsed().as_millis() as u64,
        );
        if let Err(error) = emit_json(invocation, envelope, SideEffects::None) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
        return 0;
    }
    let mut text = String::new();
    for (index, item) in data.iter().enumerate() {
        if index > 0 {
            text.push_str("\n---\n\n");
        }
        if let Some(content) = item.get("content").and_then(Value::as_str) {
            text.push_str(content);
            if full {
                for file in item
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    text.push_str(&format!(
                        "\n--- {} ---\n{}",
                        file.get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("reference"),
                        file.get("content").and_then(Value::as_str).unwrap_or("")
                    ));
                }
            }
        } else {
            text.push_str(&format!(
                "{:<10}  {}\n",
                item.get("name").and_then(Value::as_str).unwrap_or(""),
                item.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ));
        }
    }
    if let Err(error) = write_bytes(invocation.output.as_deref(), text.as_bytes()) {
        return failure(invocation, error, "E_INTERNAL", 10);
    }
    0
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

fn namespace_for(invocation: &Invocation, root: &Path) -> String {
    if let Some(namespace) = invocation
        .namespace
        .clone()
        .or_else(|| env::var("SKEPTIC_NAMESPACE").ok())
    {
        return namespace;
    }
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()))[..12].to_string()
}

fn write_bytes(path: Option<&Path>, bytes: &[u8]) -> Result<(), String> {
    if let Some(path) = path {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        fs::write(path, bytes).map_err(|error| format!("cannot write {}: {error}", path.display()))
    } else {
        std::io::stdout()
            .lock()
            .write_all(bytes)
            .map_err(|error| format!("cannot write stdout: {error}"))
    }
}

fn emit_json(
    invocation: &Invocation,
    mut envelope: ResponseEnvelope<Value>,
    side_effects: SideEffects,
) -> Result<(), String> {
    envelope.meta.side_effects = side_effects;
    envelope.validate().map_err(|error| error.to_string())?;
    let mut bytes = serde_json::to_vec(&envelope)
        .map_err(|error| format!("cannot serialize response: {error}"))?;
    bytes.push(b'\n');
    write_bytes(invocation.output.as_deref(), &bytes)
}

fn failure(invocation: &Invocation, message: impl Into<String>, code: &str, exit: i32) -> i32 {
    let message = message.into();
    if invocation.format == Format::Json {
        let envelope = ResponseEnvelope::<Value>::failure(
            ApiError {
                code: code.to_string(),
                message,
                retryable: false,
                hint: None,
            },
            0,
            SideEffects::None,
        );
        if let Err(error) = emit_json(invocation, envelope, SideEffects::None) {
            eprintln!("{error}");
            return 10;
        }
    } else {
        eprintln!("{message}");
    }
    exit
}

fn command_manifest() -> Value {
    let hot_loop = vec![
        "open",
        "snapshot",
        "audit",
        "click",
        "fill",
        "type",
        "press",
        "hover",
        "check",
        "uncheck",
        "select",
        "get",
        "is",
        "scroll",
        "screenshot",
        "find",
        "wait",
        "console",
        "network",
        "record",
        "close",
        "tab",
        "frame",
        "cookies",
        "storage",
        "state",
        "auth",
        "diff",
        "visual",
        "vitals",
        "trace",
        "profiler",
        "eval",
        "read",
    ];
    let commands = [
        json!({"name":"manifest","formats":["human","json"],"stdout":"command manifest","sideEffects":"none"}),
        json!({"name":"mark","formats":["human","json"],"stdout":"marker receipt","sideEffects":"committed"}),
        json!({"name":"config show","formats":["human","json"],"stdout":"resolved configuration","sideEffects":"none"}),
        json!({"name":"init","formats":["human","json"],"stdout":"created config path","sideEffects":"committed"}),
        json!({"name":"run","formats":["human","json","ndjson","junit"],"stdout":"test events or report","sideEffects":"possible"}),
        json!({"name":"doctor","formats":["human","json","sarif"],"stdout":"diagnostics","sideEffects":"none"}),
        json!({"name":"report","formats":["human","json","sarif"],"stdout":"folded run report","sideEffects":"none"}),
        json!({"name":"score","formats":["human","json"],"stdout":"coverage-aware score","sideEffects":"none"}),
        json!({"name":"visual","formats":["human","json"],"stdout":"visual result","sideEffects":"possible"}),
        json!({"name":"mobile","formats":["human","json"],"stdout":"mobile setup result","sideEffects":"possible"}),
        json!({"name":"skills get","formats":["human","json"],"stdout":"version-locked skill content","sideEffects":"none"}),
    ];
    json!({
        "name": "skeptic",
        "version": env!("CARGO_PKG_VERSION"),
        "contractFreeze": "M1",
        "globals": {
            "format": ["human", "json", "ndjson", "sarif", "junit"],
            "jsonAlias": "--format json",
            "output": "file destination",
            "session": "default",
            "namespace": "cwd-derived",
            "config": "skeptic.toml"
        },
        "commands": commands,
        "hotLoop": hot_loop,
        "schemas": [CONFIG_SCHEMA, DIAGNOSTIC_SCHEMA, ENVELOPE_SCHEMA, EVENT_SCHEMA, RUN_SCHEMA],
        "exitCodes": EXIT_TABLE,
    })
}

fn print_v2_help() {
    println!(
        "skeptic — deterministic, agent-native QA for web and mobile\n\n\
Usage: skeptic [global options] <command> [arguments]\n\n\
Core workflows:\n  manifest --format json          Discover the stable agent contract\n  open <url>                      Open or navigate a web session\n  snapshot -i -c                 Read the semantic tree and fresh @refs\n  click|fill|type|press ...      Act through semantic refs\n  audit                           Run browser accessibility checks\n  visual check|update <name>     Compare or update a visual baseline\n  run [specs...]                 Run isolated TypeScript E2E specs\n  doctor [path]                  Run source diagnostics\n  report                         Fold findings, tests, and evidence\n  score --explain                Explain the coverage-aware score\n\n\
Mobile sessions:\n  devices --format json\n  mobile setup android|ios [--install]\n  open <app> --platform android|ios-sim [--device <id>]\n  snapshot | click @eN | fill @eN <text> | screenshot <path> | close\n\n\
Agent integration:\n  skills get core --full\n  add skill\n  add github-action\n\n\
Global options:\n  --session <name>               Isolate browser/mobile state\n  --format human|json|ndjson|sarif|junit\n  --json                         Alias for --format json\n  --output <path>                Write command data to a file\n  --config <path>                Use an explicit skeptic.toml\n  --namespace <name>             Isolate local daemon state\n  --version                      Print the installed version\n\n\
Run `skeptic manifest --format json` for machine-readable capabilities and\n\
`skeptic skills get core --full` for the version-matched operating guide."
    );
}

fn run_manifest(invocation: &Invocation, started: Instant) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "manifest supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let manifest = command_manifest();
    if invocation.format == Format::Json {
        let mut envelope = ResponseEnvelope::success(
            manifest,
            "skeptic.command-manifest/1",
            started.elapsed().as_millis() as u64,
        );
        envelope.meta.total = None;
        if let Err(error) = emit_json(invocation, envelope, SideEffects::None) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    } else {
        let pretty = serde_json::to_vec_pretty(&manifest).unwrap_or_default();
        if let Err(error) = write_bytes(invocation.output.as_deref(), &pretty) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
        if invocation.output.is_none() {
            println!();
        }
    }
    0
}

fn run_mark(invocation: &Invocation, started: Instant, cwd: &Path) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "mark supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let Some(kind) = invocation.command.get(1) else {
        return failure(
            invocation,
            "usage: skeptic mark <STEP_START|STEP_DONE|ASSERTION_FAILED|RUN_COMPLETED> [step-id] <message>",
            "E_USAGE",
            2,
        );
    };
    let kind = match MarkerKind::parse(kind) {
        Ok(kind) => kind,
        Err(error) => return failure(invocation, error, "E_USAGE", 2),
    };
    let (step_id, message_start) = match kind {
        MarkerKind::RunCompleted => (None, 2),
        _ => match invocation.command.get(2) {
            Some(step_id) => (Some(step_id.clone()), 3),
            None => {
                return failure(invocation, "marker requires a step id", "E_USAGE", 2);
            }
        },
    };
    let message = invocation.command[message_start..].join(" ");
    if message.trim().is_empty() {
        return failure(invocation, "marker message must not be empty", "E_USAGE", 2);
    }
    let root = project_root(cwd);
    let namespace = namespace_for(invocation, &root);
    let path = session_journal_path(&root, &namespace, &invocation.session);
    let journal = Journal::for_session(&path, &invocation.session);
    let event = match journal.append_marker(MarkerPayload {
        kind,
        step_id,
        message,
    }) {
        Ok(event) => event,
        Err(error) => return failure(invocation, error, "E_INTERNAL", 10),
    };
    if invocation.format == Format::Json {
        let envelope = ResponseEnvelope::success(
            serde_json::to_value(&event).unwrap_or(Value::Null),
            EVENT_SCHEMA,
            started.elapsed().as_millis() as u64,
        );
        if let Err(error) = emit_json(invocation, envelope, SideEffects::Committed) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    } else {
        let line = format!("recorded marker {} in {}\n", event.sequence, path.display());
        if let Err(error) = write_bytes(invocation.output.as_deref(), line.as_bytes()) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    }
    0
}

fn run_config_show(invocation: &Invocation, started: Instant, cwd: &Path) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "config show supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let resolved = match load(
        cwd,
        invocation.config.as_deref(),
        ConfigOverrides::default(),
    ) {
        Ok(config) => config,
        Err(error) => return failure(invocation, error.to_string(), "E_USAGE", 2),
    };
    let value = json!({
        "config": resolved.config,
        "configHash": resolved.config_hash,
        "sources": resolved.sources,
    });
    if invocation.format == Format::Json {
        let envelope =
            ResponseEnvelope::success(value, CONFIG_SCHEMA, started.elapsed().as_millis() as u64);
        if let Err(error) = emit_json(invocation, envelope, SideEffects::None) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    } else {
        let mut bytes = toml::to_string_pretty(&resolved.config)
            .unwrap_or_else(|_| format!("schema = \"{CONFIG_SCHEMA}\"\n"))
            .into_bytes();
        if !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        if let Err(error) = write_bytes(invocation.output.as_deref(), &bytes) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    }
    0
}

fn run_init(invocation: &Invocation, started: Instant, cwd: &Path) -> i32 {
    let path = invocation
        .config
        .clone()
        .unwrap_or_else(|| cwd.join("skeptic.toml"));
    if path.exists() {
        return failure(
            invocation,
            format!("{} already exists", path.display()),
            "E_USAGE",
            2,
        );
    }
    let source = format!(
        "schema = \"{CONFIG_SCHEMA}\"\n\n[session]\nidleTtlMs = 300000\nmaxSessions = 8\n\n[runner]\nactionTimeoutMs = 5000\ntestTimeoutMs = 30000\nhardTimeoutMs = 35000\nassertionTimeoutMs = 5000\npollIntervalMs = 100\nretries = 0\n"
    );
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if let Err(error) = fs::create_dir_all(parent) {
            return failure(invocation, error.to_string(), "E_INTERNAL", 10);
        }
    }
    if let Err(error) = fs::write(&path, source) {
        return failure(invocation, error.to_string(), "E_INTERNAL", 10);
    }
    if invocation.format == Format::Json {
        let envelope = ResponseEnvelope::success(
            json!({"path": path, "created": true}),
            "skeptic.init/1",
            started.elapsed().as_millis() as u64,
        );
        if let Err(error) = emit_json(invocation, envelope, SideEffects::Committed) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    } else {
        let line = format!("created {}\n", path.display());
        if let Err(error) = write_bytes(invocation.output.as_deref(), line.as_bytes()) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    }
    0
}

fn github_action_template() -> String {
    format!(
        r#"name: Skeptic QA

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  qa:
    runs-on: ubuntu-22.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - name: Install Skeptic
        run: npm install --no-save skeptic-cli@{version}
      - name: Start app and wait
        run: |
          npm run dev > .skeptic-dev.log 2>&1 &
          npx --yes wait-on@8 http://127.0.0.1:3000
      - name: Static QA
        id: doctor
        continue-on-error: true
        run: npx skeptic doctor --format sarif --output skeptic-doctor.sarif
      - name: Browser QA
        id: browser
        continue-on-error: true
        run: npx skeptic run --format junit --output skeptic-junit.xml
      - name: Build terminal summary and annotations
        if: always()
        run: |
          npx skeptic report --format human >> "$GITHUB_STEP_SUMMARY" || true
          if [ -f skeptic-doctor.sarif ]; then
            jq -r '.runs[].results[]? | "::error file=\(.locations[0].physicalLocation.artifactLocation.uri // \"unknown\"),line=\(.locations[0].physicalLocation.region.startLine // 1)::\(.message.text)"' skeptic-doctor.sarif
          fi
      - name: Upload SARIF
        if: always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: skeptic-doctor.sarif
      - name: Upload Skeptic evidence
        if: always()
        env:
          SKEPTIC_CI_INCLUDE_SENSITIVE: "false"
        run: |
          mkdir -p skeptic-ci-artifacts
          if [ "$SKEPTIC_CI_INCLUDE_SENSITIVE" = "true" ]; then
            cp -R .skeptic/runs skeptic-ci-artifacts/ 2>/dev/null || true
          elif [ -d .skeptic/runs ]; then
            find .skeptic/runs -type f ! -name '*.png' ! -name '*.mp4' ! -name '*.webm' -exec cp --parents {{}} skeptic-ci-artifacts/ \;
          fi
      - name: Publish Skeptic evidence artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: skeptic-${{{{ github.run_id }}}}
          if-no-files-found: warn
          path: |
            skeptic-ci-artifacts/
            skeptic-doctor.sarif
            skeptic-junit.xml
            .skeptic-dev.log
      - name: Enforce result
        if: steps.doctor.outcome == 'failure' || steps.browser.outcome == 'failure'
        run: exit 1
"#,
        version = env!("CARGO_PKG_VERSION")
    )
}

fn run_add(invocation: &Invocation, started: Instant, cwd: &Path) -> i32 {
    if !matches!(invocation.format, Format::Human | Format::Json) {
        return failure(
            invocation,
            "add supports human or json output",
            "E_USAGE",
            2,
        );
    }
    let Some(kind) = invocation.command.get(1).map(String::as_str) else {
        return failure(
            invocation,
            "usage: skeptic add <github-action|skill>",
            "E_USAGE",
            2,
        );
    };
    let force = invocation.command.iter().any(|value| value == "--force");
    let result: Result<Value, String> = match kind {
        "github-action" => {
            let path = cwd.join(".github/workflows/skeptic.yml");
            if path.exists() && !force {
                Err(format!(
                    "{} already exists; pass --force to replace it",
                    path.display()
                ))
            } else {
                fs::create_dir_all(path.parent().expect("workflow parent"))
                    .map_err(|error| error.to_string())
                    .and_then(|()| {
                        fs::write(&path, github_action_template())
                            .map_err(|error| error.to_string())
                    })
                    .map(|()| json!({"installed":"github-action","path":path}))
            }
        }
        "skill" => {
            let destination = invocation
                .command
                .iter()
                .position(|value| value == "--target")
                .and_then(|index| invocation.command.get(index + 1))
                .map(|value| cwd.join(value))
                .unwrap_or_else(|| cwd.join(".agents/skills"));
            crate::skills::install_embedded_skills(
                &destination,
                &["core", "doctor", "mobile", "evidence"],
            )
            .map(|paths| json!({"installed":"skills","paths":paths}))
        }
        _ => Err(format!(
            "unknown add target `{kind}`; expected github-action or skill"
        )),
    };
    let value = match result {
        Ok(value) => value,
        Err(error) => return failure(invocation, error, "E_USAGE", 2),
    };
    if invocation.format == Format::Json {
        let envelope =
            ResponseEnvelope::success(value, "skeptic.add/1", started.elapsed().as_millis() as u64);
        if let Err(error) = emit_json(invocation, envelope, SideEffects::Committed) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    } else {
        let line = format!(
            "installed {}\n",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        );
        if let Err(error) = write_bytes(invocation.output.as_deref(), line.as_bytes()) {
            return failure(invocation, error, "E_INTERNAL", 10);
        }
    }
    0
}

pub fn try_run(args: &[String]) -> Option<i32> {
    if env::var_os("SKEPTIC_V2_RAW_BROWSER").is_some() {
        return None;
    }
    if args.is_empty()
        || matches!(
            args,
            [value] if matches!(value.as_str(), "--help" | "-h" | "help")
        )
    {
        print_v2_help();
        return Some(0);
    }
    let invocation = match parse_invocation(args) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprintln!("{error}");
            return Some(2);
        }
    };
    let command = invocation.command.first().map(String::as_str)?;
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if is_mobile_hot_loop(&invocation, &cwd) {
        return Some(run_mobile(&invocation));
    }
    if invocation.format == Format::Json && is_browser_hot_command(command) {
        return Some(run_browser_json(&invocation, args));
    }
    if !matches!(
        command,
        "manifest"
            | "mark"
            | "config"
            | "init"
            | "run"
            | "scaffold"
            | "doctor"
            | "mobile"
            | "devices"
            | "report"
            | "score"
            | "add"
            | "skills"
    ) {
        return None;
    }
    let started = Instant::now();
    let cwd = match cwd.canonicalize() {
        Ok(cwd) => cwd,
        Err(error) => return Some(failure(&invocation, error.to_string(), "E_INTERNAL", 10)),
    };
    Some(match command {
        "manifest" => run_manifest(&invocation, started),
        "mark" => run_mark(&invocation, started, &cwd),
        "config" if invocation.command.get(1).map(String::as_str) == Some("show") => {
            run_config_show(&invocation, started, &cwd)
        }
        "config" => failure(&invocation, "usage: skeptic config show", "E_USAGE", 2),
        "init" => run_init(&invocation, started, &cwd),
        "run" => run_runner(&invocation, "run"),
        "scaffold" => run_runner(&invocation, "scaffold"),
        "doctor" => run_doctor(&invocation),
        "mobile" | "devices" => run_mobile(&invocation),
        "report" | "score" => run_report(&invocation),
        "add" => run_add(&invocation, started, &cwd),
        "skills" => run_skills(&invocation, started),
        _ => unreachable!(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_json_alias_and_output_as_destination() {
        let invocation =
            parse_invocation(&args(&["--json", "--output", "result.json", "manifest"])).unwrap();
        assert_eq!(invocation.format, Format::Json);
        assert_eq!(invocation.output, Some(PathBuf::from("result.json")));
        assert_eq!(invocation.command, vec!["manifest"]);
    }

    #[test]
    fn manifest_exposes_frozen_schemas_and_named_exits() {
        let manifest = command_manifest();
        assert!(manifest["schemas"]
            .as_array()
            .unwrap()
            .iter()
            .any(|schema| schema == EVENT_SCHEMA));
        assert_eq!(manifest["exitCodes"].as_array().unwrap().len(), 10);
        assert!(!manifest["globals"]["format"]
            .as_array()
            .unwrap()
            .iter()
            .any(|format| format == "html"));
        let report = manifest["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["name"] == "report")
            .unwrap();
        assert_eq!(report["formats"], json!(["human", "json", "sarif"]));
    }

    #[test]
    fn rejects_removed_html_report_format() {
        let error = parse_invocation(&args(&["report", "--format", "html"])).unwrap_err();
        assert!(error.contains("unsupported format `html`"));
    }

    #[test]
    fn generated_action_uses_terminal_summary_without_html_report() {
        let workflow = github_action_template();
        assert!(workflow.contains("skeptic report --format human"));
        assert!(workflow.contains("GITHUB_STEP_SUMMARY"));
        assert!(!workflow.contains("--format html"));
        assert!(!workflow.contains("skeptic-report.html"));
    }

    #[test]
    fn browser_json_bridge_removes_v2_output_flags() {
        assert_eq!(
            raw_browser_args(&args(&[
                "--session",
                "qa",
                "snapshot",
                "--format",
                "json",
                "--output",
                "snapshot.json",
            ])),
            args(&["--session", "qa", "snapshot", "--json"])
        );
    }

    #[test]
    fn browser_error_mapping_preserves_retry_semantics() {
        assert_eq!(
            classify_browser_error("reference @e2 is stale", 1),
            ("E_STALE_REF", 4, true)
        );
        assert_eq!(
            classify_browser_error("browser connection unreachable", 1),
            ("E_TARGET_UNREACHABLE", 3, true)
        );
    }
}
