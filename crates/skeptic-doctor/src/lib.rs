//! Deterministic, scope-aware source diagnostics for Skeptic.
//!
//! The release pack is deliberately small: every scored rule below operates on
//! Oxc AST nodes (and scope information where identity matters). Advisory or
//! user-authored pattern rules remain visible, but never score or fail CI.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use oxc_allocator::Allocator;
use oxc_ast::{
    ast::{
        BindingPatternKind, Expression, ImportDeclarationSpecifier, ImportOrExportKind,
        JSXAttribute, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXExpression,
    },
    AstKind,
};
use oxc_parser::Parser;
use oxc_semantic::{Semantic, SemanticBuilder};
use oxc_span::SourceType;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use skeptic_contract::{
    BaselineState, Capability, CapabilityAvailability, CapabilityExecution, CapabilityRecord,
    Category, CheckDef, CheckEngine, Completeness, Diagnostic, EvidenceState, FindingState,
    Producer, Severity, Span, Suppression, SuppressionKind, Surface, TextPosition,
};

include!(concat!(env!("OUT_DIR"), "/rule_registry.rs"));

const WEB: &[Capability] = &[Capability::Web, Capability::React];
const RN: &[Capability] = &[
    Capability::ReactNative,
    Capability::Android,
    Capability::Ios,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleKind {
    NoEval,
    DangerousHtml,
    AuthTokenStorage,
    IframeSandbox,
    ImageAlt,
    FullLodash,
    Moment,
    ArrayIndexKey,
    InlineListCallback,
    DimensionsGet,
    PreferPressable,
}

#[derive(Debug, Clone, Copy)]
pub struct Rule {
    id: &'static str,
    title: &'static str,
    severity: Severity,
    category: Category,
    capabilities: &'static [Capability],
    surfaces: &'static [Surface],
    why: &'static str,
    message: &'static str,
    help: &'static str,
    confidence: f64,
    kind: RuleKind,
}

/// Metadata contract shared by the generated registry, scanner, CLI, and
/// version-locked fix recipes.
pub trait Check: Send + Sync {
    fn definition(&self) -> CheckDef;
    fn why(&self) -> &'static str;
    fn message(&self) -> &'static str;
    fn help(&self) -> &'static str;
    fn confidence(&self) -> f64;
}

impl Check for Rule {
    fn definition(&self) -> CheckDef {
        CheckDef {
            id: self.id.into(),
            title: self.title.into(),
            severity: self.severity,
            category: self.category,
            capability: self.capabilities.to_vec(),
            engine: CheckEngine::Oxc,
            surfaces: self.surfaces.to_vec(),
            correlator_id: None,
            fix_recipe: Some(self.id.replace('/', "-")),
        }
    }

    fn why(&self) -> &'static str {
        self.why
    }

    fn message(&self) -> &'static str {
        self.message
    }

    fn help(&self) -> &'static str {
        self.help
    }

    fn confidence(&self) -> f64 {
        self.confidence
    }
}

const GATED: &[Surface] = &[Surface::Cli, Surface::Score, Surface::CiFailure];
const ADVISORY: &[Surface] = &[Surface::Cli, Surface::PrComment];

fn rules() -> Vec<Rule> {
    vec![
        Rule { id: "security/no-eval", title: "Avoid dynamic code evaluation", severity: Severity::P0, category: Category::Security, capabilities: WEB, surfaces: GATED, why: "Global eval and Function compile strings as code and create a code-injection boundary.", message: "Dynamic code evaluation uses the global eval/Function implementation.", help: "Replace dynamic evaluation with explicit parsing or a fixed dispatch table.", confidence: 0.99, kind: RuleKind::NoEval },
        Rule { id: "security/no-dangerous-html", title: "Review unsanitized HTML injection", severity: Severity::P1, category: Category::Security, capabilities: WEB, surfaces: ADVISORY, why: "Raw HTML bypasses React escaping. Static analysis cannot prove arbitrary sanitizer contracts, so this check is advisory.", message: "Raw HTML is injected without a recognizable sanitizer boundary.", help: "Render structured content or pass the value through an audited allowlist sanitizer.", confidence: 0.84, kind: RuleKind::DangerousHtml },
        Rule { id: "security/auth-token-in-web-storage", title: "Do not persist credentials in Web Storage", severity: Severity::P1, category: Category::Security, capabilities: WEB, surfaces: GATED, why: "Any successful XSS can read Web Storage; HttpOnly cookies are not visible to script.", message: "A credential-like token is read from or written to Web Storage.", help: "Prefer Secure, HttpOnly, SameSite cookies and short-lived server sessions.", confidence: 0.96, kind: RuleKind::AuthTokenStorage },
        Rule { id: "a11y/iframe-missing-sandbox", title: "Sandbox embedded frames", severity: Severity::P1, category: Category::Security, capabilities: WEB, surfaces: GATED, why: "Unsandboxed third-party frames retain more capabilities than most embeds need.", message: "An iframe is missing a safe sandbox policy.", help: "Add the smallest sandbox token set required; avoid combining allow-scripts with allow-same-origin for untrusted content.", confidence: 0.95, kind: RuleKind::IframeSandbox },
        Rule { id: "a11y/image-missing-alt", title: "Describe meaningful images", severity: Severity::P1, category: Category::A11y, capabilities: WEB, surfaces: GATED, why: "Images without an accessible alternative cannot be understood by screen-reader users.", message: "An img element has no usable alt attribute.", help: "Add descriptive alt text, or alt=\"\" for a decorative image.", confidence: 0.97, kind: RuleKind::ImageAlt },
        Rule { id: "performance/no-full-lodash-import", title: "Avoid full lodash imports", severity: Severity::P2, category: Category::Performance, capabilities: WEB, surfaces: GATED, why: "The full client entry point can retain much more code than a direct per-function import.", message: "The full lodash entry point is imported into client code.", help: "Use a native method or a direct per-function import.", confidence: 0.95, kind: RuleKind::FullLodash },
        Rule { id: "performance/no-moment", title: "Avoid Moment.js in client bundles", severity: Severity::P2, category: Category::Performance, capabilities: WEB, surfaces: GATED, why: "Moment.js and locale data are costly in modern client bundles.", message: "Moment.js is imported into client code.", help: "Use Intl, Temporal, date-fns, or dayjs based on requirements.", confidence: 0.95, kind: RuleKind::Moment },
        Rule { id: "correctness/no-array-index-key", title: "Use stable list keys", severity: Severity::P1, category: Category::Correctness, capabilities: WEB, surfaces: GATED, why: "An iterator index binds React component state to position rather than item identity.", message: "A JSX key uses the current iterator's index parameter.", help: "Use a stable identifier from the item data.", confidence: 0.97, kind: RuleKind::ArrayIndexKey },
        Rule { id: "performance/no-inline-list-callback", title: "Stabilize virtualized-list callbacks", severity: Severity::P2, category: Category::Performance, capabilities: RN, surfaces: GATED, why: "New renderItem functions can make list memoization and recycling less effective.", message: "A React Native virtualized list defines renderItem inline.", help: "Hoist renderItem or memoize it with stable dependencies.", confidence: 0.95, kind: RuleKind::InlineListCallback },
        Rule { id: "react-native/no-dimensions-get", title: "Use responsive window dimensions", severity: Severity::P2, category: Category::Correctness, capabilities: RN, surfaces: GATED, why: "Dimensions.get is a snapshot and does not subscribe a component to size changes.", message: "A React Native Dimensions binding is read inside component code.", help: "Use useWindowDimensions() inside the component.", confidence: 0.97, kind: RuleKind::DimensionsGet },
        Rule { id: "react-native/prefer-pressable", title: "Prefer Pressable", severity: Severity::P3, category: Category::Maintainability, capabilities: RN, surfaces: ADVISORY, why: "Pressable exposes modern interaction state through one consistent primitive.", message: "A legacy React Native Touchable binding is rendered.", help: "Migrate to Pressable while preserving accessibilityRole and accessibilityLabel.", confidence: 0.95, kind: RuleKind::PreferPressable },
    ]
}

