use oxide_core::Core;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn enabling_customizations_lists_skills_and_commands_and_passes_slashes_through() {
    let home = tempfile::tempdir().unwrap();
    let user_home = home.path().join("user");
    let project = user_home.join("proj");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    write(
        &user_home.join(".claude/skills/tdd/SKILL.md"),
        "---\nname: tdd\ndescription: Test-driven development\n---\nbody",
    );
    write(
        &user_home.join(".claude/commands/ship.md"),
        "---\ndescription: Ship it\n---\n",
    );
    write(
        &user_home.join(".claude/commands/git/sync.md"),
        "no frontmatter",
    );
    write(
        &project.join(".claude/commands/ship.md"),
        "---\ndescription: Project ship\n---\n",
    );

    let core = Core::open_with_user_home(home.path().join("oxide"), &user_home).unwrap();
    let project_id = core.add_project(project.to_str().unwrap()).unwrap().id;

    // Off by default: nothing is listed and slashes are not passed through.
    assert!(
        core.list_slash_commands("claude", project_id)
            .unwrap()
            .is_empty()
    );
    assert!(
        !core
            .get_provider_capabilities("claude")
            .slash_command_passthrough
    );

    let mut settings = core.settings().settings;
    settings.claude_customizations.skills = true;
    core.save_settings(&settings).unwrap();

    assert!(
        core.get_provider_capabilities("claude")
            .slash_command_passthrough
    );
    let list = core.list_slash_commands("claude", project_id).unwrap();
    let names: Vec<_> = list.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["git:sync", "ship", "tdd"]);
    let ship = list.iter().find(|c| c.name == "ship").unwrap();
    assert_eq!(ship.description.as_deref(), Some("Project ship"));
    assert!(
        core.list_slash_commands("codex", project_id)
            .unwrap()
            .is_empty()
    );
}
