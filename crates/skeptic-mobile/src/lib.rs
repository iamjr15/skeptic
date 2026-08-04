#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use skeptic_contract::Platform;
use skeptic_daemon::{
    ActionResult, CapabilitySet, DocumentIdentity, Driver, DriverCapability, DriverError,
    DriverErrorCode, Element, ElementRef, Session, SettleState, Snapshot, SnapshotNode, TargetSpec,
};

pub const AXE_VERSION: &str = "1.7.1";
pub const AXE_ARCHIVE_SHA256: &str =
    "26a64009c09a3ae980b1f1b4b377bd2a2dd96cbbde24821935e47352cb71cc69";
pub const AXE_ARCHIVE_URL: &str = "https://github.com/cameroncooke/AXe/releases/download/v1.7.1/AXe-macOS-v1.7.1-universal.tar.gz";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevice {
    pub platform: String,
    pub id: String,
    pub name: String,
    pub state: String,
    pub model: Option<String>,
    pub os_version: Option<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileNode {
    pub reference: String,
    pub class: String,
    pub text: String,
    pub content_description: String,
    pub resource_id: String,
    pub bounds: [i32; 4],
    pub clickable: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSnapshot {
    pub schema: String,
    pub platform: String,
    pub device_id: String,
    pub document: String,
    pub generation: u64,
    pub source: String,
    pub nodes: Vec<MobileNode>,
    pub compact: String,
}

pub fn executable(name: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(name);
    if candidate.components().count() > 1 && candidate.is_file() {
        return Some(candidate);
    }
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| {
                directory.join(if cfg!(windows) && !name.ends_with(".exe") {
                    format!("{name}.exe")
                } else {
                    name.to_string()
                })
            })
            .find(|path| path.is_file())
    })
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

pub fn axe_executable() -> Option<PathBuf> {
    executable("axe").or_else(|| {
        dirs::data_local_dir()
            .map(|root| root.join("skeptic/tools/axe").join(AXE_VERSION))
            .and_then(|root| find_file(&root, "axe"))
    })
}

pub fn install_axe() -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") {
        return Err("E_UNSUPPORTED_ON_PLATFORM: AXe only supports macOS with iOS Simulator".into());
    }
    let root = dirs::data_local_dir()
        .ok_or("cannot resolve the platform data directory")?
        .join("skeptic/tools/axe")
        .join(AXE_VERSION);
    if let Some(existing) = find_file(&root, "axe") {
        return Ok(existing);
    }
    let response = reqwest::blocking::get(AXE_ARCHIVE_URL)
        .map_err(|error| format!("cannot download AXe: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("AXe download returned HTTP {}", response.status()));
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != AXE_ARCHIVE_SHA256 {
        return Err(format!(
            "AXe archive checksum mismatch: expected {AXE_ARCHIVE_SHA256}, got {actual}"
        ));
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let decoder = flate2::read::GzDecoder::new(bytes.as_ref());
    tar::Archive::new(decoder)
        .unpack(&root)
        .map_err(|error| format!("cannot extract AXe: {error}"))?;
    let binary = find_file(&root, "axe").ok_or("AXe archive did not contain axe")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&binary)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).map_err(|error| error.to_string())?;
    }
    Ok(binary)
}

fn run(program: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new(program)
        .args(arguments)
        .output()
        .map_err(|error| format!("cannot run {}: {error}", program.display()))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn adb_args<'a>(device: Option<&'a str>, rest: &'a [&'a str]) -> Vec<&'a str> {
    let mut arguments = Vec::new();
    if let Some(device) = device {
        arguments.extend(["-s", device]);
    }
    arguments.extend_from_slice(rest);
    arguments
}

pub fn parse_adb_devices(value: &str) -> Vec<MobileDevice> {
    value
        .lines()
        .skip_while(|line| !line.starts_with("List of devices"))
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let id = fields.next()?.to_string();
            let state = fields.next()?.to_string();
            let metadata = fields
                .filter_map(|field| field.split_once(':'))
                .collect::<BTreeMap<_, _>>();
            let model = metadata.get("model").map(|value| value.replace('_', " "));
            Some(MobileDevice {
                platform: "android".into(),
                name: model.clone().unwrap_or_else(|| id.clone()),
                id,
                state: state.clone(),
                model,
                os_version: None,
                capabilities: if state == "device" {
                    vec![
                        "snapshot",
                        "tap",
                        "swipe",
                        "type",
                        "screenshot",
                        "screenrecord",
                        "logcat",
                        "gfxinfo",
                    ]
                    .into_iter()
                    .map(str::to_string)
                    .collect()
                } else {
                    Vec::new()
                },
            })
        })
        .collect()
}

pub fn android_devices() -> Result<Vec<MobileDevice>, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed or not on PATH")?;
    let output = run(&adb, &["devices", "-l"])?;
    Ok(parse_adb_devices(&String::from_utf8_lossy(&output)))
}