pub fn definitions() -> Vec<CheckDef> {
    rules().iter().map(Check::definition).collect()
}

pub fn definition(rule_id: &str) -> Option<CheckDef> {
    rules()
        .into_iter()
        .find(|rule| rule.id == rule_id)
        .map(|rule| rule.definition())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomPack {
    rules: Vec<CustomRule>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomRule {
    id: String,
    pattern: String,
    message: String,
    help: Option<String>,
    severity: Severity,
    category: Category,
    #[serde(default = "default_confidence")]
    confidence: f64,
}

const fn default_confidence() -> f64 {
    0.8
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DoctorReport {
    pub schema: String,
    pub generated_at: String,
    pub root: String,
    pub files_scanned: usize,
    pub diagnostics: Vec<Diagnostic>,
    /// Doctor intentionally does not invent a second score. `skeptic report`
    /// and `skeptic score` own the frozen coverage-aware formula.
    pub score: Option<u8>,
    pub by_severity: BTreeMap<Severity, u64>,
    pub by_category: BTreeMap<Category, u64>,
    pub covered_categories: Vec<Category>,
    pub scored_rule_ids: Vec<String>,
    pub capabilities: Vec<CapabilityRecord>,
    pub completeness: Completeness,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BaselineEntry {
    pub fingerprint: String,
    pub occurrence_id: String,
    pub file: Option<String>,
    pub context_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Baseline {
    #[serde(default = "baseline_schema")]
    pub schema: String,
    #[serde(default)]
    pub occurrences: Vec<BaselineEntry>,
    #[serde(default)]
    pub legacy_fingerprints: BTreeSet<String>,
}

fn baseline_schema() -> String {
    "skeptic.doctor-baseline/2".into()
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    pub files: Option<BTreeSet<String>>,
    pub baseline: Baseline,
    /// Retained for CLI compatibility. Findings below this value remain in
    /// output; score/blocking consumers use it as their surface threshold.
    pub confidence_threshold: f64,
    pub custom_pack: Option<PathBuf>,
}

#[derive(Debug)]
struct Candidate {
    diagnostic: Diagnostic,
    context_hash: String,
}

#[derive(Debug, Default)]
struct ImportBindings {
    react_native: BTreeMap<String, String>,
    react_native_namespaces: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct ProjectCapabilities {
    react_native: bool,
}

fn hash(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value))
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn position(source: &str, byte: usize) -> TextPosition {
    let prefix = &source[..byte.min(source.len())];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
    let column = prefix
        .rsplit_once('\n')
        .map_or(prefix, |(_, tail)| tail)
        .chars()
        .count() as u32
        + 1;
    TextPosition {
        line,
        column,
        byte_offset: Some(byte as u32),
    }
}

fn surrounding_context(source: &str, line: u32) -> String {
    let lines: Vec<_> = source.lines().collect();
    let index = line.saturating_sub(1) as usize;
    let start = index.saturating_sub(2);
    let end = (index + 3).min(lines.len());
    normalize(&lines[start..end].join("\n"))
}

fn inline_suppression(source: &str, line: u32, rule_id: &str) -> Option<String> {
    let lines: Vec<_> = source.lines().collect();
    let index = line.saturating_sub(1) as usize;
    [index.saturating_sub(1), index]
        .into_iter()
        .find_map(|candidate| {
            let text = *lines.get(candidate)?;
            let marker = "skeptic-ignore";
            let marker_index = text.find(marker)?;
            let directive = &text[marker_index + marker.len()..];
            let (rules, reason) = directive.split_once("--")?;
            let matches = rules
                .split(|character: char| character == ',' || character.is_whitespace())
                .any(|value| value == rule_id || value == "*");
            let reason = reason.trim();
            (matches && !reason.is_empty()).then(|| reason.to_string())
        })
}

fn candidate(rule: &Rule, relative: &str, source: &str, start: usize, end: usize) -> Candidate {
    let start_position = position(source, start);
    let end_position = position(source, end);
    let subject = normalize(&source[start.min(source.len())..end.min(source.len())]);
    let fingerprint = hash(format!("{}\0{}\0{}", rule.id, subject, rule.message));
    let context_hash = hash(surrounding_context(source, start_position.line));
    let suppression = inline_suppression(source, start_position.line, rule.id);
    Candidate {
        diagnostic: Diagnostic {
            fingerprint,
            occurrence_id: String::new(),
            producer: Producer {
                tool: "skeptic-doctor".into(),
                tool_version: env!("CARGO_PKG_VERSION").into(),
                rule_id: rule.id.into(),
                rule_version: Some("2".into()),
                config_hash: None,
            },
            severity: rule.severity,
            category: rule.category,
            confidence: rule.confidence,
            file: Some(relative.into()),
            span: Some(Span {
                start: start_position,
                end: end_position,
            }),
            route: None,
            subject: (!subject.is_empty()).then_some(subject),
            message: rule.message.into(),
            help: Some(rule.help.into()),
            related_locations: Vec::new(),
            state: if suppression.is_some() {
                FindingState::Suppressed
            } else {
                FindingState::Open
            },
            evidence_state: EvidenceState::Unobserved,
            baseline_state: BaselineState::New,
            suppression: suppression.map(|justification| Suppression {
                kind: SuppressionKind::Inline,
                justification: Some(justification),
            }),
            fix_group_id: Some(rule.id.replace('/', "-")),
            links: Vec::new(),
        },
        context_hash,
    }
}

fn source_files(root: &Path, selected: Option<&BTreeSet<String>>) -> Vec<PathBuf> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git" | ".skeptic" | "node_modules" | "target" | "dist" | "build")
            )
        });
    let mut paths: Vec<_> = builder
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
        .map(|entry| entry.into_path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx")
            ) && !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.ends_with(".min.js") || name.ends_with(".generated.ts"))
        })
        .filter(|path| {
            selected.is_none_or(|selected| {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .replace('\\', "/");
                selected.contains(&relative)
            })
        })
        .collect();
    paths.sort();
    paths
}

