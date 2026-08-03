//! Kernel-backed identities and directory-relative operations for protected paths.

use std::ffi::OsStr;
#[cfg(unix)]
use std::fmt::{Debug, Formatter};
use std::fs::File;
#[cfg(unix)]
use std::io::ErrorKind;
use std::path::PathBuf;
#[cfg(unix)]
use std::{
	ffi::CString,
	fs::{self, OpenOptions},
	io::{self, Read as _},
	os::{
		fd::{AsRawFd as _, FromRawFd as _, RawFd},
		unix::{
			ffi::OsStrExt as _,
			fs::{MetadataExt as _, OpenOptionsExt as _},
		},
	},
};

#[cfg(target_os = "macos")]
use libc::RENAME_EXCL;
#[cfg(target_os = "linux")]
use libc::RENAME_NOREPLACE;
#[cfg(target_os = "linux")]
use libc::SYS_renameat2;
#[cfg(unix)]
use libc::{AT_REMOVEDIR, O_CLOEXEC, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_RDWR};

#[cfg(test)]
thread_local! {
	static FORCE_CREATE_CHILD_POST_OPEN_FAILURE: std::cell::Cell<bool> =
		const { std::cell::Cell::new(false) };
	static CREATE_CHILD_POST_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
		const { std::cell::RefCell::new(None) };
}

/// Held identity of one file and its parent directory.
#[cfg(unix)]
pub(crate) struct PinnedPathIdentity {
	parent_file: File,
	parent_path: PathBuf,
	parent_device: u64,
	parent_inode: u64,
	file_device: u64,
	file_inode: u64,
	file_links: u64,
	require_single_link: bool,
}

/// Non-Unix builds fail closed until equivalent kernel file identity support is available.
#[cfg(not(unix))]
pub(crate) struct PinnedPathIdentity {
	_unavailable: (),
}
#[cfg(unix)]
impl PinnedPathIdentity {
	/// Captures and verifies the open file and parent directory identities.
	pub(crate) fn capture(path: &std::path::Path, file: &File) -> Result<Self, String> {
		Self::capture_inner(path, file, true)
	}

	/// Captures a path whose controlled installation can legitimately use hard
	/// links, while still pinning the exact initial link count.
	pub(crate) fn capture_allow_hardlinks(
		path: &std::path::Path,
		file: &File,
	) -> Result<Self, String> {
		Self::capture_inner(path, file, false)
	}

	fn capture_inner(
		path: &std::path::Path,
		file: &File,
		require_single_link: bool,
	) -> Result<Self, String> {
		let parent_path =
			path.parent().ok_or_else(|| "protected file parent is missing".to_owned())?.to_owned();
		let parent_file = open_directory(&parent_path)?;
		let parent_metadata = parent_file
			.metadata()
			.map_err(|_| "cannot inspect protected file parent identity".to_owned())?;
		let file_metadata = file
			.metadata()
			.map_err(|_| "cannot inspect protected open file identity".to_owned())?;

		if !parent_metadata.is_dir()
			|| !file_metadata.is_file()
			|| file_metadata.nlink() == 0
			|| (require_single_link && file_metadata.nlink() != 1)
		{
			return Err("protected file or parent identity is unsafe".to_owned());
		}

		let identity = Self {
			parent_file,
			parent_path,
			parent_device: parent_metadata.dev(),
			parent_inode: parent_metadata.ino(),
			file_device: file_metadata.dev(),
			file_inode: file_metadata.ino(),
			file_links: file_metadata.nlink(),
			require_single_link,
		};

		identity.verify(path, file)?;

		Ok(identity)
	}