pub fn ios_devices() -> Result<Vec<MobileDevice>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(Vec::new());
    }
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode on macOS")?;
    let output = run(&xcrun, &["simctl", "list", "devices", "--json"])?;
    let value: Value = serde_json::from_slice(&output).map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    for (runtime, entries) in value
        .get("devices")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
    {
        for item in entries.as_array().into_iter().flatten() {
            if item.get("isAvailable").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let id = item.get("udid").and_then(Value::as_str).unwrap_or_default();
            let name = item.get("name").and_then(Value::as_str).unwrap_or(id);
            let state = item
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            devices.push(MobileDevice {
                platform: "ios-sim".into(),
                id: id.into(),
                name: name.into(),
                state: state.into(),
                model: None,
                os_version: runtime
                    .rsplit('.')
                    .next()
                    .map(|value| value.replace('-', ".")),
                capabilities: vec!["screenshot", "recordVideo", "openurl"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            });
        }
    }
    Ok(devices)
}

pub fn devices() -> Value {
    let android = android_devices();
    let ios = ios_devices();
    let mut all = Vec::new();
    if let Ok(found) = &android {
        all.extend(found.clone());
    }
    if let Ok(found) = &ios {
        all.extend(found.clone());
    }
    json!({
        "schema": "skeptic.mobile-devices/1", "devices": all,
        "backends": {
            "android": {"available": android.is_ok(), "error": android.err()},
            "ios-sim": {"available": ios.is_ok(), "error": ios.err()}
        }
    })
}

pub fn setup(platform: &str, install: bool) -> Result<Value, String> {
    match platform {
        "android" => Ok(json!({
            "schema": "skeptic.mobile-setup/1", "platform": "android",
            "ready": executable("adb").is_some(),
            "tools": {"adb": executable("adb"), "java": executable("java")},
            "driver": {"primary": "adb-shell", "snapshot": "uiautomator-dump", "zeroInstall": true},
            "capabilities": ["tap", "swipe", "keyevent", "unicode-via-adbkeyboard", "screenshot", "screenrecord", "gfxinfo", "logcat"],
            "installRequested": install,
            "notes": ["No device package is installed. Android snapshots use the platform uiautomator command and direct ADB input remains the permanent fallback."]
        })),
        "ios" | "ios-sim" => {
            let axe = if install {
                Some(install_axe()?)
            } else {
                axe_executable()
            };
            Ok(json!({
                "schema": "skeptic.mobile-setup/1", "platform": "ios-sim",
                "ready": cfg!(target_os = "macos") && executable("xcrun").is_some() && axe.is_some(),
                "tools": {"xcrun": executable("xcrun"), "axe": axe, "xctrace": executable("xctrace")},
                "driver": {"inputAndA11y": "AXe", "media": "simctl-io"},
                "asset": {"version": AXE_VERSION, "sha256": AXE_ARCHIVE_SHA256, "source": AXE_ARCHIVE_URL},
                "limitations": ["iOS real devices are outside Skeptic 2.0; simulator input depends on AXe private CoreSimulator APIs."]
            }))
        }
        _ => Ok(
            json!({"schema":"skeptic.mobile-setup/1", "ready":false, "error":"platform must be android or ios"}),
        ),
    }
}