fn non_production_path(relative: &str) -> bool {
    let path = relative.to_ascii_lowercase();
    [
        ".test.",
        ".spec.",
        ".stories.",
        "/__tests__/",
        "/fixtures/",
        "/examples/",
        "/generated/",
    ]
    .iter()
    .any(|part| path.contains(part))
}

fn detect_project_capabilities(root: &Path, files: &[(String, String)]) -> ProjectCapabilities {
    let mut capabilities = ProjectCapabilities {
        react_native: files.iter().any(|(_, source)| {
            source.contains("from 'react-native'") || source.contains("from \"react-native\"")
        }),
    };
    for entry in WalkBuilder::new(root)
        .max_depth(Some(5))
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name() == "package.json")
    {
        let Ok(value) = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or(())
        else {
            continue;
        };
        for section in ["dependencies", "devDependencies", "peerDependencies"] {
            let Some(dependencies) = value.get(section).and_then(Value::as_object) else {
                continue;
            };
            capabilities.react_native |= dependencies.contains_key("react-native");
        }
    }
    capabilities
}

fn rule_applies(rule: &Rule, capabilities: ProjectCapabilities) -> bool {
    if rule.capabilities.contains(&Capability::ReactNative) {
        capabilities.react_native
    } else {
        true
    }
}

fn attr_name<'a>(attribute: &'a JSXAttribute<'a>) -> Option<&'a str> {
    match &attribute.name {
        JSXAttributeName::Identifier(identifier) => Some(identifier.name.as_str()),
        JSXAttributeName::NamespacedName(_) => None,
    }
}

fn attribute<'a>(
    opening: &'a oxc_ast::ast::JSXOpeningElement<'a>,
    name: &str,
) -> Option<&'a JSXAttribute<'a>> {
    opening.attributes.iter().find_map(|item| match item {
        JSXAttributeItem::Attribute(attribute) if attr_name(attribute) == Some(name) => {
            Some(attribute.as_ref())
        }
        _ => None,
    })
}

fn has_spread(opening: &oxc_ast::ast::JSXOpeningElement<'_>) -> bool {
    opening
        .attributes
        .iter()
        .any(|item| matches!(item, JSXAttributeItem::SpreadAttribute(_)))
}

fn element_name<'a>(opening: &'a oxc_ast::ast::JSXOpeningElement<'a>) -> Option<&'a str> {
    opening.name.get_identifier_name().map(|name| name.as_str())
}

fn expression_identifier<'a>(expression: &'a Expression<'a>) -> Option<&'a str> {
    match expression.without_parentheses() {
        Expression::Identifier(identifier) => Some(identifier.name.as_str()),
        _ => None,
    }
}

fn jsx_expression_identifier<'a>(expression: &'a JSXExpression<'a>) -> Option<&'a str> {
    match expression {
        JSXExpression::Identifier(identifier) => Some(identifier.name.as_str()),
        _ => None,
    }
}

fn import_bindings(semantic: &Semantic<'_>) -> ImportBindings {
    let mut bindings = ImportBindings::default();
    for node in semantic.nodes().iter() {
        let AstKind::ImportDeclaration(import) = node.kind() else {
            continue;
        };
        if import.source.value.as_str() != "react-native"
            || import.import_kind == ImportOrExportKind::Type
        {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.import_kind == ImportOrExportKind::Value =>
                {
                    bindings.react_native.insert(
                        specifier.local.name.to_string(),
                        specifier.imported.name().to_string(),
                    );
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    bindings
                        .react_native_namespaces
                        .insert(specifier.local.name.to_string());
                }
                _ => {}
            }
        }
    }
    bindings
}

