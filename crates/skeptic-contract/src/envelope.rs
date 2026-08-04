use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ContractViolation, ENVELOPE_SCHEMA};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SideEffects {
    None,
    Possible,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Warning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvelopeMeta {
    pub schema: String,
    pub version: String,
    pub duration_ms: u64,
    pub side_effects: SideEffects,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponseEnvelope<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
    #[serde(default)]
    pub warnings: Vec<Warning>,
    pub meta: EnvelopeMeta,
}

impl<T> ResponseEnvelope<T> {
    pub fn success(data: T, payload_schema: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
            warnings: Vec::new(),
            meta: EnvelopeMeta {
                schema: payload_schema.into(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                duration_ms,
                side_effects: SideEffects::None,
                truncated: false,
                total: None,
                cursor: None,
            },
        }
    }

    pub fn failure(error: ApiError, duration_ms: u64, side_effects: SideEffects) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(error),
            warnings: Vec::new(),
            meta: EnvelopeMeta {
                schema: ENVELOPE_SCHEMA.to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                duration_ms,
                side_effects,
                truncated: false,
                total: None,
                cursor: None,
            },
        }
    }

    pub fn validate(&self) -> Result<(), ContractViolation> {
        match (self.ok, self.data.is_some(), self.error.is_some()) {
            (true, true, false) | (false, false, true) => {}
            _ => {
                return Err(ContractViolation::new(
                    "envelope",
                    "ok=true requires data only; ok=false requires error only",
                ));
            }
        }
        if !self.meta.truncated && (self.meta.total.is_some() || self.meta.cursor.is_some()) {
            return Err(ContractViolation::new(
                "envelope.meta",
                "total/cursor may only be present when truncated is true",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    Ok = 0,
    AssertionFailed = 1,
    Usage = 2,
    TargetUnreachable = 3,
    StaleRef = 4,
    Timeout = 5,
    EnvMissing = 6,
    PolicyBlocked = 7,
    AnalyzerFailed = 8,
    Internal = 10,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitDefinition {
    pub code: i32,
    pub name: &'static str,
    pub retryable: bool,
}

pub const EXIT_TABLE: [ExitDefinition; 10] = [
    ExitDefinition {
        code: 0,
        name: "OK",
        retryable: false,
    },
    ExitDefinition {
        code: 1,
        name: "ASSERTION_FAILED",
        retryable: false,
    },
    ExitDefinition {
        code: 2,
        name: "USAGE",
        retryable: false,
    },
    ExitDefinition {
        code: 3,
        name: "TARGET_UNREACHABLE",
        retryable: true,
    },
    ExitDefinition {
        code: 4,
        name: "STALE_REF",
        retryable: true,
    },
    ExitDefinition {
        code: 5,
        name: "TIMEOUT",
        retryable: true,
    },
    ExitDefinition {
        code: 6,
        name: "ENV_MISSING",
        retryable: false,
    },
    ExitDefinition {
        code: 7,
        name: "POLICY_BLOCKED",
        retryable: false,
    },
    ExitDefinition {
        code: 8,
        name: "ANALYZER_FAILED",
        retryable: true,
    },
    ExitDefinition {
        code: 10,
        name: "INTERNAL",
        retryable: true,
    },
];

impl ExitCode {
    pub const fn code(self) -> i32 {
        self as i32
    }
}
