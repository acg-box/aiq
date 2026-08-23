//! Shipped-binary coverage for the internal process supervisor.

#![cfg(unix)]

use std::ffi::OsStr;
use std::os::unix::process::CommandExt as _;
use std::{
	env, fs,
	io::Error,
	path::{Path, PathBuf},
	process::{self, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use aiq as _;
use clap as _;
use hex as _;
use jiff as _;
use libc::EPERM;
use libc::pid_t;
use serde as _;
use serde_json as _;
use sha2 as _;
use ureq as _;

const INTERNAL_SUPERVISOR_ENV: &str = "AIQ_INTERNAL_PROCESS_SUPERVISOR_V1";
const PARENT_FIXTURE: &str = "AIQ_TEST_PARENT_DEATH_FIXTURE_V1";
const WORKER_FIXTURE: &str = "AIQ_TEST_PARENT_DEATH_WORKER_V1";
const LEAF_FIXTURE: &str = "AIQ_TEST_PARENT_DEATH_LEAF_V1";
const GUARDIAN_PID_PATH: &str = "AIQ_TEST_GUARDIAN_PID_PATH";
const WORKER_PID_PATH: &str = "AIQ_TEST_WORKER_PID_PATH";
const LEAF_PID_PATH: &str = "AIQ_TEST_LEAF_PID_PATH";

#[test]
fn internal_supervisor_runs_the_exact_worker_command() {
	let mut command = Command::new(env!("CARGO_BIN_EXE_aiq"));

	command
		.args(["/bin/sh", "-c", "printf 'guarded-worker-ok\\n'"])
		.env(INTERNAL_SUPERVISOR_ENV, "1")
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());

	configure_new_session(&mut command);

	let mut supervisor = command.spawn().expect("shipped aiq supervisor");
	let _parent_liveness = supervisor.stdin.take().expect("supervisor liveness pipe");
	let output = supervisor.wait_with_output().expect("supervisor output");

	assert!(
		output.status.success(),
		"supervisor failed: {}",
		String::from_utf8_lossy(&output.stderr),
	);
	assert_eq!(output.stdout, b"guarded-worker-ok\n");
}

#[test]
fn parent_sigkill_leaves_no_supervised_descendant() {
	let root = env::temp_dir().join(format!("aiq-parent-death-test-{}", process::id()));
	let _ = fs::remove_dir_all(&root);

	fs::create_dir_all(&root).expect("parent-death fixture root");

	let guardian_pid_path = root.join("guardian.pid");
	let worker_pid_path = root.join("worker.pid");
	let leaf_pid_path = root.join("leaf.pid");
	let executable = env::current_exe().expect("integration test executable");
	let mut parent = Command::new(executable);

	parent
		.args(["--exact", "parent_death_fixture", "--nocapture"])
		.env(PARENT_FIXTURE, "1")
		.env(GUARDIAN_PID_PATH, &guardian_pid_path)
		.env(WORKER_PID_PATH, &worker_pid_path)
		.env(LEAF_PID_PATH, &leaf_pid_path)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());

	let parent = parent.spawn().expect("parent-death fixture");
	let guardian = wait_for_pid(&guardian_pid_path);
	let worker = wait_for_pid(&worker_pid_path);
	let leaf = wait_for_pid(&leaf_pid_path);

	assert_eq!(session_id(worker), guardian);
	assert_eq!(session_id(leaf), guardian);
	assert_ne!(process_group_id(worker), process_group_id(leaf));
	// SAFETY: `parent.id()` is a live positive PID owned by this test.
	assert_eq!(
		unsafe { libc::kill(i32::try_from(parent.id()).expect("parent PID"), libc::SIGKILL) },
		0
	);

	let mut parent = parent;
	let status = parent.wait().expect("reap killed parent fixture");

	assert!(!status.success());

	wait_for_process_exit(worker);
	wait_for_process_exit(leaf);
	wait_for_process_exit(guardian);

	fs::remove_dir_all(root).expect("remove parent-death fixture");
}