fn scalar_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn collect_ios_nodes(value: &Value, nodes: &mut Vec<MobileNode>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_ios_nodes(value, nodes);
            }
        }
        Value::Object(object) => {
            let frame = object.get("frame").and_then(Value::as_object);
            let x = frame
                .and_then(|value| value.get("x"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as i32;
            let y = frame
                .and_then(|value| value.get("y"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as i32;
            let width = frame
                .and_then(|value| value.get("width"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as i32;
            let height = frame
                .and_then(|value| value.get("height"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as i32;
            if width > 0 && height > 0 {
                nodes.push(MobileNode {
                    reference: format!("e{}", nodes.len() + 1),
                    class: scalar_string(object.get("type").or_else(|| object.get("role"))),
                    text: scalar_string(object.get("AXLabel").or_else(|| object.get("title"))),
                    content_description: scalar_string(object.get("AXValue")),
                    resource_id: scalar_string(
                        object
                            .get("AXUniqueId")
                            .or_else(|| object.get("AXIdentifier")),
                    ),
                    bounds: [x, y, x + width, y + height],
                    clickable: true,
                    enabled: object
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                });
            }
            if let Some(children) = object.get("children") {
                collect_ios_nodes(children, nodes);
            }
        }
        _ => {}
    }
}

pub fn ios_snapshot(device: &str) -> Result<MobileSnapshot, String> {
    let axe = axe_executable()
        .ok_or("E_ENV_MISSING: AXe is unavailable; run `skeptic mobile setup ios --install`")?;
    let output = run(&axe, &["describe-ui", "--udid", device])?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("invalid AXe describe-ui JSON: {error}"))?;
    let mut nodes = Vec::new();
    collect_ios_nodes(&value, &mut nodes);
    let compact = nodes
        .iter()
        .map(|node| {
            let label = if !node.text.is_empty() {
                &node.text
            } else {
                &node.resource_id
            };
            format!(
                "- [{}] {} \"{}\" {:?}",
                node.reference, node.class, label, node.bounds
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(MobileSnapshot {
        schema: "skeptic.mobile-snapshot/1".into(),
        platform: "ios-sim".into(),
        device_id: device.into(),
        document: String::new(),
        generation: 0,
        source: format!("AXe {AXE_VERSION}"),
        nodes,
        compact,
    })
}

pub fn ios_tap(device: &str, x: i32, y: i32) -> Result<Value, String> {
    let axe = axe_executable()
        .ok_or("E_ENV_MISSING: AXe is unavailable; run `skeptic mobile setup ios --install`")?;
    run(
        &axe,
        &[
            "touch",
            "-x",
            &x.to_string(),
            "-y",
            &y.to_string(),
            "--down",
            "--up",
            "--delay",
            "0.17",
            "--udid",
            device,
        ],
    )?;
    Ok(json!({"changed":true,"x":x,"y":y,"holdMs":170,"backend":"AXe"}))
}

pub fn ios_swipe(device: &str, points: [i32; 4], duration_ms: u64) -> Result<Value, String> {
    let axe = axe_executable()
        .ok_or("E_ENV_MISSING: AXe is unavailable; run `skeptic mobile setup ios --install`")?;
    let values = points.map(|value| value.to_string());
    let duration = format!("{:.3}", duration_ms as f64 / 1000.0);
    run(
        &axe,
        &[
            "swipe",
            "--start-x",
            &values[0],
            "--start-y",
            &values[1],
            "--end-x",
            &values[2],
            "--end-y",
            &values[3],
            "--duration",
            &duration,
            "--delta",
            "50",
            "--udid",
            device,
        ],
    )?;
    Ok(
        json!({"changed":true,"from":[points[0],points[1]],"to":[points[2],points[3]],"durationMs":duration_ms,"backend":"AXe"}),
    )
}

pub fn ios_type(device: &str, text: &str) -> Result<Value, String> {
    if !text.is_ascii() {
        return Err(
            "E_UNSUPPORTED_ON_PLATFORM: AXe 1.7.1 text input supports US-keyboard ASCII only"
                .into(),
        );
    }
    let axe = axe_executable()
        .ok_or("E_ENV_MISSING: AXe is unavailable; run `skeptic mobile setup ios --install`")?;
    run(&axe, &["type", text, "--udid", device])?;
    Ok(json!({"changed":true,"backend":"AXe","encoding":"us-ascii"}))
}

fn parse_bounds(value: &str) -> Option<[i32; 4]> {
    let values = value
        .split(|character: char| !character.is_ascii_digit() && character != '-')
        .filter(|part| !part.is_empty())
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (values.len() == 4).then(|| [values[0], values[1], values[2], values[3]])
}

pub fn parse_android_xml(xml: &str, device: &str) -> Result<MobileSnapshot, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut nodes = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Empty(element)) | Ok(Event::Start(element))
                if element.name().as_ref() == b"node" =>
            {
                let mut attributes = BTreeMap::new();
                for attribute in element.attributes().flatten() {
                    let key = String::from_utf8_lossy(attribute.key.as_ref()).to_string();
                    let value = attribute
                        .unescape_value()
                        .map_err(|error| error.to_string())?
                        .into_owned();
                    attributes.insert(key, value);
                }
                let bounds = attributes
                    .get("bounds")
                    .and_then(|value| parse_bounds(value))
                    .unwrap_or([0, 0, 0, 0]);
                if bounds[2] > bounds[0] && bounds[3] > bounds[1] {
                    nodes.push(MobileNode {
                        reference: format!("e{}", nodes.len() + 1),
                        class: attributes.remove("class").unwrap_or_default(),
                        text: attributes.remove("text").unwrap_or_default(),
                        content_description: attributes.remove("content-desc").unwrap_or_default(),
                        resource_id: attributes.remove("resource-id").unwrap_or_default(),
                        bounds,
                        clickable: attributes
                            .get("clickable")
                            .is_some_and(|value| value == "true"),
                        enabled: attributes
                            .get("enabled")
                            .is_none_or(|value| value == "true"),
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("invalid uiautomator XML: {error}")),
            _ => {}
        }
    }
    let compact = nodes
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
    Ok(MobileSnapshot {
        schema: "skeptic.mobile-snapshot/1".into(),
        platform: "android".into(),
        device_id: device.into(),
        document: String::new(),
        generation: 0,
        source: "uiautomator-dump".into(),
        nodes,
        compact,
    })
}

pub fn android_snapshot(device: Option<&str>) -> Result<MobileSnapshot, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    run(
        &adb,
        &adb_args(
            device,
            &["shell", "uiautomator", "dump", "/sdcard/skeptic-window.xml"],
        ),
    )?;
    let xml = run(
        &adb,
        &adb_args(device, &["exec-out", "cat", "/sdcard/skeptic-window.xml"]),
    )?;
    parse_android_xml(&String::from_utf8_lossy(&xml), device.unwrap_or("default"))
}

pub fn android_open(device: Option<&str>, target: Option<&str>) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let Some(target) = target.filter(|value| !value.is_empty()) else {
        return Ok(json!({"changed":false,"bound":true,"backend":"adb-shell"}));
    };
    let arguments = if target.starts_with("http://") || target.starts_with("https://") {
        vec![
            "shell",
            "am",
            "start",
            "-W",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            target,
        ]
    } else if target.contains('/') {
        vec!["shell", "am", "start", "-W", "-n", target]
    } else {
        vec![
            "shell",
            "monkey",
            "-p",
            target,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ]
    };
    run(&adb, &adb_args(device, &arguments))?;
    Ok(json!({"changed":true,"target":target,"backend":"adb-shell"}))
}

pub fn android_press(device: Option<&str>, key: &str) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let normalized = match key.to_ascii_lowercase().as_str() {
        "enter" => "KEYCODE_ENTER",
        "back" => "KEYCODE_BACK",
        "home" => "KEYCODE_HOME",
        "tab" => "KEYCODE_TAB",
        "escape" | "esc" => "KEYCODE_ESCAPE",
        "delete" | "backspace" => "KEYCODE_DEL",
        "menu" => "KEYCODE_MENU",
        _ if key.starts_with("KEYCODE_") => key,
        _ => return Err(format!("E_USAGE: unsupported Android key `{key}`")),
    };
    run(
        &adb,
        &adb_args(device, &["shell", "input", "keyevent", normalized]),
    )?;
    Ok(json!({"changed":true,"key":normalized,"backend":"adb-shell"}))
}

pub fn android_close(device: Option<&str>, target: Option<&str>) -> Result<Value, String> {
    let Some(package) = target
        .filter(|value| !value.starts_with("http://") && !value.starts_with("https://"))
        .and_then(|value| value.split('/').next())
        .filter(|value| !value.is_empty())
    else {
        return Ok(json!({"changed":false,"backend":"adb-shell"}));
    };
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    run(
        &adb,
        &adb_args(device, &["shell", "am", "force-stop", package]),
    )?;
    Ok(json!({"changed":true,"target":package,"backend":"adb-shell"}))
}

pub fn android_tap(device: Option<&str>, x: i32, y: i32) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    run(
        &adb,
        &adb_args(
            device,
            &["shell", "input", "tap", &x.to_string(), &y.to_string()],
        ),
    )?;
    Ok(json!({"changed": true, "x": x, "y": y}))
}

pub fn android_swipe(
    device: Option<&str>,
    points: [i32; 4],
    duration_ms: u64,
) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let values = points.map(|value| value.to_string());
    let duration = duration_ms.to_string();
    run(
        &adb,
        &adb_args(
            device,
            &[
                "shell", "input", "swipe", &values[0], &values[1], &values[2], &values[3],
                &duration,
            ],
        ),
    )?;
    Ok(
        json!({"changed": true, "from": [points[0],points[1]], "to": [points[2],points[3]], "durationMs": duration_ms}),
    )
}

pub fn android_type(device: Option<&str>, text: &str) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    if text.is_ascii() {
        let encoded = text.replace(' ', "%s");
        run(
            &adb,
            &adb_args(device, &["shell", "input", "text", &encoded]),
        )?;
        return Ok(json!({"changed": true, "method": "adb-input-text"}));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    run(&adb, &adb_args(device, &["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", &encoded]))
        .map_err(|_| "E_UNSUPPORTED_ON_PLATFORM: Unicode input requires ADBKeyboard; install it, enable its IME, then retry".to_string())?;
    Ok(json!({"changed": true, "method": "adbkeyboard-base64"}))
}

pub fn ios_open(device: &str, target: Option<&str>) -> Result<Value, String> {
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode")?;
    let Some(target) = target.filter(|value| !value.is_empty()) else {
        return Ok(json!({"changed":false,"bound":true,"backend":"simctl"}));
    };
    if target.starts_with("http://") || target.starts_with("https://") {
        run(&xcrun, &["simctl", "openurl", device, target])?;
    } else {
        run(&xcrun, &["simctl", "launch", device, target])?;
    }
    Ok(json!({"changed":true,"target":target,"backend":"simctl"}))
}

pub fn ios_close(device: &str, target: Option<&str>) -> Result<Value, String> {
    let Some(bundle) = target
        .filter(|value| !value.starts_with("http://") && !value.starts_with("https://"))
        .filter(|value| !value.is_empty())
    else {
        return Ok(json!({"changed":false,"backend":"simctl"}));
    };
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode")?;
    run(&xcrun, &["simctl", "terminate", device, bundle])?;
    Ok(json!({"changed":true,"target":bundle,"backend":"simctl"}))
}

pub fn android_screenshot(device: Option<&str>, path: &Path) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let bytes = run(&adb, &adb_args(device, &["exec-out", "screencap", "-p"]))?;
    if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, &bytes).map_err(|error| error.to_string())?;
    Ok(json!({"path": path, "bytes": bytes.len(), "mediaType": "image/png"}))
}