fn string_argument<'a>(
    call: &'a oxc_ast::ast::CallExpression<'a>,
    index: usize,
) -> Option<&'a str> {
    match call
        .arguments
        .get(index)?
        .as_expression()?
        .without_parentheses()
    {
        Expression::StringLiteral(literal) => Some(literal.value.as_str()),
        _ => None,
    }
}

fn sensitive_storage_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_', '.', ':'], "");
    matches!(
        normalized.as_str(),
        "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "jwt"
            | "sessionsecret"
            | "clientsecret"
    )
}

fn client_source(relative: &str) -> bool {
    let path = relative.to_ascii_lowercase();
    !path.contains(".server.")
        && !path.contains("/server/")
        && !path.contains("/scripts/")
        && !path.contains("/cli/")
        && !path.contains("/node/")
}

fn scan_semantic(
    relative: &str,
    source: &str,
    semantic: &Semantic<'_>,
    active_rules: &[Rule],
) -> Vec<Candidate> {
    let mut output = Vec::new();
    let rule = |kind: RuleKind| active_rules.iter().find(|rule| rule.kind == kind);
    let imports = import_bindings(semantic);
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::CallExpression(call) => {
                if let Some(rule) = rule(RuleKind::NoEval) {
                    let direct_eval = match call.callee.without_parentheses() {
                        Expression::Identifier(identifier) => {
                            identifier.name == "eval"
                                && semantic.is_reference_to_global_variable(identifier)
                        }
                        expression => expression.get_member_expr().is_some_and(|member| {
                            member.static_property_name() == Some("eval")
                                && matches!(member.object().without_parentheses(), Expression::Identifier(identifier) if identifier.name == "globalThis" && semantic.is_reference_to_global_variable(identifier))
                        }),
                    };
                    if direct_eval {
                        output.push(candidate(
                            rule,
                            relative,
                            source,
                            call.span.start as usize,
                            call.span.end as usize,
                        ));
                    }
                }

                if let Some(member) = call.callee.get_member_expr() {
                    if let Some(rule) = rule(RuleKind::AuthTokenStorage) {
                        let storage = matches!(
                            member.object().without_parentheses(),
                            Expression::Identifier(identifier)
                                if matches!(identifier.name.as_str(), "localStorage" | "sessionStorage")
                                    && semantic.is_reference_to_global_variable(identifier)
                        );
                        let operation =
                            matches!(member.static_property_name(), Some("setItem" | "getItem"));
                        if storage
                            && operation
                            && string_argument(call, 0).is_some_and(sensitive_storage_key)
                        {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                call.span.start as usize,
                                call.span.end as usize,
                            ));
                        }
                    }
                    if let Some(rule) = rule(RuleKind::DimensionsGet) {
                        let imported_dimensions = match member.object().without_parentheses() {
                            Expression::Identifier(identifier) => imports
                                .react_native
                                .get(identifier.name.as_str())
                                .is_some_and(|imported| imported == "Dimensions"),
                            expression => expression.get_member_expr().is_some_and(|outer| {
                                outer.static_property_name() == Some("Dimensions")
                                    && expression_identifier(outer.object()).is_some_and(|name| {
                                        imports.react_native_namespaces.contains(name)
                                    })
                            }),
                        };
                        let within_function =
                            semantic.nodes().ancestor_kinds(node.id()).any(|kind| {
                                matches!(
                                    kind,
                                    AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)
                                )
                            });
                        if imported_dimensions
                            && member.static_property_name() == Some("get")
                            && within_function
                        {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                call.span.start as usize,
                                call.span.end as usize,
                            ));
                        }
                    }
                }

                if client_source(relative) {
                    let required = match call.callee.without_parentheses() {
                        Expression::Identifier(identifier)
                            if identifier.name == "require"
                                && semantic.is_reference_to_global_variable(identifier) =>
                        {
                            string_argument(call, 0)
                        }
                        _ => None,
                    };
                    if required == Some("lodash") {
                        if let Some(rule) = rule(RuleKind::FullLodash) {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                call.span.start as usize,
                                call.span.end as usize,
                            ));
                        }
                    } else if required == Some("moment") {
                        if let Some(rule) = rule(RuleKind::Moment) {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                call.span.start as usize,
                                call.span.end as usize,
                            ));
                        }
                    }
                }
            }
            AstKind::NewExpression(expression) => {
                if let Some(rule) = rule(RuleKind::NoEval) {
                    if matches!(expression.callee.without_parentheses(), Expression::Identifier(identifier) if identifier.name == "Function" && semantic.is_reference_to_global_variable(identifier))
                    {
                        output.push(candidate(
                            rule,
                            relative,
                            source,
                            expression.span.start as usize,
                            expression.span.end as usize,
                        ));
                    }
                }
            }
            AstKind::ImportDeclaration(import) if client_source(relative) => {
                if import.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                let has_value = import.specifiers.as_ref().is_none_or(|specifiers| {
                    specifiers.iter().any(|specifier| match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                            specifier.import_kind == ImportOrExportKind::Value
                        }
                        _ => true,
                    })
                });
                if !has_value {
                    continue;
                }
                let kind = match import.source.value.as_str() {
                    "lodash" => RuleKind::FullLodash,
                    "moment" => RuleKind::Moment,
                    _ => continue,
                };
                if let Some(rule) = rule(kind) {
                    output.push(candidate(
                        rule,
                        relative,
                        source,
                        import.span.start as usize,
                        import.span.end as usize,
                    ));
                }
            }
            AstKind::JSXOpeningElement(opening) => {
                let name = element_name(opening);
                if name == Some("img") && !has_spread(opening) {
                    if let Some(rule) = rule(RuleKind::ImageAlt) {
                        let hidden = attribute(opening, "aria-hidden").is_some_and(|attribute| match &attribute.value {
                            None => true,
                            Some(JSXAttributeValue::StringLiteral(value)) => value.value == "true",
                            Some(JSXAttributeValue::ExpressionContainer(value)) => matches!(value.expression, JSXExpression::BooleanLiteral(ref literal) if literal.value),
                            _ => false,
                        });
                        let usable_alt = attribute(opening, "alt").is_some_and(|attribute| {
                            match &attribute.value {
                                Some(JSXAttributeValue::ExpressionContainer(value)) => {
                                    match &value.expression {
                                        JSXExpression::NullLiteral(_) => false,
                                        JSXExpression::Identifier(identifier)
                                            if identifier.name == "undefined" =>
                                        {
                                            false
                                        }
                                        _ => true,
                                    }
                                }
                                Some(_) => true,
                                None => false,
                            }
                        });
                        if !hidden && !usable_alt {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                opening.span.start as usize,
                                opening.span.end as usize,
                            ));
                        }
                    }
                }
                if name == Some("iframe") && !has_spread(opening) {
                    if let Some(rule) = rule(RuleKind::IframeSandbox) {
                        let safe = attribute(opening, "sandbox").is_some_and(|attribute| {
                            let value = match &attribute.value {
                                None => "",
                                Some(JSXAttributeValue::StringLiteral(value)) => {
                                    value.value.as_str()
                                }
                                _ => return true,
                            };
                            let tokens: BTreeSet<_> = value.split_ascii_whitespace().collect();
                            !(tokens.contains("allow-scripts")
                                && tokens.contains("allow-same-origin"))
                        });
                        if !safe {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                opening.span.start as usize,
                                opening.span.end as usize,
                            ));
                        }
                    }
                }
                if let Some(attribute) = attribute(opening, "dangerouslySetInnerHTML") {
                    if let Some(rule) = rule(RuleKind::DangerousHtml) {
                        let text =
                            &source[attribute.span.start as usize..attribute.span.end as usize];
                        let trusted = ["sanitize", "dompurify", "trustedhtml", "trustedTypes"]
                            .iter()
                            .any(|marker| {
                                text.to_ascii_lowercase()
                                    .contains(&marker.to_ascii_lowercase())
                            });
                        if !trusted {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                attribute.span.start as usize,
                                attribute.span.end as usize,
                            ));
                        }
                    }
                }

                if let Some(local) = name {
                    let imported = imports.react_native.get(local).map(String::as_str);
                    if matches!(
                        imported,
                        Some("FlatList" | "VirtualizedList" | "SectionList")
                    ) {
                        if let Some(rule) = rule(RuleKind::InlineListCallback) {
                            let inline = attribute(opening, "renderItem").is_some_and(|attribute| {
                                matches!(&attribute.value, Some(JSXAttributeValue::ExpressionContainer(value)) if matches!(value.expression, JSXExpression::ArrowFunctionExpression(_) | JSXExpression::FunctionExpression(_)))
                            });
                            if inline {
                                output.push(candidate(
                                    rule,
                                    relative,
                                    source,
                                    opening.span.start as usize,
                                    opening.span.end as usize,
                                ));
                            }
                        }
                    }
                    if matches!(
                        imported,
                        Some(
                            "TouchableOpacity"
                                | "TouchableHighlight"
                                | "TouchableWithoutFeedback"
                                | "TouchableNativeFeedback"
                        )
                    ) {
                        if let Some(rule) = rule(RuleKind::PreferPressable) {
                            output.push(candidate(
                                rule,
                                relative,
                                source,
                                opening.span.start as usize,
                                opening.span.end as usize,
                            ));
                        }
                    }
                }
            }
            AstKind::JSXAttribute(attribute) if attr_name(attribute) == Some("key") => {
                let Some(rule) = rule(RuleKind::ArrayIndexKey) else {
                    continue;
                };
                let Some(JSXAttributeValue::ExpressionContainer(container)) = &attribute.value
                else {
                    continue;
                };
                let Some(key_name) = jsx_expression_identifier(&container.expression) else {
                    continue;
                };
                let is_iterator_index = semantic
                    .nodes()
                    .ancestor_kinds(node.id())
                    .find_map(|kind| match kind {
                        AstKind::ArrowFunctionExpression(arrow) => Some(&arrow.params),
                        AstKind::Function(function) => Some(&function.params),
                        _ => None,
                    })
                    .and_then(|params| params.items.get(1))
                    .is_some_and(|parameter| matches!(&parameter.pattern.kind, BindingPatternKind::BindingIdentifier(identifier) if identifier.name == key_name));
                if is_iterator_index {
                    output.push(candidate(
                        rule,
                        relative,
                        source,
                        attribute.span.start as usize,
                        attribute.span.end as usize,
                    ));
                }
            }
            _ => {}
        }
    }
    output
}

