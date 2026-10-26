#[test]
fn bindings_are_up_to_date() {
    // Regenerates the file; CI fails on `git diff --exit-code` if it was stale.
    oxide_app_lib::export_bindings();
    let ts = std::fs::read_to_string(oxide_app_lib::BINDINGS_PATH).unwrap();
    assert!(ts.contains("listProjects") && ts.contains("saveSettings"));
    assert!(
        ts.contains("createThread")
            && ts.contains("subscribeThread")
            && ts.contains("sendPrompt")
            && ts.contains("listTurns")
    );
}

#[test]
fn webview_capabilities_grant_no_filesystem_or_shell_access() {
    let raw = std::fs::read_to_string("capabilities/default.json").unwrap();
    let cap: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for p in cap["permissions"].as_array().unwrap() {
        let p = p.as_str().unwrap();
        for denied in ["fs", "shell", "opener", "process", "http"] {
            assert!(
                !p.contains(denied),
                "capability `{p}` grants `{denied}` access"
            );
        }
        if p.starts_with("dialog:") {
            assert_eq!(p, "dialog:allow-open", "unexpected dialog capability `{p}`");
        }
    }
    assert!(
        cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "dialog:allow-open")
    );
}
