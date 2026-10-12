//! Row types for the Parquet outputs. Every state transition and every intervention is a row.

use crate::config::Arm;

#[derive(Clone, Debug, PartialEq)]
pub struct EventRow {
    pub day: i32,
    pub seq: u32,
    pub couple_id: i64,
    pub agent_id: Option<i64>,
    pub kind: &'static str,
    pub from_state: Option<&'static str>,
    pub to_state: Option<&'static str>,
    pub value: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DailyRow {
    pub day: i32,
    pub couple_id: i64,
    pub state: &'static str,
    pub in_conflict: bool,
    pub conflict_days: i32,
    pub intensity: f64,
    pub positive_episode: bool,
    pub trust_a: f64,
    pub trust_b: f64,
    pub affect_a: f64,
    pub affect_b: f64,
    pub satisfaction_a: f64,
    pub satisfaction_b: f64,
    pub neg_a: f64,
    pub neg_b: f64,
    pub pos_a: f64,
    pub pos_b: f64,
    pub stress_a: f64,
    pub stress_b: f64,
    /// Consecutive days without a warm memory on both sides (0 while associated).
    pub orphan_days: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecisionRow {
    pub day: i32,
    pub couple_id: i64,
    pub agent_id: i64,
    pub context: &'static str,
    pub action: &'static str,
    pub p_chosen: f64,
    pub u_repair: Option<f64>,
    pub u_hold: Option<f64>,
    pub u_escalate: Option<f64>,
    pub u_withdraw: Option<f64>,
    pub u_leave: Option<f64>,
    pub trust: f64,
    pub affect: f64,
    pub neg_load: f64,
    pub pos_load: f64,
    pub intensity: f64,
    pub conflict_days: i32,
    pub partner_last: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InterventionRow {
    pub day: i32,
    pub couple_id: i64,
    pub agent_id: i64,
    pub arm: Arm,
    pub parameter: &'static str,
    pub control_value: f64,
    pub applied_value: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConflictRow {
    pub couple_id: i64,
    pub started_day: i32,
    pub ended_day: Option<i32>,
    pub outcome: &'static str,
    pub peak_intensity: f64,
    pub escalations: i32,
    pub repair_attempts: i32,
    pub duration_days: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EpisodeRow {
    pub day: i32,
    pub couple_id: i64,
    pub agent_id: i64,
    pub partner_id: i64,
    pub kind: &'static str,
    pub intensity: f64,
    pub source: &'static str,
    pub amplified: bool,
}

/// One member's sealed record of a marriage that ended in divorce.
#[derive(Clone, Debug, PartialEq)]
pub struct LegacyRow {
    pub day: i32,
    pub couple_id: i64,
    pub agent_id: i64,
    pub partner_id: i64,
    pub ended_by: &'static str,
    pub conflicts: i32,
    pub reconciled: i32,
    pub final_trust: f64,
    pub final_neg_load: f64,
    pub final_pos_load: f64,
    /// The ended marriage's compatibility, as the marriage market's anchor holds it.
    pub match_quality: f64,
    pub commitment_shift: f64,
    pub trust_prior: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Logs {
    pub events: Vec<EventRow>,
    pub daily: Vec<DailyRow>,
    pub decisions: Vec<DecisionRow>,
    pub interventions: Vec<InterventionRow>,
    pub conflicts: Vec<ConflictRow>,
    pub episodes: Vec<EpisodeRow>,
    pub legacies: Vec<LegacyRow>,
    seq: u32,
    seq_day: i32,
}

impl Logs {
    /// Append an event; `seq` restarts every day so ordering is (day, seq).
    #[allow(clippy::too_many_arguments)]
    pub fn event(
        &mut self,
        day: i32,
        couple_id: u64,
        agent_id: Option<u64>,
        kind: &'static str,
        from_state: Option<&'static str>,
        to_state: Option<&'static str>,
        value: Option<f64>,
    ) {
        if day != self.seq_day {
            self.seq_day = day;
            self.seq = 0;
        }
        self.events.push(EventRow {
            day,
            seq: self.seq,
            couple_id: couple_id as i64,
            agent_id: agent_id.map(|a| a as i64),
            kind,
            from_state,
            to_state,
            value,
        });
        self.seq += 1;
    }
}
