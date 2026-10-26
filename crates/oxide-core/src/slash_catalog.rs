//! The Slash command catalog of a Thread: what its Provider reports, plus the commands Oxide
//! runs itself (ADR-0006).

use oxide_provider::{SlashCommandInfo, SlashRoute};

/// Commands Oxide intercepts for every Provider.
fn oxide_commands() -> Vec<SlashCommandInfo> {
    let own =
        |name: &str, description: &str, hint: Option<&str>, aliases: &[&str]| SlashCommandInfo {
            name: name.to_string(),
            description: Some(description.to_string()),
            argument_hint: hint.map(str::to_string),
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
            route: SlashRoute::Oxide,
        };
    vec![
        own("clear", "Start a new conversation", None, &["reset", "new"]),
        own("effort", "Set the Effort", Some("<level>"), &[]),
        own("model", "Set the Model", Some("<model>"), &[]),
    ]
}

/// Oxide's commands plus the Provider's. An Oxide command wins over a Provider command of the
/// same name, aliases included. Sorted by name.
pub fn merge(provider: Vec<SlashCommandInfo>) -> Vec<SlashCommandInfo> {
    let mut catalog = oxide_commands();
    let taken: Vec<String> = catalog
        .iter()
        .flat_map(|c| std::iter::once(c.name.clone()).chain(c.aliases.clone()))
        .collect();
    for mut cmd in provider {
        if taken.contains(&cmd.name) {
            continue;
        }
        cmd.aliases.retain(|a| !taken.contains(a));
        catalog.push(cmd);
    }
    catalog.sort_by(|a, b| a.name.cmp(&b.name));
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passthrough(name: &str, aliases: &[&str]) -> SlashCommandInfo {
        SlashCommandInfo {
            name: name.into(),
            description: None,
            argument_hint: None,
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
            route: SlashRoute::Passthrough,
        }
    }

    #[test]
    fn oxide_commands_win_by_name_and_alias() {
        let merged = merge(vec![
            passthrough("clear", &[]),
            passthrough("reset", &[]),
            passthrough("context", &["ctx", "new"]),
            passthrough("model", &[]),
        ]);
        let summary: Vec<_> = merged
            .iter()
            .map(|c| (c.name.as_str(), c.route, c.aliases.clone()))
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "clear",
                    SlashRoute::Oxide,
                    vec!["reset".to_string(), "new".to_string()]
                ),
                ("context", SlashRoute::Passthrough, vec!["ctx".to_string()]),
                ("effort", SlashRoute::Oxide, vec![]),
                ("model", SlashRoute::Oxide, vec![]),
            ]
        );
    }

    #[test]
    fn a_provider_without_commands_still_gets_oxides() {
        let names: Vec<_> = merge(Vec::new()).into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["clear", "effort", "model"]);
    }
}