	/// Rechecks both open handles and both current pathnames.
	pub(crate) fn verify(&self, path: &std::path::Path, file: &File) -> Result<(), String> {
		if path.parent() != Some(self.parent_path.as_path()) {
			return Err("protected file pathname changed".to_owned());
		}

		let canonical_parent = fs::canonicalize(&self.parent_path)
			.map_err(|_| "protected file parent pathname changed".to_owned())?;

		if canonical_parent != self.parent_path {
			return Err("protected file parent pathname changed".to_owned());
		}

		let held_parent = self
			.parent_file
			.metadata()
			.map_err(|_| "protected file parent handle changed".to_owned())?;
		let current_parent = fs::symlink_metadata(&self.parent_path)
			.map_err(|_| "protected file parent pathname changed".to_owned())?;
		let held_file = file.metadata().map_err(|_| "protected file handle changed".to_owned())?;
		let current_file =
			fs::symlink_metadata(path).map_err(|_| "protected file pathname changed".to_owned())?;

		if !held_parent.is_dir()
			|| !current_parent.is_dir()
			|| current_parent.file_type().is_symlink()
			|| held_parent.dev() != self.parent_device
			|| held_parent.ino() != self.parent_inode
			|| current_parent.dev() != self.parent_device
			|| current_parent.ino() != self.parent_inode
		{
			return Err("protected file parent identity changed".to_owned());
		}
		if !held_file.is_file()
			|| !current_file.is_file()
			|| current_file.file_type().is_symlink()
			|| held_file.nlink() != self.file_links
			|| current_file.nlink() != self.file_links
			|| (self.require_single_link && self.file_links != 1)
			|| held_file.dev() != self.file_device
			|| held_file.ino() != self.file_inode
			|| current_file.dev() != self.file_device
			|| current_file.ino() != self.file_inode
		{
			return Err("protected file identity changed".to_owned());
		}

		Ok(())
	}
}

#[cfg(not(unix))]
impl PinnedPathIdentity {
	pub(crate) fn capture(_path: &std::path::Path, _file: &File) -> Result<Self, String> {
		Err("protected file identity pinning is unavailable on this platform".to_owned())
	}

	pub(crate) fn verify(&self, _path: &std::path::Path, _file: &File) -> Result<(), String> {
		Err("protected file identity pinning is unavailable on this platform".to_owned())
	}
}

/// Held identity and descriptor for one protected directory and its parent.
#[cfg(unix)]
pub(crate) struct PinnedDirectoryIdentity {
	directory_file: File,
	parent_file: File,
	path: PathBuf,
	parent_path: PathBuf,
	parent_device: u64,
	parent_inode: u64,
	directory_device: u64,
	directory_inode: u64,
}

/// Non-Unix builds fail closed for protected directory pinning.
#[cfg(not(unix))]
pub(crate) struct PinnedDirectoryIdentity {
	_unavailable: (),
}
#[cfg(unix)]
impl PinnedDirectoryIdentity {
	/// Opens and pins one existing absolute non-symlink directory.
	pub(crate) fn capture(path: &std::path::Path) -> Result<Self, String> {
		if !path.is_absolute() {
			return Err("protected directory must be absolute".to_owned());
		}

		let path =
			fs::canonicalize(path).map_err(|_| "protected directory is unavailable".to_owned())?;
		let parent_path = path
			.parent()
			.ok_or_else(|| "protected directory parent is missing".to_owned())?
			.to_owned();
		let directory_file = open_directory(&path)?;
		let parent_file = open_directory(&parent_path)?;
		let directory_metadata = directory_file
			.metadata()
			.map_err(|_| "cannot inspect protected directory identity".to_owned())?;
		let parent_metadata = parent_file
			.metadata()
			.map_err(|_| "cannot inspect protected directory parent identity".to_owned())?;

		if !directory_metadata.is_dir() || !parent_metadata.is_dir() {
			return Err("protected directory identity is unsafe".to_owned());
		}

		let identity = Self {
			directory_file,
			parent_file,
			path,
			parent_path,
			parent_device: parent_metadata.dev(),
			parent_inode: parent_metadata.ino(),
			directory_device: directory_metadata.dev(),
			directory_inode: directory_metadata.ino(),
		};

		identity.verify()?;

		Ok(identity)
	}

	/// Returns the canonical pathname bound to the held descriptor.
	pub(crate) fn path(&self) -> &std::path::Path {
		&self.path
	}

