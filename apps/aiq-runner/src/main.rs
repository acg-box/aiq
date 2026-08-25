//! AIQ runner command-line entry point.

use std::process::ExitCode;

use clap::Parser;
use ed25519_dalek as _;
use hex as _;
use jiff as _;
use jiff_tzdb as _;
#[cfg(unix)]
use libc as _;
use serde as _;
use serde_json as _;
use serde_json_canonicalizer as _;
use sha2 as _;
use ureq as _;
#[cfg(windows)]
use windows_sys as _;

use aiq_runner::cli::Cli;
use aiq_runner::runner::RunnerError;

fn main() -> ExitCode {
	match Cli::parse().run() {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("aiq-runner: {error}");

			error
				.downcast_ref::<RunnerError>()
				.map_or(ExitCode::FAILURE, |error| ExitCode::from(error.exit_code()))
		},
	}
}
