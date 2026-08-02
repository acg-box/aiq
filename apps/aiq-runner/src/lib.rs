//! Local AIQ benchmark execution, transparent scoring, and signed result exchange.

extern crate self as aiq_runner;

pub mod adapter;
pub mod capacity;
pub mod cli;
pub mod corpus_commitment;
pub mod distributed;
pub mod isolation;
pub mod model;
pub mod normalization;
pub mod protocol;
pub mod resume;
pub mod run_validation;
pub mod runner;
pub mod schedule;
pub mod scoring;
pub mod submission;
pub mod task;

mod pinned_path;

pub use self::{
	model::{MODEL_MATRIX, ModelConfig},
	scoring::{
		AIQ_SCORING_VERSION, ScoreContext, ScoreReport, score_model, score_model_with_context,
	},
};

use clap as _;
#[cfg(test)]
use std::sync::PoisonError;
#[cfg(test)]
use std::sync::RwLockReadGuard;

#[cfg(test)]
static PROCESS_TEST_ISOLATION: std::sync::RwLock<()> = std::sync::RwLock::new(());

#[cfg(test)]
pub(crate) fn process_test_read_lock() -> RwLockReadGuard<'static, ()> {
	PROCESS_TEST_ISOLATION.read().unwrap_or_else(PoisonError::into_inner)
}
