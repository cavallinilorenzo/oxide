use std::path::PathBuf;

pub struct FakeCli {
    path: PathBuf,
    #[cfg(windows)]
    _dir: tempfile::TempDir,
}

impl FakeCli {
    pub fn command(&self) -> &str {
        self.path.to_str().unwrap()
    }
}

#[cfg(windows)]
pub fn python() -> &'static std::path::Path {
    static PYTHON: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    PYTHON.get_or_init(|| {
        let output = std::process::Command::new("python")
            .args(["-c", "import sys; print(sys.executable)"])
            .output()
            .expect("Python is required for Provider fixtures");
        assert!(output.status.success());
        PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
    })
}

pub fn fake_cli(provider: &str) -> FakeCli {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("fixtures/{provider}/fake_{provider}.py"));
    #[cfg(windows)]
    {
        let dir = tempfile::Builder::new()
            .prefix("oxide CLI fixtures ")
            .tempdir()
            .unwrap();
        let shim = dir.path().join(format!("{provider}.cmd"));
        // Launch the interpreter itself: Windows App Execution Aliases may escape the job.
        std::fs::write(
            &shim,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                python().display(),
                path.display()
            ),
        )
        .unwrap();
        FakeCli {
            path: shim,
            _dir: dir,
        }
    }
    #[cfg(not(windows))]
    FakeCli { path }
}
