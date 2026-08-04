//! Acceptance tests for the shipped `skeptic-doctor` executable.

use std::process::Command;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_skeptic-doctor");

fn doctor_command(tmp: &TempDir, args: &[&str]) -> Command {
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let mut command = Command::new(BIN);
    command
        .args(args)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("NO_COLOR", "1");
    command
}

#[test]
fn doctor_json_emits_v2_report() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_string_lossy().into_owned();
    let output = doctor_command(&tmp, &[&root, "--blocking", "none", "--json"])
        .output()
        .expect("failed to invoke skeptic-doctor");
    assert!(
        output.status.success(),
        "unexpected exit {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["meta"]["schema"], "skeptic.doctor-report/2");
    assert!(payload["data"]["score"].is_null());
    assert!(payload["data"]["coveredCategories"].is_array());
    assert!(payload["data"]["diagnostics"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn doctor_help_documents_the_agent_surface() {
    let tmp = TempDir::new().unwrap();
    let output = doctor_command(&tmp, &["--help"])
        .output()
        .expect("failed to invoke skeptic-doctor --help");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    for expected in [
        "skeptic doctor",
        "--scope all|changed",
        "--deep",
        "--fix-plan",
        "--format human|json|sarif",
        "doctor baseline update",
        "doctor analyzers list",
    ] {
        assert!(
            stdout.contains(expected),
            "help missing {expected:?}\n{stdout}"
        );
    }
}
