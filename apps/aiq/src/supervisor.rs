//! Internal process-session supervision for worker commands.

#[cfg(target_os = "linux")]
use std::fs;
use std::io::ErrorKind;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::Child;
use std::ptr;
use std::sync::Arc;
use std::thread::Builder;
use std::{
	collections::BTreeMap,
	env,
	ffi::{OsStr, OsString},
	io::{self, Read},
	mem,
	path::Path,
	process::{self, Command, ExitCode, ExitStatus, Stdio},
	sync::atomic::{AtomicBool, AtomicI32, Ordering},
	thread,
	time::{Duration, Instant},
};

use libc::ESRCH;
use libc::SIG_ERR;
use libc::SIGHUP;
use libc::SIGINT;
use libc::SIGKILL;
use libc::SIGTERM;
use libc::c_int;
use libc::c_void;
use libc::pid_t;
use libc::sighandler_t;

use crate::{Result, ResultContext};

const INTERNAL_SUPERVISOR_ENV: &str = "AIQ_INTERNAL_PROCESS_SUPERVISOR_V1";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const KILL_GRACE: Duration = Duration::from_secs(2);
const SOFTWARE_ERROR_EXIT: u8 = 70;

static TERMINATION_SIGNAL: AtomicI32 = AtomicI32::new(0);

#[derive(Debug)]
enum SupervisionOutcome {
	Worker(ExitStatus),
	ParentClosed,
	Signaled(i32),
}

/// Runs the internal worker supervisor when the private execution marker is set.
///
/// This entry point is not a user-facing CLI command.
#[must_use]
pub fn internal_exit_code() -> Option<ExitCode> {
	if env::var_os(INTERNAL_SUPERVISOR_ENV).as_deref() != Some(OsStr::new("1")) {
		return None;
	}

	Some(match run_internal() {
		Ok(SupervisionOutcome::Worker(status)) => status_exit_code(status),
		Ok(SupervisionOutcome::ParentClosed) => ExitCode::from(128 + SIGTERM as u8),
		Ok(SupervisionOutcome::Signaled(signal)) => signal_exit_code(signal),
		Err(error) => {
			eprintln!("aiq process supervisor: {error}");

			ExitCode::from(SOFTWARE_ERROR_EXIT)
		},
	})
}

#[cfg(test)]
pub(crate) fn guarded_command(
	executable: &Path,
	arguments: &[OsString],
	environment: &BTreeMap<OsString, OsString>,
) -> Result<Command> {
	let mut command = Command::new(executable);

	command.args(arguments).env_clear().envs(environment).stdin(Stdio::piped());

	Ok(command)
}

#[cfg(not(test))]
pub(crate) fn guarded_command(
	executable: &Path,
	arguments: &[OsString],
	environment: &BTreeMap<OsString, OsString>,
) -> Result<Command> {
	let supervisor = env::current_exe().context("cannot resolve the aiq supervisor executable")?;
	let mut command = Command::new(supervisor);

	command
		.arg(executable)
		.args(arguments)
		.env_clear()
		.envs(environment)
		.env(INTERNAL_SUPERVISOR_ENV, "1")
		.stdin(Stdio::piped());

	configure_new_session(&mut command);

	Ok(command)
}

fn run_internal() -> Result<SupervisionOutcome> {
	let mut arguments = env::args_os();
	let _program = arguments.next();
	let executable = arguments.next().ok_or_else(|| {
		crate::Error::new("internal process supervisor requires a worker executable")
	})?;
	let mut worker = Command::new(executable);

	worker
		.args(arguments)
		.env_remove(INTERNAL_SUPERVISOR_ENV)
		.stdin(Stdio::null())
		.stdout(Stdio::inherit())
		.stderr(Stdio::inherit());

	supervise(worker)
}

fn supervise(mut worker: Command) -> Result<SupervisionOutcome> {
	let session = current_supervisor_session()?;

	TERMINATION_SIGNAL.store(0, Ordering::SeqCst);

	install_signal_handlers()?;

	let parent_closed = Arc::new(AtomicBool::new(false));
	let watcher_state = Arc::clone(&parent_closed);

	Builder::new()
		.name("aiq-parent-liveness".to_owned())
		.spawn(move || watch_parent_liveness(&watcher_state))
		.context("cannot start the parent-liveness watcher")?;

	worker.process_group(0);

	let mut child = worker.spawn().context("cannot start the supervised worker")?;

	loop {
		let signal = TERMINATION_SIGNAL.load(Ordering::SeqCst);

		if signal != 0 {
			terminate_session(&mut child, session)?;

			return Ok(SupervisionOutcome::Signaled(signal));
		}
		if parent_closed.load(Ordering::SeqCst) {
			terminate_session(&mut child, session)?;

			return Ok(SupervisionOutcome::ParentClosed);
		}

		if let Some(status) = child.try_wait().context("cannot poll the supervised worker")? {
			let lingering = session_members(session)?;

			if lingering.is_empty() {
				return Ok(SupervisionOutcome::Worker(status));
			}

			terminate_session(&mut child, session)?;

			return Err(crate::Error::new(format!(
				"worker exited while {} descendant process(es) remained",
				lingering.len(),
			)));
		}

		thread::sleep(POLL_INTERVAL);
	}
}

