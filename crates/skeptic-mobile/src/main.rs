use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use skeptic_contract::{ApiError, ResponseEnvelope, SideEffects};
use skeptic_daemon::{enforce_session_capacity, DocumentIdentity, DurableLease, LeaseClass};
use skeptic_evidence::{
    action_payload, atomic_write_json, safe_path_component, session_journal_path, Journal,
};
use skeptic_mobile::{
    android_a11y_probe, android_close, android_gfxinfo, android_logcat, android_open,
    android_press, android_screenrecord, android_screenshot, android_snapshot, android_swipe,
    android_tap, android_type, devices, ios_accessibility_audit, ios_close, ios_open,
    ios_screenrecord, ios_screenshot, ios_snapshot, ios_swipe, ios_tap, ios_type, ios_xctrace,
    resolve_reference, setup,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
}

struct Options {
    format: Format,
    output: Option<PathBuf>,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileBinding {
    schema: String,
    namespace: String,
    session: String,
    platform: String,
    device: Option<String>,
    target: Option<String>,
    identity: DocumentIdentity,
    generation: u64,
    next_ref_id: u64,
    snapshot: Option<skeptic_mobile::MobileSnapshot>,
    lease: DurableLease,
}

fn session_name(args: &[String]) -> String {
    flag(args, "--session").unwrap_or_else(|| "default".into())
}

fn validate_session_name(args: &[String]) -> Result<(), String> {
    let session = session_name(args);
    if session.is_empty()
        || session.len() > 64
        || matches!(session.as_str(), "." | "..")
        || !session.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(
            "E_USAGE: --session must be 1-64 ASCII letters, digits, dots, dashes, or underscores"
                .into(),
        );
    }
    Ok(())
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

fn workspace_root() -> PathBuf {
    project_root(&env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn namespace() -> String {
    env::var("SKEPTIC_NAMESPACE").unwrap_or_else(|_| "default".into())
}

fn binding_directory() -> PathBuf {
    workspace_root()
        .join(".skeptic/mobile-sessions")
        .join(safe_path_component(&namespace()))
}

fn binding_path(args: &[String]) -> PathBuf {
    binding_directory().join(format!("{}.json", safe_path_component(&session_name(args))))
}

fn session_ttl() -> Duration {
    Duration::from_millis(
        env::var("SKEPTIC_SESSION_IDLE_TTL_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|value| *value > 0)
            .unwrap_or(300_000),
    )
}

fn max_sessions() -> usize {
    env::var("SKEPTIC_MAX_SESSIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(8)
}

fn save_binding(args: &[String], binding: &MobileBinding) -> Result<(), String> {
    atomic_write_json(&binding_path(args), binding)
}

fn read_binding(path: &Path) -> Option<MobileBinding> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn prune_expired_bindings() -> Result<usize, String> {
    let directory = binding_directory();
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(0);
    };
    let mut active = 0;
    for entry in entries.flatten().filter(|entry| entry.path().is_file()) {
        match read_binding(&entry.path()) {
            Some(binding) if !binding.lease.is_expired() => active += 1,
            _ => {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(active)
}

fn load_binding(args: &[String]) -> Result<MobileBinding, String> {
    let path = binding_path(args);
    let mut binding = read_binding(&path).ok_or_else(|| {
        format!(
            "E_TARGET_UNREACHABLE: mobile session `{}` is not open",
            session_name(args)
        )
    })?;
    if binding.lease.is_expired() {
        let _ = fs::remove_file(path);
        return Err(format!(
            "E_TARGET_UNREACHABLE: mobile session `{}` expired; open it again",
            session_name(args)
        ));
    }
    if let Some(platform) = flag(args, "--platform") {
        let normalized = if platform == "ios" {
            "ios-sim"
        } else {
            &platform
        };
        if normalized != binding.platform {
            return Err(format!(
                "E_USAGE: session `{}` is bound to {}; close or reopen it instead of changing --platform",
                binding.session, binding.platform
            ));
        }
    }
    if let Some(device) = flag(args, "--device") {
        if binding
            .device
            .as_deref()
            .is_some_and(|bound| bound != device)
        {
            return Err(format!(
                "E_USAGE: session `{}` is bound to a different device; close or reopen it",
                binding.session
            ));
        }
    }
    binding.lease.touch(session_ttl());
    save_binding(args, &binding)?;
    Ok(binding)
}

fn document_identity(platform: &str, device: Option<&str>, session: &str) -> DocumentIdentity {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    DocumentIdentity {
        document: format!(
            "{platform}:{}:{session}:{nonce}",
            device.unwrap_or("default")
        ),
        frame: None,
    }
}

fn invalidate_snapshot(binding: &mut MobileBinding) {
    binding.generation = binding.generation.saturating_add(1);
    binding.snapshot = None;
}

fn assign_fresh_references(snapshot: &mut skeptic_mobile::MobileSnapshot, next_ref_id: &mut u64) {
    for node in &mut snapshot.nodes {
        node.reference = format!("e{}", *next_ref_id);
        *next_ref_id = next_ref_id.saturating_add(1);
    }
    snapshot.compact = snapshot
        .nodes
        .iter()
        .map(|node| {
            let label = if !node.text.is_empty() {
                &node.text
            } else if !node.content_description.is_empty() {
                &node.content_description
            } else {
                &node.resource_id
            };
            format!(
                "- [{}] {} \"{}\" {:?}",
                node.reference,
                node.class.rsplit('.').next().unwrap_or(&node.class),
                label,
                node.bounds
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
}

fn snapshot_reference(binding: &MobileBinding, reference: &str) -> Result<(i32, i32), String> {
    let snapshot = binding.snapshot.as_ref().ok_or_else(|| {
        format!("E_STALE_REF: {reference} has no active snapshot; take a fresh snapshot")
    })?;
    if snapshot.document != binding.identity.document || snapshot.generation != binding.generation {
        return Err(format!(
            "E_STALE_REF: {reference} belongs to an invalidated mobile document"
        ));
    }
    resolve_reference(snapshot, reference)
}

fn parse(values: &[String]) -> Result<Options, String> {
    let mut format = Format::Human;
    let mut output = None;
    let mut args = Vec::new();
    let mut index = 0;
    while index < values.len() {
        match values[index].as_str() {
            "--json" => format = Format::Json,
            "--format" => {
                format = match values.get(index + 1).map(String::as_str) {
                    Some("human") => Format::Human,
                    Some("json") => Format::Json,
                    Some(value) => return Err(format!("mobile does not support format `{value}`")),
                    None => return Err("--format requires a value".into()),
                };
                index += 1;
            }
            "--output" => {
                output = Some(PathBuf::from(
                    values.get(index + 1).ok_or("--output requires a path")?,
                ));
                index += 1;
            }
            value => args.push(value.to_string()),
        }
        index += 1;
    }
    Ok(Options {
        format,
        output,
        args,
    })
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn command(options: &Options) -> Result<(Value, SideEffects), String> {
    let args = &options.args;
    validate_session_name(args)?;
    match args.first().map(String::as_str) {
        Some("--help" | "-h" | "help") => Ok((
            serde_json::json!({
                "usage":"skeptic mobile <setup|open|snapshot|click|tap|fill|swipe|scroll|type|press|screenshot|screenrecord|close|logcat|gfxinfo|xctrace|audit> ...",
                "platforms":["android","ios-sim"],
                "sessionHotLoop":["open","snapshot","click","fill","swipe","scroll","type","press","screenshot","screenrecord","close"]
            }),
            SideEffects::None,
        )),
        Some("devices") => Ok((devices(), SideEffects::None)),
        Some("setup") => Ok((
            setup(
                args.get(1).map(String::as_str).unwrap_or(""),
                args.iter().any(|value| value == "--install"),
            )?,
            SideEffects::Possible,
        )),
        Some("open") => {
            let mut platform = flag(args, "--platform").unwrap_or_else(|| "android".into());
            if !matches!(platform.as_str(), "android" | "ios" | "ios-sim") {
                return Err("E_USAGE: --platform must be android, ios, or ios-sim".into());
            }
            if platform == "ios" {
                platform = "ios-sim".into();
            }
            let path = binding_path(args);
            if !path.is_file() {
                enforce_session_capacity(prune_expired_bindings()?, max_sessions())
                    .map_err(|error| format!("E_POLICY_BLOCKED: {error}"))?;
            }
            let device = flag(args, "--device");
            let target = args.get(1).filter(|value| !value.starts_with('-')).cloned();
            let value = if platform == "ios-sim" {
                ios_open(device.as_deref().unwrap_or("booted"), target.as_deref())?
            } else {
                android_open(device.as_deref(), target.as_deref())?
            };
            let session = session_name(args);
            save_binding(
                args,
                &MobileBinding {
                    schema: "skeptic.mobile-session/1".into(),
                    namespace: namespace(),
                    session: session.clone(),
                    platform: platform.clone(),
                    device: device.clone(),
                    target,
                    identity: document_identity(&platform, device.as_deref(), &session),
                    generation: 0,
                    next_ref_id: 1,
                    snapshot: None,
                    lease: DurableLease::new(LeaseClass::Interactive, session_ttl()),
                },
            )?;
            Ok((value, SideEffects::Committed))
        }
        Some("snapshot") => {
            let mut binding = load_binding(args)?;
            let mut snapshot = if binding.platform == "ios-sim" {
                ios_snapshot(binding.device.as_deref().unwrap_or("booted"))?
            } else {
                android_snapshot(binding.device.as_deref())?
            };
            binding.generation = binding.generation.saturating_add(1);
            assign_fresh_references(&mut snapshot, &mut binding.next_ref_id);
            snapshot.document = binding.identity.document.clone();
            snapshot.generation = binding.generation;
            binding.snapshot = Some(snapshot.clone());
            save_binding(args, &binding)?;
            Ok((
                serde_json::to_value(snapshot).map_err(|error| error.to_string())?,
                SideEffects::None,
            ))
        }
        Some("tap") | Some("click") => {
            let mut binding = load_binding(args)?;
            let target = args.get(1).ok_or("tap requires @ref or x y")?;
            let (x, y) = if target.starts_with('@') {
                snapshot_reference(&binding, target)?
            } else {
                let x = target.parse().map_err(|_| "tap x must be an integer")?;
                let y = args
                    .get(2)
                    .ok_or("tap requires x y")?
                    .parse()
                    .map_err(|_| "tap y must be an integer")?;
                (x, y)
            };
            let value = if binding.platform == "ios-sim" {
                ios_tap(binding.device.as_deref().unwrap_or("booted"), x, y)?
            } else {
                android_tap(binding.device.as_deref(), x, y)?
            };
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((value, SideEffects::Committed))
        }
        Some("fill") => {
            let reference = args.get(1).ok_or("fill requires @ref and text")?;
            let text = args.get(2).ok_or("fill requires @ref and text")?;
            let mut binding = load_binding(args)?;
            let (x, y) = snapshot_reference(&binding, reference)?;
            if binding.platform == "ios-sim" {
                ios_tap(binding.device.as_deref().unwrap_or("booted"), x, y)?;
                ios_type(binding.device.as_deref().unwrap_or("booted"), text)?;
            } else {
                android_tap(binding.device.as_deref(), x, y)?;
                android_type(binding.device.as_deref(), text)?;
            }
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((serde_json::json!({"changed":true,"reference":reference}), SideEffects::Committed))
        }
        Some("swipe") => {
            let mut values = [0i32; 4];
            for (index, target) in values.iter_mut().enumerate() {
                *target = args
                    .get(index + 1)
                    .ok_or("swipe requires x1 y1 x2 y2")?
                    .parse()
                    .map_err(|_| "swipe coordinates must be integers")?;
            }
            let duration = flag(args, "--duration")
                .and_then(|value| value.parse().ok())
                .unwrap_or(300);
            let mut binding = load_binding(args)?;
            let value = if binding.platform == "ios-sim" {
                ios_swipe(
                    binding.device.as_deref().unwrap_or("booted"),
                    values,
                    duration,
                )?
            } else {
                android_swipe(binding.device.as_deref(), values, duration)?
            };
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((value, SideEffects::Committed))
        }
        Some("scroll") => {
            let direction = args.get(1).map(String::as_str).unwrap_or("down");
            let points = match direction {
                "down" => [500, 1500, 500, 500],
                "up" => [500, 500, 500, 1500],
                "right" => [900, 900, 200, 900],
                "left" => [200, 900, 900, 900],
                _ => return Err("E_USAGE: scroll direction must be up, down, left, or right".into()),
            };
            let mut binding = load_binding(args)?;
            let value = if binding.platform == "ios-sim" {
                ios_swipe(
                    binding.device.as_deref().unwrap_or("booted"),
                    points,
                    300,
                )?
            } else {
                android_swipe(binding.device.as_deref(), points, 300)?
            };
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((value, SideEffects::Committed))
        }
        Some("type") => {
            let mut binding = load_binding(args)?;
            let text = args.get(1).ok_or("type requires text")?;
            let value = if binding.platform == "ios-sim" {
                ios_type(binding.device.as_deref().unwrap_or("booted"), text)?
            } else {
                android_type(binding.device.as_deref(), text)?
            };
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((value, SideEffects::Committed))
        }
        Some("press") => {
            let key = args.get(1).ok_or("press requires a key")?;
            let mut binding = load_binding(args)?;
            if binding.platform == "ios-sim" {
                return Err("E_UNSUPPORTED_ON_PLATFORM: iOS Simulator key presses are not exposed by AXe".into());
            }
            let value = android_press(binding.device.as_deref(), key)?;
            invalidate_snapshot(&mut binding);
            save_binding(args, &binding)?;
            Ok((value, SideEffects::Committed))
        }
        Some("screenshot") => {
            let path = PathBuf::from(args.get(1).ok_or("screenshot requires a path")?);
            let binding = load_binding(args)?;
            let value = if binding.platform == "ios-sim" {
                ios_screenshot(binding.device.as_deref().unwrap_or("booted"), &path)?
            } else {
                android_screenshot(binding.device.as_deref(), &path)?
            };
            Ok((value, SideEffects::Committed))
        }
        Some("screenrecord") | Some("recordVideo") => {
            let path = PathBuf::from(args.get(1).ok_or("screenrecord requires a path")?);
            let duration = flag(args, "--duration")
                .and_then(|value| value.parse().ok())
                .unwrap_or(10);
            let binding = load_binding(args)?;
            let value = if binding.platform == "ios-sim" {
                ios_screenrecord(
                    binding.device.as_deref().unwrap_or("booted"),
                    &path,
                    duration,
                )?
            } else {
                android_screenrecord(binding.device.as_deref(), &path, duration)?
            };
            Ok((value, SideEffects::Committed))
        }
        Some("close") => {
            let binding = load_binding(args)?;
            let value = if binding.platform == "ios-sim" {
                ios_close(
                    binding.device.as_deref().unwrap_or("booted"),
                    binding.target.as_deref(),
                )?
            } else {
                android_close(binding.device.as_deref(), binding.target.as_deref())?
            };
            let _ = fs::remove_file(binding_path(args));
            Ok((value, SideEffects::Committed))
        }
        Some("logcat") => Ok((
            android_logcat(
                flag(args, "--device").as_deref(),
                Path::new(args.get(1).ok_or("logcat requires a path")?),
            )?,
            SideEffects::Committed,
        )),
        Some("gfxinfo") => Ok((
            android_gfxinfo(
                flag(args, "--device").as_deref(),
                args.get(1).ok_or("gfxinfo requires an app package")?,
            )?,
            SideEffects::None,
        )),
        Some("xctrace") => Ok((
            ios_xctrace(
                flag(args, "--device").as_deref().unwrap_or("booted"),
                Path::new(args.get(1).ok_or("xctrace requires an output path")?),
                flag(args, "--duration")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(10),
                flag(args, "--app").as_deref(),
            )?,
            SideEffects::Committed,
        )),
        Some("audit") => {
            let platform = flag(args, "--platform").unwrap_or_else(|| "android".into());
            let value = if platform == "ios" || platform == "ios-sim" {
                ios_accessibility_audit(
                    Path::new(&flag(args, "--project").ok_or("iOS audit requires --project")?),
                    &flag(args, "--scheme").ok_or("iOS audit requires --scheme")?,
                    flag(args, "--device").as_deref().unwrap_or("booted"),
                    flag(args, "--test-target").as_deref(),
                    Path::new(
                        &flag(args, "--result-bundle")
                            .unwrap_or_else(|| ".skeptic/mobile/a11y.xcresult".into()),
                    ),
                )?
            } else {
                android_a11y_probe(
                    flag(args, "--device").as_deref(),
                    Path::new(&flag(args, "--apk").ok_or("Android audit requires --apk")?),
                    &flag(args, "--runner").ok_or("Android audit requires --runner")?,
                    args.iter().any(|value| value == "--allow-install"),
                )?
            };
            Ok((value, SideEffects::Committed))
        }
        _ => Err(
            "usage: skeptic mobile <setup|open|snapshot|click|tap|fill|swipe|scroll|type|press|screenshot|screenrecord|close|logcat|gfxinfo|xctrace|audit> ..."
                .into(),
        ),
    }
}

fn write(path: Option<&Path>, bytes: &[u8]) -> Result<(), String> {
    if let Some(path) = path {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
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

fn command_journal(args: &[String]) -> Option<Journal> {
    let action = args.first()?.as_str();
    if matches!(action, "help" | "--help" | "-h" | "devices" | "setup") {
        return None;
    }
    Some(Journal::for_session(
        session_journal_path(&workspace_root(), &namespace(), &session_name(args)),
        session_name(args),
    ))
}

fn journal_target(args: &[String]) -> Option<String> {
    match args.first().map(String::as_str) {
        Some("type") => Some("[REDACTED]".into()),
        Some("fill") => args.get(1).cloned(),
        Some("open" | "click" | "tap" | "scroll" | "screenshot" | "screenrecord") => {
            args.get(1).cloned()
        }
        _ => None,
    }
}

fn invalidates_mobile_refs(action: &str) -> bool {
    matches!(
        action,
        "open"
            | "snapshot"
            | "click"
            | "tap"
            | "fill"
            | "swipe"
            | "scroll"
            | "type"
            | "press"
            | "close"
    )
}

fn main() {
    let values = env::args().skip(1).collect::<Vec<_>>();
    let options = match parse(&values) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let action = options.args.first().cloned().unwrap_or_default();
    let target = journal_target(&options.args);
    let journal = command_journal(&options.args);
    if let Some(journal) = journal.as_ref() {
        let _ = journal.append(
            "action-start",
            action_payload(&action, target.as_deref(), "started"),
            None,
        );
    }
    match command(&options) {
        Ok((value, effects)) => {
            if let Some(journal) = journal.as_ref() {
                let _ = journal.append(
                    "action",
                    action_payload(&action, target.as_deref(), "success"),
                    None,
                );
                if invalidates_mobile_refs(&action) {
                    let _ = journal.append(
                        "ref-invalidation",
                        serde_json::json!({"reason":action,"scope":"session"}),
                        None,
                    );
                }
            }
            let mut bytes = if options.format == Format::Json {
                let mut envelope = ResponseEnvelope::success(value, "skeptic.mobile/1", 0);
                envelope.meta.side_effects = effects;
                serde_json::to_vec(&envelope).unwrap_or_default()
            } else {
                serde_json::to_vec_pretty(&value).unwrap_or_default()
            };
            bytes.push(b'\n');
            if let Err(error) = write(options.output.as_deref(), &bytes) {
                eprintln!("{error}");
                std::process::exit(10);
            }
        }
        Err(error) => {
            if let Some(journal) = journal.as_ref() {
                let _ = journal.append(
                    "action",
                    action_payload(&action, target.as_deref(), "error"),
                    None,
                );
            }
            let (code, exit, retryable, hint) = if error.starts_with("E_ENV_MISSING") {
                ("E_ENV_MISSING", 6, false, None)
            } else if error.starts_with("E_STALE_REF") {
                (
                    "E_STALE_REF",
                    4,
                    true,
                    Some("take a fresh mobile snapshot and retry with its ref".into()),
                )
            } else if error.starts_with("E_POLICY_BLOCKED") {
                ("E_POLICY_BLOCKED", 7, false, None)
            } else if error.starts_with("E_TIMEOUT") {
                ("E_TIMEOUT", 5, true, None)
            } else if error.starts_with("E_USAGE")
                || error.starts_with("usage:")
                || error.contains(" requires ")
                || error.contains(" must be ")
            {
                ("E_USAGE", 2, false, None)
            } else if error.starts_with("E_UNSUPPORTED") {
                ("E_UNSUPPORTED_ON_PLATFORM", 2, false, None)
            } else {
                ("E_TARGET_UNREACHABLE", 3, true, None)
            };
            if options.format == Format::Json {
                let envelope = ResponseEnvelope::<Value>::failure(
                    ApiError {
                        code: code.into(),
                        message: error,
                        retryable,
                        hint,
                    },
                    0,
                    SideEffects::None,
                );
                let mut bytes = serde_json::to_vec(&envelope).unwrap_or_default();
                bytes.push(b'\n');
                let _ = write(options.output.as_deref(), &bytes);
            } else {
                eprintln!("{error}");
            }
            std::process::exit(exit);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_session_paths() {
        assert!(validate_session_name(&[
            "snapshot".into(),
            "--session".into(),
            "../escape".into()
        ])
        .is_err());
        assert!(
            validate_session_name(&["snapshot".into(), "--session".into(), "qa-1.web".into()])
                .is_ok()
        );
    }

    #[test]
    fn refs_resolve_only_against_the_frozen_session_snapshot() {
        let mut snapshot = skeptic_mobile::parse_android_xml(
            r#"<hierarchy><node class="Button" text="Save" bounds="[10,20][110,80]" /></hierarchy>"#,
            "device",
        )
        .unwrap();
        snapshot.document = "document-1".into();
        snapshot.generation = 4;
        let mut binding = MobileBinding {
            schema: "skeptic.mobile-session/1".into(),
            namespace: "test".into(),
            session: "session".into(),
            platform: "android".into(),
            device: Some("device".into()),
            target: Some("dev.skeptic.fixture".into()),
            identity: DocumentIdentity {
                document: "document-1".into(),
                frame: None,
            },
            generation: 4,
            next_ref_id: 2,
            snapshot: Some(snapshot),
            lease: DurableLease::new(LeaseClass::Interactive, Duration::from_secs(60)),
        };

        assert_eq!(snapshot_reference(&binding, "@e1").unwrap(), (60, 50));
        invalidate_snapshot(&mut binding);
        assert!(snapshot_reference(&binding, "@e1")
            .unwrap_err()
            .starts_with("E_STALE_REF"));
    }

    #[test]
    fn consecutive_snapshots_never_reuse_ref_ids() {
        let xml = r#"<hierarchy><node class="Button" text="Save" bounds="[10,20][110,80]" /></hierarchy>"#;
        let mut first = skeptic_mobile::parse_android_xml(xml, "device").unwrap();
        let mut second = skeptic_mobile::parse_android_xml(xml, "device").unwrap();
        let mut next_ref_id = 1;
        assign_fresh_references(&mut first, &mut next_ref_id);
        assign_fresh_references(&mut second, &mut next_ref_id);
        assert_eq!(first.nodes[0].reference, "e1");
        assert_eq!(second.nodes[0].reference, "e2");
        assert!(second.compact.contains("[e2]"));
    }
}
