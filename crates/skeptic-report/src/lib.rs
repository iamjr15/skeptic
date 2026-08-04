#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use skeptic_contract::{
    BaselineState, Category, CorrelationLink, Diagnostic, EvidenceRef, EvidenceState, FindingState,
    Producer, RunManifest, Score, Severity, TestStatus, SCORE_FORMULA,
};

const CATEGORY_WEIGHTS: [(Category, f64); 6] = [
    (Category::Correctness, 25.0),
    (Category::Security, 20.0),
    (Category::Performance, 20.0),
    (Category::A11y, 15.0),
    (Category::Maintainability, 10.0),
    (Category::Visual, 10.0),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreExplanation {
    pub category: Category,
    pub weight: f64,
    pub severity_points: f64,
    pub normalization: f64,
    pub deduction: f64,
    pub points: Option<f64>,
    pub covered: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedReport {
    pub schema: String,
    pub manifest_path: String,
    pub manifest: RunManifest,
    pub diagnostics: Vec<Diagnostic>,
    pub score: Score,
    pub score_explanation: Vec<ScoreExplanation>,
    pub markers: Vec<Value>,
    pub correlation_version: String,
}

fn severity_points(severity: Severity) -> f64 {
    match severity {
        Severity::P0 => 8.0,
        Severity::P1 => 3.0,
        Severity::P2 => 1.0,
        Severity::P3 => 0.25,
    }
}

pub fn calculate_score(
    diagnostics: &[Diagnostic],
    analyzed_files: usize,
    covered: &BTreeSet<Category>,
) -> (Score, Vec<ScoreExplanation>) {
    let normalization = (8.0 * ((analyzed_files as f64 / 100.0).sqrt())).max(8.0);
    let mut by_category = BTreeMap::new();
    let mut explanation = Vec::new();
    let mut earned = 0.0;
    let mut scored_weights = 0.0;
    let mut ghost_gain = 0.0;
    for (category, weight) in CATEGORY_WEIGHTS {
        let sev_points = diagnostics
            .iter()
            .filter(|item| {
                item.category == category
                    && item.confidence >= 0.75
                    && matches!(item.state, skeptic_contract::FindingState::Open)
            })
            .map(|item| severity_points(item.severity))
            .sum::<f64>();
        let deduction = weight * (1.0 - (-sev_points / normalization).exp());
        let is_covered = covered.contains(&category);
        let points = is_covered.then_some((weight - deduction).max(0.0));
        by_category.insert(category, points.map(|value| value / weight * 100.0));
        if let Some(points) = points {
            earned += points;
            scored_weights += weight;
            ghost_gain += deduction;
        }
        explanation.push(ScoreExplanation {
            category,
            weight,
            severity_points: sev_points,
            normalization,
            deduction,
            points,
            covered: is_covered,
            reason: (!is_covered)
                .then(|| "required capability did not execute successfully".into()),
        });
    }
    let total = (scored_weights > 0.0)
        .then(|| (earned / scored_weights * 100.0).round().clamp(0.0, 100.0) as u8);
    (
        Score {
            total,
            by_category,
            coverage: scored_weights / 100.0,
            ghost_gain,
            formula: SCORE_FORMULA.into(),
        },
        explanation,
    )
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

pub fn latest_manifest(root: &Path) -> Result<PathBuf, String> {
    let latest = root.join(".skeptic/runs/latest.json");
    let value: Value = serde_json::from_slice(
        &fs::read(&latest)
            .map_err(|_| "no latest Skeptic run; run `skeptic run` first".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let manifest = value
        .get("manifest")
        .and_then(Value::as_str)
        .ok_or("latest run pointer has no manifest")?;
    Ok(root.join(".skeptic/runs").join(manifest))
}

type DiagnosticInput = (Vec<Diagnostic>, BTreeSet<Category>, BTreeSet<String>);

fn read_diagnostics(path: Option<&Path>) -> Result<DiagnosticInput, String> {
    let Some(path) = path else {
        return Ok((Vec::new(), BTreeSet::new(), BTreeSet::new()));
    };
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let value = value.get("data").cloned().unwrap_or(value);
    let values = value
        .get("diagnostics")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let covered = value
        .get("coveredCategories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|category| serde_json::from_value(category.clone()).ok())
        .collect();
    let scored_rule_ids = value
        .get("scoredRuleIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let diagnostics = values
        .into_iter()
        .map(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((diagnostics, covered, scored_rule_ids))
}

fn sidecar_payload(path: &Path) -> Option<Value> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    Some(value.get("data").cloned().unwrap_or(value))
}

fn runtime_diagnostic(
    evidence: &EvidenceRef,
    rule_id: &str,
    severity: Severity,
    category: Category,
    message: String,
    subject: Option<String>,
    occurrence: usize,
) -> Diagnostic {
    let identity = format!(
        "runtime:{rule_id}:{}:{}",
        evidence.rel_path,
        subject.as_deref().unwrap_or("page")
    );
    Diagnostic {
        fingerprint: identity.clone(),
        occurrence_id: format!("{identity}:{occurrence}"),
        producer: Producer {
            tool: "skeptic-evidence".into(),
            tool_version: env!("CARGO_PKG_VERSION").into(),
            rule_id: rule_id.into(),
            rule_version: Some("1".into()),
            config_hash: None,
        },
        severity,
        category,
        confidence: 1.0,
        file: None,
        span: None,
        route: None,
        subject,
        message,
        help: Some("Inspect the linked runtime evidence and fix the observed behavior.".into()),
        related_locations: Vec::new(),
        state: FindingState::Open,
        evidence_state: EvidenceState::Corroborated,
        baseline_state: BaselineState::New,
        suppression: None,
        fix_group_id: None,
        links: vec![CorrelationLink {
            correlator_id: "runtime-evidence".into(),
            correlator_version: "1".into(),
            evidence: vec![evidence.clone()],
            window_ms: None,
            confidence: 1.0,
        }],
    }
}

fn evidence_diagnostics(manifest: &RunManifest, run_dir: &Path) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for evidence in &manifest.sidecars {
        let Some(value) = sidecar_payload(&run_dir.join(&evidence.rel_path)) else {
            continue;
        };
        match evidence.kind.as_str() {
            "network" => {
                for (index, issue) in value
                    .get("issues")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let rule = issue
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("network/issue");
                    let severity = match issue.get("severity").and_then(Value::as_str) {
                        Some("error") => Severity::P1,
                        Some("warning") => Severity::P2,
                        _ => Severity::P3,
                    };
                    diagnostics.push(runtime_diagnostic(
                        evidence,
                        rule,
                        severity,
                        if rule.contains("mixed-content") {
                            Category::Security
                        } else {
                            Category::Correctness
                        },
                        issue
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Network issue observed")
                            .into(),
                        issue.get("url").and_then(Value::as_str).map(str::to_string),
                        index,
                    ));
                }
            }
            "a11y" => {
                for (index, issue) in value
                    .get("violations")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let rule = issue
                        .get("ruleId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let severity = match issue.get("impact").and_then(Value::as_str) {
                        Some("critical" | "serious") => Severity::P1,
                        Some("moderate") => Severity::P2,
                        _ => Severity::P3,
                    };
                    let subject = issue
                        .get("nodes")
                        .and_then(Value::as_array)
                        .and_then(|nodes| nodes.first())
                        .and_then(|node| node.get("selector"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    diagnostics.push(runtime_diagnostic(
                        evidence,
                        &format!("a11y/{rule}"),
                        severity,
                        Category::A11y,
                        issue
                            .get("help")
                            .or_else(|| issue.get("description"))
                            .and_then(Value::as_str)
                            .unwrap_or("Accessibility violation observed")
                            .into(),
                        subject,
                        index,
                    ));
                }
            }
            "browser-console" => {
                for (index, issue) in value
                    .get("messages")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|issue| {
                        matches!(
                            issue.get("type").and_then(Value::as_str),
                            Some("error" | "warning" | "warn")
                        )
                    })
                    .enumerate()
                {
                    let level = issue.get("type").and_then(Value::as_str).unwrap_or("error");
                    diagnostics.push(runtime_diagnostic(
                        evidence,
                        &format!("browser-console/{level}"),
                        if level == "error" {
                            Severity::P1
                        } else {
                            Severity::P2
                        },
                        Category::Correctness,
                        issue
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("Browser console issue")
                            .into(),
                        None,
                        index,
                    ));
                }
            }
            "performance" => {
                let metric = |name: &str| {
                    value.get(name).and_then(|metric| {
                        metric
                            .as_f64()
                            .or_else(|| metric.get("value").and_then(Value::as_f64))
                            .or_else(|| metric.get("score").and_then(Value::as_f64))
                    })
                };
                let url = value.get("url").and_then(Value::as_str).map(str::to_string);
                for (index, (name, warn, poor, unit)) in [
                    ("lcp", 2_500.0, 4_000.0, "ms"),
                    ("cls", 0.1, 0.25, ""),
                    ("inp", 200.0, 500.0, "ms"),
                    ("ttfb", 800.0, 1_800.0, "ms"),
                ]
                .into_iter()
                .enumerate()
                {
                    let Some(measured) = metric(name) else {
                        continue;
                    };
                    if measured <= warn {
                        continue;
                    }
                    diagnostics.push(runtime_diagnostic(
                        evidence,
                        &format!("performance/{name}"),
                        if measured > poor {
                            Severity::P1
                        } else {
                            Severity::P2
                        },
                        Category::Performance,
                        format!(
                            "{} measured {:.2}{unit}; good is at most {warn:.2}{unit}",
                            name.to_ascii_uppercase(),
                            measured
                        ),
                        url.clone(),
                        index,
                    ));
                }
            }
            _ => {}
        }
    }
    for (index, test) in manifest
        .tests
        .iter()
        .filter(|test| {
            matches!(
                test.status,
                TestStatus::Failed | TestStatus::Errored | TestStatus::TimedOut
            )
        })
        .enumerate()
    {
        let evidence = test.artifacts.first().or_else(|| manifest.sidecars.first());
        if let Some(evidence) = evidence {
            diagnostics.push(runtime_diagnostic(
                evidence,
                "test/failure",
                if test.status == TestStatus::TimedOut {
                    Severity::P1
                } else {
                    Severity::P2
                },
                Category::Correctness,
                format!("Test '{}' ended with status {:?}", test.title, test.status),
                Some(test.file.clone()),
                index,
            ));
        }
    }
    diagnostics
}

fn read_markers(root: &Path) -> Vec<Value> {
    let sessions = root.join(".skeptic/sessions");
    let mut output = Vec::new();
    fn visit(path: &Path, output: &mut Vec<Value>) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, output);
            } else if path.file_name().and_then(|name| name.to_str()) == Some("events.ndjson") {
                if let Ok(text) = fs::read_to_string(path) {
                    output.extend(
                        text.lines()
                            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                            .filter(|value| {
                                value.get("type").and_then(Value::as_str) == Some("marker")
                            }),
                    );
                }
            }
        }
    }
    visit(&sessions, &mut output);
    output.sort_by_key(|value| {
        value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    output
}

fn correlate(diagnostics: &mut [Diagnostic], manifest: &RunManifest, run_dir: &Path) {
    let duplicate_observed = manifest
        .sidecars
        .iter()
        .filter(|item| item.kind == "network")
        .any(|item| {
            sidecar_payload(&run_dir.join(&item.rel_path))
                .and_then(|value| value.get("issues").cloned())
                .and_then(|value| value.as_array().cloned())
                .is_some_and(|issues| {
                    issues.iter().any(|issue| {
                        issue.get("id").and_then(Value::as_str) == Some("network/duplicate-request")
                    })
                })
        });
    if duplicate_observed {
        for diagnostic in diagnostics.iter_mut().filter(|item| {
            item.producer.rule_id.contains("effect") || item.producer.rule_id.contains("fetch")
        }) {
            diagnostic.evidence_state = EvidenceState::Corroborated;
        }
    }
}

pub fn build(
    manifest_path: &Path,
    diagnostics_path: Option<&Path>,
) -> Result<UnifiedReport, String> {
    let manifest: RunManifest =
        serde_json::from_slice(&fs::read(manifest_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    let run_dir = manifest_path
        .parent()
        .ok_or("manifest has no run directory")?;
    let root = manifest
        .projects
        .first()
        .map(|project| PathBuf::from(&project.root))
        .unwrap_or_else(|| project_root(run_dir));
    let (mut diagnostics, doctor_categories, scored_doctor_rules) =
        read_diagnostics(diagnostics_path)?;
    diagnostics.extend(evidence_diagnostics(&manifest, run_dir));
    correlate(&mut diagnostics, &manifest, run_dir);
    diagnostics.sort_by(|left, right| {
        (left.severity, left.category, left.fingerprint.as_str()).cmp(&(
            right.severity,
            right.category,
            right.fingerprint.as_str(),
        ))
    });
    let mut covered = BTreeSet::new();
    if !manifest.tests.is_empty() {
        covered.insert(Category::Correctness);
    }
    covered.extend(doctor_categories);
    for capability in manifest
        .capabilities
        .iter()
        .filter(|record| record.execution == skeptic_contract::CapabilityExecution::Succeeded)
    {
        match capability.id.as_str() {
            "network" => {
                covered.extend([
                    Category::Correctness,
                    Category::Security,
                    Category::Performance,
                ]);
            }
            "browser-console" | "snapshot" => {
                covered.insert(Category::Correctness);
            }
            "a11y" | "mobile-a11y" => {
                covered.insert(Category::A11y);
            }
            "visual" | "screenshot" => {
                covered.insert(Category::Visual);
            }
            "performance" | "har" | "gfxinfo" | "xctrace" => {
                covered.insert(Category::Performance);
            }
            _ => {}
        }
    }
    let analyzed_files = diagnostics
        .iter()
        .filter_map(|item| item.file.as_deref())
        .collect::<BTreeSet<_>>()
        .len()
        .max(
            manifest
                .tests
                .iter()
                .map(|item| item.file.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
        );
    let scoring_diagnostics: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| {
            diagnostic.producer.tool != "skeptic-doctor"
                || scored_doctor_rules.contains(&diagnostic.producer.rule_id)
        })
        .cloned()
        .collect();
    let (score, score_explanation) =
        calculate_score(&scoring_diagnostics, analyzed_files, &covered);
    Ok(UnifiedReport {
        schema: "skeptic.report/1".into(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        manifest,
        diagnostics,
        score,
        score_explanation,
        markers: read_markers(&root),
        correlation_version: "skeptic.correlators/1".into(),
    })
}

/// Human-readable label for a run: outcome, what was exercised, tests, branch.
/// The raw run id moves to the subtitle so the header reads in plain language.
fn human_title(manifest: &skeptic_contract::RunManifest) -> String {
    use skeptic_contract::RunOutcome;
    let (glyph, word) = match manifest.outcome {
        RunOutcome::Passed => ("✓", "passed"),
        RunOutcome::Failed => ("✗", "failed"),
        RunOutcome::Errored => ("✗", "errored"),
        RunOutcome::Cancelled => ("⊘", "cancelled"),
    };
    let mut parts = vec![format!("{glyph} {word}")];
    if let Some(targets) = summarize_targets(&manifest.targets) {
        parts.push(targets);
    }
    match manifest.tests.len() {
        0 => {}
        1 => parts.push("1 test".into()),
        n => parts.push(format!("{n} tests")),
    }
    if let Some(branch) = manifest.source.branch.as_deref() {
        parts.push(branch.to_string());
    }
    parts.join("  ·  ")
}

fn summarize_targets(targets: &[skeptic_contract::Target]) -> Option<String> {
    use skeptic_contract::Platform;
    if targets.is_empty() {
        return None;
    }
    let labels = targets
        .iter()
        .map(|target| {
            let platform = match target.platform {
                Platform::Web => "web",
                Platform::Android => "android",
                Platform::IosSim => "iOS sim",
            };
            match target
                .url
                .as_deref()
                .or(target.app.as_deref())
                .or(target.device.as_deref())
            {
                Some(detail) => format!("{platform} {detail}"),
                None => platform.to_string(),
            }
        })
        .collect::<Vec<_>>();
    Some(labels.join(", "))
}

/// "2026-07-20T15:47:56.054Z" -> "2026-07-20 15:47" (best-effort; ISO 8601 is ASCII).
fn friendly_time(started_at: &str) -> String {
    let bytes = started_at.as_bytes();
    if started_at.len() >= 16 && bytes[10] == b'T' {
        format!("{} {}", &started_at[0..10], &started_at[11..16])
    } else {
        started_at.to_string()
    }
}

fn friendly_duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1000)
    }
}

/// Short, human-scannable run reference: time · duration · short id.
fn human_subtitle(manifest: &skeptic_contract::RunManifest) -> String {
    let short_id = manifest
        .run_id
        .rsplit('-')
        .next()
        .unwrap_or(&manifest.run_id);
    format!(
        "{}  ·  {}  ·  {short_id}",
        friendly_time(&manifest.started_at),
        friendly_duration(manifest.duration_ms)
    )
}

pub fn view(report: &UnifiedReport) -> skeptic_tui::ReportView {
    skeptic_tui::ReportView {
        title: human_title(&report.manifest),
        subtitle: human_subtitle(&report.manifest),
        score: report.score.total,
        coverage: report.score.coverage,
        ghost_gain: report.score.ghost_gain,
        diagnostics: report.diagnostics.len(),
        tests_passed: report
            .manifest
            .tests
            .iter()
            .filter(|test| test.status == TestStatus::Passed)
            .count(),
        tests_failed: report
            .manifest
            .tests
            .iter()
            .filter(|test| {
                matches!(
                    test.status,
                    TestStatus::Failed | TestStatus::Errored | TestStatus::TimedOut
                )
            })
            .count(),
        by_category: report.score.by_category.clone(),
        top_findings: report
            .diagnostics
            .iter()
            .take(8)
            .map(|item| {
                format!(
                    "{:?} · {} · {}",
                    item.severity, item.producer.rule_id, item.message
                )
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn score_is_unknown_without_coverage() {
        let (score, _) = calculate_score(&[], 1, &BTreeSet::new());
        assert_eq!(score.total, None);
        assert_eq!(score.coverage, 0.0);
    }
    #[test]
    fn score_is_perfect_with_covered_clean_category() {
        let (score, _) = calculate_score(&[], 1, &BTreeSet::from([Category::Correctness]));
        assert_eq!(score.total, Some(100));
        assert_eq!(score.coverage, 0.25);
    }
}