pub fn android_logcat(device: Option<&str>, path: &Path) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let bytes = run(
        &adb,
        &adb_args(device, &["logcat", "-d", "-v", "threadtime"]),
    )?;
    if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let redacted = redact_mobile_text(&String::from_utf8_lossy(&bytes));
    fs::write(path, redacted.as_bytes()).map_err(|error| error.to_string())?;
    Ok(json!({"path": path, "bytes": redacted.len(), "redaction": "redacted"}))
}

pub fn android_gfxinfo(device: Option<&str>, package: &str) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let bytes = run(
        &adb,
        &adb_args(
            device,
            &["shell", "dumpsys", "gfxinfo", package, "framestats"],
        ),
    )?;
    let text = redact_mobile_text(&String::from_utf8_lossy(&bytes));
    let frames = text
        .lines()
        .filter(|line| line.matches(',').count() >= 12)
        .count();
    Ok(
        json!({"schema":"skeptic.mobile-gfxinfo/1", "package": package, "frameRows": frames, "raw": text}),
    )
}

fn redact_mobile_text(input: &str) -> String {
    let bearer = Regex::new(r"(?i)bearer\s+[a-z0-9._~+/-]+=*").expect("valid regex");
    let query = Regex::new(
        r"(?i)([?&](?:token|access_token|refresh_token|api_key|apikey|password|secret)=)[^&#\s]+",
    )
    .expect("valid regex");
    let assignment = Regex::new(
        r"(?i)\b(authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+",
    )
    .expect("valid regex");
    let value = bearer.replace_all(input, "Bearer [REDACTED]");
    let value = query.replace_all(&value, "$1[REDACTED]");
    assignment.replace_all(&value, "$1=[REDACTED]").into_owned()
}