	/// Rechecks held and pathname identities for the directory and its parent.
	pub(crate) fn verify(&self) -> Result<(), String> {
		if self.path.parent() != Some(self.parent_path.as_path())
			|| fs::canonicalize(&self.parent_path)
				.map_err(|_| "protected directory parent pathname changed".to_owned())?
				!= self.parent_path
			|| fs::canonicalize(&self.path)
				.map_err(|_| "protected directory pathname changed".to_owned())?
				!= self.path
		{
			return Err("protected directory pathname changed".to_owned());
		}

		let held_parent = self
			.parent_file
			.metadata()
			.map_err(|_| "protected directory parent handle changed".to_owned())?;
		let current_parent = fs::symlink_metadata(&self.parent_path)
			.map_err(|_| "protected directory parent pathname changed".to_owned())?;
		let held_directory = self
			.directory_file
			.metadata()
			.map_err(|_| "protected directory handle changed".to_owned())?;
		let current_directory = fs::symlink_metadata(&self.path)
			.map_err(|_| "protected directory pathname changed".to_owned())?;

		if !held_parent.is_dir()
			|| !current_parent.is_dir()
			|| current_parent.file_type().is_symlink()
			|| held_parent.dev() != self.parent_device
			|| held_parent.ino() != self.parent_inode
			|| current_parent.dev() != self.parent_device
			|| current_parent.ino() != self.parent_inode
			|| !held_directory.is_dir()
			|| !current_directory.is_dir()
			|| current_directory.file_type().is_symlink()
			|| held_directory.dev() != self.directory_device
			|| held_directory.ino() != self.directory_inode
			|| current_directory.dev() != self.directory_device
			|| current_directory.ino() != self.directory_inode
		{
			return Err("protected directory identity changed".to_owned());
		}

		Ok(())
	}

	/// Reads one direct child regular file through the held directory descriptor.
	///
	/// The size is checked before allocation and again while reading. The
	/// pathname is reopened after the read to detect replacement races.
	pub(crate) fn read_child_file_bounded(
		&self,
		name: &OsStr,
		maximum_bytes: usize,
	) -> Result<Vec<u8>, String> {
		self.verify()?;

		let mut file = openat_file(
			self.directory_file.as_raw_fd(),
			name,
			O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
			0,
		)
		.map_err(|_| "cannot open controlled task file".to_owned())?;
		let metadata =
			file.metadata().map_err(|_| "cannot inspect controlled task file".to_owned())?;

		if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != effective_user_id() {
			return Err("controlled task file identity is unsafe".to_owned());
		}

		let maximum_u64 = u64::try_from(maximum_bytes).unwrap_or(u64::MAX);

		if metadata.len() > maximum_u64 {
			return Err("controlled task file exceeds the byte limit".to_owned());
		}

		let mut bytes =
			Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(maximum_bytes));

		file.by_ref()
			.take(maximum_u64.saturating_add(1))
			.read_to_end(&mut bytes)
			.map_err(|_| "cannot read controlled task file".to_owned())?;

		if bytes.len() > maximum_bytes {
			return Err("controlled task file exceeds the byte limit".to_owned());
		}

		let current = openat_file(
			self.directory_file.as_raw_fd(),
			name,
			O_RDONLY | O_NOFOLLOW | O_CLOEXEC,
			0,
		)
		.map_err(|_| "controlled task file changed while it was read".to_owned())?;
		let current_metadata = current
			.metadata()
			.map_err(|_| "controlled task file changed while it was read".to_owned())?;

		if current_metadata.dev() != metadata.dev()
			|| current_metadata.ino() != metadata.ino()
			|| current_metadata.nlink() != 1
			|| current_metadata.len() != metadata.len()
		{
			return Err("controlled task file changed while it was read".to_owned());
		}

		self.verify()?;

