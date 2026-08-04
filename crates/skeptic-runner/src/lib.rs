//! Sandboxed TypeScript spec runtime. Each file is evaluated in its own V8
//! isolate; the parent runner uses one worker process per attempt so hard
//! timeouts can always be enforced outside V8 as well.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deno_core::{
    extension, op2, resolve_import, JsRuntime, ModuleLoadOptions, ModuleLoadResponse, ModuleLoader,
    ModuleResolveResponse, ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, OpState,
    ResolutionKind, RuntimeOptions,
};
use deno_error::JsErrorBox;
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use skeptic_contract::{AssertionResult, EvidenceRef};
use tokio::sync::oneshot;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTarget {
    #[serde(default = "default_worker_platform")]
    pub platform: String,
    pub device: Option<String>,
    pub app: Option<String>,
}

impl Default for WorkerTarget {
    fn default() -> Self {
        Self {
            platform: default_worker_platform(),
            device: None,
            app: None,
        }
    }
}

fn default_worker_platform() -> String {
    "web".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTestResult {
    pub title: String,
    pub status: String,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub assertion: Option<AssertionResult>,
    pub session: Option<String>,
    #[serde(default)]
    pub target: WorkerTarget,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerEvidence {
    pub kind: String,
    pub path: PathBuf,
    pub media_type: String,
    pub sensitive: bool,
    pub redacted: bool,
    pub session: Option<String>,
    pub target: Option<WorkerTarget>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResult {
    pub tests: Vec<WorkerTestResult>,
    pub console: Vec<JsonValue>,
    #[serde(default)]
    pub sidecars: Vec<WorkerEvidence>,
}

#[derive(Clone)]
struct RunnerState {
    skeptic_bin: PathBuf,
    default_session: String,
    allowed_domains: Vec<String>,
    env: BTreeMap<String, String>,
    result: Arc<Mutex<Option<Vec<WorkerTestResult>>>>,
    console: Arc<Mutex<Vec<JsonValue>>>,
    timers: Arc<Mutex<BTreeMap<u64, oneshot::Sender<()>>>>,
    initialized_collectors: Arc<Mutex<BTreeSet<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageCommand {
    session: Option<String>,
    args: Vec<String>,
}

fn initialize_web_collectors(state: &RunnerState, session: &str) {
    let already_initialized = state
        .initialized_collectors
        .lock()
        .is_ok_and(|sessions| sessions.contains(session));
    if already_initialized {
        return;
    }
    let invoke = |args: &[&str]| {
        std::process::Command::new(&state.skeptic_bin)
            .arg("--session")
            .arg(session)
            .arg("--format")
            .arg("json")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    let _ = invoke(&["network", "requests"]);
    if invoke(&["network", "har", "start"]) {
        if let Ok(mut sessions) = state.initialized_collectors.lock() {
            sessions.insert(session.to_string());
        }
    }
}

#[op2]
#[serde]
fn op_page(
    state: &mut OpState,
    #[serde] request: PageCommand,
) -> Result<serde_json::Value, JsErrorBox> {
    let state = state.borrow::<RunnerState>().clone();
    let session = request.session.as_deref().unwrap_or(&state.default_session);
    let mut command = std::process::Command::new(&state.skeptic_bin);
    command
        .arg("--session")
        .arg(session)
        .arg("--format")
        .arg("json")
        .args(&request.args);
    // The browser client/daemon needs platform launch variables. Spec code
    // still sees only the separately filtered map through `skeptic.env()`.
    let output = command
        .output()
        .map_err(|error| JsErrorBox::generic(format!("cannot invoke Skeptic: {error}")))?;
    let payload: JsonValue = serde_json::from_slice(&output.stdout).map_err(|error| {
        JsErrorBox::generic(format!(
            "invalid Skeptic response: {error}; stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    })?;
    if !payload
        .get("ok")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
    {
        let error = payload
            .get("error")
            .cloned()
            .unwrap_or_else(|| json!({"code":"E_ACTION_FAILED","message":"browser action failed"}));
        return Err(JsErrorBox::generic(error.to_string()));
    }
    let is_web = !request
        .args
        .windows(2)
        .any(|values| values[0] == "--platform" && values[1] != "web");
    if is_web {
        initialize_web_collectors(&state, session);
    }
    Ok(payload.get("data").cloned().unwrap_or(JsonValue::Null))
}

#[op2(fast)]
fn op_sleep(#[bigint] milliseconds: u64) {
    std::thread::sleep(Duration::from_millis(milliseconds.min(60_000)));
}

#[op2]
async fn op_timeout(
    state: Rc<RefCell<OpState>>,
    #[bigint] timer_id: u64,
    #[bigint] milliseconds: u64,
) -> bool {
    let timers = state.borrow().borrow::<RunnerState>().timers.clone();
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut active) = timers.lock() {
        active.insert(timer_id, sender);
    }
    let fired = tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(milliseconds.min(60_000))) => true,
        _ = receiver => false,
    };
    if let Ok(mut active) = timers.lock() {
        active.remove(&timer_id);
    };
    fired
}

#[op2(fast)]
fn op_cancel_timeout(state: &mut OpState, #[bigint] timer_id: u64) {
    if let Some(sender) = state
        .borrow::<RunnerState>()
        .timers
        .lock()
        .ok()
        .and_then(|mut active| active.remove(&timer_id))
    {
        let _ = sender.send(());
    }
}

#[op2]
#[string]
fn op_env(state: &mut OpState, #[string] name: String) -> Option<String> {
    state.borrow::<RunnerState>().env.get(&name).cloned()
}

#[op2]
#[serde]
fn op_console(state: &mut OpState, #[serde] entry: serde_json::Value) -> Result<(), JsErrorBox> {
    state
        .borrow::<RunnerState>()
        .console
        .lock()
        .map_err(|_| JsErrorBox::generic("console journal lock poisoned"))?
        .push(entry);
    Ok(())
}

#[op2]
#[serde]
fn op_finish(
    state: &mut OpState,
    #[serde] results: Vec<WorkerTestResult>,
) -> Result<(), JsErrorBox> {
    *state
        .borrow::<RunnerState>()
        .result
        .lock()
        .map_err(|_| JsErrorBox::generic("result lock poisoned"))? = Some(results);
    Ok(())
}

#[op2]
#[serde]
fn op_fetch(state: &mut OpState, #[string] url: String) -> Result<serde_json::Value, JsErrorBox> {
    let parsed = Url::parse(&url).map_err(|error| JsErrorBox::generic(error.to_string()))?;
    let host = parsed.host_str().unwrap_or_default();
    let allowed = state.borrow::<RunnerState>().allowed_domains.clone();
    if !allowed.iter().any(|domain| domain == "*" || domain == host) {
        return Err(JsErrorBox::generic(format!(
            "E_POLICY_BLOCKED: fetch to {host} is outside policy.allowedDomains"
        )));
    }
    let response = reqwest::blocking::get(parsed)
        .map_err(|error| JsErrorBox::generic(format!("fetch failed: {error}")))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let body = response
        .text()
        .map_err(|error| JsErrorBox::generic(format!("fetch body failed: {error}")))?;
    Ok(json!({"status": status, "headers": headers, "body": body}))
}

extension!(
    skeptic_runtime,
    ops = [op_page, op_sleep, op_timeout, op_cancel_timeout, op_env, op_console, op_finish, op_fetch],
    options = { runner_state: RunnerState },
    state = |state, options| state.put(options.runner_state),
);

extension!(
    skeptic_web_globals,
    deps = [deno_web, deno_crypto],
    esm_entry_point = "ext:skeptic_web_globals/bootstrap.js",
    esm = ["ext:skeptic_web_globals/bootstrap.js" = {
        source = r#"
const { URL, URLSearchParams } = Deno.core.loadExtScript("ext:deno_web/00_url.js");
const { DOMException } = Deno.core.loadExtScript("ext:deno_web/01_dom_exception.js");
const { TextDecoder, TextEncoder } = Deno.core.loadExtScript("ext:deno_web/08_text_encoding.js");
const { crypto, Crypto, CryptoKey, SubtleCrypto } = Deno.core.loadExtScript("ext:deno_crypto/00_crypto.js");

Object.defineProperties(globalThis, {
  URL: { value: URL, writable: true, configurable: true },
  URLSearchParams: { value: URLSearchParams, writable: true, configurable: true },
  DOMException: { value: DOMException, writable: true, configurable: true },
  TextDecoder: { value: TextDecoder, writable: true, configurable: true },
  TextEncoder: { value: TextEncoder, writable: true, configurable: true },
  crypto: { value: crypto, configurable: true },
  Crypto: { value: Crypto, writable: true, configurable: true },
  CryptoKey: { value: CryptoKey, writable: true, configurable: true },
  SubtleCrypto: { value: SubtleCrypto, writable: true, configurable: true },
});
"#
    }],
);

struct TypeScriptLoader {
    root: PathBuf,
}

impl ModuleLoader for TypeScriptLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> ModuleResolveResponse {
        if specifier == "skeptic-cli" {
            return ModuleSpecifier::parse("skeptic:api").map_err(JsErrorBox::from_err);
        }
        let resolved = resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)?;
        if resolved.scheme() != "file" {
            return Err(JsErrorBox::generic(
                "only local relative imports and `skeptic-cli` are allowed",
            ));
        }
        let path = resolved
            .to_file_path()
            .map_err(|_| JsErrorBox::generic("invalid local module URL"))?;
        let canonical = path
            .canonicalize()
            .map_err(|error| JsErrorBox::generic(error.to_string()))?;
        if !canonical.starts_with(&self.root) {
            return Err(JsErrorBox::generic(
                "module import escapes the project root",
            ));
        }
        Ok(resolved)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        _referrer: Option<&deno_core::ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        if specifier.as_str() == "skeptic:api" {
            let source = r#"
                export const test = globalThis.test;
                export const expect = globalThis.expect;
                export const beforeAll = globalThis.beforeAll;
                export const beforeEach = globalThis.beforeEach;
                export const afterAll = globalThis.afterAll;
                export const afterEach = globalThis.afterEach;
                export const page = globalThis.page;
                export const device = globalThis.device;
                export const skeptic = globalThis.skeptic;
            "#;
            return ModuleLoadResponse::Sync(Ok(ModuleSource::new(
                ModuleType::JavaScript,
                ModuleSourceCode::String(source.to_string().into()),
                specifier,
                None,
            )));
        }
        let path = match specifier.to_file_path() {
            Ok(path) => path,
            Err(_) => {
                return ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                    "invalid local module path",
                )))
            }
        };
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            if options.requested_module_type != deno_core::RequestedModuleType::Json {
                return ModuleLoadResponse::Sync(Err(JsErrorBox::generic(
                    "JSON imports require `with { type: \"json\" }`",
                )));
            }
            return ModuleLoadResponse::Sync(
                std::fs::read(&path)
                    .map(|bytes| {
                        ModuleSource::new(
                            ModuleType::Json,
                            ModuleSourceCode::Bytes(bytes.into_boxed_slice().into()),
                            specifier,
                            None,
                        )
                    })
                    .map_err(JsErrorBox::from_err),
            );
        }
        let result = std::fs::read_to_string(&path)
            .map_err(JsErrorBox::from_err)
            .and_then(|source| transpile(&path, &source).map_err(JsErrorBox::generic))
            .map(|code| {
                ModuleSource::new(
                    ModuleType::JavaScript,
                    ModuleSourceCode::String(code.into()),
                    specifier,
                    None,
                )
            });
        ModuleLoadResponse::Sync(result)
    }
}

