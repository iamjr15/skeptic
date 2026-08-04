use std::collections::BTreeMap;

use schemars::{schema_for, JsonSchema};
use serde_json::{json, Value};

use crate::{
    Diagnostic, EventEnvelope, ResponseEnvelope, RunManifest, SkepticConfig, CONFIG_SCHEMA,
    DIAGNOSTIC_SCHEMA, ENVELOPE_SCHEMA, EVENT_SCHEMA, RUN_SCHEMA,
};

fn published_schema<T: JsonSchema>(id: &str, schema_value: Option<&str>) -> Value {
    let schema = schema_for!(T);
    let mut value = serde_json::to_value(schema).expect("JSON Schema must serialize");
    let object = value
        .as_object_mut()
        .expect("schemars root schema must be a JSON object");
    object.insert("$id".to_string(), json!(id));
    object.insert(
        "x-skeptic-version".to_string(),
        json!(env!("CARGO_PKG_VERSION")),
    );
    if let Some(schema_value) = schema_value {
        object
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .and_then(|properties| properties.get_mut("schema"))
            .and_then(Value::as_object_mut)
            .expect("versioned contract must expose a schema property")
            .insert("const".to_string(), json!(schema_value));
    }
    value
}

fn event_schema() -> Value {
    let mut schema = published_schema::<EventEnvelope>(EVENT_SCHEMA, Some(EVENT_SCHEMA));
    schema
        .as_object_mut()
        .expect("event schema must be an object")
        .insert(
            "allOf".to_string(),
            json!([{
                "anyOf": [
                    {
                        "properties": { "runId": { "type": "string", "minLength": 1 } },
                        "required": ["runId"]
                    },
                    {
                        "properties": { "sessionId": { "type": "string", "minLength": 1 } },
                        "required": ["sessionId"]
                    }
                ]
            }]),
        );
    schema
}

/// All schemas currently intended for publication.
pub fn published_schemas() -> BTreeMap<&'static str, Value> {
    BTreeMap::from([
        (
            CONFIG_SCHEMA,
            published_schema::<SkepticConfig>(CONFIG_SCHEMA, Some(CONFIG_SCHEMA)),
        ),
        (
            DIAGNOSTIC_SCHEMA,
            published_schema::<Diagnostic>(DIAGNOSTIC_SCHEMA, None),
        ),
        (EVENT_SCHEMA, event_schema()),
        (
            ENVELOPE_SCHEMA,
            published_schema::<ResponseEnvelope<Value>>(ENVELOPE_SCHEMA, None),
        ),
        (
            RUN_SCHEMA,
            published_schema::<RunManifest>(RUN_SCHEMA, Some(RUN_SCHEMA)),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use crate::{
        ApiError, EventEnvelope, ExitCode, ResponseEnvelope, SideEffects, EVENT_SCHEMA, EXIT_TABLE,
    };

    use super::*;

    #[test]
    fn every_published_schema_has_its_contract_id() {
        for (id, schema) in published_schemas() {
            assert_eq!(schema["$id"], id);
            assert!(schema.get("$schema").is_some());
        }
        let schemas = published_schemas();
        assert_eq!(
            schemas[EVENT_SCHEMA]["properties"]["schema"]["const"],
            EVENT_SCHEMA
        );
        assert_eq!(
            schemas[RUN_SCHEMA]["properties"]["schema"]["const"],
            RUN_SCHEMA
        );
        assert!(schemas[EVENT_SCHEMA].get("allOf").is_some());
    }

    #[test]
    fn exit_table_is_unique_and_matches_stable_codes() {
        let codes: BTreeSet<_> = EXIT_TABLE.iter().map(|entry| entry.code).collect();
        let names: BTreeSet<_> = EXIT_TABLE.iter().map(|entry| entry.name).collect();
        assert_eq!(codes.len(), EXIT_TABLE.len());
        assert_eq!(names.len(), EXIT_TABLE.len());
        assert_eq!(ExitCode::Ok.code(), 0);
        assert_eq!(ExitCode::AssertionFailed.code(), 1);
        assert_eq!(ExitCode::Usage.code(), 2);
        assert_eq!(ExitCode::TargetUnreachable.code(), 3);
        assert_eq!(ExitCode::StaleRef.code(), 4);
        assert_eq!(ExitCode::Timeout.code(), 5);
        assert_eq!(ExitCode::EnvMissing.code(), 6);
        assert_eq!(ExitCode::PolicyBlocked.code(), 7);
        assert_eq!(ExitCode::AnalyzerFailed.code(), 8);
        assert_eq!(ExitCode::Internal.code(), 10);
    }

    #[test]
    fn event_requires_a_run_or_session_identity() {
        let event = EventEnvelope {
            schema: EVENT_SCHEMA.to_string(),
            stream_id: "stream-1".to_string(),
            sequence: 1,
            event_type: "step".to_string(),
            run_id: None,
            session_id: None,
            timestamp: "2026-07-20T00:00:00Z".to_string(),
            correlation_id: None,
            payload: json!({}),
        };
        assert!(event.validate().is_err());
    }

    #[test]
    fn response_envelope_enforces_success_error_exclusivity() {
        let success = ResponseEnvelope::success(json!({"value": 42}), "skeptic.test/1", 3);
        assert!(success.validate().is_ok());

        let failure = ResponseEnvelope::<Value>::failure(
            ApiError {
                code: "E_STALE_REF".to_string(),
                message: "reference expired".to_string(),
                retryable: true,
                hint: Some("take a fresh snapshot".to_string()),
            },
            2,
            SideEffects::Possible,
        );
        assert!(failure.validate().is_ok());
    }
}
