use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{require_nonempty, ContractViolation, EVENT_SCHEMA};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    pub schema: String,
    pub stream_id: String,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub payload: Value,
}

impl EventEnvelope {
    pub fn validate(&self) -> Result<(), ContractViolation> {
        if self.schema != EVENT_SCHEMA {
            return Err(ContractViolation::new(
                "event.schema",
                format!("expected {EVENT_SCHEMA}"),
            ));
        }
        require_nonempty("event.streamId", &self.stream_id)?;
        require_nonempty("event.type", &self.event_type)?;
        require_nonempty("event.timestamp", &self.timestamp)?;
        if self.run_id.as_deref().is_none_or(str::is_empty)
            && self.session_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(ContractViolation::new(
                "event",
                "runId or sessionId must be present",
            ));
        }
        Ok(())
    }
}
