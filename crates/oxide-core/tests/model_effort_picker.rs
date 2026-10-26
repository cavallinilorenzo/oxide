use oxide_core::{Core, PermissionMode, TurnStatus};
use oxide_provider::{FakeProvider, Provider, ProviderEvent};
use tempfile::tempdir;

fn setup_project(core: &Core, dir: &std::path::Path) -> u32 {
    let project_dir = dir.join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    core.add_project(&project_dir.to_string_lossy()).unwrap().id
}

#[test]
fn favourites_persistence() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();

    // Default should be empty or valid list
    let initial = core.get_favourite_models().unwrap();
    assert!(initial.is_empty());

    let favourites = vec!["gpt-5".to_string(), "claude-3-7-sonnet".to_string()];
    core.set_favourite_models(&favourites).unwrap();

    let reloaded = core.get_favourite_models().unwrap();
    assert_eq!(reloaded, favourites);

    // Persists across Core instances
    drop(core);
    let core2 = Core::open(dir.path()).unwrap();
    assert_eq!(core2.get_favourite_models().unwrap(), favourites);
}

#[test]
fn chosen_thread_model_survives_restart() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    let project_id = setup_project(&core, dir.path());
    let thread = core
        .create_thread(
            project_id,
            "fake",
            Some("initial".into()),
            Some("low".into()),
            PermissionMode::AutoEdit,
        )
        .unwrap();
    core.set_thread_model_and_effort(thread.id, Some("chosen".into()), Some("high".into()))
        .unwrap();
    drop(core);
    let reopened = Core::open(dir.path()).unwrap();
    let snapshot = reopened.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.model.as_deref(), Some("chosen"));
    assert_eq!(snapshot.thread.effort.as_deref(), Some("high"));
}

#[test]
fn model_catalog_caching_and_refresh() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();

    // Fetch catalog for a provider (e.g. claude or codex or agy)
    // The catalog comes from the installed CLI, so it may be empty where none is available.
    let cat1 = core.get_model_catalog("claude", false).unwrap();

    // Second call without refresh should use cache
    let cat2 = core.get_model_catalog("claude", false).unwrap();
    assert_eq!(cat1, cat2);

    // Refresh should re-query provider models
    let cat3 = core.get_model_catalog("claude", true).unwrap();
    assert_eq!(cat1, cat3);
}

#[test]
fn mid_thread_model_switch_gating() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let project_id = setup_project(&core, dir.path());

    // Provider that DOES NOT support mid_thread_model_switch
    let mut fake = FakeProvider::default().reusable();
    let mut caps = fake.capabilities();
    caps.mid_thread_model_switch = false;
    fake.set_capabilities(caps);

    let sender = fake.sender();
    fake.on_prompt(move |_prompt| {
        let s = sender.clone();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt: "turn 0".into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(
            project_id,
            "fake-locked",
            Some("initial-model".into()),
            Some("medium".into()),
            PermissionMode::AutoEdit,
        )
        .unwrap();

    core.register_fake_provider(thread.id, fake);

    // Before any turn runs: switching model succeeds
    let res_before = core.set_thread_model_and_effort(
        thread.id,
        Some("before-turn-model".into()),
        Some("high".into()),
    );
    assert!(res_before.is_ok());

    // Run first turn
    core.send_prompt(thread.id, "Hello first turn").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));

    // After first turn runs: switching model fails because mid_thread_model_switch is false
    let res_after = core.set_thread_model_and_effort(
        thread.id,
        Some("different-model".into()),
        Some("low".into()),
    );
    assert!(res_after.is_err());

    // But keeping the same model while changing effort should succeed
    let res_same_model = core.set_thread_model_and_effort(
        thread.id,
        Some("before-turn-model".into()),
        Some("low".into()),
    );
    assert!(res_same_model.is_ok());
}

#[test]
fn turn_records_model_and_effort_used() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let project_id = setup_project(&core, dir.path());

    let mut fake = FakeProvider::default().reusable();
    let mut caps = fake.capabilities();
    caps.mid_thread_model_switch = true;
    fake.set_capabilities(caps);

    let sender = fake.sender();
    fake.on_prompt(move |_prompt| {
        let s = sender.clone();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt: "ok".into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(
            project_id,
            "fake",
            Some("model-v1".into()),
            Some("low".into()),
            PermissionMode::AutoEdit,
        )
        .unwrap();

    core.register_fake_provider(thread.id, fake);

    // Turn 1
    core.send_prompt(thread.id, "Turn 1").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));

    let page1 = core.list_turns(thread.id, 0, 10).unwrap();
    assert_eq!(page1.turns.len(), 1);
    assert_eq!(page1.turns[0].model.as_deref(), Some("model-v1"));
    assert_eq!(page1.turns[0].effort.as_deref(), Some("low"));

    // Switch model and effort for next turn
    core.set_thread_model_and_effort(thread.id, Some("model-v2".into()), Some("high".into()))
        .unwrap();

    // Turn 2
    core.send_prompt(thread.id, "Turn 2").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));

    let page2 = core.list_turns(thread.id, 0, 10).unwrap();
    assert_eq!(page2.turns.len(), 2);
    assert_eq!(page2.turns[1].model.as_deref(), Some("model-v2"));
    assert_eq!(page2.turns[1].effort.as_deref(), Some("high"));
}

#[test]
fn slash_commands_model_and_effort_intercepted_and_not_sent_to_provider() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let project_id = setup_project(&core, dir.path());

    let fake = FakeProvider::default().reusable();
    let recorder = fake.recorder();

    let thread = core
        .create_thread(
            project_id,
            "fake",
            Some("original-model".into()),
            Some("low".into()),
            PermissionMode::AutoEdit,
        )
        .unwrap();

    core.register_fake_provider(thread.id, fake);

    // Sending /model without args
    core.send_prompt(thread.id, "/model").unwrap();
    // Sending /model with model arg
    core.send_prompt(thread.id, "/model new-cool-model")
        .unwrap();
    // Sending /effort with effort arg
    core.send_prompt(thread.id, "/effort high").unwrap();

    // None of these should have reached the provider!
    assert_eq!(recorder.prompts().len(), 0);

    // And the model/effort on thread should be updated
    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.model.as_deref(), Some("new-cool-model"));
    assert_eq!(snapshot.thread.effort.as_deref(), Some("high"));
}

#[test]
fn slash_command_passthrough_gated() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let project_id = setup_project(&core, dir.path());

    // 1. When passthrough is FALSE
    let mut fake1 = FakeProvider::default().reusable();
    let mut caps1 = fake1.capabilities();
    caps1.slash_command_passthrough = false;
    fake1.set_capabilities(caps1);
    let rec1 = fake1.recorder();

    let t1 = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(t1.id, fake1);

    // Other slash command (e.g. /compact or /custom) should be rejected
    let res = core.send_prompt(t1.id, "/compact");
    assert!(res.is_err());
    assert_eq!(rec1.prompts().len(), 0);

    // 2. When passthrough is TRUE
    let mut fake2 = FakeProvider::default().reusable();
    let mut caps2 = fake2.capabilities();
    caps2.slash_command_passthrough = true;
    fake2.set_capabilities(caps2);
    let rec2 = fake2.recorder();

    let t2 = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(t2.id, fake2);

    let res2 = core.send_prompt(t2.id, "/compact");
    assert!(res2.is_ok());
    assert_eq!(rec2.prompts().as_slice(), &["/compact"]);
}
