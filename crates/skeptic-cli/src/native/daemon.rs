// Derived from vercel-labs/agent-browser v0.32.2 (Apache-2.0); modified by Skeptic.
use serde_json::Value;
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::signal;
use tokio::sync::{mpsc, Notify};

use super::actions::{
    auto_save_restore_state, close_current_browser, execute_command, maybe_autosave_restore_state,
    DaemonState,
};
use super::state;
use crate::connection::INTERNAL_DAEMON_SHUTDOWN_ACTION;

pub async fn run_daemon(session: &str) {
    let socket_dir = get_daemon_socket_dir();
    if let Err(error) = prepare_socket_directory(&socket_dir) {
        let _ = writeln!(std::io::stderr(), "Daemon security error: {error}");
        process::exit(1);
    }

    // When debug mode is on, redirect stderr to a log file so daemon
    // output can be inspected (the daemon normally has stderr piped to its
    // parent which drops the read end after startup).
    #[cfg(unix)]
    if env::var("SKEPTIC_DEBUG").is_ok() {
        let log_path = socket_dir.join(format!("{}.log", session));
        if let Ok(file) = fs::File::create(&log_path) {
            use std::os::unix::io::IntoRawFd;
            let fd = file.into_raw_fd();
            unsafe {
                libc::dup2(fd, 2);
                libc::close(fd);
            }
            let _ = writeln!(
                std::io::stderr(),
                "[daemon] Debug logging started for session: {}",
                session
            );
        }
    } else {
        // Redirect stderr to /dev/null to prevent daemon crash when the
        // parent CLI drops the piped stderr handle after startup.  Cloud
        // providers (AgentCore, Browserbase, etc.) may write to stderr
        // during connection setup; a broken pipe would kill the daemon.
        #[cfg(unix)]
        {
            use std::os::unix::io::IntoRawFd;
            if let Ok(devnull) = fs::File::create("/dev/null") {
                let fd = devnull.into_raw_fd();
                unsafe {
                    libc::dup2(fd, 2);
                    libc::close(fd);
                }
            }
        }
    }

    let pid_path = socket_dir.join(format!("{}.pid", session));
    let _ = fs::write(&pid_path, process::id().to_string());

    let version_path = socket_dir.join(format!("{}.version", session));
    let _ = fs::write(&version_path, env!("CARGO_PKG_VERSION"));

    // On Unix the daemon listens on a Unix domain socket; on Windows it uses
    // TCP, so there is no .sock file — only a .port file written by the server.
    let socket_path = socket_dir.join(format!("{}.sock", session));

    #[cfg(unix)]
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    #[cfg(windows)]
    {
        let _ = fs::remove_file(socket_dir.join(format!("{}.port", session)));
        let _ = fs::remove_file(socket_dir.join(format!("{}.token", session)));
    }

    let _ = fs::remove_file(socket_dir.join(format!("{}.engine", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.provider", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.extensions", session)));

    if let Ok(days_str) = env::var("SKEPTIC_STATE_EXPIRE_DAYS") {
        if let Ok(days) = days_str.parse::<u64>() {
            if days > 0 {
                let _ = state::state_clean(days);
            }
        }
    }

    // Auto-shutdown the daemon after this many ms of inactivity (no commands received).
    // Disabled when unset or 0.
    let idle_timeout_ms = env::var("SKEPTIC_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&ms| ms > 0);

    let autosave_interval_ms = autosave_interval_ms_from_env();

    let result =
        run_socket_server(&socket_path, session, idle_timeout_ms, autosave_interval_ms).await;

    #[cfg(unix)]
    {
        let _ = fs::remove_file(&socket_path);
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(socket_dir.join(format!("{}.port", session)));
        let _ = fs::remove_file(socket_dir.join(format!("{}.token", session)));
    }
    let _ = fs::remove_file(&pid_path);
    let _ = fs::remove_file(&version_path);
    let _ = fs::remove_file(socket_dir.join(format!("{}.engine", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.provider", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.extensions", session)));

    if let Err(e) = result {
        let _ = writeln!(std::io::stderr(), "Daemon error: {}", e);
        process::exit(1);
    }
}

/// Minimum ms between periodic session autosaves while the browser is open.
/// Defaults to 30s; 0 disables periodic autosave (save-on-close still runs).
fn autosave_interval_ms_from_env() -> u64 {
    env::var("SKEPTIC_AUTOSAVE_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000)
}

#[cfg(unix)]
async fn run_socket_server(
    socket_path: &PathBuf,
    _session: &str,
    idle_timeout_ms: Option<u64>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::UnixListener;

    let listener =
        UnixListener::bind(socket_path).map_err(|e| format!("Failed to bind socket: {}", e))?;
    secure_unix_socket(socket_path)?;

    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(DaemonState::new()));

    let (reset_tx, mut reset_rx) = mpsc::channel::<()>(64);
    let reset_tx = idle_timeout_ms.map(|_| Arc::new(reset_tx));

    // Notifier used by handle_connection to signal the daemon loop to exit
    // after a "close" command, instead of calling process::exit() which skips
    // destructors and can leave Chrome processes orphaned (issue #1113).
    let close_notify = Arc::new(Notify::new());

    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        if let Err(error) = validate_unix_peer(&stream) {
                            let _ = writeln!(std::io::stderr(), "Rejected daemon peer: {error}");
                            continue;
                        }
                        let state = state.clone();
                        let reset_tx = reset_tx.clone();
                        let cn = close_notify.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, reset_tx, cn, None).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                let mut s = state.lock().await;
                let process_exited = s
                    .browser
                    .as_mut()
                    .map(|mgr| mgr.has_process_exited())
                    .unwrap_or(false);
                if process_exited {
                    let _ = close_current_browser(&mut s).await;
                } else if s.browser.is_some() {
                    if let Err(error) = s.drain_cdp_events_background().await {
                        let _ = writeln!(
                            std::io::stderr(),
                            "Failed to apply browser network controls: {}",
                            error
                        );
                    } else {
                        maybe_autosave_restore_state(&mut s, autosave_interval_ms).await;
                    }
                }
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_current_browser(&mut s).await;
                break;
            }
            _ = reset_rx.recv(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                // "close" command was handled; browser already closed by
                // handle_close(). Break to run cleanup and exit gracefully
                // so destructors fire.
                break;
            }
            _ = shutdown_signal() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_current_browser(&mut s).await;
                break;
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
async fn run_socket_server(
    socket_path: &PathBuf,
    session: &str,
    idle_timeout_ms: Option<u64>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::TcpListener;

    let preferred_port = get_port_for_session(session);
    // Try the hash-derived port first; if it is blocked (e.g. Windows Hyper-V
    // excluded port range), fall back to an OS-assigned ephemeral port.
    let listener = match TcpListener::bind(format!("127.0.0.1:{}", preferred_port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind TCP: {}", e))?,
    };
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();

    let socket_dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
    let auth_token = Arc::new(create_windows_auth_token(socket_dir, session)?);
    let port_path = socket_dir.join(format!("{}.port", session));
    let _ = fs::write(&port_path, actual_port.to_string());

    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(DaemonState::new()));

    let (reset_tx, mut reset_rx) = mpsc::channel::<()>(64);
    let reset_tx = idle_timeout_ms.map(|_| Arc::new(reset_tx));

    let close_notify = Arc::new(Notify::new());

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);

    // Mirror the unix loop's background tick: reap a browser the user closed
    // by hand, and drain CDP events (dialog state in particular) before
    // autosave so a save never runs against a dialog-blocked renderer.
    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let reset_tx = reset_tx.clone();
                        let cn = close_notify.clone();
                        let token = auth_token.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, reset_tx, cn, Some(token)).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                let mut s = state.lock().await;
                let process_exited = s
                    .browser
                    .as_mut()
                    .map(|mgr| mgr.has_process_exited())
                    .unwrap_or(false);
                if process_exited {
                    let _ = close_current_browser(&mut s).await;
                } else if s.browser.is_some() {
                    s.drain_cdp_events_background().await;
                    maybe_autosave_restore_state(&mut s, autosave_interval_ms).await;
                }
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_current_browser(&mut s).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = reset_rx.recv(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = shutdown_signal() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_current_browser(&mut s).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
        }
    }

    Ok(())
}

