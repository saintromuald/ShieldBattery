use async_graphql::scalar;
use enumset::EnumSetType;
use serde::{Deserialize, Serialize};
use strum_macros::EnumIter;
use typeshare::typeshare;
use uuid::Uuid;

use crate::users::SbUserId;

pub mod admin;
pub mod api;
pub mod backbone;
pub mod config;
pub mod history;
pub mod matchmaker;
mod metrics;

/// A single player's entry in a match found message.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare]
pub struct MatchedPlayer {
    pub id: SbUserId,
    /// Base64-encoded JSON QueueTicket. Node.js stores this and sends it back
    /// via POST /matchmaker/requeue if the match fails to start.
    pub ticket: String,
}

/// Data carried by the [`PublishedMatchmakingMessage::MatchFound`] event.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare]
pub struct MatchFoundMessage {
    /// Stable identity of this formation, reused by the game and relay session.
    pub formation_id: Uuid,
    pub mode: MatchmakingType,
    pub team_a: Vec<MatchedPlayer>,
    pub team_b: Vec<MatchedPlayer>,
    /// Overall match-quality score (in seconds of wait) the match formed at.
    pub quality: f32,
    /// Variance of the matched players' effective ratings (raw skill-spread input to `quality`).
    pub skill_variance: f32,
    /// Win probability of team A vs team B (0.5 == perfectly balanced).
    pub win_probability: f32,
    /// Effective team ratings used to compute `win_probability`.
    pub team_a_rating: f32,
    pub team_b_rating: f32,
    /// Estimated one-way latency (ms) of the match's worst pairwise link, computed from each
    /// player's measured RTT to their desired game server region plus the region-to-region
    /// backbone RTT (raw latency input to `quality`).
    pub max_latency: f32,
}

/// Messages published to the Redis `"matchmaking"` channel.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
#[typeshare]
pub enum PublishedMatchmakingMessage {
    MatchFound(MatchFoundMessage),
}

/// Error codes the matchmaking HTTP API returns in the `code` field of its JSON error bodies. This
/// is the single source of truth for the set of codes; it's shared with the Node.js client via
/// typeshare so both sides agree on the exact strings (rather than the client re-declaring them).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare]
pub enum RsMatchmakerErrorCode {
    /// The player is already in the queue.
    AlreadyInQueue,
    /// The queue request listed no modes to search for.
    NoModesSelected,
    /// The player was not found in the queue (e.g. cancel/requeue for someone already removed).
    NotFound,
    /// A requeue ticket was malformed and couldn't be decoded.
    InvalidTicket,
    /// A requeue ticket was issued by a previous process — server-rs has restarted since.
    StaleTicket,
}

/// All of the matchmaking types that we support. These values match the enum values used in the
/// database.
#[typeshare]
#[derive(Debug, Hash, EnumIter, EnumSetType, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "matchmaking_type")]
pub enum MatchmakingType {
    #[serde(rename = "1v1")]
    #[sqlx(rename = "1v1")]
    Match1v1,
    #[serde(rename = "1v1fastest")]
    #[sqlx(rename = "1v1fastest")]
    Match1v1Fastest,
    #[serde(rename = "2v2")]
    #[sqlx(rename = "2v2")]
    Match2v2,
    #[serde(rename = "2v2bgh")]
    #[sqlx(rename = "2v2bgh")]
    Match2v2Bgh,
    #[serde(rename = "2v2hunters")]
    #[sqlx(rename = "2v2hunters")]
    Match2v2Hunters,
    #[serde(rename = "2v2fastest")]
    #[sqlx(rename = "2v2fastest")]
    Match2v2Fastest,
    #[serde(rename = "3v3bgh")]
    #[sqlx(rename = "3v3bgh")]
    Match3v3Bgh,
    #[serde(rename = "3v3hunters")]
    #[sqlx(rename = "3v3hunters")]
    Match3v3Hunters,
    #[serde(rename = "3v3fastest")]
    #[sqlx(rename = "3v3fastest")]
    Match3v3Fastest,
    #[serde(rename = "hyperion1v1rule1")]
    #[sqlx(rename = "hyperion1v1rule1")]
    Hyperion1v1Rule1,
    #[serde(rename = "hyperion1v1rule2")]
    #[sqlx(rename = "hyperion1v1rule2")]
    Hyperion1v1Rule2,
    #[serde(rename = "hyperion1v1rule3")]
    #[sqlx(rename = "hyperion1v1rule3")]
    Hyperion1v1Rule3,
    #[serde(rename = "hyperion2v2rule1")]
    #[sqlx(rename = "hyperion2v2rule1")]
    Hyperion2v2Rule1,
    #[serde(rename = "hyperion2v2rule2")]
    #[sqlx(rename = "hyperion2v2rule2")]
    Hyperion2v2Rule2,
    #[serde(rename = "hyperion3v3rule1")]
    #[sqlx(rename = "hyperion3v3rule1")]
    Hyperion3v3Rule1,
    #[serde(rename = "hyperion3v3rule2")]
    #[sqlx(rename = "hyperion3v3rule2")]
    Hyperion3v3Rule2,
}

