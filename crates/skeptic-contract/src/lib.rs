//! Versioned serialized contracts shared by every Skeptic surface.
//!
//! M1 is the compatibility freeze. Until then these types are pre-freeze, but
//! all producers and consumers should converge here instead of inventing local
//! JSON shapes.

#![forbid(unsafe_code)]

mod config;
mod diagnostic;
mod envelope;
mod error;
mod event;
mod evidence;
mod manifest;
mod schema;

pub use config::*;
pub use diagnostic::*;
pub use envelope::*;
pub use error::*;
pub use event::*;
pub use evidence::*;
pub use manifest::*;
pub use schema::*;

pub const RUN_SCHEMA: &str = "skeptic.run/2";
pub const EVENT_SCHEMA: &str = "skeptic.event/1";
pub const DIAGNOSTIC_SCHEMA: &str = "skeptic.diagnostic/1";
pub const ENVELOPE_SCHEMA: &str = "skeptic.envelope/1";
pub const SCORE_FORMULA: &str = "skeptic.score/1";
pub const CONFIG_SCHEMA: &str = "skeptic.config/1";
