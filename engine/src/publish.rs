//! Publish a finished run into its results directory without ever losing the previous one.
//!
//! The protocol and its file names are shared with the Python runner (`python/loveworld/runner.py`),
//! so either side recovers what the other left behind:
//! * `.<name>.lock` is an exclusive per-target lock (created with O_EXCL) held from validation
//!   through publication; a stale lock is reported, never stolen.
//! * `.<name>.tmp-<pid>-<n>` is the staging directory a run is written into.
//! * `.<name>.old-<pid>-<n>` holds the previous results, renamed aside with a `SWAP_MARKER` naming
//!   their target, for the moment between the two renames of a publication. `recover` puts such a
//!   directory back when its target is missing and removes it when the target exists again.
//!
//! Nothing without the marker is ever deleted.

use anyhow::Result;
use std::path::{Path, PathBuf};

/// Marker file written into a results directory just before it is renamed aside.
pub const SWAP_MARKER: &str = ".loveworld-swap.json";

/// Split a target path into its parent directory and name, refusing paths that cannot be published.
pub fn split(target: &Path) -> Result<(PathBuf, String)> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n != "..")
        .ok_or_else(|| anyhow::anyhow!("{} is not a usable results directory", target.display()))?
        .to_string();
    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        Some(_) => PathBuf::from("."),
        None => anyhow::bail!("{} has no parent directory", target.display()),
    };
    Ok((parent, name))
}

/// An exclusive per-target lock file, removed on drop.
#[derive(Debug)]
pub struct TargetLock {
    path: PathBuf,
}

impl TargetLock {
    /// Create `.<name>.lock` next to the target, failing if another run holds it.
    pub fn acquire(parent: &Path, name: &str) -> Result<Self> {
        std::fs::create_dir_all(parent)?;
        let path = parent.join(format!(".{name}.lock"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                use std::io::Write;
                let _ = write!(f, "{}", std::process::id());
                Ok(Self { path })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => anyhow::bail!(
                "{} exists: another run is publishing this target (remove it if stale)",
                path.display()
            ),
            Err(e) => Err(e.into()),
        }
    }
}

impl Drop for TargetLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Reconcile every `.<name>.old-*` leftover of an interrupted publication next to `parent/name`;
/// return how many were restored or removed. Call it while holding the target's lock.
pub fn recover(parent: &Path, name: &str) -> Result<usize> {
    let target = parent.join(name);
    let prefix = format!(".{name}.old-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Ok(0);
    };
    let mut olds: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|f| f.to_str())
                .is_some_and(|f| f.starts_with(&prefix))
        })
        .collect();
    olds.sort();
    let mut n = 0;
    for old in olds {
        // A symlink's own metadata is not a directory, so links are skipped along with files.
        if !std::fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(old.join(SWAP_MARKER)) else {
            continue;
        };
        let Ok(marker) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if marker.get("target").and_then(|t| t.as_str()) != Some(name) {
            continue;
        }
        if target.exists() {
            let _ = std::fs::remove_dir_all(&old);
        } else {
            std::fs::rename(&old, &target)?;
            let _ = std::fs::remove_file(target.join(SWAP_MARKER));
        }
        n += 1;
    }
    Ok(n)
}

/// A hidden sibling of the target that holds a run until it is published. Dropped before
/// `publish` succeeds, it removes itself, so a failed run leaves nothing behind.
pub struct Staging {
    /// Where the run's files go.
    pub path: PathBuf,
    parent: PathBuf,
    name: String,
    published: bool,
}

