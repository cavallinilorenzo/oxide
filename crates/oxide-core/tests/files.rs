use oxide_core::{Core, FileEntry};
use std::fs;
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path().join("home")).unwrap();
    let project = dir.path().join("proj");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(project.join("src")).unwrap();
    fs::write(project.join(".gitignore"), "target/\n*.log\n").unwrap();
    fs::write(project.join("src/main.rs"), "fn main() {}\n").unwrap();
    fs::write(project.join("a.log"), "noise").unwrap();
    fs::create_dir_all(project.join("target")).unwrap();
    fs::write(project.join("target/out"), "x").unwrap();
    fs::write(project.join("README.md"), "# hi\n").unwrap();
    let id = core.add_project(&project.to_string_lossy()).unwrap().id;
    (dir, core, id)
}

fn names(entries: &[FileEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

#[test]
fn lists_checkout_hiding_ignored_files_and_dot_git() {
    let (_dir, core, project) = setup();
    let entries = core.list_dir(project, None, "").unwrap();
    // Directories first, then files, each sorted.
    assert_eq!(names(&entries), vec!["src", ".gitignore", "README.md"]);
    assert!(entries[0].is_dir);
    assert_eq!(entries[0].path, "src");
}

#[test]
fn lists_nested_directory() {
    let (_dir, core, project) = setup();
    let entries = core.list_dir(project, None, "src").unwrap();
    assert_eq!(names(&entries), vec!["main.rs"]);
    assert_eq!(entries[0].path, "src/main.rs");
}

#[test]
fn reads_file_content() {
    let (_dir, core, project) = setup();
    let file = core.read_file(project, None, "src/main.rs").unwrap();
    assert_eq!(file.content, "fn main() {}\n");
    assert!(!file.truncated && !file.binary);
}

#[test]
fn truncates_large_files_and_flags_binary() {
    let (dir, core, project) = setup();
    let root = dir.path().join("proj");
    fs::write(root.join("big.txt"), "a".repeat(2_000_000)).unwrap();
    fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
    let big = core.read_file(project, None, "big.txt").unwrap();
    assert!(big.truncated);
    assert_eq!(big.size, 2_000_000);
    assert!(big.content.len() <= 1_048_576);
    let bin = core.read_file(project, None, "blob.bin").unwrap();
    assert!(bin.binary);
    assert!(bin.content.is_empty());
}

#[test]
fn rejects_paths_escaping_the_checkout() {
    let (dir, core, project) = setup();
    fs::write(dir.path().join("secret.txt"), "s").unwrap();
    assert!(core.read_file(project, None, "../secret.txt").is_err());
    assert!(core.list_dir(project, None, "..").is_err());
    assert!(core.read_file(project, None, "/etc/passwd").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), dir.path().join("proj/link"))
            .unwrap();
        assert!(core.read_file(project, None, "link").is_err());
    }
}