pub fn transpile(path: &Path, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|error| error.to_string())?;
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.errors.is_empty() {
        return Err(parsed
            .errors
            .into_iter()
            .map(|error| format!("{error:?}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .build(&program);
    if !semantic.errors.is_empty() {
        return Err(semantic
            .errors
            .into_iter()
            .map(|error| format!("{error:?}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let transformed = Transformer::new(&allocator, path, &TransformOptions::default())
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    if !transformed.errors.is_empty() {
        return Err(transformed
            .errors
            .into_iter()
            .map(|error| format!("{error:?}"))
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .build(&program);
    let mut code = generated.code;
    if let Some(map) = generated.map {
        code.push_str("\n//# sourceMappingURL=");
        code.push_str(&map.to_data_url());
        code.push('\n');
    }
    Ok(code)
}

pub struct ExecuteOptions<'a> {
    pub file: &'a Path,
    pub project_root: &'a Path,
    pub skeptic_bin: &'a Path,
    pub session: &'a str,
    pub test_timeout_ms: u64,
    pub hard_timeout_ms: u64,
    pub assertion_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub allowed_domains: Vec<String>,
    pub env: BTreeMap<String, String>,
}

pub async fn execute_file(options: ExecuteOptions<'_>) -> Result<WorkerResult, String> {
    let ExecuteOptions {
        file,
        project_root,
        skeptic_bin,
        session,
        test_timeout_ms,
        hard_timeout_ms,
        assertion_timeout_ms,
        poll_interval_ms,
        allowed_domains,
        env,
    } = options;
    let result = Arc::new(Mutex::new(None));
    let console = Arc::new(Mutex::new(Vec::new()));
    let timers = Arc::new(Mutex::new(BTreeMap::new()));
    let initialized_collectors = Arc::new(Mutex::new(BTreeSet::new()));
    let state = RunnerState {
        skeptic_bin: skeptic_bin.to_path_buf(),
        default_session: session.to_string(),
        allowed_domains,
        env,
        result: Arc::clone(&result),
        console: Arc::clone(&console),
        timers,
        initialized_collectors,
    };
    let loader = TypeScriptLoader {
        root: project_root
            .canonicalize()
            .map_err(|error| error.to_string())?,
    };
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(loader)),
        extensions: vec![
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                Arc::new(deno_web::BlobStore::default()) as Arc<dyn deno_web::BlobStoreTrait>,
                None,
                Default::default(),
                Default::default(),
            ),
            deno_crypto::deno_crypto::init(None),
            skeptic_web_globals::init(),
            skeptic_runtime::init(state),
        ],
        ..Default::default()
    });
    runtime
        .execute_script("skeptic:bootstrap", BOOTSTRAP)
        .map_err(|error| error.to_string())?;
    runtime
        .execute_script(
            "skeptic:configuration",
            format!(
                "globalThis.__skepticTestTimeout = {test_timeout_ms}; \
                 globalThis.__skepticAssertionTimeout = {assertion_timeout_ms}; \
                 globalThis.__skepticPollInterval = {poll_interval_ms};"
            ),
        )
        .map_err(|error| error.to_string())?;

    let completed = Arc::new(AtomicBool::new(false));
    let terminate = runtime.v8_isolate().thread_safe_handle();
    let watchdog_done = Arc::clone(&completed);
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_millis(hard_timeout_ms);
        while !watchdog_done.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !watchdog_done.load(Ordering::Acquire) {
            let _ = terminate.terminate_execution();
        }
    });

    let specifier =
        ModuleSpecifier::from_file_path(file.canonicalize().map_err(|error| error.to_string())?)
            .map_err(|_| "invalid spec path".to_string())?;
    let module_id = runtime
        .load_main_es_module(&specifier)
        .await
        .map_err(|error| error.to_string())?;
    let evaluation = runtime.mod_evaluate(module_id);
    runtime
        .run_event_loop(Default::default())
        .await
        .map_err(|error| error.to_string())?;
    evaluation.await.map_err(|error| error.to_string())?;
    runtime
        .execute_script("skeptic:execute", "globalThis.__skepticRun()")
        .map_err(|error| error.to_string())?;
    runtime
        .run_event_loop(Default::default())
        .await
        .map_err(|error| error.to_string())?;
    completed.store(true, Ordering::Release);

    let tests = result
        .lock()
        .map_err(|_| "result lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "spec runtime did not return test results".to_string())?;
    let captured = console
        .lock()
        .map_err(|_| "console lock poisoned".to_string())?
        .clone();
    Ok(WorkerResult {
        tests,
        console: captured,
        sidecars: Vec::new(),
    })
}

const BOOTSTRAP: &str = r#"
(() => {
  const tests = [], hooks = { beforeAll: [], beforeEach: [], afterAll: [], afterEach: [] };
  let useOptions = {};
  const core = Deno.core.ops;
  const now = () => Date.now();
  let nextTimerId = 1;
  const serialize = value => { try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } };
  const log = level => (...args) => core.op_console({ level, args: args.map(serialize), timestamp: new Date().toISOString() });
  globalThis.console = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    const timerId = nextTimerId++;
    core.op_timeout(BigInt(timerId), BigInt(Math.max(0, Number(ms) || 0)))
      .then(fired => { if (fired) callback(...args); });
    return timerId;
  };
  globalThis.clearTimeout = timerId => core.op_cancel_timeout(BigInt(timerId));
  globalThis.fetch = async url => {
    const value = core.op_fetch(String(url));
    return { ok: value.status >= 200 && value.status < 300, status: value.status, headers: value.headers,
      text: async () => value.body, json: async () => JSON.parse(value.body) };
  };
  let activeUse = {};
  const routedArgs = args => {
    const routed = args.map(String);
    const platform = activeUse.platform ?? 'web';
    if (platform !== 'web') routed.push('--platform', String(platform));
    if (activeUse.device != null) routed.push('--device', String(activeUse.device));
    return routed;
  };
  const invoke = args => core.op_page({ session: activeUse.session ?? null, args: routedArgs(args) });
  class Locator {
    constructor(kind, value, options = {}) { this.__skepticLocator = true; this.kind = kind; this.value = value; this.options = options; }
    args(action, extra = []) {
      if (this.kind === 'css') return [action, this.value, ...extra];
      const name = this.options.name == null ? [] : ['--name', String(this.options.name)];
      return ['find', this.kind, this.value, action, ...extra, ...name];
    }
    click() { return invoke(this.args('click')); }
    fill(value) { return invoke(this.args('fill', [value])); }
    type(value) { return invoke(this.args('type', [value])); }
    press(value) { return invoke(this.args('press', [value])); }
    check() { return invoke(this.args('check')); }
    uncheck() { return invoke(this.args('uncheck')); }
  }
  const page = {
    open: url => invoke(['open', url]), goto: url => invoke(['open', url]), snapshot: options => invoke(['snapshot', ...(options?.interactive ? ['-i'] : [])]),
    screenshot: path => invoke(['screenshot', path]), click: target => locator(target).click(), fill: (target, value) => locator(target).fill(value),
    type: (target, value) => locator(target).type(value), press: (target, value) => locator(target).press(value),
    locator: value => new Locator('css', value), getByRole: (value, options) => new Locator('role', value, options),
    getByText: (value, options) => new Locator('text', value, options), getByLabel: value => new Locator('label', value),
    getByPlaceholder: value => new Locator('placeholder', value), getByTestId: value => new Locator('testid', value),
  };
  const device = {
    ...page,
    swipe: (x1, y1, x2, y2, options = {}) => invoke(['swipe', x1, y1, x2, y2, ...(options.duration == null ? [] : ['--duration', options.duration])]),
    scroll: direction => invoke(['scroll', direction ?? 'down']),
    screenrecord: (path, options = {}) => invoke(['screenrecord', path, ...(options.duration == null ? [] : ['--duration', options.duration])]),
  };
  const locator = value => value?.__skepticLocator ? value : new Locator('css', String(value));
  function register(mode, title, fn) { tests.push({ mode, title, fn, use: { ...useOptions } }); }
  function test(title, fn) { register('run', title, fn); }
  test.skip = (title, fn = () => {}) => register('skip', title, fn);
  test.only = (title, fn) => register('only', title, fn);
  test.use = options => { useOptions = { ...useOptions, ...options }; };
  globalThis.test = test;
  for (const name of Object.keys(hooks)) globalThis[name] = fn => hooks[name].push(fn);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function makeFailure(matcher, expected, actual, negated = false, timedOut = false, ref = null) {
    const error = new Error(`${matcher} failed: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    error.skeptic = { matcher, expected: serialize(expected), actual: serialize(actual), negated, timedOut, reference: ref, evidence: [] };
    return error;
  }
  function valueMatchers(received, negated = false) {
    const check = (matcher, expected, pass, actual = received) => { if (negated ? pass : !pass) throw makeFailure(matcher, expected, actual, negated); };
    return {
      get not() { return valueMatchers(received, !negated); },
      toBe: expected => check('toBe', expected, Object.is(received, expected)),
      toEqual: expected => check('toEqual', expected, equal(received, expected)),
      toBeTruthy: () => check('toBeTruthy', true, !!received), toBeFalsy: () => check('toBeFalsy', false, !received),
      toContain: expected => check('toContain', expected, received?.includes?.(expected) === true),
      toMatch: expected => check('toMatch', String(expected), new RegExp(expected).test(String(received))),
      toBeGreaterThan: expected => check('toBeGreaterThan', expected, received > expected),
      toBeLessThan: expected => check('toBeLessThan', expected, received < expected),
      toThrow: expected => { let thrown; try { received(); } catch (error) { thrown = error; } const pass = !!thrown && (expected == null || new RegExp(expected).test(String(thrown))); check('toThrow', expected, pass, thrown ? String(thrown) : null); },
      ...uiMatchers(received, negated),
    };
  }
  function scalar(data, keys) { for (const key of keys) if (data && Object.hasOwn(data, key)) return data[key]; return data; }
  function uiMatchers(received, negated) {
    if (!received?.__skepticLocator) return {};
    const poll = (matcher, expected, query, compare, options = {}) => {
      const timeout = options.timeout ?? globalThis.__skepticAssertionTimeout ?? 5000;
      const interval = globalThis.__skepticPollInterval ?? 100;
      const started = now(); let actual, error;
      do { try { actual = query(); error = null; if (negated ? !compare(actual) : compare(actual)) return; } catch (caught) { error = caught; }
        core.op_sleep(BigInt(interval)); } while (now() - started < timeout);
      throw makeFailure(matcher, expected, error ? String(error) : actual, negated, true, received.value);
    };
    return {
      toBeVisible: (options) => poll('toBeVisible', true, () => scalar(invoke(received.args('is', ['visible'])), ['visible','value']), Boolean, options),
      toBeEnabled: (options) => poll('toBeEnabled', true, () => scalar(invoke(received.args('is', ['enabled'])), ['enabled','value']), Boolean, options),
      toBeChecked: (options) => poll('toBeChecked', true, () => scalar(invoke(received.args('is', ['checked'])), ['checked','value']), Boolean, options),
      toHaveText: (expected, options) => poll('toHaveText', expected, () => scalar(invoke(received.args('get', ['text'])), ['text','value']), value => String(value).includes(String(expected)), options),
      toHaveValue: (expected, options) => poll('toHaveValue', expected, () => scalar(invoke(received.args('get', ['value'])), ['value']), value => equal(value, expected), options),
      toHaveAttribute: (name, expected, options) => poll('toHaveAttribute', expected, () => scalar(invoke(received.args('get', ['attribute', name])), ['value','attribute']), value => equal(value, expected), options),
      toHaveCount: (expected, options) => poll('toHaveCount', expected, () => scalar(invoke(received.args('get', ['count'])), ['count','value']), value => Number(value) === expected, options),
      toMatchScreenshot: (name, options) => poll('toMatchScreenshot', name, () => invoke(['visual', 'check', name, '--selector', received.value]), value => value?.status === 'match', options),
    };
  }
  globalThis.expect = received => valueMatchers(received);
  globalThis.page = page;
  globalThis.device = device;
  globalThis.skeptic = { env: name => core.op_env(String(name)), page, device };
  globalThis.__skepticRun = async () => {
    const results = [], only = tests.some(test => test.mode === 'only');
    try { for (const hook of hooks.beforeAll) await hook({ page, skeptic: globalThis.skeptic }); } catch (error) { console.error(error); }
    for (const item of tests) {
      const target = { platform: item.use.platform ?? 'web', device: item.use.device ?? null, app: item.use.app ?? null };
      const session = item.use.session ?? null;
      if (item.mode === 'skip' || (only && item.mode !== 'only')) { results.push({ title: item.title, status: 'skipped', durationMs: 0, error: null, assertion: null, session, target }); continue; }
      const started = now(); let status = 'passed', error = null, assertion = null;
      try {
        activeUse = item.use;
        for (const hook of hooks.beforeEach) await hook({ page, device, session: item.use.session, evidence: {}, skeptic: globalThis.skeptic });
        const timeout = item.use.timeout ?? globalThis.__skepticTestTimeout ?? 30000;
        const timerId = nextTimerId++;
        try {
          await Promise.race([
            Promise.resolve(item.fn({ page, device, session: item.use.session, evidence: {}, skeptic: globalThis.skeptic })),
            core.op_timeout(BigInt(timerId), BigInt(timeout)).then(fired => {
              if (!fired) return new Promise(() => {});
              const failure = new Error(`test timeout after ${timeout}ms`); failure.skepticTestTimeout = true; throw failure;
            }),
          ]);
        } finally { core.op_cancel_timeout(BigInt(timerId)); }
      }
      catch (caught) { status = caught?.skepticTestTimeout ? 'timed-out' : 'failed'; error = caught?.stack || String(caught); assertion = caught?.skeptic || null; }
      finally { try { for (const hook of hooks.afterEach) await hook({ page, device, session: item.use.session, evidence: {}, skeptic: globalThis.skeptic }); } catch (caught) { if (status === 'passed') { status = 'errored'; error = caught?.stack || String(caught); } } activeUse = {}; }
      results.push({ title: item.title, status, durationMs: now() - started, error, assertion, session, target });
    }
    try { for (const hook of hooks.afterAll) await hook({ page, skeptic: globalThis.skeptic }); } catch (error) { console.error(error); }
    core.op_finish(results); return results;
  };
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_typescript_annotations_with_oxc() {
        let code = transpile(
            Path::new("example.spec.ts"),
            "const answer: number = 42; export { answer };",
        )
        .unwrap();
        assert!(code.contains("answer = 42"));
        assert!(!code.contains(": number"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executes_registered_tests_in_an_isolate() {
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let file = crate_root.join("tests/fixtures/basic.spec.ts");
        let result = execute_file(ExecuteOptions {
            file: &file,
            project_root: crate_root.parent().unwrap().parent().unwrap(),
            skeptic_bin: Path::new("/unused/skeptic"),
            session: "runner-test",
            test_timeout_ms: 1_000,
            hard_timeout_ms: 5_000,
            assertion_timeout_ms: 500,
            poll_interval_ms: 10,
            allowed_domains: Vec::new(),
            env: BTreeMap::new(),
        })
        .await
        .unwrap();
        assert_eq!(result.tests.len(), 2);
        assert_eq!(result.tests[0].status, "passed");
        assert_eq!(result.tests[1].status, "skipped");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn provides_standard_web_globals() {
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = execute_file(ExecuteOptions {
            file: &crate_root.join("tests/fixtures/web-globals.spec.ts"),
            project_root: crate_root.parent().unwrap().parent().unwrap(),
            skeptic_bin: Path::new("/unused/skeptic"),
            session: "runner-test",
            test_timeout_ms: 1_000,
            hard_timeout_ms: 5_000,
            assertion_timeout_ms: 500,
            poll_interval_ms: 10,
            allowed_domains: Vec::new(),
            env: BTreeMap::new(),
        })
        .await
        .unwrap();

        assert_eq!(result.tests.len(), 1);
        assert_eq!(
            result.tests[0].status, "passed",
            "{:?}",
            result.tests[0].error
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn exposes_real_cancellable_timers() {
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let file = crate_root.join("tests/fixtures/timers.spec.ts");
        let result = execute_file(ExecuteOptions {
            file: &file,
            project_root: crate_root.parent().unwrap().parent().unwrap(),
            skeptic_bin: Path::new("/unused/skeptic"),
            session: "runner-test",
            test_timeout_ms: 1_000,
            hard_timeout_ms: 5_000,
            assertion_timeout_ms: 500,
            poll_interval_ms: 10,
            allowed_domains: Vec::new(),
            env: BTreeMap::new(),
        })
        .await
        .unwrap();
        assert_eq!(result.tests[0].status, "passed");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn named_session_and_mobile_target_reach_page_operations() {
        use std::os::unix::fs::PermissionsExt;

        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let directory = tempfile::tempdir().unwrap();
        let capture = directory.path().join("arguments.txt");
        let fake = directory.path().join("skeptic");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{{\"ok\":true,\"data\":{{}},\"warnings\":[],\"meta\":{{\"schema\":\"skeptic.envelope/1\",\"version\":\"2.0.0\",\"durationMs\":0,\"sideEffects\":\"none\",\"truncated\":false}}}}'\n",
                capture.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&fake, permissions).unwrap();

        let result = execute_file(ExecuteOptions {
            file: &crate_root.join("tests/fixtures/named-session.spec.ts"),
            project_root: crate_root.parent().unwrap().parent().unwrap(),
            skeptic_bin: &fake,
            session: "generated-session",
            test_timeout_ms: 1_000,
            hard_timeout_ms: 5_000,
            assertion_timeout_ms: 500,
            poll_interval_ms: 10,
            allowed_domains: Vec::new(),
            env: BTreeMap::new(),
        })
        .await
        .unwrap();

        assert_eq!(result.tests[0].status, "passed");
        assert_eq!(result.tests[0].target.platform, "android");
        assert_eq!(
            result.tests[0].target.device.as_deref(),
            Some("emulator-5554")
        );
        let arguments = std::fs::read_to_string(capture).unwrap();
        assert!(arguments.contains("shared-session"));
        assert!(!arguments.contains("generated-session"));
        assert!(arguments.contains("--platform"));
        assert!(arguments.contains("android"));
    }
}
