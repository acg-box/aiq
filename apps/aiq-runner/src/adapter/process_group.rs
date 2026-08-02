//! Platform-specific lifecycle for a child and members that remain in its original process group.

#[cfg(all(test, unix))]
mod tests {
	use std::{env, process::Stdio};

	use crate::adapter::process_group::{
		Command, Duration, Instant, ProcessGroupPoll, cleanup_after_poll, configure,
		kill_and_reap_group, poll_exit_without_reaping, thread,
	};

	#[test]
	fn exit_poll_keeps_the_group_leader_waitable_until_cleanup() {
		let mut command = Command::new(env::current_exe().expect("current test executable"));

		command
			.args(["--exact", "adapter::process_group::tests::nonexistent_child_fixture"])
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		configure(&mut command);

		let deadline = Instant::now() + Duration::from_secs(1);
		let mut child = command.spawn().expect("poll fixture child");

		while poll_exit_without_reaping(&mut child).expect("first non-reaping poll")
			== ProcessGroupPoll::Running
		{
			assert!(Instant::now() < deadline, "poll fixture child did not exit");

			thread::sleep(Duration::from_millis(1));
		}

		assert_eq!(
			poll_exit_without_reaping(&mut child).expect("second non-reaping poll"),
			ProcessGroupPoll::Exited,
			"WNOWAIT must leave the exited group leader waitable"
		);

		cleanup_after_poll(&mut child, ProcessGroupPoll::Exited).expect("exited group cleanup");
	}

	#[test]
	fn not_signalable_poll_outcome_never_signals_the_cached_group_id() {
		let mut command = Command::new(env::current_exe().expect("current test executable"));

		command
			.args(["--exact", "adapter::process_group::tests::non_signalable_live_child_fixture"])
			.env("AIQ_NON_SIGNALABLE_CHILD", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		configure(&mut command);

		let mut child = command.spawn().expect("non-signalable fixture child");
		let error = cleanup_after_poll(&mut child, ProcessGroupPoll::NotSignalable)
			.expect_err("ECHILD-equivalent state must fail without signaling");

		assert_eq!(error.source.raw_os_error(), Some(libc::ECHILD));

		let observation_deadline = Instant::now() + Duration::from_millis(100);

		while Instant::now() < observation_deadline {
			assert_eq!(
				child.try_wait().expect("fixture child status"),
				None,
				"the non-signalable branch must not signal the live fixture group"
			);

			thread::sleep(Duration::from_millis(1));
		}

		kill_and_reap_group(&mut child).expect("exact test-owned group cleanup");
	}

	#[test]
	fn externally_reaped_child_maps_to_not_signalable() {
		let mut command = Command::new(env::current_exe().expect("current test executable"));

		command
			.args(["--exact", "adapter::process_group::tests::non_signalable_live_child_fixture"])
			.env("AIQ_NON_SIGNALABLE_CHILD", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		configure(&mut command);

		let mut child = command.spawn().expect("externally reaped fixture child");
		let child_pid = i32::try_from(child.id()).expect("fixture PID");

		// SAFETY: This test owns the exact child PID, then performs the external
		// reap needed to make Rust's still-live Child handle observe ECHILD.
		assert_eq!(unsafe { libc::kill(child_pid, libc::SIGKILL) }, 0);

		let mut status = 0;

		assert_eq!(unsafe { libc::waitpid(child_pid, &mut status, 0) }, child_pid);
		assert_eq!(
			poll_exit_without_reaping(&mut child).expect("ECHILD poll"),
			ProcessGroupPoll::NotSignalable
		);
	}

	#[test]
	fn missing_cached_group_falls_back_to_exact_child_kill_and_reap() {
		let mut command = Command::new(env::current_exe().expect("current test executable"));

		command
			.args(["--exact", "adapter::process_group::tests::non_signalable_live_child_fixture"])
			.env("AIQ_NON_SIGNALABLE_CHILD", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		// Deliberately do not call `configure`: the child inherits this test's
		// group, so the cached group ID derived from its PID does not exist.
		let mut child = command.spawn().expect("out-of-group fixture child");
		let child_pid = i32::try_from(child.id()).expect("fixture PID");

		kill_and_reap_group(&mut child).expect("exact child fallback cleanup");

		// SAFETY: Signal zero only checks the exact PID that this test created.
		assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
		assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
	}

	#[test]
	fn non_signalable_live_child_fixture() {
		if env::var_os("AIQ_NON_SIGNALABLE_CHILD").is_some() {
			thread::sleep(Duration::from_secs(30));
		}
	}
}

#[cfg(all(test, target_os = "linux"))]
use std::cell::Cell;
use std::io::ErrorKind;
use std::{
	fmt::{Display, Formatter},
	process::{Child, Command, ExitStatus},
	thread,
	time::{Duration, Instant},
};
#[cfg(unix)]
use std::{mem::MaybeUninit, os::unix::process::CommandExt as _};

#[cfg(unix)]
use libc::{_SC_OPEN_MAX, EBADF, EINVAL, F_GETFD, F_SETFD, FD_CLOEXEC};
#[cfg(target_os = "linux")]
use libc::{CLOSE_RANGE_CLOEXEC, ENOSYS, SYS_close_range};
#[cfg(unix)]
use libc::{ECHILD, EINTR, EPERM, ESRCH, P_PID, SIGKILL, WEXITED, WNOHANG, WNOWAIT};
#[cfg(unix)]
use libc::{id_t, siginfo_t};

#[cfg(all(test, target_os = "linux"))]
thread_local! {
	static FORCE_CLOSE_RANGE_FALLBACK: std::cell::Cell<bool> = const {
		std::cell::Cell::new(false)
	};
}

const PROCESS_REAP_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessGroupPoll {
	Running,
	Exited,
	NotSignalable,
}

#[cfg(unix)]
enum ProcessGroupSignal {
	Sent,
	Missing,
}

#[derive(Debug)]
pub(crate) struct ProcessGroupCleanupError {
	source: std::io::Error,
	release_observed_pid: bool,
	status: Option<ExitStatus>,
}
impl ProcessGroupCleanupError {
	fn waitable(source: std::io::Error) -> Self {
		Self { source, release_observed_pid: false, status: None }
	}

	fn not_waitable(source: std::io::Error, status: Option<ExitStatus>) -> Self {
		Self { source, release_observed_pid: true, status }
	}

	pub(crate) fn release_observed_pid(&self) -> bool {
		self.release_observed_pid
	}

	pub(crate) fn exit_code(&self) -> Option<i32> {
		self.status.as_ref().and_then(ExitStatus::code)
	}
}

impl Display for ProcessGroupCleanupError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		Display::fmt(&self.source, formatter)
	}
}

impl std::error::Error for ProcessGroupCleanupError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		Some(&self.source)
	}
}