fn parse_error(relative: &str, source: &str, message: String) -> Candidate {
    let fingerprint = hash(format!("syntax/parse-error\0{}", normalize(&message)));
    Candidate {
        diagnostic: Diagnostic {
            fingerprint,
            occurrence_id: String::new(),
            producer: Producer {
                tool: "skeptic-doctor".into(),
                tool_version: env!("CARGO_PKG_VERSION").into(),
                rule_id: "syntax/parse-error".into(),
                rule_version: Some("1".into()),
                config_hash: None,
            },
            severity: Severity::P0,
            category: Category::Correctness,
            confidence: 1.0,
            file: Some(relative.into()),
            span: None,
            route: None,
            subject: None,
            message,
            help: Some(
                "Fix the syntax error before relying on other diagnostics for this file.".into(),
            ),
            related_locations: Vec::new(),
            state: FindingState::Open,
            evidence_state: EvidenceState::Unobserved,
            baseline_state: BaselineState::New,
            suppression: None,
            fix_group_id: None,
            links: Vec::new(),
        },
        context_hash: hash(source),
    }
}

fn custom_candidates(
    root: &Path,
    files: &[(String, String)],
    pack_path: Option<&Path>,
) -> Result<Vec<Candidate>, String> {
    let path = pack_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("skeptic-rules.yml"));
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let pack: CustomPack =
        serde_yaml::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    for custom in pack.rules {
        if !(0.0..=1.0).contains(&custom.confidence) {
            return Err(format!("custom rule {} confidence must be 0..1", custom.id));
        }
        let pattern = Regex::new(&custom.pattern)
            .map_err(|error| format!("custom rule {}: {error}", custom.id))?;
        for (relative, source) in files {
            for found in pattern.find_iter(source) {
                let start = position(source, found.start());
                let end = position(source, found.end());
                let subject = normalize(found.as_str());
                let fingerprint = hash(format!("custom/{}\0{}", custom.id, subject));
                let context_hash = hash(surrounding_context(source, start.line));
                output.push(Candidate {
                    diagnostic: Diagnostic {
                        fingerprint,
                        occurrence_id: String::new(),
                        producer: Producer {
                            tool: "skeptic-doctor".into(),
                            tool_version: env!("CARGO_PKG_VERSION").into(),
                            rule_id: format!("custom/{}", custom.id),
                            rule_version: Some("1".into()),
                            config_hash: None,
                        },
                        severity: custom.severity,
                        category: custom.category,
                        confidence: custom.confidence,
                        file: Some(relative.clone()),
                        span: Some(Span { start, end }),
                        route: None,
                        subject: Some(subject),
                        message: custom.message.clone(),
                        help: custom.help.clone(),
                        related_locations: Vec::new(),
                        state: FindingState::Open,
                        evidence_state: EvidenceState::Unobserved,
                        baseline_state: BaselineState::New,
                        suppression: None,
                        fix_group_id: None,
                        links: Vec::new(),
                    },
                    context_hash,
                });
            }
        }
    }
    Ok(output)
}

