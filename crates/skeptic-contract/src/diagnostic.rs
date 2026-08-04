use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ContractViolation, EvidenceRef};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub enum Severity {
    P0,
    P1,
    P2,
    P3,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    Correctness,
    Security,
    Performance,
    A11y,
    Maintainability,
    Visual,
}

impl std::fmt::Display for Category {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Category::Correctness => "Correctness",
            Category::Security => "Security",
            Category::Performance => "Performance",
            Category::A11y => "Accessibility",
            Category::Maintainability => "Maintainability",
            Category::Visual => "Visual",
        })
    }
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Severity::P0 => "P0",
            Severity::P1 => "P1",
            Severity::P2 => "P2",
            Severity::P3 => "P3",
        })
    }
}

impl Severity {
    /// Plain-language urgency word for human output (P0 = most urgent).
    pub fn word(&self) -> &'static str {
        match self {
            Severity::P0 => "critical",
            Severity::P1 => "high",
            Severity::P2 => "medium",
            Severity::P3 => "low",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Web,
    React,
    Nextjs,
    ReactNative,
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CheckEngine {
    OxlintNative,
    Oxc,
    Astgrep,
    Deadcode,
    Runtime,
    Analyzer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum Surface {
    #[serde(rename = "cli")]
    Cli,
    #[serde(rename = "prComment")]
    PrComment,
    #[serde(rename = "score")]
    Score,
    #[serde(rename = "ciFailure")]
    CiFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckDef {
    pub id: String,
    pub title: String,
    pub severity: Severity,
    pub category: Category,
    pub capability: Vec<Capability>,
    pub engine: CheckEngine,
    pub surfaces: Vec<Surface>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlator_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_recipe: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Producer {
    pub tool: String,
    pub tool_version: String,
    pub rule_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityAvailability {
    Available,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityExecution {
    NotRequested,
    Skipped,
    Succeeded,
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRecord {
    pub id: String,
    pub availability: CapabilityAvailability,
    pub execution: CapabilityExecution,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum FindingState {
    Open,
    Suppressed,
    Fixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceState {
    Unobserved,
    Corroborated,
    Contradicted,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BaselineState {
    New,
    Existing,
    Moved,
    Fixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SuppressionKind {
    Inline,
    Config,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPosition {
    /// One-based line number.
    pub line: u32,
    /// One-based Unicode scalar column.
    pub column: u32,
    /// Optional zero-based UTF-8 byte offset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Span {
    pub start: TextPosition,
    pub end: TextPosition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suppression {
    pub kind: SuppressionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrelationLink {
    pub correlator_id: String,
    pub correlator_version: String,
    pub evidence: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_ms: Option<u64>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostic {
    pub fingerprint: String,
    pub occurrence_id: String,
    pub producer: Producer,
    pub severity: Severity,
    pub category: Category,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_locations: Vec<Location>,
    pub state: FindingState,
    pub evidence_state: EvidenceState,
    pub baseline_state: BaselineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppression: Option<Suppression>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_group_id: Option<String>,
    #[serde(default)]
    pub links: Vec<CorrelationLink>,
}

impl Diagnostic {
    pub fn validate(&self) -> Result<(), ContractViolation> {
        crate::require_nonempty("diagnostic.fingerprint", &self.fingerprint)?;
        crate::require_nonempty("diagnostic.occurrenceId", &self.occurrence_id)?;
        crate::require_nonempty("diagnostic.message", &self.message)?;
        if !(0.0..=1.0).contains(&self.confidence) {
            return Err(ContractViolation::new(
                "diagnostic.confidence",
                "must be between 0 and 1",
            ));
        }
        for link in &self.links {
            if !(0.0..=1.0).contains(&link.confidence) {
                return Err(ContractViolation::new(
                    "diagnostic.links[].confidence",
                    "must be between 0 and 1",
                ));
            }
            for evidence in &link.evidence {
                evidence.validate()?;
            }
        }
        Ok(())
    }
}

pub type SeverityCounts = BTreeMap<Severity, u64>;
pub type CategoryCounts = BTreeMap<Category, u64>;
