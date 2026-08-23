#[cfg(unix)]
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt as _};
use std::process;
use std::{
	fs::{self, File, OpenOptions},
	io::{Seek as _, SeekFrom, Write as _},
	path::Path,
};

use libc::EAGAIN;
use libc::EWOULDBLOCK;
use libc::LOCK_EX;
use libc::LOCK_NB;
use libc::LOCK_UN;

use crate::{Result, ResultContext};

pub struct ProcessLock {
	file: File,
}
impl ProcessLock {
	pub fn try_acquire(state_root: &Path) -> Result<Option<Self>> {
		fs::create_dir_all(state_root)
			.context(format!("cannot create state root {}", state_root.display()))?;

		let path = state_root.join("active.lock");
		let mut options = OpenOptions::new();

		options.read(true).write(true).create(true);
		#[cfg(unix)]
		options.mode(0o600);

		let mut file =
			options.open(&path).context(format!("cannot open lock {}", path.display()))?;

		if !lock_nonblocking(&file)? {
			return Ok(None);
		}

		file.set_len(0).context("cannot reset process lock")?;
		file.seek(SeekFrom::Start(0)).context("cannot seek process lock")?;

		writeln!(file, "{}", process::id()).context("cannot write process lock owner")?;

		file.sync_data().context("cannot sync process lock")?;

		Ok(Some(Self { file }))
	}
}

impl Drop for ProcessLock {
	fn drop(&mut self) {
		#[cfg(unix)]
		{
			// SAFETY: `self.file` still owns a valid descriptor while `drop` runs.
			let _ = unsafe { libc::flock(self.file.as_raw_fd(), LOCK_UN) };
		}
	}
}

#[cfg(unix)]
fn lock_nonblocking(file: &File) -> Result<bool> {
	// SAFETY: `file` owns a valid descriptor for the duration of the call.
	let result = unsafe { libc::flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };

	if result == 0 {
		return Ok(true);
	}

	let error = std::io::Error::last_os_error();

	if error.raw_os_error() == Some(EWOULDBLOCK) || error.raw_os_error() == Some(EAGAIN) {
		return Ok(false);
	}

	Err(crate::Error::new(format!("cannot acquire active lock: {error}")))
}

#[cfg(not(unix))]
fn lock_nonblocking(_file: &File) -> Result<bool> {
	Ok(true)
}

#[cfg(test)]
mod tests {
	use std::process;
	use std::{env, fs};

	use crate::lock::ProcessLock;

	#[test]
	fn lock_is_nonblocking_and_recovers_on_drop() {
		let root = env::temp_dir().join(format!("aiq-lock-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let first = ProcessLock::try_acquire(&root).expect("first lock").expect("lock acquired");

		assert!(ProcessLock::try_acquire(&root).expect("contended lock").is_none());

		drop(first);

		assert!(ProcessLock::try_acquire(&root).expect("recovered lock").is_some());

		fs::remove_dir_all(root).expect("remove lock fixture");
	}
}
