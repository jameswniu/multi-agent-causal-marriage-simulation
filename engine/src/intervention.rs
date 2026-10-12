//! The causal intervention. This is the only place the arm touches agent state: it sets the
//! agent's memory half-lives from the arm's parameter set and logs every parameter it set,
//! control value beside applied value, even when they are equal (a placebo run shows that).

use crate::config::{Arm, EffectConfig, ShockConfig, ShockKind, ShockTarget, SimConfig};
use crate::log::{InterventionRow, Logs};
use crate::memory::Memory;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

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
        ShockKind::Custom => "shock_custom",
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
        ShockKind::Custom => "shock:custom",
    }
}

/// Intern a log name built at run time (custom shock labels) so log rows can keep `&'static str`
/// fields. Each distinct name is leaked once per process, and names are bounded by the configs run.
pub fn intern(name: String) -> &'static str {
    static NAMES: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut set = NAMES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .expect("intern lock");
    if let Some(found) = set.get(name.as_str()) {
        return found;
    }
    let leaked: &'static str = Box::leak(name.into_boxed_str());
    set.insert(leaked);
    leaked
}

/// Intervention row parameter for one effect of a custom shock, e.g. `custom:in_law_moves_in:stress`.
pub fn custom_parameter(shock: &ShockConfig, effect: &EffectConfig) -> &'static str {
    let detail = effect
        .class
        .as_deref()
        .or(effect.trait_name.as_deref())
        .map(|d| format!(":{d}"))
        .unwrap_or_default();
    intern(format!(
        "custom:{}:{}{detail}",
        shock.label_slug(),
        effect.channel.as_str()
    ))
}

/// Event kind for a custom shock, e.g. `shock_custom:in_law_moves_in`.
pub fn custom_event(shock: &ShockConfig) -> &'static str {
    intern(format!("shock_custom:{}", shock.label_slug()))
}

/// Episode source for memories a custom shock stores, e.g. `shock:custom:in_law_moves_in`.
pub fn custom_source(shock: &ShockConfig) -> &'static str {
    intern(format!("shock:custom:{}", shock.label_slug()))
}

/// Whom a named kind's start log names: the resolved member, or both partners.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogWho {
    Member,
    Both,
}

/// How a named kind logs, kept exactly as before effects existed: whom its start is logged on,
/// and the couple-level event (if any) for each later firing.
pub fn builtin_log_plan(kind: ShockKind) -> (LogWho, Option<&'static str>) {
    match kind {
        ShockKind::FinancialCrisis | ShockKind::DateNights => (LogWho::Both, None),
        ShockKind::Anniversary => (LogWho::Both, Some("shock_anniversary")),
        _ => (LogWho::Member, None),
    }
}

/// Log the start of a custom shock on one agent: one intervention row per effect that hits the
/// agent (control value is the channel's identity, applied value the amount), then one event.
pub fn log_custom_start(
    day: i32,
    couple_id: u64,
    agent_id: u64,
    arm: Option<Arm>,
    shock: &ShockConfig,
    effects: &[&EffectConfig],
    logs: &mut Logs,
) {
    for e in effects {
        logs.interventions.push(InterventionRow {
            day,
            couple_id: couple_id as i64,
            agent_id: agent_id as i64,
            arm: arm.unwrap_or(Arm::Control),
            parameter: custom_parameter(shock, e),
            control_value: e.channel.identity(),
            applied_value: e.amount,
        });
    }
    logs.event(
        day,
        couple_id,
        Some(agent_id),
        custom_event(shock),
        None,
        None,
        Some(effects.len() as f64),
    );
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
