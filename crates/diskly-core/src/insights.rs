//! Where the space went, as a scan finds it: the biggest files, what kinds of file
//! take it, how it spreads over file sizes, and the well-known places that tend to
//! grow.
//!
//! This is worked out once, from the finished tree, while the scan still has it in
//! memory, and is small and bounded however large the disk is.

use std::collections::HashMap;
use std::path::Path;

use diskghost_core::{ScanTree, Snapshot};
use serde::{Deserialize, Serialize};

use crate::scan::relative_path;

/// Files listed whatever their kind.
pub const TOP_FILES: usize = 100;
/// The biggest of each kind, so that filtering by kind always has something to show.
const TOP_PER_KIND: usize = 20;
/// How far down the size order the search for those goes.
const CANDIDATES: usize = 3000;
const EXTENSIONS: usize = 40;
const TOP_FOLDERS: usize = 32;
/// Below this a well-known place is not worth a line.
const SPOT_MINIMUM: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopFile {
    pub path: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KindStat {
    pub kind: String,
    pub size: u64,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionStat {
    pub ext: String,
    pub kind: String,
    pub size: u64,
    pub count: u64,
}

/// Files under `upper` bytes, and at or above the bucket before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SizeRange {
    pub upper: Option<u64>,
    pub size: u64,
    pub count: u64,
}

/// A well-known place. The report says what it is and what can be done about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spot {
    pub id: String,
    pub size: u64,
    pub places: u64,
    pub largest: String,
    pub largest_size: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Insights {
    pub files: Vec<TopFile>,
    pub kinds: Vec<KindStat>,
    pub extensions: Vec<ExtensionStat>,
    pub ranges: Vec<SizeRange>,
    pub spots: Vec<Spot>,
    /// The top-level folders, biggest first. One that could not be read is left
    /// out: it has no known size.
    pub top_folders: Vec<(String, u64)>,
}

/// Which of the report's eight kinds an extension belongs to.
pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" | "mts"
        | "m2ts" | "vob" | "rmvb" | "rm" | "3gp" | "ts" => "video",
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "wma" | "ape" | "opus" | "aiff" => "audio",
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" | "heif" | "tif" | "tiff"
        | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "psd" | "ai" | "svg" | "ico" => "image",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "odt"
        | "ods" | "odp" | "csv" | "epub" | "mobi" | "wps" | "et" | "dps" | "pages" | "numbers"
        | "key" => "document",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "cab" | "iso" | "img"
        | "dmg" | "wim" | "esd" | "vhd" | "vhdx" | "vmdk" | "vdi" | "qcow2" | "ova" | "msu"
        | "appx" | "msix" | "msixbundle" => "archive",
        "exe" | "dll" | "sys" | "msi" | "ocx" | "drv" | "mui" | "cat" | "efi" | "so" | "dylib"
        | "node" | "pyd" | "winmd" | "manifest" => "program",
        "js" | "mjs" | "cjs" | "tsx" | "jsx" | "py" | "pyc" | "rs" | "c" | "h" | "cc" | "cpp"
        | "hpp" | "cs" | "java" | "class" | "jar" | "go" | "rb" | "php" | "html" | "htm"
        | "css" | "scss" | "json" | "xml" | "yaml" | "yml" | "toml" | "ini" | "lock" | "map"
        | "wasm" | "rlib" | "rmeta" | "pdb" | "lib" | "obj" | "o" | "a" | "d" | "ipynb" | "sh"
        | "ps1" | "bat" | "sql" => "code",
        _ => "other",
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Which well-known place a folder is, from its path in lower case.
fn spot_of(parts: &[&str]) -> Option<&'static str> {
    let last = *parts.last()?;
    match parts {
        ["$recycle.bin"] => return Some("recycle"),
        ["windows.old"] => return Some("windows-old"),
        ["system volume information"] => return Some("restore"),
        ["windows", "winsxs"] => return Some("winsxs"),
        ["windows", "temp"] | ["users", _, "appdata", "local", "temp"] => return Some("temp"),
        ["windows", "softwaredistribution", "download"] => return Some("update-cache"),
        ["windows", "installer"] => return Some("installers"),
        ["users", _, "downloads"] => return Some("downloads"),
        ["users", _, "appdata", "local", "docker"] | ["programdata", "dockerdesktop"] => {
            return Some("containers")
        }
        ["users", _, "appdata", "local", "packages", package]
            if package.starts_with("canonicalgroup")
                || package.starts_with("thedebianproject")
                || package.contains("linux") =>
        {
            return Some("containers")
        }
        ["users", _, ".cargo" | ".rustup" | ".gradle" | ".m2" | ".npm" | ".nuget" | ".pub-cache"] => {
            return Some("dev-cache")
        }
        ["users", _, "appdata", "local", "npm-cache" | "pip" | "yarn" | "pnpm"] => {
            return Some("dev-cache")
        }
        _ => {}
    }
    if matches!(last, "node_modules" | "__pycache__" | ".venv") {
        return Some("dev-deps");
    }
    if last == "steamapps" {
        return Some("games");
    }
    if parts.len() > 3
        && parts[0] == "users"
        && parts[2] == "appdata"
        && matches!(
            last,
            "cache" | "cache2" | "code cache" | "gpucache" | "shadercache" | "cachedata"
        )
    {
        return Some("app-cache");
    }
    None
}

