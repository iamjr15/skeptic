use std::path::{Component, Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{require_nonempty, ContractViolation};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Sensitivity {
    Normal,
    Sensitive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RedactionState {
    None,
    Redacted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRef {
    pub kind: String,
    pub rel_path: String,
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    pub sensitivity: Sensitivity,
    pub redaction: RedactionState,
}

impl EvidenceRef {
    pub fn validate(&self) -> Result<(), ContractViolation> {
        require_nonempty("evidence.kind", &self.kind)?;
        require_nonempty("evidence.relPath", &self.rel_path)?;
        require_nonempty("evidence.mediaType", &self.media_type)?;
        require_nonempty("evidence.producer", &self.producer)?;

        let path = Path::new(&self.rel_path);
        let safe_relative = !path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
        if !safe_relative {
            return Err(ContractViolation::new(
                "evidence.relPath",
                "must be run-directory-relative and must not traverse parents",
            ));
        }

        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ContractViolation::new(
                "evidence.sha256",
                "must be a 64-character hexadecimal SHA-256 digest",
            ));
        }
        Ok(())
    }
}
