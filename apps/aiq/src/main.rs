//! AIQ orchestration command-line entry point.

use std::process::ExitCode;

use clap::Parser;
use hex as _;
use jiff as _;
#[cfg(unix)]
use libc as _;
use serde as _;
use serde_json as _;
use sha2 as _;
use ureq as _;

use aiq::cli::Cli;
use aiq::supervisor;

fn main() -> ExitCode {
	if let Some(exit_code) = supervisor::internal_exit_code() {
		return exit_code;
	}

	match Cli::parse().run() {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("aiq: {error}");

			ExitCode::FAILURE
		},
	}
}