		Ok(bytes)
	}

	/// Opens or creates one direct child directory relative to the held root descriptor.
	pub(crate) fn child_directory(&self, name: &OsStr, create: bool) -> Result<File, String> {
		let name_c = component(name)?;

		if create {
			let result =
				unsafe { libc::mkdirat(self.directory_file.as_raw_fd(), name_c.as_ptr(), 0o700) };

			if result != 0 {
				let error = io::Error::last_os_error();

				if error.kind() != ErrorKind::AlreadyExists {
					return Err("cannot create protected child directory".to_owned());
				}
			}
		}

		let file = openat_file(
			self.directory_file.as_raw_fd(),
			name,
			O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
			0,
		)
		.map_err(|_| "cannot open protected child directory".to_owned())?;
		let metadata =
			file.metadata().map_err(|_| "cannot inspect protected child directory".to_owned())?;

		if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
			return Err("protected child directory identity is unsafe".to_owned());
		}

		Ok(file)
	}

	/// Creates and opens one new direct child directory beneath the held root.
	pub(crate) fn create_child_directory(&self, name: &OsStr) -> Result<File, io::Error> {
		self.verify().map_err(io::Error::other)?;

		let name_c = component(name).map_err(io::Error::other)?;
		let result =
			unsafe { libc::mkdirat(self.directory_file.as_raw_fd(), name_c.as_ptr(), 0o700) };

		if result != 0 {
			return Err(io::Error::last_os_error());
		}

		let rollback = EmptyChildDirectoryRollback {
			parent: self,
			name: name_c,
			held_directory: None,
			armed: true,
		};
		let directory = openat_file(
			self.directory_file.as_raw_fd(),
			name,
			O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
			0,
		)?;
		let metadata = directory.metadata()?;
		let mut rollback = rollback;

		if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
			return Err(io::Error::other("new protected child directory identity is unsafe"));
		}

		rollback.held_directory = Some(directory.try_clone()?);

		#[cfg(test)]
		if let Some(hook) = CREATE_CHILD_POST_OPEN_HOOK.with(|slot| slot.borrow_mut().take()) {
			hook();
		}

		#[cfg(test)]
		if FORCE_CREATE_CHILD_POST_OPEN_FAILURE.with(|forced| forced.replace(false)) {
			return Err(io::Error::other("forced post-open child directory failure"));
		}

		self.verify().map_err(io::Error::other)?;

		rollback.armed = false;

		Ok(directory)
	}

	/// Atomically moves one direct child directory to a create-once name beneath
	/// another held directory. Existing destinations are never replaced.
	pub(crate) fn rename_child_noreplace_to(
		&self,
		source_name: &OsStr,
		destination_directory: &Self,
		destination_name: &OsStr,
	) -> Result<(), io::Error> {
		self.verify().map_err(io::Error::other)?;
		destination_directory.verify().map_err(io::Error::other)?;

		let source_name = component(source_name).map_err(io::Error::other)?;
		let destination_name = component(destination_name).map_err(io::Error::other)?;
		#[cfg(target_os = "linux")]
		let result = unsafe {
			libc::syscall(
				SYS_renameat2,
				self.directory_file.as_raw_fd(),
				source_name.as_ptr(),
				destination_directory.directory_file.as_raw_fd(),
				destination_name.as_ptr(),
				RENAME_NOREPLACE,
			)
		};
		#[cfg(target_os = "macos")]
		let result = unsafe {
			libc::renameatx_np(
				self.directory_file.as_raw_fd(),
				source_name.as_ptr(),
				destination_directory.directory_file.as_raw_fd(),
				destination_name.as_ptr(),
				RENAME_EXCL,
			)
		};
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		let result = -1;

		if result == 0 {
			self.verify().map_err(io::Error::other)?;

			destination_directory.verify().map_err(io::Error::other)
		} else {
			#[cfg(any(target_os = "linux", target_os = "macos"))]
			return Err(io::Error::last_os_error());

			#[cfg(not(any(target_os = "linux", target_os = "macos")))]
			return Err(io::Error::new(
				ErrorKind::Unsupported,
				"atomic create-once rename is unavailable",
			));
		}
	}

	/// Verifies that a direct child directory still has the held directory identity.
	pub(crate) fn verify_child_directory(
		&self,
		name: &OsStr,
		held_directory: &File,
	) -> Result<(), String> {
		self.verify()?;

		let held_metadata = held_directory
			.metadata()
			.map_err(|_| "cannot inspect held protected child directory".to_owned())?;
		let current = self.child_directory(name, false)?;
		let current_metadata = current
			.metadata()
			.map_err(|_| "cannot inspect current protected child directory".to_owned())?;

		if !held_metadata.is_dir()
			|| held_metadata.dev() != current_metadata.dev()
			|| held_metadata.ino() != current_metadata.ino()
		{
			return Err("protected child directory identity changed".to_owned());
		}

		self.verify()
	}

	/// Removes one empty direct child directory from the held directory.
	pub(crate) fn unlink_empty_child_directory(&self, name: &OsStr) -> Result<(), String> {
		self.verify()?;

		let name = component(name)?;
		let result =
			unsafe { libc::unlinkat(self.directory_file.as_raw_fd(), name.as_ptr(), AT_REMOVEDIR) };

		if result == 0 {
			self.verify()
		} else {
			Err("cannot remove protected empty child directory".to_owned())
		}
	}

	/// Opens an existing direct child regular file beneath a held child directory.
	pub(crate) fn open_child_file(&self, directory: &File, name: &OsStr) -> Result<File, String> {
		let file = openat_file(directory.as_raw_fd(), name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0)
			.map_err(|_| "cannot open protected child file".to_owned())?;
		let metadata =
			file.metadata().map_err(|_| "cannot inspect protected child file".to_owned())?;

		if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != effective_user_id() {
			return Err("protected child file identity is unsafe".to_owned());
		}

		Ok(file)
	}

	/// Reopens one child path from the held root and compares both directory and
	/// file identities with the handles used for an artifact operation.
	pub(crate) fn verify_child_file(
		&self,
		directory_name: &OsStr,
		held_directory: &File,
		file_name: &OsStr,
		held_file: &File,
	) -> Result<(), String> {
		self.verify()?;

		let held_directory_metadata = held_directory
			.metadata()
			.map_err(|_| "cannot inspect held protected child directory".to_owned())?;
		let current_directory = self.child_directory(directory_name, false)?;
		let current_directory_metadata = current_directory
			.metadata()
			.map_err(|_| "cannot inspect current protected child directory".to_owned())?;

		if !held_directory_metadata.is_dir()
			|| held_directory_metadata.dev() != current_directory_metadata.dev()
			|| held_directory_metadata.ino() != current_directory_metadata.ino()
		{
			return Err("protected child directory identity changed".to_owned());
		}

		let held_file_metadata = held_file
			.metadata()
			.map_err(|_| "cannot inspect held protected child file".to_owned())?;
		let current_file = self.open_child_file(&current_directory, file_name)?;
		let current_file_metadata = current_file
			.metadata()
			.map_err(|_| "cannot inspect current protected child file".to_owned())?;

		if !held_file_metadata.is_file()
			|| held_file_metadata.nlink() != 1
			|| held_file_metadata.uid() != unsafe { libc::geteuid() }
			|| held_file_metadata.dev() != current_file_metadata.dev()
			|| held_file_metadata.ino() != current_file_metadata.ino()
		{
			return Err("protected child file identity changed".to_owned());
		}

		self.verify()
	}

	/// Creates one temporary direct child file beneath a held child directory.
	pub(crate) fn create_child_file(&self, directory: &File, name: &OsStr) -> Result<File, String> {
		openat_file(
			directory.as_raw_fd(),
			name,
			O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
			0o600,
		)
		.map_err(|_| "cannot create protected child file".to_owned())
	}

	/// Publishes one temporary file under a create-once name in the same held directory.
	pub(crate) fn link_child_file(
		&self,
		directory: &File,
		temporary: &OsStr,
		final_name: &OsStr,
	) -> Result<(), io::Error> {
		let temporary = component(temporary).map_err(io::Error::other)?;
		let final_name = component(final_name).map_err(io::Error::other)?;
		let result = unsafe {
			libc::linkat(
				directory.as_raw_fd(),
				temporary.as_ptr(),
				directory.as_raw_fd(),
				final_name.as_ptr(),
				0,
			)
		};

		if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
	}

	/// Removes one temporary direct child file from the held directory.
	pub(crate) fn unlink_child_file(&self, directory: &File, name: &OsStr) -> Result<(), String> {
		let name = component(name)?;
		let result = unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };

		if result == 0 { Ok(()) } else { Err("cannot remove protected temporary file".to_owned()) }
	}

	/// Flushes the held root directory metadata.
	pub(crate) fn sync(&self) -> Result<(), String> {
		self.directory_file
			.sync_all()
			.map_err(|_| "cannot synchronize protected directory".to_owned())
	}
}

