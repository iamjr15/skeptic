use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Category, CONFIG_SCHEMA};

fn config_schema() -> String {
    CONFIG_SCHEMA.to_string()
}

const fn default_idle_ttl_ms() -> u64 {
    300_000
}

const fn default_max_sessions() -> usize {
    8
}

const fn default_action_timeout_ms() -> u64 {
    5_000
}

const fn default_test_timeout_ms() -> u64 {
    30_000
}

const fn default_hard_timeout_ms() -> u64 {
    35_000
}

const fn default_assertion_timeout_ms() -> u64 {
    5_000
}

const fn default_poll_interval_ms() -> u64 {
    100
}

const fn default_analyzer_timeout_ms() -> u64 {
    120_000
}

fn default_confidence_threshold() -> f64 {
    0.75
}

fn default_visual_threshold() -> f64 {
    0.1
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BlockingLevel {
    #[default]
    Error,
    Warning,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AnalyzerFormat {
    Sarif,
    Ndjson,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConfig {
    #[serde(default = "default_idle_ttl_ms")]
    pub idle_ttl_ms: u64,
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            idle_ttl_ms: default_idle_ttl_ms(),
            max_sessions: default_max_sessions(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerConfig {
    #[serde(default = "default_action_timeout_ms")]
    pub action_timeout_ms: u64,
    #[serde(default = "default_test_timeout_ms")]
    pub test_timeout_ms: u64,
    #[serde(default = "default_hard_timeout_ms")]
    pub hard_timeout_ms: u64,
    #[serde(default = "default_assertion_timeout_ms")]
    pub assertion_timeout_ms: u64,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
    pub retries: u32,
    pub shard: Option<String>,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            action_timeout_ms: default_action_timeout_ms(),
            test_timeout_ms: default_test_timeout_ms(),
            hard_timeout_ms: default_hard_timeout_ms(),
            assertion_timeout_ms: default_assertion_timeout_ms(),
            poll_interval_ms: default_poll_interval_ms(),
            retries: 0,
            shard: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DoctorConfig {
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f64,
    pub blocking: BlockingLevel,
    pub required_categories: Vec<Category>,
}

impl Default for DoctorConfig {
    fn default() -> Self {
        Self {
            confidence_threshold: default_confidence_threshold(),
            blocking: BlockingLevel::default(),
            required_categories: vec![
                Category::Correctness,
                Category::Security,
                Category::Performance,
                Category::A11y,
                Category::Maintainability,
                Category::Visual,
            ],
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentConfig {
    pub pass: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyConfig {
    pub allowed_domains: Vec<String>,
    pub allow_project_commands: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualConfig {
    pub mask: Vec<String>,
    pub sensitive: bool,
    #[serde(default = "default_visual_threshold")]
    pub threshold: f64,
}

impl Default for VisualConfig {
    fn default() -> Self {
        Self {
            mask: Vec::new(),
            sensitive: false,
            threshold: default_visual_threshold(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalyzerConfig {
    pub command: Vec<String>,
    pub capability: Option<String>,
    pub format: AnalyzerFormat,
    pub required: bool,
    #[serde(default = "default_analyzer_timeout_ms")]
    pub timeout_ms: u64,
    pub trust_project: bool,
}

impl Default for AnalyzerConfig {
    fn default() -> Self {
        Self {
            command: Vec::new(),
            capability: None,
            format: AnalyzerFormat::Ndjson,
            required: false,
            timeout_ms: default_analyzer_timeout_ms(),
            trust_project: false,
        }
    }
}

/// Frozen `skeptic.config/1` shape. Top-level extension tables are accepted
/// only when their names begin with `x-`; the loader enforces that invariant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SkepticConfig {
    #[serde(default = "config_schema")]
    pub schema: String,
    pub session: SessionConfig,
    pub runner: RunnerConfig,
    pub doctor: DoctorConfig,
    pub env: EnvironmentConfig,
    pub policy: PolicyConfig,
    pub visual: VisualConfig,
    pub analyzers: BTreeMap<String, AnalyzerConfig>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

impl Default for SkepticConfig {
    fn default() -> Self {
        Self {
            schema: config_schema(),
            session: SessionConfig::default(),
            runner: RunnerConfig::default(),
            doctor: DoctorConfig::default(),
            env: EnvironmentConfig::default(),
            policy: PolicyConfig::default(),
            visual: VisualConfig::default(),
            analyzers: BTreeMap::new(),
            extensions: BTreeMap::new(),
        }
    }
}

impl SkepticConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != CONFIG_SCHEMA {
            return Err(format!("config schema must be {CONFIG_SCHEMA}"));
        }
        if self.session.idle_ttl_ms == 0 {
            return Err("session.idleTtlMs must be greater than zero".to_string());
        }
        if self.session.max_sessions == 0 {
            return Err("session.maxSessions must be greater than zero".to_string());
        }
        if self.runner.action_timeout_ms == 0
            || self.runner.test_timeout_ms == 0
            || self.runner.hard_timeout_ms == 0
            || self.runner.assertion_timeout_ms == 0
            || self.runner.poll_interval_ms == 0
        {
            return Err("runner timeout values must be greater than zero".to_string());
        }
        if self.runner.hard_timeout_ms <= self.runner.test_timeout_ms {
            return Err("runner.hardTimeoutMs must exceed runner.testTimeoutMs".to_string());
        }
        if !(0.0..=1.0).contains(&self.doctor.confidence_threshold) {
            return Err("doctor.confidenceThreshold must be between 0 and 1".to_string());
        }
        if !(0.0..=1.0).contains(&self.visual.threshold) {
            return Err("visual.threshold must be between 0 and 1".to_string());
        }
        if let Some(key) = self.extensions.keys().find(|key| !key.starts_with("x-")) {
            return Err(format!(
                "unknown config key `{key}`; extension keys must start with x-"
            ));
        }
        for (name, analyzer) in &self.analyzers {
            if analyzer.command.is_empty() {
                return Err(format!("analyzers.{name}.command must not be empty"));
            }
            if analyzer.timeout_ms == 0 {
                return Err(format!(
                    "analyzers.{name}.timeoutMs must be greater than zero"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_versioned() {
        let config = SkepticConfig::default();
        assert_eq!(config.schema, CONFIG_SCHEMA);
        config.validate().unwrap();
    }

    #[test]
    fn only_x_prefixed_extensions_are_accepted() {
        let mut config = SkepticConfig::default();
        config.extensions.insert("typo".to_string(), Value::Null);
        assert!(config
            .validate()
            .unwrap_err()
            .contains("unknown config key"));
    }
}