fn ensure_output_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn android_screenrecord(
    device: Option<&str>,
    path: &Path,
    duration_seconds: u64,
) -> Result<Value, String> {
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let duration = duration_seconds.clamp(1, 180).to_string();
    let remote = format!("/sdcard/skeptic-record-{}.mp4", std::process::id());
    run(
        &adb,
        &adb_args(
            device,
            &["shell", "screenrecord", "--time-limit", &duration, &remote],
        ),
    )?;
    let bytes = run(&adb, &adb_args(device, &["exec-out", "cat", &remote]))?;
    let _ = run(&adb, &adb_args(device, &["shell", "rm", "-f", &remote]));
    ensure_output_parent(path)?;
    fs::write(path, &bytes).map_err(|error| error.to_string())?;
    Ok(
        json!({"path":path,"bytes":bytes.len(),"durationSeconds":duration_seconds.clamp(1,180),"mediaType":"video/mp4","backend":"adb-screenrecord"}),
    )
}

pub fn ios_screenshot(device: &str, path: &Path) -> Result<Value, String> {
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode")?;
    let path_value = path.to_string_lossy().to_string();
    run(&xcrun, &["simctl", "io", device, "screenshot", &path_value])?;
    let bytes = fs::metadata(path).map_err(|error| error.to_string())?.len();
    Ok(json!({"path": path, "bytes": bytes, "mediaType": "image/png"}))
}

pub fn ios_screenrecord(device: &str, path: &Path, duration_seconds: u64) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("E_UNSUPPORTED_ON_PLATFORM: iOS Simulator recording requires macOS".into());
    }
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode")?;
    ensure_output_parent(path)?;
    let mut child = Command::new(&xcrun)
        .args(["simctl", "io", device, "recordVideo", "--codec", "h264"])
        .arg(path)
        .spawn()
        .map_err(|error| format!("cannot start Simulator recording: {error}"))?;
    std::thread::sleep(std::time::Duration::from_secs(
        duration_seconds.clamp(1, 180),
    ));
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status();
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() && !path.is_file() {
        return Err(format!("Simulator recording failed with {status}"));
    }
    let bytes = fs::metadata(path).map_err(|error| error.to_string())?.len();
    Ok(
        json!({"path":path,"bytes":bytes,"durationSeconds":duration_seconds.clamp(1,180),"mediaType":"video/mp4","backend":"simctl-io"}),
    )
}

pub fn ios_xctrace(
    device: &str,
    path: &Path,
    duration_seconds: u64,
    app: Option<&str>,
) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("E_UNSUPPORTED_ON_PLATFORM: xctrace requires macOS and Xcode".into());
    }
    let xcrun = executable("xcrun").ok_or("E_ENV_MISSING: xcrun requires Xcode")?;
    ensure_output_parent(path)?;
    let duration = format!("{}s", duration_seconds.clamp(1, 300));
    let output = path.to_string_lossy().to_string();
    let mut arguments = vec![
        "xctrace",
        "record",
        "--template",
        "Time Profiler",
        "--device",
        device,
        "--time-limit",
        &duration,
        "--output",
        &output,
    ];
    if let Some(app) = app {
        arguments.extend(["--launch", app]);
    } else {
        arguments.push("--all-processes");
    }
    run(&xcrun, &arguments)?;
    Ok(
        json!({"path":path,"durationSeconds":duration_seconds.clamp(1,300),"backend":"xctrace","template":"Time Profiler"}),
    )
}

pub fn resolve_reference(snapshot: &MobileSnapshot, reference: &str) -> Result<(i32, i32), String> {
    let normalized = reference.strip_prefix('@').unwrap_or(reference);
    let node = snapshot
        .nodes
        .iter()
        .find(|node| node.reference == normalized)
        .ok_or_else(|| {
            format!("E_STALE_REF: {reference} is not present in the current mobile snapshot")
        })?;
    Ok((
        (node.bounds[0] + node.bounds[2]) / 2,
        (node.bounds[1] + node.bounds[3]) / 2,
    ))
}