fn assign_occurrence_ids(candidates: &mut [Candidate]) {
    candidates.sort_by(|left, right| {
        (
            left.diagnostic.file.as_deref(),
            left.diagnostic.span.as_ref().map(|span| span.start.line),
            left.diagnostic.producer.rule_id.as_str(),
        )
            .cmp(&(
                right.diagnostic.file.as_deref(),
                right.diagnostic.span.as_ref().map(|span| span.start.line),
                right.diagnostic.producer.rule_id.as_str(),
            ))
    });
    let mut ranks: BTreeMap<(String, Option<String>, String), usize> = BTreeMap::new();
    for candidate in candidates {
        let key = (
            candidate.diagnostic.fingerprint.clone(),
            candidate.diagnostic.file.clone(),
            candidate.context_hash.clone(),
        );
        let rank = ranks.entry(key).or_default();
        candidate.diagnostic.occurrence_id = hash(format!(
            "{}\0{}\0{}\0{}",
            candidate.diagnostic.fingerprint,
            candidate.diagnostic.file.as_deref().unwrap_or(""),
            candidate.context_hash,
            *rank
        ));
        *rank += 1;
    }
}

fn apply_baseline(candidates: &mut Vec<Candidate>, baseline: &Baseline) {
    let mut used = vec![false; baseline.occurrences.len()];
    for candidate in candidates.iter_mut() {
        let exact = baseline
            .occurrences
            .iter()
            .enumerate()
            .position(|(index, old)| {
                !used[index] && old.occurrence_id == candidate.diagnostic.occurrence_id
            });
        let within_file = || {
            baseline
                .occurrences
                .iter()
                .enumerate()
                .position(|(index, old)| {
                    !used[index]
                        && old.fingerprint == candidate.diagnostic.fingerprint
                        && old.file == candidate.diagnostic.file
                        && old.context_hash == candidate.context_hash
                })
        };
        let moved = || {
            baseline
                .occurrences
                .iter()
                .enumerate()
                .position(|(index, old)| {
                    !used[index]
                        && old.fingerprint == candidate.diagnostic.fingerprint
                        && old.file != candidate.diagnostic.file
                })
        };
        if let Some(index) = exact.or_else(within_file) {
            used[index] = true;
            candidate.diagnostic.baseline_state = BaselineState::Existing;
        } else if let Some(index) = moved() {
            used[index] = true;
            candidate.diagnostic.baseline_state = BaselineState::Moved;
        } else if baseline
            .legacy_fingerprints
            .contains(&candidate.diagnostic.fingerprint)
        {
            candidate.diagnostic.baseline_state = BaselineState::Existing;
        }
    }
    for (index, old) in baseline.occurrences.iter().enumerate() {
        if used[index] {
            continue;
        }
        let Some(mut fixed) = old.diagnostic.clone() else {
            continue;
        };
        fixed.state = FindingState::Fixed;
        fixed.baseline_state = BaselineState::Fixed;
        candidates.push(Candidate {
            diagnostic: fixed,
            context_hash: old.context_hash.clone(),
        });
    }
}

pub fn refresh_report(report: &mut DoctorReport) -> Result<(), String> {
    report.by_severity.clear();
    report.by_category.clear();
    for diagnostic in &report.diagnostics {
        diagnostic.validate().map_err(|error| error.to_string())?;
        if diagnostic.state == FindingState::Open {
            *report.by_severity.entry(diagnostic.severity).or_insert(0) += 1;
            *report.by_category.entry(diagnostic.category).or_insert(0) += 1;
        }
    }
    report.score = None;
    Ok(())
}