impl From<std::io::Error> for ProcessGroupCleanupError {
	fn from(error: std::io::Error) -> Self {
		Self::waitable(error)
	}
}

pub(super) fn configure(command: &mut Command) {
	#[cfg(unix)]
	command.process_group(0);

	#[cfg(unix)]
	let observed_maximum = unsafe { libc::sysconf(_SC_OPEN_MAX) };
	#[cfg(unix)]
	let maximum_descriptor =
		i32::try_from(observed_maximum).unwrap_or(if observed_maximum > 0 { i32::MAX } else { -1 });
	#[cfg(target_os = "linux")]
	let force_close_range_fallback = {
		#[cfg(test)]
		{
			FORCE_CLOSE_RANGE_FALLBACK.with(Cell::take)
		}

		#[cfg(not(test))]
		{
			false
		}
	};

	#[cfg(target_os = "linux")]
	unsafe {
		command.pre_exec(move || {
			// Preserve only the three standard streams across `exec`. Marking
			// descriptors close-on-exec, instead of closing them here, keeps
			// Rust's private spawn-error pipe usable until `exec` completes.
			if !force_close_range_fallback
				&& libc::syscall(SYS_close_range, 3_u32, u32::MAX, CLOSE_RANGE_CLOEXEC) == 0
			{
				return Ok(());
			}
			if !force_close_range_fallback {
				let error = std::io::Error::last_os_error();

				if !matches!(error.raw_os_error(), Some(ENOSYS) | Some(EPERM)) {
					return Err(error);
				}
			}
			if maximum_descriptor < 3 {
				return Err(std::io::Error::from_raw_os_error(EINVAL));
			}

			for descriptor in 3..maximum_descriptor {
				let flags = libc::fcntl(descriptor, F_GETFD);

				if flags < 0 {
					let error = std::io::Error::last_os_error();

					if error.raw_os_error() == Some(EBADF) {
						continue;
					}

					return Err(error);
				}
				if flags & FD_CLOEXEC == 0
					&& libc::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) != 0
				{
					return Err(std::io::Error::last_os_error());
				}
			}

			Ok(())
		});
	}
	#[cfg(all(unix, not(target_os = "linux")))]
	{
		// `close_range(..., CLOSE_RANGE_CLOEXEC)` is Linux-specific. Resolve
		// the platform descriptor ceiling before `fork`, then use only
		// async-signal-safe `fcntl` calls in the child.
		unsafe {
			command.pre_exec(move || {
				if maximum_descriptor < 3 {
					return Err(std::io::Error::from_raw_os_error(EINVAL));
				}

				for descriptor in 3..maximum_descriptor {
					let flags = libc::fcntl(descriptor, F_GETFD);

					if flags < 0 {
						let error = std::io::Error::last_os_error();

						if error.raw_os_error() == Some(EBADF) {
							continue;
						}

						return Err(error);
					}
					if flags & FD_CLOEXEC == 0
						&& libc::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) != 0
					{
						return Err(std::io::Error::last_os_error());
					}
				}

				Ok(())
			});
		}
	}

	#[cfg(not(unix))]
	let _ = command;
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn force_close_range_fallback_for_test() {
	FORCE_CLOSE_RANGE_FALLBACK.with(|forced| forced.set(true));
}