fn spots_of(tree: &ScanTree, files: &[TopFile]) -> Vec<Spot> {
    let root = tree.root();
    let mut found: HashMap<&'static str, Spot> = HashMap::new();
    let mut last_match: HashMap<&'static str, String> = HashMap::new();
    let mut add = |id: &'static str, path: String, size: u64| {
        let spot = found.entry(id).or_insert_with(|| Spot {
            id: id.to_string(),
            size: 0,
            places: 0,
            largest: String::new(),
            largest_size: 0,
        });
        spot.size += size;
        spot.places += 1;
        if size > spot.largest_size {
            spot.largest = path;
            spot.largest_size = size;
        }
    };
    for dir in tree.dir_sizes() {
        // Unread folders have no known size, and an empty one is nothing to point at.
        if dir.size == 0 {
            continue;
        }
        let Some(rel) = relative_path(root, &dir.path) else {
            continue;
        };
        let lower = rel.to_lowercase();
        let parts: Vec<&str> = lower.split('\\').collect();
        let Some(id) = spot_of(&parts) else {
            continue;
        };
        // Children come right after their parent. The outermost match counts, so
        // that node_modules inside node_modules is not counted twice.
        let inside = last_match
            .get(id)
            .is_some_and(|prefix| lower.starts_with(prefix.as_str()));
        if inside {
            continue;
        }
        last_match.insert(id, format!("{lower}\\"));
        add(id, rel, dir.size);
    }
    for file in files {
        let lower = file.path.to_lowercase();
        if matches!(
            lower.as_str(),
            "hiberfil.sys" | "pagefile.sys" | "swapfile.sys"
        ) {
            add("system-files", file.path.clone(), file.size);
        }
    }
    let mut spots: Vec<Spot> = found
        .into_values()
        .filter(|s| s.size >= SPOT_MINIMUM)
        .collect();
    spots.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.id.cmp(&b.id)));
    spots
}

/// Everything above, from a finished scan's tree.
pub fn from_tree(tree: &ScanTree) -> Insights {
    let root = tree.root();
    let report = tree.root_report(CANDIDATES);

    let mut per_kind: HashMap<&'static str, usize> = HashMap::new();
    let mut files = Vec::new();
    for (place, file) in report.top_files.iter().enumerate() {
        let kind = kind_of(&extension_of(&file.path));
        let taken = per_kind.entry(kind).or_default();
        if place >= TOP_FILES && *taken >= TOP_PER_KIND {
            continue;
        }
        *taken += 1;
        let Some(path) = relative_path(root, &file.path) else {
            continue;
        };
        files.push(TopFile {
            path,
            size: file.size,
            kind: kind.to_string(),
        });
    }

    let stats = tree.file_stats(root).unwrap_or(diskghost_core::FileStats {
        extensions: Vec::new(),
        size_buckets: Vec::new(),
    });
    let mut kinds: HashMap<&'static str, KindStat> = HashMap::new();
    for e in &stats.extensions {
        let kind = kind_of(&e.ext);
        let stat = kinds.entry(kind).or_insert_with(|| KindStat {
            kind: kind.to_string(),
            size: 0,
            count: 0,
        });
        stat.size += e.size;
        stat.count += e.count;
    }
    let mut kinds: Vec<KindStat> = kinds.into_values().collect();
    kinds.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.kind.cmp(&b.kind)));

    let extensions = stats
        .extensions
        .iter()
        .take(EXTENSIONS)
        .map(|e| ExtensionStat {
            ext: e.ext.clone(),
            kind: kind_of(&e.ext).to_string(),
            size: e.size,
            count: e.count,
        })
        .collect();
    let ranges = stats
        .size_buckets
        .iter()
        .map(|b| SizeRange {
            upper: b.upper,
            size: b.size,
            count: b.count,
        })
        .collect();
    let top_folders = report
        .children
        .iter()
        .filter(|d| d.size > 0)
        .filter_map(|d| Some((relative_path(root, &d.path)?, d.size)))
        .take(TOP_FOLDERS)
        .collect();
    let spots = spots_of(tree, &files);
    Insights {
        files,
        kinds,
        extensions,
        ranges,
        spots,
        top_folders,
    }
}

/// The same from a stored scan, for one made before this existed.
pub fn from_snapshot(snapshot: &Snapshot) -> Option<Insights> {
    snapshot.to_tree().ok().as_ref().map(from_tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_sort_into_the_kinds_the_report_knows() {
        assert_eq!(kind_of("mkv"), "video");
        assert_eq!(kind_of("vhdx"), "archive");
        assert_eq!(kind_of("dll"), "program");
        assert_eq!(kind_of(""), "other");
        assert_eq!(kind_of("whatever"), "other");
    }

    #[test]
    fn well_known_places_are_found_by_where_they_are() {
        let spot = |path: &str| spot_of(&path.split('\\').collect::<Vec<_>>());
        assert_eq!(spot("$recycle.bin"), Some("recycle"));
        assert_eq!(spot("users\\a\\downloads"), Some("downloads"));
        assert_eq!(spot("users\\a\\appdata\\local\\temp"), Some("temp"));
        assert_eq!(spot("d\\project\\node_modules"), Some("dev-deps"));
        assert_eq!(
            spot("users\\a\\appdata\\local\\google\\chrome\\user data\\default\\cache"),
            Some("app-cache")
        );
        // The same name elsewhere is somebody's own folder.
        assert_eq!(spot("downloads"), None);
        assert_eq!(spot("projects\\cache"), None);
        assert_eq!(spot("temp"), None);
    }
}
