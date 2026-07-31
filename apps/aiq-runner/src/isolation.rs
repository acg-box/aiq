//! Fail-closed filesystem layout checks for benchmark control data.

use std::{
	collections::BTreeMap,
	error::Error,
	fmt::{Display, Formatter},
	fs,
	io::ErrorKind,
	path::{Component, Path, PathBuf},
};

/// Version of the conservative Codex `:minimal` root manifest.
///
/// The roots are pinned to the first-party Codex implementation reviewed on
/// 2026-07-26. A Codex upgrade must review and deliberately update this value.
pub const PLATFORM_MINIMAL_ROOTS_VERSION: &str = "codex.platform-minimal-roots.2026-07-26.v1";

#[cfg(target_os = "macos")]
const PLATFORM_MINIMAL_ROOTS: &[&str] = &[
	"/Applications",
	"/Library/Apple",
	"/Library/Filesystems/NetFSPlugins",
	"/Library/Preferences",
	"/System/Library",
	"/System/iOSSupport/System/Library",
	"/bin",
	"/etc",
	"/opt/homebrew/lib",
	"/private/etc",
	"/private/tmp",
	"/private/var/db",
	"/private/var/tmp",
	"/sbin",
	"/tmp",
	"/usr/bin",
	"/usr/lib",
	"/usr/libexec",
	"/usr/local/lib",
	"/usr/sbin",
	"/usr/share",
	"/var/db",
	"/var/tmp",
];
#[cfg(any(target_os = "linux", target_os = "android"))]
const PLATFORM_MINIMAL_ROOTS: &[&str] =
	&["/bin", "/etc", "/lib", "/lib64", "/nix/store", "/run/current-system/sw", "/sbin", "/usr"];
#[cfg(windows)]
const PLATFORM_MINIMAL_ROOTS: &[&str] =
	&[r"C:\Program Files", r"C:\Program Files (x86)", r"C:\ProgramData", r"C:\Windows"];
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android", windows)))]
const PLATFORM_MINIMAL_ROOTS: &[&str] = &[];

/// One benchmark control path that must stay unreadable to model commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectedBenchmarkPath {
	/// Stable public category name. It must not contain private path data.
	pub category: &'static str,
	/// Existing or future control path.
	pub path: PathBuf,
}

/// A public-safe filesystem-layout validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IsolationLayoutError {
	message: String,
}
impl IsolationLayoutError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for IsolationLayoutError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for IsolationLayoutError {}

/// Returns the pinned platform-minimal roots after symlink-aware resolution.
pub fn platform_minimal_roots() -> Result<Vec<PathBuf>, IsolationLayoutError> {
	let mut roots = PLATFORM_MINIMAL_ROOTS
		.iter()
		.map(|root| resolve_policy_path(Path::new(root)))
		.collect::<Result<Vec<_>, _>>()?;

	roots.sort();
	roots.dedup();

	Ok(roots)
}

/// Rejects layouts that can reopen protected benchmark control data.
pub fn validate_protected_layout(
	protected: &[ProtectedBenchmarkPath],
	writable_workspace: Option<&Path>,
	additional_read_grants: &[PathBuf],
) -> Result<(), IsolationLayoutError> {
	if protected.is_empty() {
		return Err(IsolationLayoutError::new(
			"benchmark isolation requires at least one protected path",
		));
	}

	let minimal_roots = platform_minimal_roots()?;
	let writable_workspace = writable_workspace.map(resolve_policy_path).transpose()?;
	let additional_read_grants = additional_read_grants
		.iter()
		.map(|path| resolve_policy_path(path))
		.collect::<Result<Vec<_>, _>>()?;

	if writable_workspace.as_ref().is_some_and(|workspace| {
		additional_read_grants.iter().any(|grant| paths_overlap(workspace, grant))
	}) {
		return Err(IsolationLayoutError::new(
			"writable execution workspace overlaps an additional read grant",
		));
	}

	let mut exact_paths = BTreeMap::new();

	for entry in protected {
		if entry.category.is_empty()
			|| !entry
				.category
				.bytes()
				.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
		{
			return Err(IsolationLayoutError::new(
				"protected benchmark path has an invalid public category",
			));
		}

		let path = resolve_policy_path(&entry.path)?;

		if let Some(other_category) = exact_paths.insert(path.clone(), entry.category) {
			return Err(IsolationLayoutError::new(format!(
				"protected benchmark categories {other_category} and {} resolve to the same path",
				entry.category
			)));
		}

		if minimal_roots.iter().any(|root| paths_overlap(&path, root)) {
			return Err(IsolationLayoutError::new(format!(
				"protected benchmark category {} is inside the pinned platform-minimal roots ({PLATFORM_MINIMAL_ROOTS_VERSION})",
				entry.category
			)));
		}
		if writable_workspace.as_ref().is_some_and(|workspace| paths_overlap(&path, workspace)) {
			return Err(IsolationLayoutError::new(format!(
				"protected benchmark category {} overlaps the writable execution workspace",
				entry.category
			)));
		}
		if additional_read_grants.iter().any(|grant| paths_overlap(&path, grant)) {
			return Err(IsolationLayoutError::new(format!(
				"protected benchmark category {} overlaps an additional read grant",
				entry.category
			)));
		}
	}

	Ok(())
}