#[cfg(not(unix))]
impl PinnedDirectoryIdentity {
	pub(crate) fn capture(_path: &std::path::Path) -> Result<Self, String> {
		Err("protected directory identity pinning is unavailable on this platform".to_owned())
	}

	pub(crate) fn path(&self) -> &std::path::Path {
		std::path::Path::new("")
	}

	pub(crate) fn verify(&self) -> Result<(), String> {
		Err("protected directory identity pinning is unavailable on this platform".to_owned())
	}

	pub(crate) fn read_child_file_bounded(
		&self,
		_name: &OsStr,
		_maximum_bytes: usize,
	) -> Result<Vec<u8>, String> {
		Err("protected directory identity pinning is unavailable on this platform".to_owned())
	}
}

#[cfg(unix)]
impl Debug for PinnedDirectoryIdentity {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("PinnedDirectoryIdentity")
			.field("pinned", &true)
			.finish_non_exhaustive()
	}
}

#[cfg(unix)]
struct EmptyChildDirectoryRollback<'a> {
	parent: &'a PinnedDirectoryIdentity,
	name: CString,
	held_directory: Option<File>,
	armed: bool,
}
#[cfg(unix)]
impl Drop for EmptyChildDirectoryRollback<'_> {
	fn drop(&mut self) {
		if !self.armed || self.parent.verify().is_err() {
			return;
		}

		let Some(held_directory) = self.held_directory.as_ref() else { return };
		let descriptor = unsafe {
			libc::openat(
				self.parent.directory_file.as_raw_fd(),
				self.name.as_ptr(),
				O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
				0,
			)
		};

		if descriptor < 0 {
			return;
		}

		let current = unsafe { File::from_raw_fd(descriptor) };
		let Ok(held_metadata) = held_directory.metadata() else { return };
		let Ok(current_metadata) = current.metadata() else { return };

		if !held_metadata.is_dir()
			|| !current_metadata.is_dir()
			|| held_metadata.dev() != current_metadata.dev()
			|| held_metadata.ino() != current_metadata.ino()
		{
			return;
		}

		unsafe {
			libc::unlinkat(
				self.parent.directory_file.as_raw_fd(),
				self.name.as_ptr(),
				AT_REMOVEDIR,
			);
		}
	}
}

#[cfg(test)]
pub(crate) fn force_create_child_post_open_failure() {
	FORCE_CREATE_CHILD_POST_OPEN_FAILURE.with(|forced| forced.set(true));
}

#[cfg(test)]
pub(crate) fn set_create_child_post_open_hook(hook: impl FnOnce() + 'static) {
	CREATE_CHILD_POST_OPEN_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
	unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn open_directory(path: &std::path::Path) -> Result<File, String> {
	let mut options = OpenOptions::new();

	options.read(true).custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);

	options.open(path).map_err(|_| "cannot pin protected directory identity".to_owned())
}

#[cfg(unix)]
fn component(value: &OsStr) -> Result<CString, String> {
	let bytes = value.as_bytes();

	if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
		return Err("protected relative path component is unsafe".to_owned());
	}

	CString::new(bytes).map_err(|_| "protected relative path component is unsafe".to_owned())
}

#[cfg(unix)]
fn openat_file(directory: RawFd, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
	let name = component(name).map_err(io::Error::other)?;
	let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, mode) };

	if descriptor < 0 {
		return Err(io::Error::last_os_error());
	}

	Ok(unsafe { File::from_raw_fd(descriptor) })
}