pub fn scan(root: &Path, options: ScanOptions) -> Result<DoctorReport, String> {
    let release_rules = rules();
    let registered: BTreeSet<_> = release_rules
        .iter()
        .map(|rule| rule.id.to_string())
        .collect();
    let generated: BTreeSet<_> = GENERATED_RULE_IDS.iter().map(|id| id.to_string()).collect();
    if registered != generated {
        return Err("generated rule registry and runtime checks diverged".into());
    }
    let paths = source_files(root, options.files.as_ref());
    let mut files = Vec::new();
    for path in &paths {
        let source =
            fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
        if source.lines().count() <= 2 && source.len() > 10_000 {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push((relative, source));
    }
    let capabilities = detect_project_capabilities(root, &files);
    let active_rules: Vec<_> = release_rules
        .iter()
        .copied()
        .filter(|rule| rule_applies(rule, capabilities))
        .collect();
    let mut candidates = Vec::new();
    for (relative, source) in &files {
        let source_type =
            SourceType::from_path(Path::new(relative)).map_err(|error| error.to_string())?;
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, source_type).parse();
        if !parsed.errors.is_empty() {
            candidates.push(parse_error(
                relative,
                source,
                format!("Oxc could not parse this file: {:?}", parsed.errors[0]),
            ));
            continue;
        }
        let built = SemanticBuilder::new()
            .with_check_syntax_error(true)
            .build(&parsed.program);
        if let Some(error) = built.errors.first() {
            candidates.push(parse_error(
                relative,
                source,
                format!("Oxc semantic analysis failed: {error:?}"),
            ));
            continue;
        }
        let mut found = scan_semantic(relative, source, &built.semantic, &active_rules);
        if non_production_path(relative) {
            for candidate in &mut found {
                candidate.diagnostic.state = FindingState::Suppressed;
                candidate.diagnostic.suppression = Some(Suppression {
                    kind: SuppressionKind::Config,
                    justification: Some("non-production test/story/fixture context".into()),
                });
            }
        }
        candidates.extend(found);
    }
    candidates.extend(custom_candidates(
        root,
        &files,
        options.custom_pack.as_deref(),
    )?);
    assign_occurrence_ids(&mut candidates);
    apply_baseline(&mut candidates, &options.baseline);
    candidates.sort_by(|left, right| {
        (
            left.diagnostic.file.as_deref(),
            left.diagnostic.span.as_ref().map(|span| span.start.line),
            left.diagnostic.producer.rule_id.as_str(),
        )
            .cmp(&(
                right.diagnostic.file.as_deref(),
                right.diagnostic.span.as_ref().map(|span| span.start.line),
                right.diagnostic.producer.rule_id.as_str(),
            ))
    });
    let mut covered_categories: Vec<_> = if files.is_empty() {
        Vec::new()
    } else {
        active_rules
            .iter()
            .filter(|rule| rule.surfaces.contains(&Surface::Score))
            .map(|rule| rule.category)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    covered_categories.sort();
    let mut scored_rule_ids: Vec<_> = active_rules
        .iter()
        .filter(|rule| rule.surfaces.contains(&Surface::Score))
        .map(|rule| rule.id.to_string())
        .collect();
    scored_rule_ids.push("syntax/parse-error".into());
    scored_rule_ids.sort();
    let custom_present = options
        .custom_pack
        .as_ref()
        .is_some_and(|path| path.is_file())
        || root.join("skeptic-rules.yml").is_file();
    let mut report = DoctorReport {
        schema: "skeptic.doctor-report/2".into(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        root: root.to_string_lossy().to_string(),
        files_scanned: files.len(),
        diagnostics: candidates
            .into_iter()
            .map(|candidate| candidate.diagnostic)
            .collect(),
        score: None,
        by_severity: BTreeMap::new(),
        by_category: BTreeMap::new(),
        covered_categories,
        scored_rule_ids,
        capabilities: vec![
            CapabilityRecord {
                id: "doctor/oxc".into(),
                availability: CapabilityAvailability::Available,
                execution: CapabilityExecution::Succeeded,
                required: true,
                reason: None,
                backend: Some("oxc-semantic".into()),
                version: Some("0.100.0".into()),
            },
            CapabilityRecord {
                id: "doctor/custom-patterns".into(),
                availability: CapabilityAvailability::Available,
                execution: if custom_present {
                    CapabilityExecution::Succeeded
                } else {
                    CapabilityExecution::NotRequested
                },
                required: false,
                reason: (!custom_present).then(|| "no custom rule pack configured".into()),
                backend: Some("regex".into()),
                version: Some("1".into()),
            },
        ],
        completeness: Completeness::Complete,
        warnings: Vec::new(),
    };
    refresh_report(&mut report)?;
    Ok(report)
}

pub fn why(rule_id: &str) -> Option<(CheckDef, &'static str, &'static str)> {
    rules()
        .into_iter()
        .find(|rule| rule.id == rule_id)
        .map(|rule| (rule.definition(), rule.why(), rule.help()))
}

pub fn read_baseline(path: &Path) -> Result<Baseline, String> {
    if !path.is_file() {
        return Ok(Baseline {
            schema: baseline_schema(),
            ..Baseline::default()
        });
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if let Ok(baseline) = serde_json::from_slice::<Baseline>(&bytes) {
        return Ok(baseline);
    }
    let legacy: BTreeSet<String> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(Baseline {
        schema: baseline_schema(),
        occurrences: Vec::new(),
        legacy_fingerprints: legacy,
    })
}

pub fn write_baseline(path: &Path, report: &DoctorReport) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let baseline = Baseline {
        schema: baseline_schema(),
        occurrences: report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.state != FindingState::Fixed)
            .map(|diagnostic| BaselineEntry {
                fingerprint: diagnostic.fingerprint.clone(),
                occurrence_id: diagnostic.occurrence_id.clone(),
                file: diagnostic.file.clone(),
                context_hash: diagnostic
                    .file
                    .as_deref()
                    .zip(diagnostic.span.as_ref())
                    .and_then(|(file, span)| {
                        fs::read_to_string(Path::new(&report.root).join(file))
                            .ok()
                            .map(|source| hash(surrounding_context(&source, span.start.line)))
                    })
                    .unwrap_or_else(|| hash(diagnostic.subject.as_deref().unwrap_or(""))),
                diagnostic: Some(diagnostic.clone()),
            })
            .collect(),
        legacy_fingerprints: BTreeSet::new(),
    };
    let mut bytes = serde_json::to_vec_pretty(&baseline).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| error.to_string())
}