impl MatchmakingType {
    pub fn team_size(&self) -> usize {
        match self {
            MatchmakingType::Match1v1 => 1,
            MatchmakingType::Match1v1Fastest => 1,
            MatchmakingType::Match2v2 => 2,
            MatchmakingType::Match2v2Bgh => 2,
            MatchmakingType::Match2v2Hunters => 2,
            MatchmakingType::Match2v2Fastest => 2,
            MatchmakingType::Match3v3Bgh => 3,
            MatchmakingType::Match3v3Hunters => 3,
            MatchmakingType::Match3v3Fastest => 3,
            MatchmakingType::Hyperion1v1Rule1
            | MatchmakingType::Hyperion1v1Rule2
            | MatchmakingType::Hyperion1v1Rule3 => 1,
            MatchmakingType::Hyperion2v2Rule1 | MatchmakingType::Hyperion2v2Rule2 => 2,
            MatchmakingType::Hyperion3v3Rule1 | MatchmakingType::Hyperion3v3Rule2 => 3,
        }
    }

    pub fn total_players(&self) -> usize {
        self.team_size() * 2
    }

    /// A stable, lowercase string identifier for this mode, matching its serde/DB name. Used as a
    /// Prometheus label value (`mode="2v2bgh"`), so it must stay in sync with the `#[serde(rename)]`
    /// attributes above.
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchmakingType::Match1v1 => "1v1",
            MatchmakingType::Match1v1Fastest => "1v1fastest",
            MatchmakingType::Match2v2 => "2v2",
            MatchmakingType::Match2v2Bgh => "2v2bgh",
            MatchmakingType::Match2v2Hunters => "2v2hunters",
            MatchmakingType::Match2v2Fastest => "2v2fastest",
            MatchmakingType::Match3v3Bgh => "3v3bgh",
            MatchmakingType::Match3v3Hunters => "3v3hunters",
            MatchmakingType::Match3v3Fastest => "3v3fastest",
            MatchmakingType::Hyperion1v1Rule1 => "hyperion1v1rule1",
            MatchmakingType::Hyperion1v1Rule2 => "hyperion1v1rule2",
            MatchmakingType::Hyperion1v1Rule3 => "hyperion1v1rule3",
            MatchmakingType::Hyperion2v2Rule1 => "hyperion2v2rule1",
            MatchmakingType::Hyperion2v2Rule2 => "hyperion2v2rule2",
            MatchmakingType::Hyperion3v3Rule1 => "hyperion3v3rule1",
            MatchmakingType::Hyperion3v3Rule2 => "hyperion3v3rule2",
        }
    }
}

scalar!(
    MatchmakingType,
    "MatchmakingType",
    "All of the matchmaking types that we support. These values match the enum values used in the database."
);

#[cfg(test)]
mod tests {
    use strum::IntoEnumIterator;

    use super::MatchmakingType;

    #[test]
    fn hyperion_modes_have_independent_names_and_team_sizes() {
        let expected = [
            (MatchmakingType::Hyperion1v1Rule1, "hyperion1v1rule1", 1, 2),
            (MatchmakingType::Hyperion1v1Rule2, "hyperion1v1rule2", 1, 2),
            (MatchmakingType::Hyperion1v1Rule3, "hyperion1v1rule3", 1, 2),
            (MatchmakingType::Hyperion2v2Rule1, "hyperion2v2rule1", 2, 4),
            (MatchmakingType::Hyperion2v2Rule2, "hyperion2v2rule2", 2, 4),
            (MatchmakingType::Hyperion3v3Rule1, "hyperion3v3rule1", 3, 6),
            (MatchmakingType::Hyperion3v3Rule2, "hyperion3v3rule2", 3, 6),
        ];
        for (mode, name, team_size, total_players) in expected {
            assert_eq!(mode.as_str(), name);
            assert_eq!(mode.team_size(), team_size);
            assert_eq!(mode.total_players(), total_players);
        }
    }

    #[test]
    fn as_str_matches_serde_rename() {
        // `as_str` is used as a Prometheus label and must stay identical to the serde/DB name. This
        // catches a new mode (or a rename) that updates the serde attribute but forgets `as_str`.
        for mode in MatchmakingType::iter() {
            let serde = serde_json::to_string(&mode).unwrap();
            let serde = serde.trim_matches('"');
            assert_eq!(
                mode.as_str(),
                serde,
                "as_str() drifted from the serde rename for {mode:?}"
            );
        }
    }
}