async fn handle_connection<S>(
    stream: S,
    state: std::sync::Arc<tokio::sync::Mutex<DaemonState>>,
    idle_reset_tx: Option<Arc<mpsc::Sender<()>>>,
    close_notify: Arc<Notify>,
    expected_token: Option<Arc<String>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if looks_like_http(trimmed) {
                    break;
                }

                let mut cmd: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        let err = serde_json::json!({
                            "success": false,
                            "error": format!("Invalid JSON: {}", e),
                        });
                        let mut resp = serde_json::to_string(&err).unwrap_or_default();
                        resp.push('\n');
                        let _ = writer.write_all(resp.as_bytes()).await;
                        continue;
                    }
                };

                if let Some(expected) = expected_token.as_deref() {
                    let supplied = cmd
                        .get("_skepticAuthToken")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !constant_time_equal(supplied.as_bytes(), expected.as_bytes()) {
                        let response = serde_json::json!({
                            "success": false,
                            "error": "E_POLICY_BLOCKED: daemon authentication failed",
                        });
                        let mut encoded = serde_json::to_string(&response).unwrap_or_default();
                        encoded.push('\n');
                        let _ = writer.write_all(encoded.as_bytes()).await;
                        break;
                    }
                    if let Some(object) = cmd.as_object_mut() {
                        object.remove("_skepticAuthToken");
                    }
                }

                if let Some(ref tx) = idle_reset_tx {
                    let _ = tx.try_send(());
                }

                let action = cmd
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let response = {
                    let mut s = state.lock().await;
                    execute_command(&cmd, &mut s).await
                };

                let mut resp = serde_json::to_string(&response).unwrap_or_default();
                resp.push('\n');
                if writer.write_all(resp.as_bytes()).await.is_err() {
                    break;
                }

                if close_completed_response(&action, &response) {
                    // Signal the daemon loop to exit gracefully instead of
                    // calling process::exit(), which skips destructors and
                    // can leave Chrome processes orphaned (issue #1113).
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    close_notify.notify_one();
                    return;
                }
            }
            Err(_) => break,
        }
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn prepare_socket_directory(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "{} must be a real directory owned by the current user",
                path.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(format!(
                    "{} is owned by uid {}, expected {}",
                    path.display(),
                    metadata.uid(),
                    unsafe { libc::geteuid() }
                ));
            }
        }
    } else {
        fs::create_dir_all(path)
            .map_err(|error| format!("cannot create {}: {error}", path.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot secure {}: {error}", path.display()))?;
    }
    #[cfg(windows)]
    secure_windows_path(path, true)?;
    Ok(())
}

#[cfg(unix)]
fn secure_unix_socket(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot secure {}: {error}", path.display()))
}

#[cfg(unix)]
fn validate_unix_peer(stream: &tokio::net::UnixStream) -> Result<(), String> {
    let peer = stream
        .peer_cred()
        .map_err(|error| format!("cannot read peer credentials: {error}"))?;
    let owner = unsafe { libc::geteuid() };
    if peer.uid() != owner {
        return Err(format!(
            "peer uid {} does not match daemon uid {owner}",
            peer.uid()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn secure_windows_path(path: &std::path::Path, directory: bool) -> Result<(), String> {
    let username = env::var("USERNAME").map_err(|_| {
        "USERNAME is unavailable; cannot construct a user-only daemon ACL".to_string()
    })?;
    let principal = env::var("USERDOMAIN")
        .ok()
        .filter(|domain| !domain.is_empty())
        .map_or(username.clone(), |domain| format!(r"{domain}\{username}"));
    let grant = if directory {
        format!("{principal}:(OI)(CI)(F)")
    } else {
        format!("{principal}:(F)")
    };
    let status = process::Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(grant)
        .stdout(process::Stdio::null())
        .stderr(process::Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "cannot apply a user-only ACL to {}: {error}",
                path.display()
            )
        })?;
    if !status.success() {
        return Err(format!(
            "cannot apply a user-only ACL to {}; icacls exited {status}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn create_windows_auth_token(directory: &std::path::Path, session: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("cannot generate daemon authentication token: {error}"))?;
    let token = hex::encode(bytes);
    let path = directory.join(format!("{session}.token"));
    fs::write(&path, token.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    if let Err(error) = secure_windows_path(&path, false) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(token)
}

fn looks_like_http(line: &str) -> bool {
    let prefixes = [
        "GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "HEAD ", "OPTIONS ", "CONNECT ", "TRACE ",
    ];
    prefixes.iter().any(|p| line.starts_with(p))
}

fn close_completed_response(action: &str, response: &Value) -> bool {
    if !matches!(
        action,
        "close" | "confirm" | INTERNAL_DAEMON_SHUTDOWN_ACTION
    ) {
        return false;
    }

    fn data_closed(data: &Value) -> bool {
        data.get("closed").and_then(|v| v.as_bool()) == Some(true)
    }

    if response.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }

    let Some(data) = response.get("data") else {
        return false;
    };
    if data_closed(data) {
        return true;
    }

    data.get("result").is_some_and(|result| {
        result.get("success").and_then(|v| v.as_bool()) == Some(true)
            && result.get("data").is_some_and(data_closed)
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigint = match signal::unix::signal(signal::unix::SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGINT handler: {}", e);
                process::exit(1);
            }
        };
        let mut sigterm = match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Failed to install SIGTERM handler: {}",
                    e
                );
                process::exit(1);
            }
        };
        let mut sighup = match signal::unix::signal(signal::unix::SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGHUP handler: {}", e);
                process::exit(1);
            }
        };

        tokio::select! {
            _ = sigint.recv() => {}
            _ = sigterm.recv() => {}
            _ = sighup.recv() => {}
        }
    }

    #[cfg(windows)]
    {
        if let Err(e) = signal::ctrl_c().await {
            let _ = writeln!(std::io::stderr(), "Failed to install Ctrl+C handler: {}", e);
            process::exit(1);
        }
    }
}

fn get_daemon_socket_dir() -> PathBuf {
    crate::connection::get_socket_dir()
}

#[cfg(windows)]
fn get_port_for_session(session: &str) -> u16 {
    crate::connection::get_port_for_session(session)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn test_daemon_socket_dir_matches_client_namespace() {
        let guard = crate::test_utils::EnvGuard::new(&[
            "SKEPTIC_SOCKET_DIR",
            "XDG_RUNTIME_DIR",
            "SKEPTIC_NAMESPACE",
        ]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("SKEPTIC_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("XDG_RUNTIME_DIR");
        guard.set("SKEPTIC_NAMESPACE", "Worktree: One");

        let socket_dir = get_daemon_socket_dir();

        assert_eq!(socket_dir, crate::connection::get_socket_dir());
        assert!(socket_dir.ends_with(
            std::path::PathBuf::from("namespaces")
                .join("worktree-one")
                .join("run")
        ));
    }

    #[test]
    fn authentication_tokens_use_constant_time_comparison() {
        assert!(constant_time_equal(b"same-token", b"same-token"));
        assert!(!constant_time_equal(b"same-token", b"other-token"));
        assert!(!constant_time_equal(b"short", b"longer"));
    }

    #[cfg(unix)]
    #[test]
    fn socket_directory_and_socket_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("daemon");
        prepare_socket_directory(&directory).unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let socket = directory.join("test.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        secure_unix_socket(&socket).unwrap();
        assert_eq!(
            fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn accepts_a_peer_owned_by_the_daemon_user() {
        let (peer, _other) = tokio::net::UnixStream::pair().unwrap();
        validate_unix_peer(&peer).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn test_port_matches_client_algorithm() {
        let guard = crate::test_utils::EnvGuard::new(&["SKEPTIC_NAMESPACE"]);
        guard.remove("SKEPTIC_NAMESPACE");

        assert_eq!(get_port_for_session("default"), 50838);
        assert_eq!(get_port_for_session("my-session"), 63105);
        assert_eq!(get_port_for_session("work"), 51184);
        assert_eq!(get_port_for_session(""), 49152);
    }

    #[test]
    fn test_close_completed_response_requires_actual_close_result() {
        let confirmation_response = serde_json::json!({
            "success": true,
            "data": {
                "confirmation_required": true,
                "confirmation_id": "close-1",
                "action": "close"
            }
        });

        assert!(!close_completed_response("close", &confirmation_response));
    }

    #[test]
    fn test_close_completed_response_accepts_direct_and_confirmed_close() {
        let direct = serde_json::json!({
            "success": true,
            "data": { "closed": true }
        });
        let confirmed = serde_json::json!({
            "success": true,
            "data": {
                "confirmed": true,
                "action": "close",
                "result": {
                    "success": true,
                    "data": { "closed": true }
                }
            }
        });

        assert!(close_completed_response("close", &direct));
        assert!(close_completed_response(
            crate::connection::INTERNAL_DAEMON_SHUTDOWN_ACTION,
            &direct
        ));
        assert!(close_completed_response("confirm", &confirmed));
    }

    /// Guard against re-introducing `waitpid(-1)` in daemon code.
    ///
    /// Issue #1035: a SIGCHLD handler that called `waitpid(-1, WNOHANG)` was
    /// added in v0.22.3 to reap zombie Chrome processes. This races with
    /// Rust's `Child::try_wait()` / `Child::wait()` because `waitpid(-1)`
    /// reaps *any* child, stealing the exit status before Rust can collect
    /// it. The result is ECHILD errors in `BrowserManager::has_process_exited()`
    /// and `ChromeProcess::kill()`, which can leave the daemon in a broken
    /// state or cause hangs on certain Linux configurations.
    ///
    /// The fix uses the existing 500ms drain interval to call
    /// `has_process_exited()` (which delegates to `Child::try_wait()`)
    /// for targeted, race-free zombie detection.
    #[test]
    fn test_no_waitpid_minus_one_in_daemon() {
        let source = include_str!("daemon.rs");
        // Only check production code (everything before `#[cfg(test)]`)
        let production_code = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert!(
            !production_code.contains("waitpid(-1"),
            "daemon.rs production code must not call waitpid(-1, ...). \
             Use Child::try_wait() via has_process_exited() instead. \
             See issue #1035."
        );
    }

    /// Verify that `Child::try_wait()` correctly detects a crashed child
    /// without needing a global SIGCHLD handler or `waitpid(-1)`.
    /// This is what `has_process_exited()` uses in the fixed code.
    #[cfg(unix)]
    #[test]
    fn test_child_try_wait_detects_exit_without_sigchld_handler() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 42"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        std::thread::sleep(std::time::Duration::from_millis(200));

        match child.try_wait() {
            Ok(Some(status)) => {
                assert!(
                    !status.success(),
                    "child exited with code 42, should not be success"
                );
            }
            Ok(None) => panic!("try_wait() returned None but child should have exited"),
            Err(e) => panic!("try_wait() should succeed without waitpid(-1): {}", e),
        }
    }

    /// Regression test for #1101: idle timeout must fire even while the
    /// drain interval ticks every 500 ms.  The bug was that `sleep_future`
    /// was created **inside** the loop, so each drain tick dropped the
    /// in-progress sleep and replaced it with a fresh one – the timer
    /// could never reach its deadline.
    #[tokio::test]
    async fn test_idle_timeout_fires_despite_drain_interval() {
        use tokio::sync::mpsc;

        let idle_timeout_ms: u64 = 1000;
        let mut drain_interval = tokio::time::interval(Duration::from_millis(500));
        drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let (_reset_tx, mut reset_rx) = mpsc::channel::<()>(64);

        let start = tokio::time::Instant::now();

        let exited = tokio::time::timeout(Duration::from_secs(5), async {
            let mut idle_sleep_pin = Some(Box::pin(tokio::time::sleep(Duration::from_millis(
                idle_timeout_ms,
            ))));

            loop {
                tokio::select! {
                    _ = drain_interval.tick() => {}
                    _ = async {
                        match idle_sleep_pin {
                            Some(ref mut s) => s.as_mut().await,
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        break;
                    }
                    _ = reset_rx.recv() => {
                        idle_sleep_pin = Some(Box::pin(
                            tokio::time::sleep(Duration::from_millis(idle_timeout_ms)),
                        ));
                        continue;
                    }
                }
            }
        })
        .await;

        let elapsed = start.elapsed();

        assert!(
            exited.is_ok(),
            "idle timeout never fired – loop ran for >5 s (bug #1101)"
        );
        assert!(
            elapsed < Duration::from_millis(idle_timeout_ms + 500),
            "idle timeout took too long: {:?} (expected ~{} ms)",
            elapsed,
            idle_timeout_ms,
        );
    }

    /// Verify that `ChromeProcess::has_exited()` (which uses `Child::try_wait()`)
    /// correctly detects a killed child, the same way the drain interval does
    /// in the fixed daemon code. This ensures crash detection works without
    /// a SIGCHLD handler.
    #[cfg(unix)]
    #[test]
    fn test_has_exited_detects_killed_process() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        // Process should be running
        match child.try_wait() {
            Ok(None) => {} // expected
            other => panic!("expected Ok(None) for running process, got {:?}", other),
        }

        // Kill it (simulates Chrome crash)
        child.kill().expect("failed to kill child");
        std::thread::sleep(std::time::Duration::from_millis(100));

        // try_wait should detect the exit
        match child.try_wait() {
            Ok(Some(_)) => {} // expected: detected the crash
            other => panic!(
                "expected Ok(Some(_)) after kill, got {:?}. \
                 Crash detection via try_wait() must work for the drain \
                 interval fix (issue #1035) to function correctly.",
                other
            ),
        }
    }
}