fn watch_parent_liveness(closed: &AtomicBool) {
	let mut input = io::stdin().lock();
	let mut byte = [0_u8; 1];

	loop {
		match input.read(&mut byte) {
			Ok(0) => {
				closed.store(true, Ordering::SeqCst);

				return;
			},
			Ok(_) => {},
			Err(error) if error.kind() == ErrorKind::Interrupted => {},
			Err(_) => {
				closed.store(true, Ordering::SeqCst);

				return;
			},
		}
	}
}

fn current_supervisor_session() -> Result<pid_t> {
	let process = i32::try_from(process::id())
		.context("supervisor process ID is outside the platform range")?;
	// SAFETY: `getsid` accepts any process ID. Zero is not used here.
	let session = unsafe { libc::getsid(0) };

	if session < 0 {
		return Err(crate::Error::new(format!(
			"cannot inspect the process-supervisor session: {}",
			io::Error::last_os_error(),
		)));
	}
	if session != process {
		return Err(crate::Error::new("internal process supervisor must be a session leader"));
	}

	Ok(session)
}

fn configure_new_session(command: &mut Command) {
	// SAFETY: `setsid` is async-signal-safe and the closure performs no access to
	// shared process state after `fork` and before `exec`.
	unsafe {
		command.pre_exec(
			|| {
				if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
			},
		);
	}
}

extern "C" fn record_termination_signal(signal: c_int) {
	TERMINATION_SIGNAL.store(signal, Ordering::SeqCst);
}

fn install_signal_handlers() -> Result<()> {
	for signal in [SIGHUP, SIGINT, SIGTERM] {
		// SAFETY: The handler only stores one integer in a lock-free atomic. One
		// caught termination signal is sufficient because the supervisor drains its
		// process session and exits immediately.
		let previous =
			unsafe { libc::signal(signal, record_termination_signal as *const () as sighandler_t) };

		if previous == SIG_ERR {
			return Err(crate::Error::new(format!(
				"cannot install process-supervisor signal handler: {}",
				io::Error::last_os_error(),
			)));
		}
	}

	Ok(())
}

fn terminate_session(child: &mut Child, session: pid_t) -> Result<()> {
	if drain_session(child, session, SIGTERM, TERMINATE_GRACE)? {
		return Ok(());
	}
	if drain_session(child, session, SIGKILL, KILL_GRACE)? {
		return Ok(());
	}

	Err(crate::Error::new(format!(
		"process supervisor could not terminate every descendant in session {session}",
	)))
}

fn drain_session(
	child: &mut Child,
	session: pid_t,
	signal: c_int,
	grace: Duration,
) -> Result<bool> {
	let deadline = Instant::now() + grace;

	loop {
		let _status = child.try_wait().context("cannot reap the supervised worker")?;
		let members = session_members(session)?;

		if members.is_empty() {
			return Ok(true);
		}

		for process in members {
			signal_session_member(process, session, signal)?;
		}

		if Instant::now() >= deadline {
			return Ok(false);
		}

		thread::sleep(POLL_INTERVAL);
	}
}

fn session_members(session: pid_t) -> Result<Vec<pid_t>> {
	let supervisor = i32::try_from(process::id())
		.context("supervisor process ID is outside the platform range")?;
	let mut members = Vec::new();

	for process in all_process_ids()? {
		if process <= 1 || process == supervisor {
			continue;
		}
		// SAFETY: `getsid` accepts any positive process ID. A failure means the
		// process exited or is not inspectable and therefore is not signalable here.
		if unsafe { libc::getsid(process) } == session {
			members.push(process);
		}
	}

	Ok(members)
}

fn signal_session_member(process: pid_t, session: pid_t, signal: c_int) -> Result<()> {
	// Recheck the session immediately before signaling to narrow the PID-reuse window.
	// SAFETY: Both functions accept any positive process ID and a valid signal.
	let result = unsafe {
		if libc::getsid(process) != session {
			return Ok(());
		}

		libc::kill(process, signal)
	};

	if result == 0 {
		return Ok(());
	}

	let error = io::Error::last_os_error();

	if error.raw_os_error() == Some(ESRCH) {
		Ok(())
	} else {
		Err(crate::Error::new(format!("cannot signal supervised process {process}: {error}",)))
	}
}

