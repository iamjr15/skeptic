use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    require_nonempty, CapabilityRecord, Category, CategoryCounts, ContractViolation, EvidenceRef,
    SeverityCounts, RUN_SCHEMA, SCORE_FORMULA,
};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RunOutcome {
    Passed,
    Failed,
    Cancelled,
    Errored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Completeness {
    Complete,
    Partial,
    Failed,
}

impl std::fmt::Display for Completeness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Completeness::Complete => "complete",
            Completeness::Partial => "partial",
            Completeness::Failed => "failed",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Git,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceInfo {
    pub kind: SourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunConfig {
    pub config_hash: String,
    pub tool_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub name: String,
    pub root: String,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    Web,
    Android,
    IosSim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub platform: Platform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Score {
    pub total: Option<u8>,
    pub by_category: BTreeMap<Category, Option<f64>>,
    pub coverage: f64,
    pub ghost_gain: f64,
    pub formula: String,
}

impl Score {
    pub fn validate(&self) -> Result<(), ContractViolation> {
        if self.formula != SCORE_FORMULA {
            return Err(ContractViolation::new(
                "manifest.score.formula",
                format!("expected {SCORE_FORMULA}"),
            ));
        }
        if self.total.is_some_and(|total| total > 100) {
            return Err(ContractViolation::new(
                "manifest.score.total",
                "must be between 0 and 100 or null",
            ));
        }
        if !(0.0..=1.0).contains(&self.coverage) {
            return Err(ContractViolation::new(
                "manifest.score.coverage",
                "must be between 0 and 1",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TestStatus {
    Passed,
    Failed,
    Skipped,
    TimedOut,
    Errored,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssertionResult {
    pub matcher: String,
    pub expected: Value,
    pub actual: Value,
    pub negated: bool,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestResult {
    pub id: String,
    pub title: String,
    pub file: String,
    pub status: TestStatus,
    pub duration_ms: u64,
    /// Index into `RunManifest.targets`.
    pub target: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assertion: Option<AssertionResult>,
    #[serde(default)]
    pub artifacts: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ColorScheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualKey {
    pub platform: Platform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub viewport: String,
    pub dpr: f64,
    pub color_scheme: ColorScheme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum VisualStatus {
    Match,
    Diff,
    New,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualResult {
    pub name: String,
    pub key: VisualKey,
    pub status: VisualStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<EvidenceRef>,
    pub actual: EvidenceRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticSummary {
    pub total: u64,
    pub new: u64,
    pub by_severity: SeverityCounts,
    pub by_category: CategoryCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticReportRef {
    pub report: EvidenceRef,
    pub summary: DiagnosticSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunManifest {
    pub schema: String,
    pub run_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u64,
    pub outcome: RunOutcome,
    pub source: SourceInfo,
    pub config: RunConfig,
    pub completeness: Completeness,
    #[serde(default)]
    pub capabilities: Vec<CapabilityRecord>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<Score>,
    #[serde(default)]
    pub tests: Vec<TestResult>,
    #[serde(default)]
    pub sidecars: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mobile: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual: Option<Vec<VisualResult>>,
    pub journal: EvidenceRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<DiagnosticReportRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcripts: Option<Vec<EvidenceRef>>,
}

impl RunManifest {
    pub fn validate(&self) -> Result<(), ContractViolation> {
        if self.schema != RUN_SCHEMA {
            return Err(ContractViolation::new(
                "manifest.schema",
                format!("expected {RUN_SCHEMA}"),
            ));
        }
        require_nonempty("manifest.runId", &self.run_id)?;
        require_nonempty("manifest.startedAt", &self.started_at)?;
        require_nonempty("manifest.finishedAt", &self.finished_at)?;
        require_nonempty("manifest.config.configHash", &self.config.config_hash)?;
        self.journal.validate()?;
        if let Some(score) = &self.score {
            score.validate()?;
        }
        for result in &self.tests {
            if result.target >= self.targets.len() {
                return Err(ContractViolation::new(
                    "manifest.tests[].target",
                    format!(
                        "target index {} is outside {} declared targets",
                        result.target,
                        self.targets.len()
                    ),
                ));
            }
            for artifact in &result.artifacts {
                artifact.validate()?;
            }
        }
        for sidecar in &self.sidecars {
            sidecar.validate()?;
        }
        if let Some(mobile) = &self.mobile {
            for evidence in mobile {
                evidence.validate()?;
            }
        }
        if let Some(visual) = &self.visual {
            for result in visual {
                result.actual.validate()?;
                if let Some(baseline) = &result.baseline {
                    baseline.validate()?;
                }
                if let Some(diff) = &result.diff {
                    diff.validate()?;
                }
            }
        }
        if let Some(diagnostics) = &self.diagnostics {
            diagnostics.report.validate()?;
        }
        if let Some(transcripts) = &self.transcripts {
            for transcript in transcripts {
                transcript.validate()?;
            }
        }
        Ok(())
    }
}
