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