pub(crate) fn cleanup_after_poll(
	child: &mut Child,
	poll: ProcessGroupPoll,
) -> Result<ExitStatus, ProcessGroupCleanupError> {
	match poll {
		ProcessGroupPoll::Exited => {
			#[cfg(unix)]
			return signal_and_reap_group(child);

			#[cfg(not(unix))]
			return child.wait().map_err(wait_error);
		},
		ProcessGroupPoll::NotSignalable => {
			Err(ProcessGroupCleanupError::not_waitable(not_signalable_error(), None))
		},
		ProcessGroupPoll::Running => Err(ProcessGroupCleanupError::waitable(
			std::io::Error::other("process-group cleanup requires an exited leader observation"),
		)),
	}
}

pub(crate) fn kill_and_reap_group(
	child: &mut Child,
) -> Result<ExitStatus, ProcessGroupCleanupError> {
	#[cfg(unix)]
	return signal_and_reap_group(child);

	#[cfg(not(unix))]
	{
		match child.kill() {
			Ok(()) => wait_for_exit_and_reap(child, PROCESS_REAP_TIMEOUT),
			Err(error) => match child.try_wait() {
				Ok(Some(status)) => Ok(status),
				Ok(None) => Err(ProcessGroupCleanupError::waitable(error)),
				Err(poll_error) => Err(wait_error(poll_error)),
			},
		}
	}
}

pub(crate) fn poll_exit_without_reaping(child: &mut Child) -> std::io::Result<ProcessGroupPoll> {
	#[cfg(unix)]
	{
		let child_id = id_t::try_from(child.id())
			.map_err(|_| std::io::Error::other("child process ID exceeds the platform range"))?;

		loop {
			let mut information = MaybeUninit::<siginfo_t>::zeroed();
			// SAFETY: `information` points to writable storage for `waitid`. `WNOWAIT`
			// keeps an observed leader waitable, so its PID and process-group ID cannot
			// be reused before the group is signaled and `Child::wait` reaps it.
			let result = unsafe {
				libc::waitid(P_PID, child_id, information.as_mut_ptr(), WEXITED | WNOHANG | WNOWAIT)
			};

			if result == 0 {
				// SAFETY: A successful `waitid` initialized the siginfo storage. POSIX
				// reports no state change for `WNOHANG` by leaving `si_pid` equal to 0.
				return Ok(if unsafe { information.assume_init().si_pid() } == 0 {
					ProcessGroupPoll::Running
				} else {
					ProcessGroupPoll::Exited
				});
			}

			let error = std::io::Error::last_os_error();

			match error.raw_os_error() {
				Some(EINTR) => {},
				Some(ECHILD) => return Ok(ProcessGroupPoll::NotSignalable),
				_ => return Err(error),
			}
		}
	}

	#[cfg(not(unix))]
	child.try_wait().map(|status| {
		if status.is_some() { ProcessGroupPoll::Exited } else { ProcessGroupPoll::Running }
	})
}

