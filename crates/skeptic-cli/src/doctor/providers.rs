// Derived from vercel-labs/agent-browser v0.32.2 (Apache-2.0); modified by Skeptic.
//! Check remote browser providers: API key presence for Browserless,
//! Browserbase, Browser Use, Kernel, and AgentCore (AWS). Info-level unless
//! the provider is selected via `SKEPTIC_PROVIDER`.

use std::env;

use super::{Check, Status};

pub(super) fn check(checks: &mut Vec<Check>) {
    let category = "Providers";

    let active = env::var("SKEPTIC_PROVIDER").ok();
    let normalized = active
        .as_ref()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let active_status = |provider: &str, ok: bool| -> Status {
        if normalized == provider {
            if ok {
                Status::Pass
            } else {
                Status::Fail
            }
        } else {
            Status::Info
        }
    };

    let providers: &[(&str, &[&str], &str)] = &[
        ("browserless", &["BROWSERLESS_API_KEY"], "Browserless"),
        ("browserbase", &["BROWSERBASE_API_KEY"], "Browserbase"),
        ("browseruse", &["BROWSER_USE_API_KEY"], "Browser Use"),
        ("kernel", &["KERNEL_API_KEY"], "Kernel"),
    ];

    for (id, env_keys, label) in providers {
        let present = env_keys.iter().any(|k| env::var(k).is_ok());
        let provider_id = *id;
        let status = active_status(provider_id, present);
        let msg = if present {
            format!("{}: API key present", label)
        } else {
            format!("{}: {} not set", label, env_keys.join(" / "))
        };
        let mut check = Check::new(format!("providers.{}", provider_id), category, status, msg);
        if status == Status::Fail {
            check = check.with_fix(format!(
                "set {} (or unset SKEPTIC_PROVIDER={})",
                env_keys.first().copied().unwrap_or(""),
                provider_id
            ));
        }
        checks.push(check);
    }

    let aws_present = env::var("AWS_ACCESS_KEY_ID").is_ok()
        || env::var("AWS_PROFILE").is_ok()
        || env::var("AWS_SESSION_TOKEN").is_ok();
    let agentcore_status = active_status("agentcore", aws_present);
    let mut agentcore_check = Check::new(
        "providers.agentcore",
        category,
        agentcore_status,
        if aws_present {
            "AgentCore: AWS credentials resolvable".to_string()
        } else {
            "AgentCore: no AWS credentials in env (AWS_ACCESS_KEY_ID / AWS_PROFILE)".to_string()
        },
    );
    if agentcore_status == Status::Fail {
        agentcore_check = agentcore_check
            .with_fix("export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or AWS_PROFILE");
    }
    checks.push(agentcore_check);

    if let Some(active) = active {
        checks.push(Check::new(
            "providers.active",
            category,
            Status::Info,
            format!("SKEPTIC_PROVIDER = {}", active),
        ));
    }
}