pub fn changed_files(root: &Path, base: &str) -> Result<BTreeSet<String>, String> {
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", &format!("{base}...HEAD")])
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_source(name: &str, source: &str) -> DoctorReport {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("package.json"),
            r#"{"dependencies":{"react":"19","react-native":"0.80"}}"#,
        )
        .unwrap();
        fs::write(temp.path().join(name), source).unwrap();
        scan(temp.path(), ScanOptions::default()).unwrap()
    }

    fn ids(report: &DoctorReport) -> BTreeSet<&str> {
        report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.state == FindingState::Open)
            .map(|diagnostic| diagnostic.producer.rule_id.as_str())
            .collect()
    }

    #[test]
    fn semantic_pack_finds_high_signal_issues() {
        let report = scan_source(
            "app.tsx",
            r#"
              import _ from 'lodash';
              import { Dimensions, FlatList, TouchableOpacity } from 'react-native';
              export const App = () => {
                Dimensions.get('window');
                return <><img src="x"/><iframe src="x"/><FlatList renderItem={({item}) => <div>{item}</div>}/><TouchableOpacity onPress={() => eval('x')}/></>;
              };
            "#,
        );
        let found = ids(&report);
        for expected in [
            "security/no-eval",
            "a11y/image-missing-alt",
            "a11y/iframe-missing-sandbox",
            "performance/no-full-lodash-import",
            "performance/no-inline-list-callback",
            "react-native/no-dimensions-get",
            "react-native/prefer-pressable",
        ] {
            assert!(found.contains(expected), "missing {expected}: {found:?}");
        }
        assert_eq!(report.score, None);
    }

    #[test]
    fn ignores_text_shadowing_type_imports_and_unrelated_bindings() {
        let report = scan_source(
            "clean.jsx",
            r#"
              const sandbox = { eval(value) { return value; } };
              const Dimensions = { get: () => 1 };
              const note = "eval('not code') <img>";
              export const App = () => <img alt="decorative" src="x" />;
              sandbox.eval(note); Dimensions.get();
            "#,
        );
        assert!(
            ids(&report).is_empty(),
            "unexpected: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn index_key_must_be_the_iterator_index_binding() {
        let positive = scan_source(
            "bad.tsx",
            "export const App=({xs}) => xs.map((item, index) => <div key={index}>{item.id}</div>);",
        );
        assert!(ids(&positive).contains("correctness/no-array-index-key"));
        let negative = scan_source(
            "good.tsx",
            "const index='stable'; export const App=({xs}) => xs.map((item) => <div key={index}>{item.id}</div>);",
        );
        assert!(!ids(&negative).contains("correctness/no-array-index-key"));
    }

    #[test]
    fn justified_inline_suppression_is_retained_not_deleted() {
        let report = scan_source(
            "app.tsx",
            "// skeptic-ignore security/no-eval -- sandbox expression evaluator\neval(input);",
        );
        let diagnostic = report.diagnostics.first().unwrap();
        assert_eq!(diagnostic.state, FindingState::Suppressed);
        assert_eq!(
            diagnostic.suppression.as_ref().unwrap().kind,
            SuppressionKind::Inline
        );
    }

    #[test]
    fn baseline_survives_line_shift_move_and_reports_fixed() {
        let first = tempfile::tempdir().unwrap();
        fs::write(
            first.path().join("package.json"),
            r#"{"dependencies":{"react":"19"}}"#,
        )
        .unwrap();
        fs::write(first.path().join("a.ts"), "eval(input);").unwrap();
        let report = scan(first.path(), ScanOptions::default()).unwrap();
        let baseline_path = first.path().join("baseline.json");
        write_baseline(&baseline_path, &report).unwrap();
        let baseline = read_baseline(&baseline_path).unwrap();
        fs::remove_file(first.path().join("a.ts")).unwrap();
        fs::write(first.path().join("b.ts"), "\n\n eval( input );").unwrap();
        let moved = scan(
            first.path(),
            ScanOptions {
                baseline: baseline.clone(),
                ..ScanOptions::default()
            },
        )
        .unwrap();
        assert!(moved
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.baseline_state == BaselineState::Moved));
        fs::write(first.path().join("b.ts"), "export const safe = true;").unwrap();
        let fixed = scan(
            first.path(),
            ScanOptions {
                baseline,
                ..ScanOptions::default()
            },
        )
        .unwrap();
        assert!(fixed
            .diagnostics
            .iter()
            .any(
                |diagnostic| diagnostic.baseline_state == BaselineState::Fixed
                    && diagnostic.state == FindingState::Fixed
            ));
    }

    #[test]
    fn non_production_findings_are_suppressed() {
        let report = scan_source("thing.test.ts", "eval(input);");
        assert_eq!(report.diagnostics[0].state, FindingState::Suppressed);
    }

    #[test]
    fn release_pack_fixture_has_exact_positive_and_negative_behavior() {
        let positive = scan_source(
            "release-pack-positive.tsx",
            include_str!("../tests/fixtures/release-pack-positive.tsx"),
        );
        let found = ids(&positive);
        for expected in [
            "security/no-eval",
            "security/no-dangerous-html",
            "security/auth-token-in-web-storage",
            "a11y/iframe-missing-sandbox",
            "a11y/image-missing-alt",
            "performance/no-full-lodash-import",
            "performance/no-moment",
            "correctness/no-array-index-key",
            "performance/no-inline-list-callback",
            "react-native/no-dimensions-get",
            "react-native/prefer-pressable",
        ] {
            assert!(found.contains(expected), "missing {expected}: {found:?}");
        }

        let negative = scan_source(
            "release-pack-negative.tsx",
            include_str!("../tests/fixtures/release-pack-negative.tsx"),
        );
        let unexpected: Vec<_> = negative
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.state == FindingState::Open)
            .filter(|diagnostic| diagnostic.producer.rule_id != "react-native/no-dimensions-get")
            .collect();
        assert!(unexpected.is_empty(), "unexpected: {unexpected:#?}");
        assert_eq!(
            negative
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.producer.rule_id == "react-native/no-dimensions-get")
                .count(),
            1,
            "the imported RN binding remains a valid positive while the unrelated local object is ignored"
        );
    }
}
