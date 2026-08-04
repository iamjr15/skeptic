use std::fmt;

/// A contract invariant rejected before data is persisted or emitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractViolation {
    pub path: &'static str,
    pub message: String,
}

impl ContractViolation {
    pub fn new(path: &'static str, message: impl Into<String>) -> Self {
        Self {
            path,
            message: message.into(),
        }
    }
}

impl fmt::Display for ContractViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for ContractViolation {}

pub(crate) fn require_nonempty(path: &'static str, value: &str) -> Result<(), ContractViolation> {
    if value.trim().is_empty() {
        return Err(ContractViolation::new(path, "must not be empty"));
    }
    Ok(())
}
