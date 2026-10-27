use oxide_core::Core;

#[test]
fn a_provider_with_no_commands_still_lists_oxides_once_each() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("proj");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let core = Core::open(home.path().join("oxide")).unwrap();
    let project_id = core.add_project(project.to_str().unwrap()).unwrap().id;

    for provider in ["fake", "codex"] {
        let list = core.list_slash_commands(provider, project_id).unwrap();
        let names: Vec<_> = list.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "clear",
                "diff",
                "effort",
                "model",
                "permissions",
                "reload-cache",
                "rename"
            ],
            "{provider}"
        );
    }
}

#[test]
fn slash_catalog_refresh_is_thread_scoped_and_persisted_outside_the_project() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let oxide_home = temp.path().join("oxide");
    let core = Core::open(&oxide_home).unwrap();
    let project_id = core.add_project(project.to_str().unwrap()).unwrap().id;
    let thread = core
        .create_thread(project_id, "fake", None, None, None)
        .unwrap();
    let catalog = core
        .thread_slash_commands("fake", project_id, Some(thread.id), true)
        .unwrap();
    assert!(catalog.iter().any(|c| c.name == "reload-cache"));
    assert!(
        oxide_home
            .join("cache/slash-commands/catalogs.json")
            .is_file()
    );
    assert!(!project.join(".oxide").exists());
    let other = temp.path().join("other");
    std::fs::create_dir_all(other.join(".git")).unwrap();
    let other_id = core.add_project(other.to_str().unwrap()).unwrap().id;
    assert!(
        core.thread_slash_commands("fake", other_id, Some(thread.id), false)
            .is_err()
    );
}
