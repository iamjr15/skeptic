//! Strict `skeptic.toml` discovery, inheritance, hashing, and environment
//! filtering. Configuration is data; loading it never executes project code.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use skeptic_contract::{SkepticConfig, CONFIG_SCHEMA};
use toml::Value;

pub const CONFIG_FILENAME: &str = "skeptic.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigOverrides {
    pub idle_ttl_ms: Option<u64>,
    pub max_sessions: Option<usize>,
    pub action_timeout_ms: Option<u64>,
    pub test_timeout_ms: Option<u64>,
    pub hard_timeout_ms: Option<u64>,
    pub assertion_timeout_ms: Option<u64>,
    pub poll_interval_ms: Option<u64>,
    pub retries: Option<u32>,
    pub allowed_domains: Option<Vec<String>>,
    pub allow_project_commands: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedConfig {
    pub config: SkepticConfig,
    pub config_hash: String,
    pub sources: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct ConfigError {
    pub path: Option<PathBuf>,
    pub message: String,
}

impl ConfigError {
    fn new(path: Option<&Path>, message: impl Into<String>) -> Self {
        Self {
            path: path.map(Path::to_path_buf),
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.path {
            Some(path) => write!(formatter, "{}: {}", path.display(), self.message),
            None => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for ConfigError {}

fn read_value(path: &Path) -> Result<Value, ConfigError> {
    let source = fs::read_to_string(path)
        .map_err(|error| ConfigError::new(Some(path), format!("cannot read config: {error}")))?;
    let value = toml::from_str::<Value>(&source)
        .map_err(|error| ConfigError::new(Some(path), format!("invalid TOML: {error}")))?;
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(|| ConfigError::new(Some(path), "missing `schema = \"skeptic.config/1\"`"))?;
    if schema != CONFIG_SCHEMA {
        return Err(ConfigError::new(
            Some(path),
            format!("unsupported schema `{schema}`; expected `{CONFIG_SCHEMA}`"),
        ));
    }
    Ok(value)
}

/// Merge `overlay` into `base`. Tables deep-merge; every other value,
/// including arrays, replaces the lower-precedence value wholesale.
fn merge_value(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Table(base), Value::Table(overlay)) => {
            for (key, value) in overlay {
                match base.get_mut(&key) {
                    Some(existing) => merge_value(existing, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (base, overlay) => *base = overlay,
    }
}

fn project_root(start: &Path) -> PathBuf {
    let start = if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    };
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        let Some(parent) = current.parent() else {
            return current;
        };
        current = parent.to_path_buf();
    }
}

pub fn discover_project_configs(start: &Path) -> Vec<PathBuf> {
    let root = project_root(start);
    let start = if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    };
    let mut current = start.to_path_buf();
    let mut paths = Vec::new();
    loop {
        let candidate = current.join(CONFIG_FILENAME);
        if candidate.is_file() {
            paths.push(candidate);
        }
        if current == root || !current.pop() {
            break;
        }
    }
    paths.reverse();
    paths
}

pub fn user_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let native = dirs::home_dir().map(|home| {
        home.join("Library")
            .join("Application Support")
            .join("skeptic")
            .join(CONFIG_FILENAME)
    });

    #[cfg(target_os = "windows")]
    let native = dirs::config_dir().map(|dir| dir.join("skeptic").join(CONFIG_FILENAME));

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let native = dirs::config_dir().map(|dir| dir.join("skeptic").join(CONFIG_FILENAME));

    if native.as_ref().is_some_and(|path| path.is_file()) {
        return native;
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let fallback =
            dirs::home_dir().map(|home| home.join(".config").join("skeptic").join(CONFIG_FILENAME));
        if fallback.as_ref().is_some_and(|path| path.is_file()) {
            return fallback;
        }
    }

    None
}

fn parse_bool(name: &str, value: &str) -> Result<bool, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::new(
            None,
            format!("{name} must be true or false"),
        )),
    }
}