#[cfg(target_os = "macos")]
fn all_process_ids() -> Result<Vec<pid_t>> {
	for extra_capacity in [64_usize, 256, 1_024] {
		// SAFETY: A null buffer with size zero asks libproc for the current count.
		let count = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };

		if count < 1 {
			return Err(crate::Error::new(format!(
				"cannot list processes for descendant cleanup: {}",
				io::Error::last_os_error(),
			)));
		}

		let capacity = usize::try_from(count)
			.context("process count is outside the platform range")?
			.saturating_add(extra_capacity);
		let byte_count = capacity
			.checked_mul(mem::size_of::<pid_t>())
			.and_then(|value| i32::try_from(value).ok())
			.ok_or_else(|| {
				crate::Error::new("process-list buffer is outside the platform range")
			})?;
		let mut processes = vec![0; capacity];
		// SAFETY: `processes` is initialized and writable for exactly `byte_count` bytes.
		let listed =
			unsafe { libc::proc_listallpids(processes.as_mut_ptr().cast::<c_void>(), byte_count) };

		if listed < 0 {
			return Err(crate::Error::new(format!(
				"cannot list processes for descendant cleanup: {}",
				io::Error::last_os_error(),
			)));
		}
		if usize::try_from(listed).ok().is_some_and(|listed| listed < capacity) {
			processes.truncate(usize::try_from(listed).unwrap_or_default());

			return Ok(processes);
		}
	}

	Err(crate::Error::new("process list changed too quickly during descendant cleanup"))
}

