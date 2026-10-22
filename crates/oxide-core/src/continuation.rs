use oxide_provider::ItemKind;
use serde::{Deserialize, Serialize};

use crate::thread::{ThreadSummary, TurnSnapshot};

/// The most characters a recap prefill may hold.
pub const RECAP_MAX_CHARS: usize = 4000;

const RECAP_HEADER: &str =
    "Continuing a previous conversation whose session is no longer available. Recap of it:\n\n";

/// A Thread created to continue one whose Provider session is gone, with the prompt to prefill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuedThread {
    pub thread: ThreadSummary,
    pub recap: String,
}

/// The user prompts and the final agent message of each Turn, no tool output, cut to
/// [`RECAP_MAX_CHARS`] from the start so the latest exchange survives.
pub fn build_recap(turns: &[TurnSnapshot]) -> String {
    let body = turns
        .iter()
        .map(|turn| {
            let answer = turn
                .items
                .iter()
                .rfind(|i| i.kind == ItemKind::AgentMessage && i.parent_item_index.is_none());
            match answer {
                Some(answer) => format!("User: {}\nAgent: {}", turn.prompt, answer.content),
                None => format!("User: {}", turn.prompt),
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let budget = RECAP_MAX_CHARS - RECAP_HEADER.chars().count();
    let len = body.chars().count();
    if len <= budget {
        return format!("{RECAP_HEADER}{body}");
    }
    let tail: String = body.chars().skip(len - (budget - 1)).collect();
    format!("{RECAP_HEADER}…{tail}")
}
