// Derived from vercel-labs/agent-browser v0.32.2 (Apache-2.0); modified by Skeptic.
//! Integration tests for `skeptic doctor`.
//!
//! These tests spawn the real CLI binary and verify that the v2 source Doctor
//! surface is wired through the top-level executable.

use std::process::Command;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_skeptic");

fn build_doctor_cmd(tmp: &TempDir, args: &[&str]) -> Command {
    let socket_dir = tmp.path().join("sockets");
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&socket_dir).unwrap();
    std::fs::create_dir_all(&home).unwrap();

    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env("SKEPTIC_SOCKET_DIR", &socket_dir)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        // Keep the launch test's skip-logic deterministic across hosts.
        .env_remove("SKEPTIC_PROVIDER")
        .env_remove("SKEPTIC_CDP")
        // Don't emit color codes into captured stdout.
        .env("NO_COLOR", "1");
    cmd
}

#[test]
fn doctor_json_emits_v2_envelope() {
    let tmp = TempDir::new().unwrap();

    let root = tmp.path().to_string_lossy().into_owned();
    let output = build_doctor_cmd(&tmp, &["doctor", &root, "--blocking", "none", "--json"])
        .output()
        .expect("failed to invoke skeptic doctor");

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    assert!(
        code == 0,
        "unexpected exit code {}\nstdout:\n{}\nstderr:\n{}",
        code,
        stdout,
        stderr,
    );

    let payload: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("stdout was not JSON: {}\n---\n{}", e, stdout));

    assert_eq!(payload["ok"], true);
    assert_eq!(payload["meta"]["schema"], "skeptic.doctor-report/2");
    assert!(payload["data"]["score"].is_null());
    assert!(payload["data"]["coveredCategories"].is_array());

    let diagnostics = payload["data"]["diagnostics"]
        .as_array()
        .expect("diagnostics should be an array");
    assert!(diagnostics.is_empty());
}

#[test]
fn doctor_help_describes_flags_and_examples() {
    let tmp = TempDir::new().unwrap();

    let output = build_doctor_cmd(&tmp, &["doctor", "--help"])
        .output()
        .expect("failed to invoke skeptic doctor --help");

    assert!(
        output.status.success(),
        "doctor --help should exit 0; got {:?}",
        output.status
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout should be utf8");

    for needle in [
        "skeptic doctor",
        "--scope all|changed",
        "--deep",
        "--fix-plan",
        "--format human|json|sarif",
        "doctor baseline update",
        "doctor analyzers list",
    ] {
        assert!(
            stdout.contains(needle),
            "doctor --help output missing {:?}\n---\n{}",
            needle,
            stdout
        );
    }
}