impl Staging {
    /// Create a fresh `.<name>.tmp-<pid>-<n>` directory next to the target.
    pub fn create(parent: &Path, name: &str) -> Result<Self> {
        std::fs::create_dir_all(parent)?;
        let pid = std::process::id();
        let mut i = 0u32;
        loop {
            let path = parent.join(format!(".{name}.tmp-{pid}-{i}"));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        parent: parent.to_path_buf(),
                        name: name.to_string(),
                        published: false,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => i += 1,
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Move the staged run to `target`. An existing target gets the marker, is renamed to a free
    /// `.old-` sibling and is removed only once the new one is in place; if that second rename
    /// fails it is renamed back, and a crash in between is repaired by `recover`.
    pub fn publish(mut self, target: &Path) -> Result<()> {
        if !target.exists() {
            std::fs::rename(&self.path, target)?;
            self.published = true;
            return Ok(());
        }
        let pid = std::process::id();
        let aside = (0u32..)
            .map(|i| self.parent.join(format!(".{}.old-{pid}-{i}", self.name)))
            .find(|p| !p.exists() && std::fs::symlink_metadata(p).is_err())
            .expect("some aside name is free");
        let marker = serde_json::json!({
            "state": "replacing",
            "target": self.name,
            "staging": self.path.display().to_string(),
            "pid": pid,
        });
        std::fs::write(target.join(SWAP_MARKER), marker.to_string())?;
        std::fs::rename(target, &aside)?;
        if let Err(e) = std::fs::rename(&self.path, target) {
            let _ = std::fs::rename(&aside, target);
            let _ = std::fs::remove_file(target.join(SWAP_MARKER));
            return Err(e.into());
        }
        self.published = true;
        // The previous results are superseded; failing to remove them does not fail the run.
        let _ = std::fs::remove_dir_all(&aside);
        Ok(())
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with('.'))
            .collect();
        v.sort();
        v
    }

    fn marker_for(name: &str) -> String {
        serde_json::json!({"state": "replacing", "target": name, "pid": 1}).to_string()
    }

    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let first = TargetLock::acquire(dir.path(), "r").unwrap();
        let err = TargetLock::acquire(dir.path(), "r").unwrap_err();
        assert!(err.to_string().contains("another run is publishing"));
        drop(first);
        assert!(hidden(dir.path()).is_empty());
        TargetLock::acquire(dir.path(), "r").unwrap();
    }

    #[test]
    fn recover_restores_a_missing_target_and_removes_a_superseded_copy() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(".r.old-1-0");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("manifest.json"), "{}").unwrap();
        std::fs::write(old.join(SWAP_MARKER), marker_for("r")).unwrap();
        assert_eq!(recover(dir.path(), "r").unwrap(), 1);
        let target = dir.path().join("r");
        assert!(target.join("manifest.json").exists());
        assert!(!target.join(SWAP_MARKER).exists() && !old.exists());
        // With the target present again, a marked leftover is a superseded copy.
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join(SWAP_MARKER), marker_for("r")).unwrap();
        assert_eq!(recover(dir.path(), "r").unwrap(), 1);
        assert!(!old.exists() && target.exists());
    }

    #[test]
    fn recover_leaves_unmarked_mismatched_and_other_names_alone() {
        let dir = tempfile::tempdir().unwrap();
        let unmarked = dir.path().join(".r.old-2-0");
        std::fs::create_dir(&unmarked).unwrap();
        std::fs::write(unmarked.join("keep.txt"), "the only copy").unwrap();
        let mismatched = dir.path().join(".r.old-3-0");
        std::fs::create_dir(&mismatched).unwrap();
        std::fs::write(mismatched.join(SWAP_MARKER), marker_for("other")).unwrap();
        let other = dir.path().join(".s.old-4-0");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join(SWAP_MARKER), marker_for("s")).unwrap();
        assert_eq!(recover(dir.path(), "r").unwrap(), 0);
        assert!(unmarked.join("keep.txt").exists() && mismatched.exists() && other.exists());
        assert!(!dir.path().join("r").exists() && !dir.path().join("s").exists());
    }

    #[test]
    fn publish_replaces_without_reusing_an_occupied_aside_name() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("r");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("manifest.json"), "old").unwrap();
        let occupied = dir.path().join(format!(".r.old-{}-0", std::process::id()));
        std::fs::create_dir(&occupied).unwrap();
        std::fs::write(occupied.join("keep.txt"), "the only copy").unwrap();
        let staging = Staging::create(dir.path(), "r").unwrap();
        std::fs::write(staging.path.join("manifest.json"), "new").unwrap();
        staging.publish(&target).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("manifest.json")).unwrap(),
            "new"
        );
        assert!(!target.join(SWAP_MARKER).exists());
        assert_eq!(
            std::fs::read_to_string(occupied.join("keep.txt")).unwrap(),
            "the only copy"
        );
        assert_eq!(
            hidden(dir.path()),
            vec![occupied.file_name().unwrap().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn unpublished_staging_removes_itself() {
        let dir = tempfile::tempdir().unwrap();
        {
            let staging = Staging::create(dir.path(), "r").unwrap();
            std::fs::write(staging.path.join("partial.parquet"), "x").unwrap();
        }
        assert!(hidden(dir.path()).is_empty());
    }

    #[test]
    fn split_refuses_unusable_paths() {
        assert!(split(Path::new("/")).is_err());
        assert!(split(Path::new("..")).is_err());
        let (parent, name) = split(Path::new("r")).unwrap();
        assert_eq!((parent.as_path(), name.as_str()), (Path::new("."), "r"));
        let (parent, name) = split(Path::new("a/b/r")).unwrap();
        assert_eq!((parent.as_path(), name.as_str()), (Path::new("a/b"), "r"));
    }
}