pub fn android_a11y_probe(
    device: Option<&str>,
    apk: &Path,
    runner: &str,
    allow_install: bool,
) -> Result<Value, String> {
    if !allow_install {
        return Err(
            "E_POLICY_BLOCKED: Android ATF probe installation requires --allow-install".into(),
        );
    }
    let adb = executable("adb").ok_or("E_ENV_MISSING: adb is not installed")?;
    let apk_value = apk.to_string_lossy().to_string();
    run(&adb, &adb_args(device, &["install", "-r", &apk_value]))?;
    let output = run(
        &adb,
        &adb_args(device, &["shell", "am", "instrument", "-w", runner]),
    )?;
    let text = redact_mobile_text(&String::from_utf8_lossy(&output));
    Ok(
        json!({"schema":"skeptic.mobile-a11y/1","platform":"android","engine":"ATF instrumentation","runner":runner,"output":text}),
    )
}

pub fn ios_accessibility_audit(
    project: &Path,
    scheme: &str,
    device: &str,
    test_target: Option<&str>,
    result_bundle: &Path,
) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "E_UNSUPPORTED_ON_PLATFORM: XCUITest accessibility audits require macOS and Xcode"
                .into(),
        );
    }
    let xcodebuild = executable("xcodebuild").ok_or("E_ENV_MISSING: xcodebuild requires Xcode")?;
    ensure_output_parent(result_bundle)?;
    let project_value = project.to_string_lossy().to_string();
    let destination = format!("platform=iOS Simulator,id={device}");
    let result = result_bundle.to_string_lossy().to_string();
    let mut arguments = vec![
        "test",
        "-project",
        &project_value,
        "-scheme",
        scheme,
        "-destination",
        &destination,
        "-resultBundlePath",
        &result,
    ];
    if let Some(test_target) = test_target {
        arguments.extend(["-only-testing", test_target]);
    }
    let output = run(&xcodebuild, &arguments);
    match output {
        Ok(stdout) => Ok(
            json!({"schema":"skeptic.mobile-a11y/1","platform":"ios-sim","engine":"XCUITest performAccessibilityAudit","resultBundle":result_bundle,"passed":true,"output":redact_mobile_text(&String::from_utf8_lossy(&stdout))}),
        ),
        Err(error) => Ok(
            json!({"schema":"skeptic.mobile-a11y/1","platform":"ios-sim","engine":"XCUITest performAccessibilityAudit","resultBundle":result_bundle,"passed":false,"output":redact_mobile_text(&error)}),
        ),
    }
}

#[derive(Debug, Default)]
pub struct AndroidDriver;

#[derive(Debug, Default)]
pub struct IosSimulatorDriver;

#[derive(Debug, Clone)]
struct MobileElement {
    reference: ElementRef,
    node: MobileNode,
}

impl Element for MobileElement {
    fn reference(&self) -> &ElementRef {
        &self.reference
    }
}

struct MobileDriverSession {
    id: String,
    platform: Platform,
    device: Option<String>,
    target: Option<String>,
    capabilities: CapabilitySet,
    identity: DocumentIdentity,
    generation: u64,
    next_ref_id: u64,
    refs: BTreeMap<String, MobileElement>,
}

fn driver_capabilities(platform: Platform) -> CapabilitySet {
    let mut values = vec![
        DriverCapability::Navigate,
        DriverCapability::Snapshot,
        DriverCapability::Click,
        DriverCapability::Fill,
        DriverCapability::Type,
        DriverCapability::Scroll,
        DriverCapability::Screenshot,
        DriverCapability::Record,
        DriverCapability::Accessibility,
    ];
    if platform == Platform::Android {
        values.extend([
            DriverCapability::Press,
            DriverCapability::Performance,
            DriverCapability::Console,
        ]);
    }
    CapabilitySet::new(values)
}

fn driver_error(error: String) -> DriverError {
    let code = if error.starts_with("E_STALE_REF") {
        DriverErrorCode::StaleRef
    } else if error.starts_with("E_UNSUPPORTED_ON_PLATFORM") {
        DriverErrorCode::UnsupportedOnPlatform
    } else if error.starts_with("E_TIMEOUT") {
        DriverErrorCode::Timeout
    } else if error.starts_with("E_POLICY_BLOCKED") {
        DriverErrorCode::PolicyBlocked
    } else if error.starts_with("E_ENV_MISSING") || error.starts_with("E_TARGET_UNREACHABLE") {
        DriverErrorCode::TargetUnreachable
    } else {
        DriverErrorCode::Internal
    };
    DriverError {
        code,
        retryable: matches!(
            code,
            DriverErrorCode::StaleRef
                | DriverErrorCode::TargetUnreachable
                | DriverErrorCode::Timeout
        ),
        hint: (code == DriverErrorCode::StaleRef)
            .then(|| "take a fresh snapshot and retry with the new reference".to_string()),
        message: error,
    }
}

fn element_backend_id(node: &MobileNode) -> String {
    let stable_name = if !node.resource_id.is_empty() {
        &node.resource_id
    } else if !node.content_description.is_empty() {
        &node.content_description
    } else {
        &node.text
    };
    format!(
        "{}|{}|{}|{:?}",
        node.class, stable_name, node.enabled, node.bounds
    )
}

fn same_element(left: &MobileNode, right: &MobileNode) -> bool {
    element_backend_id(left) == element_backend_id(right)
        && left.clickable == right.clickable
        && left.text == right.text
        && left.content_description == right.content_description
}