#[cfg(target_os = "linux")]
fn all_process_ids() -> Result<Vec<pid_t>> {
	let entries = fs::read_dir("/proc").context("cannot list /proc for descendant cleanup")?;
	let mut processes = Vec::new();

	for entry in entries {
		let entry = entry.context("cannot inspect /proc for descendant cleanup")?;
		let name = entry.file_name();
		let Some(name) = name.to_str() else {
			continue;
		};
		let Ok(process) = name.parse::<pid_t>() else {
			continue;
		};

		processes.push(process);
	}

	Ok(processes)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn all_process_ids() -> Result<Vec<pid_t>> {
	Err(crate::Error::new("process-session supervision is supported only on macOS and Linux"))
}

fn status_exit_code(status: ExitStatus) -> ExitCode {
	if status.success() {
		return ExitCode::SUCCESS;
	}

	if let Some(code) = status.code() {
		return ExitCode::from(u8::try_from(code.clamp(1, 255)).unwrap_or(SOFTWARE_ERROR_EXIT));
	}

	status.signal().map_or(ExitCode::from(SOFTWARE_ERROR_EXIT), signal_exit_code)
}

fn signal_exit_code(signal: i32) -> ExitCode {
	let code = 128_i32.saturating_add(signal).clamp(1, 255);

	ExitCode::from(u8::try_from(code).unwrap_or(SOFTWARE_ERROR_EXIT))
}

#[cfg(test)]
mod tests {
	use std::os::unix::process::CommandExt as _;
	use std::{
		env, fs,
		path::{Path, PathBuf},
		process::{self, Command, Stdio},
		thread,
		time::{Duration, Instant},
	};

	use crate::supervisor::{self, SupervisionOutcome};

	const GUARDIAN_FIXTURE: &str = "AIQ_TEST_PROCESS_GUARDIAN_V1";
	const WORKER_FIXTURE: &str = "AIQ_TEST_PROCESS_WORKER_V1";
	const LEAF_FIXTURE: &str = "AIQ_TEST_PROCESS_LEAF_V1";
	const WORKER_PID_PATH: &str = "AIQ_TEST_PROCESS_WORKER_PID_PATH";
	const LEAF_PID_PATH: &str = "AIQ_TEST_PROCESS_LEAF_PID_PATH";

	#[test]
	fn parent_pipe_close_terminates_descendants_in_separate_process_groups() {
		let root = env::temp_dir().join(format!("aiq-supervisor-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);

		fs::create_dir_all(&root).expect("supervisor fixture root");

		let worker_pid_path = root.join("worker.pid");
		let leaf_pid_path = root.join("leaf.pid");
		let executable = env::current_exe().expect("test executable");
		let mut command = Command::new(executable);

		command
			.args(["--exact", "supervisor::tests::process_guardian_fixture", "--nocapture"])
			.env(GUARDIAN_FIXTURE, "1")
			.env(WORKER_PID_PATH, &worker_pid_path)
			.env(LEAF_PID_PATH, &leaf_pid_path)
			.stdin(Stdio::piped())
			.stdout(Stdio::null())
			.stderr(Stdio::piped());

		supervisor::configure_new_session(&mut command);

		let mut guardian = command.spawn().expect("guardian fixture");
		let liveness = guardian.stdin.take().expect("guardian liveness pipe");
		let worker = wait_for_pid(&worker_pid_path);
		let leaf = wait_for_pid(&leaf_pid_path);
		let guardian_pid = i32::try_from(guardian.id()).expect("guardian PID");

		assert_eq!(session_id(worker), guardian_pid);
		assert_eq!(session_id(leaf), guardian_pid);
		assert_ne!(process_group_id(worker), process_group_id(leaf));

		drop(liveness);

		let status = wait_for_child(&mut guardian, Duration::from_secs(8));
		let stderr = guardian
			.stderr
			.take()
			.map(|mut stderr| {
				let mut output = String::new();
				let _ = std::io::Read::read_to_string(&mut stderr, &mut output);

				output
			})
			.unwrap_or_default();

		assert!(status.success(), "guardian fixture failed: {stderr}");

		wait_for_process_exit(worker);
		wait_for_process_exit(leaf);

		fs::remove_dir_all(root).expect("remove supervisor fixture");
	}

	#[test]
	fn process_guardian_fixture() {
		if env::var_os(GUARDIAN_FIXTURE).as_deref() != Some(std::ffi::OsStr::new("1")) {
			return;
		}

		let executable = env::current_exe().expect("guardian test executable");
		let mut worker = Command::new(executable);

		worker
			.args(["--exact", "supervisor::tests::process_worker_fixture", "--nocapture"])
			.env(WORKER_FIXTURE, "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		let result = supervisor::supervise(worker);
		let successful = matches!(result, Ok(SupervisionOutcome::ParentClosed));

		process::exit(i32::from(!successful));
	}

	#[test]
	fn process_worker_fixture() {
		if env::var_os(LEAF_FIXTURE).as_deref() == Some(std::ffi::OsStr::new("1")) {
			write_pid_from_environment(LEAF_PID_PATH);

			loop {
				thread::sleep(Duration::from_secs(60));
			}
		}
		if env::var_os(WORKER_FIXTURE).as_deref() != Some(std::ffi::OsStr::new("1")) {
			return;
		}

		write_pid_from_environment(WORKER_PID_PATH);

		let executable = env::current_exe().expect("worker test executable");
		let mut leaf = Command::new(executable);

		leaf.args(["--exact", "supervisor::tests::process_worker_fixture", "--nocapture"])
			.env(LEAF_FIXTURE, "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.process_group(0);

		let mut leaf = leaf.spawn().expect("separate-group leaf fixture");
		let _status = leaf.wait().expect("leaf fixture wait");
	}

	fn write_pid_from_environment(variable: &str) {
		let path = env::var_os(variable).map(PathBuf::from).expect("fixture PID path");

		fs::write(path, format!("{}\n", process::id())).expect("write fixture PID");
	}

	fn wait_for_pid(path: &Path) -> libc::pid_t {
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

	fn wait_for_child(child: &mut process::Child, timeout: Duration) -> process::ExitStatus {
		let deadline = Instant::now() + timeout;

		loop {
			if let Some(status) = child.try_wait().expect("poll guardian fixture") {
				return status;
			}

			if Instant::now() >= deadline {
				let _ = child.kill();
				let _ = child.wait();

				panic!("guardian fixture timed out");
			}

			thread::sleep(Duration::from_millis(10));
		}
	}

	fn wait_for_process_exit(process: libc::pid_t) {
		let deadline = Instant::now() + Duration::from_secs(5);

		while process_exists(process) {
			assert!(Instant::now() < deadline, "process {process} survived supervisor cleanup");

			thread::sleep(Duration::from_millis(10));
		}
	}

	fn process_exists(process: libc::pid_t) -> bool {
		// SAFETY: Signal zero performs a presence check for a positive process ID.
		let result = unsafe { libc::kill(process, 0) };

		result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
	}

	fn session_id(process: libc::pid_t) -> libc::pid_t {
		// SAFETY: `getsid` accepts any positive process ID.
		let session = unsafe { libc::getsid(process) };

		assert!(session > 0, "fixture session must exist");

		session
	}

	fn process_group_id(process: libc::pid_t) -> libc::pid_t {
		// SAFETY: `getpgid` accepts any positive process ID.
		let group = unsafe { libc::getpgid(process) };

		assert!(group > 0, "fixture process group must exist");

		group
	}
}
