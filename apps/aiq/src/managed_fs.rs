//! Filesystem primitives for managed release and observation state.

use std::{fs, path::Path};
#[cfg(unix)]
use std::{fs::Permissions, os::unix::fs::PermissionsExt as _};

use serde::Deserialize;

use crate::{Error, Result, ResultContext};

pub(crate) fn private_directory(path: &Path) -> Result<()> {
	fs::create_dir_all(path)
		.context(format!("cannot create private directory {}", path.display()))?;

	let metadata = fs::symlink_metadata(path)
		.context(format!("cannot inspect private directory {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(Error::new(format!("private path is not a directory: {}", path.display())));
	}

	#[cfg(unix)]
	fs::set_permissions(path, Permissions::from_mode(0o700))
		.context(format!("cannot protect directory {}", path.display()))?;

	Ok(())
}

pub(crate) fn read_json<T>(path: &Path, label: &str) -> Result<T>
where
	T: for<'de> Deserialize<'de>,
{
	let bytes = fs::read(path).context(format!("cannot read {label} {}", path.display()))?;

	serde_json::from_slice(&bytes).context(format!("invalid {label} {}", path.display()))
}