impl MobileDriverSession {
    fn invalidate(&mut self, reason: &str) {
        self.generation = self.generation.saturating_add(1);
        self.identity.document = format!(
            "{}:{}:{}:{}",
            match self.platform {
                Platform::Android => "android",
                Platform::IosSim => "ios-sim",
                Platform::Web => "web",
            },
            self.device.as_deref().unwrap_or("default"),
            self.id,
            self.generation
        );
        self.identity.frame = Some(reason.to_string());
        self.refs.clear();
    }

    fn capture(&self) -> Result<MobileSnapshot, DriverError> {
        match self.platform {
            Platform::Android => android_snapshot(self.device.as_deref()),
            Platform::IosSim => ios_snapshot(self.device.as_deref().unwrap_or("booted")),
            Platform::Web => {
                Err("E_UNSUPPORTED_ON_PLATFORM: mobile driver cannot capture web".into())
            }
        }
        .map_err(driver_error)
    }

    fn action_result(data: Value) -> ActionResult {
        ActionResult {
            changed: data.get("changed").and_then(Value::as_bool).unwrap_or(true),
            settle_state: SettleState::Complete,
            data,
        }
    }
}

#[async_trait]
impl Driver for AndroidDriver {
    fn name(&self) -> &'static str {
        "android-adb"
    }

    fn platform(&self) -> Platform {
        Platform::Android
    }

    fn capabilities(&self) -> CapabilitySet {
        driver_capabilities(self.platform())
    }

    async fn open(
        &self,
        session_id: &str,
        target: &TargetSpec,
    ) -> Result<Box<dyn Session>, DriverError> {
        if target.platform != Platform::Android {
            return Err(DriverError::unsupported(
                target.platform,
                DriverCapability::Navigate,
            ));
        }
        android_open(target.device.as_deref(), Some(&target.location)).map_err(driver_error)?;
        Ok(Box::new(MobileDriverSession {
            id: session_id.to_string(),
            platform: Platform::Android,
            device: target.device.clone(),
            target: Some(target.location.clone()),
            capabilities: self.capabilities(),
            identity: DocumentIdentity {
                document: format!(
                    "android:{}:{session_id}:0",
                    target.device.as_deref().unwrap_or("default")
                ),
                frame: None,
            },
            generation: 0,
            next_ref_id: 1,
            refs: BTreeMap::new(),
        }))
    }
}

#[async_trait]
impl Driver for IosSimulatorDriver {
    fn name(&self) -> &'static str {
        "ios-simulator"
    }

    fn platform(&self) -> Platform {
        Platform::IosSim
    }

    fn capabilities(&self) -> CapabilitySet {
        driver_capabilities(self.platform())
    }

    async fn open(
        &self,
        session_id: &str,
        target: &TargetSpec,
    ) -> Result<Box<dyn Session>, DriverError> {
        if target.platform != Platform::IosSim {
            return Err(DriverError::unsupported(
                target.platform,
                DriverCapability::Navigate,
            ));
        }
        let device = target.device.as_deref().unwrap_or("booted");
        ios_open(device, Some(&target.location)).map_err(driver_error)?;
        Ok(Box::new(MobileDriverSession {
            id: session_id.to_string(),
            platform: Platform::IosSim,
            device: Some(device.to_string()),
            target: Some(target.location.clone()),
            capabilities: self.capabilities(),
            identity: DocumentIdentity {
                document: format!("ios-sim:{device}:{session_id}:0"),
                frame: None,
            },
            generation: 0,
            next_ref_id: 1,
            refs: BTreeMap::new(),
        }))
    }
}

#[async_trait]
impl Session for MobileDriverSession {
    fn id(&self) -> &str {
        &self.id
    }

    fn platform(&self) -> Platform {
        self.platform
    }

    fn capabilities(&self) -> &CapabilitySet {
        &self.capabilities
    }

    fn document_identity(&self) -> &DocumentIdentity {
        &self.identity
    }

    async fn navigate(&mut self, location: &str) -> Result<ActionResult, DriverError> {
        let value = match self.platform {
            Platform::Android => android_open(self.device.as_deref(), Some(location)),
            Platform::IosSim => {
                ios_open(self.device.as_deref().unwrap_or("booted"), Some(location))
            }
            Platform::Web => {
                Err("E_UNSUPPORTED_ON_PLATFORM: mobile driver cannot navigate web".into())
            }
        }
        .map_err(driver_error)?;
        self.target = Some(location.to_string());
        self.invalidate("navigate");
        Ok(Self::action_result(value))
    }

    async fn snapshot(&mut self, _interactive_only: bool) -> Result<Snapshot, DriverError> {
        let snapshot = self.capture()?;
        self.invalidate("snapshot");
        let mut children = Vec::with_capacity(snapshot.nodes.len());
        for node in snapshot.nodes {
            let reference = ElementRef {
                id: format!("e{}", self.next_ref_id),
                backend_id: element_backend_id(&node),
                identity: self.identity.clone(),
                role: Some(
                    node.class
                        .rsplit('.')
                        .next()
                        .unwrap_or(&node.class)
                        .to_string(),
                ),
                name: Some(if !node.text.is_empty() {
                    node.text.clone()
                } else if !node.content_description.is_empty() {
                    node.content_description.clone()
                } else {
                    node.resource_id.clone()
                }),
            };
            self.next_ref_id = self.next_ref_id.saturating_add(1);
            self.refs.insert(
                reference.id.clone(),
                MobileElement {
                    reference: reference.clone(),
                    node,
                },
            );
            children.push(SnapshotNode {
                role: reference.role.clone().unwrap_or_default(),
                name: reference.name.clone().unwrap_or_default(),
                reference: Some(reference),
                children: Vec::new(),
            });
        }
        Ok(Snapshot {
            identity: self.identity.clone(),
            root: SnapshotNode {
                role: "application".into(),
                name: self.target.clone().unwrap_or_else(|| self.id.clone()),
                reference: None,
                children,
            },
        })
    }

