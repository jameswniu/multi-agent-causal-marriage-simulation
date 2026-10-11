//! The causal intervention. This is the only place the arm touches agent state: it sets the
//! agent's memory half-lives from the arm's parameter set and logs every parameter it set,
//! control value beside applied value, even when they are equal (a placebo run shows that).

use crate::config::{Arm, ShockConfig, ShockKind, ShockTarget, SimConfig};
use crate::log::{InterventionRow, Logs};
use crate::memory::Memory;

pub fn apply(
    cfg: &SimConfig,
    arm: Arm,
    day: i32,
    couple_id: u64,
    agent_id: u64,
    memory: &mut Memory,
    logs: &mut Logs,
) {
    let control = &cfg.memory.control;
    let applied = cfg.memory_params(arm).clone();
    let pairs: [(&'static str, f64, f64); 4] = [
        (
            "conflict_half_life_days",
            control.conflict_half_life_days,
            applied.conflict_half_life_days,
        ),
        (
            "repair_half_life_days",
            control.repair_half_life_days,
            applied.repair_half_life_days,
        ),
        (
            "positive_half_life_days",
            control.positive_half_life_days,
            applied.positive_half_life_days,
        ),
        (
            "load_saturation",
            control.load_saturation,
            applied.load_saturation,
        ),
    ];
    memory.params = applied;
    for (parameter, control_value, applied_value) in pairs {
        logs.interventions.push(InterventionRow {
            day,
            couple_id: couple_id as i64,
            agent_id: agent_id as i64,
            arm,
            parameter,
            control_value,
            applied_value,
        });
    }
    logs.event(
        day,
        couple_id,
        Some(agent_id),
        "intervention_applied",
        None,
        None,
        Some(memory.params.conflict_half_life_days),
    );
}

/// Whether a shock aimed at `target` applies to a couple in `arm` (remarriage couples have none).
pub fn shock_applies(target: ShockTarget, arm: Option<Arm>) -> bool {
    match target {
        ShockTarget::All => true,
        ShockTarget::Treatment => arm == Some(Arm::Treatment),
        ShockTarget::Control => arm == Some(Arm::Control),
    }
}

/// Log the start of a shock on one agent as an intervention row plus an event.
pub fn log_shock_start(
    day: i32,
    couple_id: u64,
    agent_id: u64,
    arm: Option<Arm>,
    shock: &ShockConfig,
    logs: &mut Logs,
) {
    logs.interventions.push(InterventionRow {
        day,
        couple_id: couple_id as i64,
        agent_id: agent_id as i64,
        arm: arm.unwrap_or(Arm::Control),
        parameter: shock_parameter_name(shock),
        control_value: 0.0,
        applied_value: shock.magnitude(),
    });
    logs.event(
        day,
        couple_id,
        Some(agent_id),
        shock_event_name(shock.kind),
        None,
        None,
        Some(shock.magnitude()),
    );
}

/// Intervention row parameter name; trait shifts name the trait they move.
pub fn shock_parameter_name(shock: &ShockConfig) -> &'static str {
    match (shock.kind, shock.trait_name.as_deref()) {
        (ShockKind::TraitShift, Some("neuroticism")) => "trait_shift:neuroticism",
        (ShockKind::TraitShift, Some("agreeableness")) => "trait_shift:agreeableness",
        (ShockKind::TraitShift, Some("conscientiousness")) => "trait_shift:conscientiousness",
        (ShockKind::TraitShift, Some("openness")) => "trait_shift:openness",
        (ShockKind::TraitShift, Some("extraversion")) => "trait_shift:extraversion",
        (ShockKind::TraitShift, Some("forgiveness")) => "trait_shift:forgiveness",
        (ShockKind::TraitShift, Some("commitment")) => "trait_shift:commitment",
        (ShockKind::TraitShift, Some("closeness_pref")) => "trait_shift:closeness_pref",
        (ShockKind::TraitShift, Some("conflict_engagement")) => "trait_shift:conflict_engagement",
        (ShockKind::TraitShift, _) => "trait_shift",
        (kind, _) => kind.as_str(),
    }
}

pub fn shock_event_name(kind: ShockKind) -> &'static str {
    match kind {
        ShockKind::JobLoss => "shock_job_loss",
        ShockKind::FinancialCrisis => "shock_financial_crisis",
        ShockKind::Temptation => "shock_temptation",
        ShockKind::IntimacyMismatch => "shock_intimacy_mismatch",
        ShockKind::DailyTexts => "shock_daily_texts",
        ShockKind::Anniversary => "shock_anniversary",
        ShockKind::DateNights => "shock_date_nights",
        ShockKind::TraitShift => "shock_trait_shift",
    }
}

pub fn shock_source(kind: ShockKind) -> &'static str {
    match kind {
        ShockKind::JobLoss => "shock:job_loss",
        ShockKind::FinancialCrisis => "shock:financial_crisis",
        ShockKind::Temptation => "shock:temptation",
        ShockKind::IntimacyMismatch => "shock:intimacy_mismatch",
        ShockKind::DailyTexts => "shock:daily_texts",
        ShockKind::Anniversary => "shock:anniversary",
        ShockKind::DateNights => "shock:date_nights",
        ShockKind::TraitShift => "shock:trait_shift",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treatment_sets_params_and_logs_three_rows() {
        let cfg = SimConfig::default();
        let mut m = Memory::new(cfg.memory.control.clone(), vec![]);
        let mut logs = Logs::default();
        apply(&cfg, Arm::Treatment, 0, 3, 7, &mut m, &mut logs);
        assert_eq!(m.params, cfg.memory.treatment);
        assert_eq!(logs.interventions.len(), 4);
        let row = &logs.interventions[0];
        assert_eq!(row.parameter, "conflict_half_life_days");
        assert_eq!(row.control_value, 14.0);
        assert_eq!(row.applied_value, 90.0);
        assert_eq!(logs.events.len(), 1);
    }

    #[test]
    fn shock_targets_resolve_by_arm() {
        assert!(shock_applies(ShockTarget::All, None));
        assert!(shock_applies(ShockTarget::Treatment, Some(Arm::Treatment)));
        assert!(!shock_applies(ShockTarget::Treatment, Some(Arm::Control)));
        assert!(!shock_applies(ShockTarget::Treatment, None));
        assert!(shock_applies(ShockTarget::Control, Some(Arm::Control)));
    }

    #[test]
    fn control_logs_equal_values() {
        let cfg = SimConfig::default();
        let mut m = Memory::new(cfg.memory.treatment.clone(), vec![]);
        let mut logs = Logs::default();
        apply(&cfg, Arm::Control, 0, 1, 2, &mut m, &mut logs);
        assert_eq!(m.params, cfg.memory.control);
        assert!(logs
            .interventions
            .iter()
            .all(|r| r.control_value == r.applied_value));
    }
}