fn env_u64(name: &str) -> Result<Option<u64>, ConfigError> {
    env::var(name)
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|_| ConfigError::new(None, format!("{name} must be an unsigned integer")))
        })
        .transpose()
}

fn env_usize(name: &str) -> Result<Option<usize>, ConfigError> {
    env::var(name)
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|_| ConfigError::new(None, format!("{name} must be an unsigned integer")))
        })
        .transpose()
}

fn env_u32(name: &str) -> Result<Option<u32>, ConfigError> {
    env::var(name)
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|_| ConfigError::new(None, format!("{name} must be an unsigned integer")))
        })
        .transpose()
}

fn environment_overrides() -> Result<ConfigOverrides, ConfigError> {
    Ok(ConfigOverrides {
        idle_ttl_ms: env_u64("SKEPTIC_SESSION_IDLE_TTL_MS")?,
        max_sessions: env_usize("SKEPTIC_MAX_SESSIONS")?,
        action_timeout_ms: env_u64("SKEPTIC_ACTION_TIMEOUT_MS")?,
        test_timeout_ms: env_u64("SKEPTIC_TEST_TIMEOUT_MS")?,
        hard_timeout_ms: env_u64("SKEPTIC_HARD_TIMEOUT_MS")?,
        assertion_timeout_ms: env_u64("SKEPTIC_ASSERTION_TIMEOUT_MS")?,
        poll_interval_ms: env_u64("SKEPTIC_POLL_INTERVAL_MS")?,
        retries: env_u32("SKEPTIC_RETRIES")?,
        allowed_domains: env::var("SKEPTIC_ALLOWED_DOMAINS").ok().map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        }),
        allow_project_commands: env::var("SKEPTIC_ALLOW_PROJECT_COMMANDS")
            .ok()
            .map(|value| parse_bool("SKEPTIC_ALLOW_PROJECT_COMMANDS", &value))
            .transpose()?,
    })
}

fn apply_overrides(config: &mut SkepticConfig, overrides: &ConfigOverrides) {
    if let Some(value) = overrides.idle_ttl_ms {
        config.session.idle_ttl_ms = value;
    }
    if let Some(value) = overrides.max_sessions {
        config.session.max_sessions = value;
    }
    if let Some(value) = overrides.action_timeout_ms {
        config.runner.action_timeout_ms = value;
    }
    if let Some(value) = overrides.test_timeout_ms {
        config.runner.test_timeout_ms = value;
    }
    if let Some(value) = overrides.hard_timeout_ms {
        config.runner.hard_timeout_ms = value;
    }
    if let Some(value) = overrides.assertion_timeout_ms {
        config.runner.assertion_timeout_ms = value;
    }
    if let Some(value) = overrides.poll_interval_ms {
        config.runner.poll_interval_ms = value;
    }
    if let Some(value) = overrides.retries {
        config.runner.retries = value;
    }
    if let Some(value) = &overrides.allowed_domains {
        config.policy.allowed_domains.clone_from(value);
    }
    if let Some(value) = overrides.allow_project_commands {
        config.policy.allow_project_commands = value;
    }
}