    async fn resolve(&mut self, reference: &str) -> Result<Box<dyn Element>, DriverError> {
        let normalized = reference.strip_prefix('@').unwrap_or(reference);
        self.refs
            .get(normalized)
            .filter(|element| element.reference.identity == self.identity)
            .cloned()
            .map(|element| Box::new(element) as Box<dyn Element>)
            .ok_or_else(|| DriverError::stale(reference))
    }

    async fn click(&mut self, element: &dyn Element) -> Result<ActionResult, DriverError> {
        let reference = element.reference();
        if reference.identity != self.identity {
            return Err(DriverError::stale(&reference.id));
        }
        let expected = self
            .refs
            .get(&reference.id)
            .ok_or_else(|| DriverError::stale(&reference.id))?;
        if expected.reference.backend_id != reference.backend_id {
            return Err(DriverError::stale(&reference.id));
        }
        let current = self.capture()?;
        let attached = current
            .nodes
            .iter()
            .find(|candidate| same_element(&expected.node, candidate))
            .ok_or_else(|| DriverError::stale(&reference.id))?;
        let x = (attached.bounds[0] + attached.bounds[2]) / 2;
        let y = (attached.bounds[1] + attached.bounds[3]) / 2;
        let value = match self.platform {
            Platform::Android => android_tap(self.device.as_deref(), x, y),
            Platform::IosSim => ios_tap(self.device.as_deref().unwrap_or("booted"), x, y),
            Platform::Web => {
                Err("E_UNSUPPORTED_ON_PLATFORM: mobile driver cannot click web".into())
            }
        }
        .map_err(driver_error)?;
        self.invalidate("click");
        Ok(Self::action_result(value))
    }

    async fn screenshot(&mut self) -> Result<Vec<u8>, DriverError> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "skeptic-mobile-driver-{}-{nonce}.png",
            std::process::id()
        ));
        match self.platform {
            Platform::Android => android_screenshot(self.device.as_deref(), &path),
            Platform::IosSim => ios_screenshot(self.device.as_deref().unwrap_or("booted"), &path),
            Platform::Web => {
                Err("E_UNSUPPORTED_ON_PLATFORM: mobile driver cannot screenshot web".into())
            }
        }
        .map_err(driver_error)?;
        let bytes = fs::read(&path).map_err(|error| driver_error(error.to_string()))?;
        let _ = fs::remove_file(path);
        Ok(bytes)
    }

    async fn close(&mut self) -> Result<(), DriverError> {
        match self.platform {
            Platform::Android => android_close(self.device.as_deref(), self.target.as_deref()),
            Platform::IosSim => ios_close(
                self.device.as_deref().unwrap_or("booted"),
                self.target.as_deref(),
            ),
            Platform::Web => {
                Err("E_UNSUPPORTED_ON_PLATFORM: mobile driver cannot close web".into())
            }
        }
        .map_err(driver_error)?;
        self.invalidate("close");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adb_device_lines() {
        let devices = parse_adb_devices("List of devices attached\nemulator-5554 device product:sdk model:Pixel_9 device:emu\nabc unauthorized\n");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].name, "Pixel 9");
        assert!(devices[0].capabilities.contains(&"snapshot".to_string()));
        assert!(devices[1].capabilities.is_empty());
    }

    #[test]
    fn parses_uiautomator_snapshot_to_refs() {
        let xml = r#"<hierarchy><node index="0" text="Save" resource-id="app:id/save" class="android.widget.Button" content-desc="" clickable="true" enabled="true" bounds="[10,20][110,70]" /></hierarchy>"#;
        let snapshot = parse_android_xml(xml, "emulator-5554").unwrap();
        assert_eq!(snapshot.nodes[0].reference, "e1");
        assert_eq!(snapshot.nodes[0].bounds, [10, 20, 110, 70]);
        assert!(snapshot.compact.contains("Save"));
    }

    #[test]
    fn resolves_snapshot_refs_to_element_centers() {
        let snapshot = parse_android_xml(r#"<hierarchy><node class="Button" text="Save" bounds="[10,20][110,80]" /></hierarchy>"#, "device").unwrap();
        assert_eq!(resolve_reference(&snapshot, "@e1").unwrap(), (60, 50));
        assert!(resolve_reference(&snapshot, "@e2")
            .unwrap_err()
            .starts_with("E_STALE_REF"));
    }

    #[test]
    fn redacts_mobile_logs_before_persistence() {
        let value = redact_mobile_text("Authorization: Bearer abc.def /?token=visible");
        assert!(!value.contains("abc.def"));
        assert!(!value.contains("visible"));
    }
}
