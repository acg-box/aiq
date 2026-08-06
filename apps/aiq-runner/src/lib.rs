//! Local AIQ benchmark execution, transparent scoring, and signed result exchange.

extern crate self as aiq_runner;

pub mod adapter;
pub mod calibration_verification;
pub mod capacity;
pub mod cli;
pub mod corpus_commitment;
pub mod distributed;
pub mod isolation;
pub mod model;
pub mod normalization;
pub mod protocol;
pub mod public_fixture;
pub mod resume;
pub mod run_validation;
pub mod runner;
pub mod schedule;
pub mod scoring;
pub mod submission;
pub mod task;

mod official_admission;
mod pinned_path;

pub use self::{
	model::{MODEL_MATRIX, ModelConfig},
	scoring::{
		AIQ_BENCHMARK_VERSION, AIQ_MEASUREMENT_VERSION, AIQ_SCORING_VERSION, AIQ_TASK_SET_ID,
		AIQ_TASK_SET_VERSION, LatentAbilityEstimate, ScoreContext, ScoreReport, score_model,
		score_model_with_context,
	},
};

#[cfg(test)]
use std::sync::{PoisonError, RwLockReadGuard};

use clap as _;

#[cfg(test)]
static PROCESS_TEST_ISOLATION: std::sync::RwLock<()> = std::sync::RwLock::new(());

#[cfg(test)]
pub(crate) fn process_test_read_lock() -> RwLockReadGuard<'static, ()> {
	PROCESS_TEST_ISOLATION.read().unwrap_or_else(PoisonError::into_inner)
}
