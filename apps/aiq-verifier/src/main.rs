//! AIQ verifier worker command.

use std::process::ExitCode;

use aiq_runner as _;
use clap as _;
use hex as _;
use libc as _;
use serde as _;
use serde_json as _;
use sha2 as _;
use ureq as _;

fn main() -> ExitCode {
	match aiq_verifier::run_cli() {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("aiq-verifier: {error}");

			ExitCode::FAILURE
		},
	}
}

#[cfg(test)]
mod tests {
	use ed25519_dalek::SigningKey;

	#[test]
	fn verifier_test_signing_key_has_expected_width() {
		assert_eq!(SigningKey::from_bytes(&[0; 32]).to_bytes().len(), 32);
	}
}
