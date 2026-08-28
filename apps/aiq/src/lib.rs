//! Scheduled AIQ observation orchestration.

pub mod cli;
pub mod config;
pub mod release;
pub mod schedule;
pub mod supervisor;
pub mod workflow;

mod credentials;
mod lock;
mod provision;

use std::{
	error,
	fmt::{self, Display, Formatter},
};

/// Result type used by the orchestrator.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
pub(crate) static TEST_ENVIRONMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) trait ResultContext<T> {
	fn context(self, message: impl Display) -> Result<T>;
}

/// An orchestration failure with a safe operator-facing message.
#[derive(Debug)]
pub struct Error {
	kind: ErrorKind,
	message: String,
}
impl Error {
	/// Creates an error from an operator-facing message.
	#[must_use]
	pub fn new(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::General, message: message.into() }
	}

	pub(crate) fn subscription_backpressure(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::SubscriptionBackpressure, message: message.into() }
	}

	pub(crate) fn verifier_rejection(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::VerifierRejection, message: message.into() }
	}

	pub(crate) fn is_subscription_backpressure(&self) -> bool {
		self.kind == ErrorKind::SubscriptionBackpressure
	}

	pub(crate) fn is_verifier_rejection(&self) -> bool {
		self.kind == ErrorKind::VerifierRejection
	}
}

impl Display for Error {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl error::Error for Error {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ErrorKind {
	General,
	SubscriptionBackpressure,
	VerifierRejection,
}
impl<T, E> ResultContext<T> for std::result::Result<T, E>
where
	E: Display,
{
	fn context(self, message: impl Display) -> Result<T> {
		self.map_err(|error| Error::new(format!("{message}: {error}")))
	}
}