fn config_hash(config: &SkepticConfig) -> Result<String, ConfigError> {
    let bytes = serde_json::to_vec(config)
        .map_err(|error| ConfigError::new(None, format!("cannot hash config: {error}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub fn load(
    start: &Path,
    explicit: Option<&Path>,
    cli: ConfigOverrides,
) -> Result<ResolvedConfig, ConfigError> {
    let mut merged = Value::Table(toml::map::Map::new());
    let mut sources = Vec::new();

    if let Some(user) = user_config_path() {
        merge_value(&mut merged, read_value(&user)?);
        sources.push(user);
    }

    let project_sources = match explicit {
        Some(path) => vec![path.to_path_buf()],
        None => discover_project_configs(start),
    };
    for path in project_sources {
        merge_value(&mut merged, read_value(&path)?);
        sources.push(path);
    }

    if merged.as_table().is_some_and(|table| table.is_empty()) {
        merged = Value::try_from(SkepticConfig::default())
            .map_err(|error| ConfigError::new(None, format!("cannot build defaults: {error}")))?;
    }

    let mut config: SkepticConfig = merged.try_into().map_err(|error| {
        ConfigError::new(
            sources.last().map(PathBuf::as_path),
            format!("invalid config: {error}"),
        )
    })?;
    config.schema = CONFIG_SCHEMA.to_string();
    apply_overrides(&mut config, &environment_overrides()?);
    apply_overrides(&mut config, &cli);
    config
        .validate()
        .map_err(|error| ConfigError::new(sources.last().map(PathBuf::as_path), error))?;

    Ok(ResolvedConfig {
        config_hash: config_hash(&config)?,
        config,
        sources,
    })
}

fn wildcard_matches(pattern: &str, candidate: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let Some(star) = pattern.find('*') else {
        return pattern == candidate;
    };
    let (prefix, suffix) = pattern.split_at(star);
    candidate.starts_with(prefix) && candidate.ends_with(&suffix[1..])
}

fn sensitive_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("TOKEN")
        || upper.contains("KEY")
        || upper.contains("SECRET")
        || upper.starts_with("AWS_")
        || upper.contains("PASSWORD")
        || upper.contains("CREDENTIAL")
}

fn allowed_name(pass: &[String], name: &str) -> bool {
    let matched = pass.iter().any(|pattern| wildcard_matches(pattern, name));
    let explicitly_named = pass.iter().any(|pattern| pattern == name);
    matched && (!sensitive_name(name) || explicitly_named)
}

/// Build the exact child-process/isolate environment. Sensitive names matched
/// only through a wildcard stay stripped; an exact allowlist entry is needed.
pub fn filtered_environment(pass: &[String]) -> BTreeMap<String, String> {
    env::vars()
        .filter(|(name, _)| allowed_name(pass, name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, source: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }

    #[test]
    fn arrays_replace_and_tables_deep_merge() {
        let mut base: Value = toml::from_str(
            r#"
            schema = "skeptic.config/1"
            [env]
            pass = ["FIRST", "SECOND"]
            [runner]
            retries = 1
            testTimeoutMs = 10
        "#,
        )
        .unwrap();
        let overlay: Value = toml::from_str(
            r#"
            [env]
            pass = ["ONLY"]
            [runner]
            retries = 2
        "#,
        )
        .unwrap();
        merge_value(&mut base, overlay);
        assert_eq!(base["env"]["pass"].as_array().unwrap().len(), 1);
        assert_eq!(base["runner"]["retries"].as_integer(), Some(2));
        assert_eq!(base["runner"]["testTimeoutMs"].as_integer(), Some(10));
    }

    #[test]
    fn discovers_root_to_leaf() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        let leaf = temp.path().join("packages/app/src");
        fs::create_dir_all(&leaf).unwrap();
        write(
            &temp.path().join(CONFIG_FILENAME),
            "schema = \"skeptic.config/1\"\n",
        );
        write(
            &temp.path().join("packages/app").join(CONFIG_FILENAME),
            "schema = \"skeptic.config/1\"\n",
        );
        let found = discover_project_configs(&leaf);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], temp.path().join(CONFIG_FILENAME));
    }

    #[test]
    fn rejects_unknown_nested_keys() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join(CONFIG_FILENAME);
        write(
            &config,
            "schema = \"skeptic.config/1\"\n[runner]\ntimeuotMs = 10\n",
        );
        let error = load(temp.path(), Some(&config), ConfigOverrides::default()).unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn wildcard_rules_require_exact_sensitive_opt_in() {
        assert!(allowed_name(&["PUBLIC_*".into()], "PUBLIC_VALUE"));
        assert!(!allowed_name(
            &["SKEPTIC_TEST_*".into()],
            "SKEPTIC_TEST_SECRET_TOKEN"
        ));
        assert!(allowed_name(
            &["SKEPTIC_TEST_SECRET_TOKEN".into()],
            "SKEPTIC_TEST_SECRET_TOKEN"
        ));
    }
}
