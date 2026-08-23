//! Public command-line contract.

use std::{
	io::{self, Write as _},
	path::PathBuf,
};

use clap::{Parser, Subcommand};
use serde::Serialize;

use crate::{
	Result, ResultContext,
	config::{Configuration, ProvisionConfiguration},
	provision, release,
	schedule::scheduled_slot,
	workflow,
};

/// Runs and inspects scheduled AIQ observations.
#[derive(Debug, Parser)]
#[command(name = "aiq", version, about)]
pub struct Cli {
	#[command(subcommand)]
	command: Commands,
}
impl Cli {
	/// Executes the selected command.
	///
	/// # Errors
	///
	/// Returns an error when configuration, validation, execution, or output fails.
	pub fn run(self) -> Result<()> {
		match self.command {
			Commands::Run { config, slot } => {
				let configuration = Configuration::read(&config)?;
				let selected = slot.as_deref().map(scheduled_slot).transpose()?;

				workflow::run(&configuration, selected)
			},
			Commands::Status { config } => {
				let configuration = Configuration::read(&config)?;

				write_json(&workflow::status(&configuration)?)
			},
			Commands::Doctor { config } => {
				let configuration = Configuration::read(&config)?;

				write_json(&workflow::doctor(&configuration)?)
			},
			Commands::InstallRelease {
				source_release,
				source_repository,
				destination,
				release_id,
			} => write_json(&release::install_release(
				&source_release,
				&source_repository,
				&destination,
				&release_id,
			)?),
			Commands::Operator { command } => match command {
				OperatorCommands::ProvisionUnattended { config } => {
					let configuration = ProvisionConfiguration::read(&config)?;

					write_json(&provision::provision(&configuration)?)
				},
			},
		}
	}
}

#[derive(Debug, Subcommand)]
enum Commands {
	/// Run or resume one scheduled observation slot.
	Run {
		/// Absolute path to the private runtime configuration.
		#[arg(long)]
		config: PathBuf,
		/// Exact UTC slot to recover; task dispatch is limited to its current 12-hour window.
		#[arg(long)]
		slot: Option<String>,
	},
	/// Show the latest retained state and next UTC slot.
	Status {
		/// Absolute path to the private runtime configuration.
		#[arg(long)]
		config: PathBuf,
	},
	/// Validate the release and reconstruct its source without model work.
	Doctor {
		/// Absolute path to the private runtime configuration.
		#[arg(long)]
		config: PathBuf,
	},
	/// Install a minimal self-contained observation release.
	InstallRelease {
		/// Frozen release directory produced by the controlled release flow.
		#[arg(long)]
		source_release: PathBuf,
		/// Git repository that contains the source commit in the final build receipt.
		#[arg(long)]
		source_repository: PathBuf,
		/// New versioned release directory outside the repository.
		#[arg(long)]
		destination: PathBuf,
		/// Stable filesystem-safe release identity.
		#[arg(long)]
		release_id: String,
	},
	/// Internal operator-only commands.
	#[command(hide = true)]
	Operator {
		#[command(subcommand)]
		command: OperatorCommands,
	},
}

#[derive(Debug, Subcommand)]
enum OperatorCommands {
	/// Create the exact unattended provider identity and Keychain bootstrap once.
	#[command(hide = true)]
	ProvisionUnattended {
		/// Absolute path to the non-secret exact provider setup configuration.
		#[arg(long)]
		config: PathBuf,
	},
}

fn write_json(value: &impl Serialize) -> Result<()> {
	let stdout = io::stdout();
	let mut output = stdout.lock();

	serde_json::to_writer_pretty(&mut output, value).context("cannot write JSON output")?;

	output.write_all(b"\n").context("cannot finish JSON output")
}

#[cfg(test)]
mod tests {
	use clap::{CommandFactory as _, Parser as _};

	use crate::cli::Cli;

	#[test]
	fn parses_primary_workflow_commands() {
		for command in ["run", "status", "doctor"] {
			assert!(
				Cli::try_parse_from(["aiq", command, "--config", "/private/config.json"]).is_ok()
			);
		}
	}

	#[test]
	fn run_accepts_one_explicit_recovery_slot() {
		assert!(
			Cli::try_parse_from([
				"aiq",
				"run",
				"--config",
				"/private/config.json",
				"--slot",
				"2026-08-12T03-00Z",
			])
			.is_ok()
		);
	}

	#[test]
	fn operator_setup_is_parseable_but_not_in_primary_help() {
		assert!(
			Cli::try_parse_from([
				"aiq",
				"operator",
				"provision-unattended",
				"--config",
				"/private/provider.json",
			])
			.is_ok()
		);

		let mut help = Vec::new();

		Cli::command().write_long_help(&mut help).expect("primary help");

		assert!(!String::from_utf8(help).expect("UTF-8 help").contains("operator"));
	}
}
