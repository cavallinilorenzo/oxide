use oxide_core::Core;

#[test]
fn a_provider_with_no_commands_still_lists_oxides_once_each() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("proj");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let core = Core::open(home.path().join("oxide")).unwrap();
    let project_id = core.add_project(project.to_str().unwrap()).unwrap().id;

    let list = core.list_slash_commands("fake", project_id, None).unwrap();
    let names: Vec<_> = list.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["clear", "effort", "model"]);
}
