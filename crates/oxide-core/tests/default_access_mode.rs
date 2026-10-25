use oxide_core::{Core, PermissionMode};

#[test]
fn antigravity_defaults_to_auto_edit_including_legacy_ask_settings() {
    let home = tempfile::tempdir().unwrap();
    let core = Core::open(home.path()).unwrap();
    assert_eq!(
        core.settings()
            .settings
            .providers
            .antigravity
            .permission_mode,
        PermissionMode::AutoEdit
    );
    let mut settings = core.settings().settings;
    settings.providers.antigravity.permission_mode = PermissionMode::Ask;
    core.save_settings(&settings).unwrap();
    assert!(core.settings().errors.is_empty());
    assert_eq!(
        core.default_permission_mode_for("agy"),
        PermissionMode::AutoEdit
    );
}

#[test]
fn new_threads_use_persisted_provider_defaults_and_preserve_explicit_modes() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let core = Core::open(home.path()).unwrap();
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![home.path().to_string_lossy().into_owned()];
    settings.providers.claude.permission_mode = PermissionMode::FullAccess;
    settings.providers.codex.permission_mode = PermissionMode::AutoEdit;
    settings.providers.antigravity.permission_mode = PermissionMode::FullAccess;
    core.save_settings(&settings).unwrap();
    drop(core);
    let core = Core::open(home.path()).unwrap();
    let project_id = core.rescan_projects().unwrap()[0].id;
    for (provider, expected) in [
        ("claude", PermissionMode::FullAccess),
        ("codex", PermissionMode::AutoEdit),
        ("antigravity", PermissionMode::FullAccess),
        ("agy", PermissionMode::FullAccess),
    ] {
        let thread = core
            .create_thread(project_id, provider, None, None, None)
            .unwrap();
        assert_eq!(thread.permission_mode, expected);
    }
    let thread = core
        .create_thread(project_id, "claude", None, None, PermissionMode::Ask)
        .unwrap();
    assert_eq!(thread.permission_mode, PermissionMode::Ask);
}