/// Resolves symlinks in the longest existing prefix while preserving a future suffix.
pub fn resolve_policy_path(path: &Path) -> Result<PathBuf, IsolationLayoutError> {
	if !path.is_absolute() {
		return Err(IsolationLayoutError::new("benchmark isolation policy paths must be absolute"));
	}
	if path.components().any(|component| matches!(component, Component::ParentDir)) {
		return Err(IsolationLayoutError::new(
			"benchmark isolation policy paths must not contain parent traversal",
		));
	}

	let mut existing = path;
	let mut suffix = Vec::new();

	loop {
		match fs::canonicalize(existing) {
			Ok(mut resolved) => {
				for component in suffix.iter().rev() {
					resolved.push(component);
				}

				return Ok(resolved);
			},
			Err(error) if error.kind() == ErrorKind::NotFound => {
				let name = existing.file_name().ok_or_else(|| {
					IsolationLayoutError::new("benchmark isolation path has no existing ancestor")
				})?;

				suffix.push(name.to_owned());

				existing = existing.parent().ok_or_else(|| {
					IsolationLayoutError::new("benchmark isolation path has no existing ancestor")
				})?;
			},
			Err(error) => {
				return Err(IsolationLayoutError::new(format!(
					"cannot resolve benchmark isolation path: {error}"
				)));
			},
		}
	}
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
	left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
	use std::{
		env, fs,
		path::PathBuf,
		process, slice,
		time::{SystemTime, UNIX_EPOCH},
	};

	use crate::isolation::{self, ProtectedBenchmarkPath};

	fn fixture_root(name: &str) -> PathBuf {
		let suffix =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();

		env::temp_dir().join(format!("aiq-isolation-{name}-{}-{suffix}", process::id()))
	}

	#[test]
	fn writable_and_read_grant_overlaps_fail_closed() {
		let root = fixture_root("overlap");
		let protected_root = root.join("protected");
		let workspace = root.join("workspace");

		fs::create_dir_all(&protected_root).expect("protected fixture");
		fs::create_dir_all(&workspace).expect("workspace fixture");

		let protected = [ProtectedBenchmarkPath {
			category: "hidden_tasks",
			path: fs::canonicalize(&protected_root).expect("canonical protected fixture"),
		}];

		assert!(
			isolation::validate_protected_layout(
				&protected,
				Some(&protected_root.join("child")),
				&[]
			)
			.is_err()
		);
		assert!(
			isolation::validate_protected_layout(
				&protected,
				Some(&workspace),
				&[protected_root.join("reader")]
			)
			.is_err()
		);
		assert!(
			isolation::validate_protected_layout(
				&protected,
				Some(&workspace),
				slice::from_ref(&workspace)
			)
			.is_err()
		);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_protected_path_is_resolved_before_overlap_checks() {
		let root = fixture_root("symlink");
		let workspace = root.join("workspace");
		let alias = root.join("alias");

		fs::create_dir_all(&workspace).expect("workspace fixture");
		std::os::unix::fs::symlink(&workspace, &alias).expect("symlink fixture");

		let protected =
			[ProtectedBenchmarkPath { category: "capabilities", path: alias.join("future.json") }];

		assert!(isolation::validate_protected_layout(&protected, Some(&workspace), &[]).is_err());
		assert_eq!(
			isolation::resolve_policy_path(&alias.join("future.json")).expect("resolved alias"),
			fs::canonicalize(&workspace).expect("canonical workspace").join("future.json")
		);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn private_tmp_is_rejected_before_any_codex_process() {
		let protected = [ProtectedBenchmarkPath {
			category: "checkpoint",
			path: PathBuf::from("/private/tmp/aiq-checkpoint.json"),
		}];
		let error = isolation::validate_protected_layout(&protected, None, &[])
			.expect_err("macOS platform-minimal collision must fail");

		assert!(error.to_string().contains("checkpoint"));
		assert!(error.to_string().contains("platform-minimal"));
	}
}