#[test]
fn parent_death_fixture() {
	if env::var_os(PARENT_FIXTURE).as_deref() != Some(OsStr::new("1")) {
		return;
	}

	let executable = env::current_exe().expect("parent fixture executable");
	let mut guardian = Command::new(env!("CARGO_BIN_EXE_aiq"));

	guardian
		.arg(executable)
		.args(["--exact", "parent_death_worker_fixture", "--nocapture"])
		.env(INTERNAL_SUPERVISOR_ENV, "1")
		.env(WORKER_FIXTURE, "1")
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::null());

	configure_new_session(&mut guardian);

	let mut guardian = guardian.spawn().expect("aiq guardian fixture");
	let _parent_liveness = guardian.stdin.take().expect("guardian liveness pipe");

	write_pid_from_environment(GUARDIAN_PID_PATH, guardian.id());

	let status = guardian.wait().expect("guardian fixture wait");

	process::exit(status.code().unwrap_or(1));
}

#[test]
fn parent_death_worker_fixture() {
	if env::var_os(LEAF_FIXTURE).as_deref() == Some(OsStr::new("1")) {
		write_pid_from_environment(LEAF_PID_PATH, process::id());

		loop {
			thread::sleep(Duration::from_secs(60));
		}
	}
	if env::var_os(WORKER_FIXTURE).as_deref() != Some(OsStr::new("1")) {
		return;
	}

	write_pid_from_environment(WORKER_PID_PATH, process::id());

	let executable = env::current_exe().expect("worker fixture executable");
	let mut leaf = Command::new(executable);

	leaf.args(["--exact", "parent_death_worker_fixture", "--nocapture"])
		.env(LEAF_FIXTURE, "1")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.process_group(0);

	let mut leaf = leaf.spawn().expect("separate-group leaf fixture");
	let _status = leaf.wait().expect("leaf fixture wait");
}

fn configure_new_session(command: &mut Command) {
	// SAFETY: `setsid` is async-signal-safe and the closure touches no shared
	// process state after `fork` and before `exec`.
	unsafe {
		command.pre_exec(|| if libc::setsid() < 0 { Err(Error::last_os_error()) } else { Ok(()) });
	}
}

fn write_pid_from_environment(variable: &str, process: u32) {
	let path = env::var_os(variable).map(PathBuf::from).expect("fixture PID path");

	fs::write(path, format!("{process}\n")).expect("write fixture PID");
}

fn wait_for_pid(path: &Path) -> pid_t {
	let deadline = Instant::now() + Duration::from_secs(5);

	loop {
		if let Ok(value) = fs::read_to_string(path)
			&& let Ok(process) = value.trim().parse()
		{
			return process;
		}

		assert!(Instant::now() < deadline, "fixture did not write {}", path.display());

		thread::sleep(Duration::from_millis(10));
	}
}

fn wait_for_process_exit(process: pid_t) {
	let deadline = Instant::now() + Duration::from_secs(5);

	while process_exists(process) {
		assert!(Instant::now() < deadline, "process {process} survived supervisor cleanup");

		thread::sleep(Duration::from_millis(10));
	}
}

fn process_exists(process: pid_t) -> bool {
	// SAFETY: Signal zero performs a presence check for a positive process ID.
	let result = unsafe { libc::kill(process, 0) };

	result == 0 || Error::last_os_error().raw_os_error() == Some(EPERM)
}

fn session_id(process: pid_t) -> pid_t {
	// SAFETY: `getsid` accepts any positive process ID.
	let session = unsafe { libc::getsid(process) };

	assert!(session > 0, "fixture session must exist");

	session
}

fn process_group_id(process: pid_t) -> pid_t {
	// SAFETY: `getpgid` accepts any positive process ID.
	let group = unsafe { libc::getpgid(process) };

	assert!(group > 0, "fixture process group must exist");

	group
}
