//! Diskly must never touch a user's files. The core library it builds on can
//! delete, so this keeps its delete functions out of Diskly's own code, and all
//! file removal inside the one place that checks what it removes.

use std::fs;
use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn own_sources() -> Vec<PathBuf> {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo = crate_dir.parent().unwrap().parent().unwrap();
    let mut files = Vec::new();
    sources(&crate_dir.join("src"), &mut files);
    sources(&repo.join("app").join("src-tauri").join("src"), &mut files);
    assert!(
        files.iter().any(|f| f.ends_with("store.rs")),
        "looked in the wrong place"
    );
    files
}

/// What ships: `text` without its comments, so explaining a rule cannot break
/// it, and without its test module, which cleans up after itself.
fn code_of(text: &str) -> String {
    let shipped = text.split("#[cfg(test)]").next().unwrap_or("");
    shipped
        .lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn diskly_does_not_call_anything_that_deletes_in_the_core() {
    for file in own_sources() {
        let code = code_of(&fs::read_to_string(&file).unwrap());
        for banned in [
            "reclaim",
            "remove_path",
            "trash::",
            "ReclaimAction",
            "RemoveMode",
        ] {
            assert!(!code.contains(banned), "{banned} in {}", file.display());
        }
    }
}

#[test]
fn only_the_store_removes_files_and_it_checks_each_one() {
    for file in own_sources() {
        let code = code_of(&fs::read_to_string(&file).unwrap());
        if file.ends_with("store.rs") {
            assert_eq!(
                code.matches("fs::remove_file").count(),
                1,
                "one guarded call"
            );
            assert!(code.contains("fn remove_plain_file"));
            assert_eq!(
                code.matches("fs::remove_dir(").count(),
                1,
                "one empty folder"
            );
            assert!(!code.contains("remove_dir_all"));
        } else {
            assert!(
                !code.contains("remove_file"),
                "remove_file in {}",
                file.display()
            );
        }
        if !file.ends_with("store.rs") {
            assert!(!code.contains("fs::remove_dir"), "in {}", file.display());
        }
        for banned in ["DeleteFile", "MoveFileEx", "SHFileOperation"] {
            assert!(!code.contains(banned), "{banned} in {}", file.display());
        }
    }
}