#[cfg(unix)]
fn process_group_id(child: &Child) -> std::io::Result<i32> {
	i32::try_from(child.id())
		.map_err(|_| std::io::Error::other("child process ID exceeds the platform range"))
}

#[cfg(unix)]
fn signal_process_group(process_group: i32) -> std::io::Result<ProcessGroupSignal> {
	// SAFETY: `process_group` is the positive ID returned for the child that this
	// executor placed in a new process group. Negating it selects only that group.
	let result = unsafe { libc::kill(-process_group, SIGKILL) };

	if result == 0 {
		return Ok(ProcessGroupSignal::Sent);
	}

	let error = std::io::Error::last_os_error();

	if error.raw_os_error() == Some(ESRCH) { Ok(ProcessGroupSignal::Missing) } else { Err(error) }
}

#[cfg(unix)]
fn signal_and_reap_group(child: &mut Child) -> Result<ExitStatus, ProcessGroupCleanupError> {
	match poll_exit_without_reaping(child).map_err(wait_error)? {
		ProcessGroupPoll::Running | ProcessGroupPoll::Exited => {},
		ProcessGroupPoll::NotSignalable => {
			return Err(ProcessGroupCleanupError::not_waitable(not_signalable_error(), None));
		},
	}

	let process_group = process_group_id(child).map_err(ProcessGroupCleanupError::waitable)?;

	match signal_process_group(process_group) {
		Ok(ProcessGroupSignal::Sent | ProcessGroupSignal::Missing) => {
			// The waitability check above proves that the exact child PID cannot
			// yet be reused. Also signal that PID so cleanup still terminates a
			// leader that escaped its original process group.
			match child.kill() {
				Ok(()) => {},
				Err(error) if error.raw_os_error() == Some(ESRCH) => {},
				Err(error) => return Err(ProcessGroupCleanupError::waitable(error)),
			}

			wait_for_exit_and_reap(child, PROCESS_REAP_TIMEOUT)
		},
		Err(error) if error.raw_os_error() == Some(EPERM) => {
			let status = wait_for_exit_and_reap(child, Duration::from_millis(50))?;

			// Darwin can report EPERM when the unreaped group leader is no longer
			// signalable. After reaping, probe without sending another signal. ESRCH
			// proves that the original process group no longer exists. Any extant or
			// reused group fails closed without signaling the reused PGID.
			match probe_process_group(process_group) {
				Err(probe_error) if probe_error.raw_os_error() == Some(ESRCH) => Ok(status),
				_ => Err(ProcessGroupCleanupError::not_waitable(error, Some(status))),
			}
		},
		Err(error) => Err(ProcessGroupCleanupError::waitable(error)),
	}
}

fn wait_for_exit_and_reap(
	child: &mut Child,
	timeout: Duration,
) -> Result<ExitStatus, ProcessGroupCleanupError> {
	let deadline = Instant::now() + timeout;

	loop {
		match poll_exit_without_reaping(child).map_err(wait_error)? {
			ProcessGroupPoll::Running if Instant::now() < deadline => {
				thread::sleep(Duration::from_millis(1));
			},
			ProcessGroupPoll::Running => {
				return Err(ProcessGroupCleanupError::waitable(std::io::Error::new(
					ErrorKind::TimedOut,
					"process-group leader did not become waitable after termination",
				)));
			},
			ProcessGroupPoll::Exited => {
				return child.wait().map_err(wait_error);
			},
			ProcessGroupPoll::NotSignalable => {
				return Err(ProcessGroupCleanupError::not_waitable(not_signalable_error(), None));
			},
		}
	}
}

fn wait_error(error: std::io::Error) -> ProcessGroupCleanupError {
	#[cfg(unix)]
	if error.raw_os_error() == Some(ECHILD) {
		return ProcessGroupCleanupError::not_waitable(error, None);
	}

	ProcessGroupCleanupError::waitable(error)
}

fn not_signalable_error() -> std::io::Error {
	#[cfg(unix)]
	return std::io::Error::from_raw_os_error(ECHILD);

	#[cfg(not(unix))]
	std::io::Error::other("process-group leader is not waitable")
}

#[cfg(unix)]
fn probe_process_group(process_group: i32) -> std::io::Result<()> {
	// SAFETY: Signal zero does not modify the target group. The caller uses it only
	// after reaping and never sends a signal to a potentially reused group ID.
	let result = unsafe { libc::kill(-process_group, 0) };

	if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}
