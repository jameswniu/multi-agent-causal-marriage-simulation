//! Build the world from a config, run it for `days` ticks, and summarise.

use crate::assignment;
use crate::components::*;
use crate::config::{Arm, SimConfig};
use crate::dynamics;
use crate::intervention;
use crate::legacy::Legacy;
use crate::log::{ConflictRow, Logs};
use crate::memory::Memory;
use crate::population::{self, Population};
use crate::publish;
use crate::rng;
use crate::systems::{agents_by_id, build_schedule, couples_by_id};
use anyhow::Result;
use bevy_ecs::prelude::*;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct AgentSummary {
    pub agent_id: i64,
    pub couple_id: i64,
    pub arm: &'static str,
    pub neuroticism: f64,
    pub agreeableness: f64,
    pub conscientiousness: f64,
    pub openness: f64,
    pub extraversion: f64,
    pub forgiveness: f64,
    pub commitment: f64,
    pub closeness_pref: f64,
    pub conflict_engagement: f64,
    pub prior_relationships: i32,
    pub prior_divorces: i32,
    pub years_married: f64,
    pub base_trust: f64,
    pub relax_rate: f64,
    pub initial_episodes: i32,
    pub conflict_half_life_days: f64,
    pub repair_half_life_days: f64,
    pub positive_half_life_days: f64,
    pub divorces_in_sim: i32,
    pub marriages_in_sim: i32,
    pub final_trust: f64,
    pub final_memory_size: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CoupleSummary {
    pub couple_id: i64,
    pub agent_a: i64,
    pub agent_b: i64,
    pub arm: Option<&'static str>,
    pub origin: &'static str,
    pub formed_day: i32,
    pub married_day: Option<i32>,
    pub compatibility: f64,
    pub final_state: &'static str,
    pub ended_day: Option<i32>,
    pub years_married_at_start: f64,
}

#[derive(Clone, Debug)]
pub struct SimResult {
    pub logs: Logs,
    pub agents: Vec<AgentSummary>,
    pub couples: Vec<CoupleSummary>,
    pub arms: Vec<Arm>,
    pub population: Population,
}

/// Spawn agents and couples, wire the network, randomise, and apply the intervention at day 0.
pub fn build_world(cfg: &SimConfig) -> (World, Population, Vec<Arm>) {
    let pop = population::generate(cfg);
    let arms = assignment::assign(cfg);
    let mut world = World::new();
    world.insert_resource(Clock { day: 0 });
    world.insert_resource(Config(cfg.clone()));
    world.insert_resource(NextCoupleId(cfg.n_couples as u64));
    world.insert_resource(MarketRng(rng::stream(cfg.seeds.dynamics, "market", 0)));
    world.insert_resource(LogStore::default());

    let mut index: Vec<Entity> = Vec::with_capacity(pop.agents.len());
    for a in &pop.agents {
        let e = world
            .spawn((
                AgentId(a.id),
                Traits {
                    personality: a.personality,
                    prefs: a.prefs,
                    history: a.history,
                    base_trust: a.base_trust,
                    relax_rate: a.relax_rate,
                },
                Affect {
                    trust: a.base_trust,
                    affect: 0.0,
                    stress: 0.0,
                    satisfaction: 0.5,
                },
                Bond::default(),
                Market {
                    single_since: None,
                    threshold: cfg.market.initial_threshold,
                    last_compat: None,
                    divorces_in_sim: 0,
                    marriages_in_sim: 0,
                },
                AgentRng(rng::stream(cfg.seeds.dynamics, "agent", a.id)),
                LastAction::default(),
                Memory::new(cfg.memory.control.clone(), a.initial_episodes.clone())
                    .with_plateau(cfg.memory_rules.plateau_days),
                Social::default(),
                Modifiers::default(),
                Legacy::default(),
            ))
            .id();
        index.push(e);
    }
    for (i, nbrs) in pop.network.iter().enumerate() {
        let ents: Vec<Entity> = nbrs.iter().map(|&j| index[j as usize]).collect();
        world
            .get_mut::<Social>(index[i])
            .expect("social")
            .neighbours = ents;
    }
    for c in &pop.couples {
        let (ea, eb) = (index[c.a as usize], index[c.b as usize]);
        let formed = -((c.years_married * 365.0).round() as i32);
        let ce = world
            .spawn((
                Couple {
                    id: c.id,
                    a: ea,
                    b: eb,
                    a_id: c.a,
                    b_id: c.b,
                    origin: Origin::Initial,
                    arm: Some(arms[c.id as usize]),
                    formed_day: formed,
                    married_day: Some(formed),
                    compatibility: c.compatibility,
                },
                Rel::new(RelState::Married),
                CoupleRng(rng::stream(cfg.seeds.dynamics, "couple", c.id)),
                ShockState {
                    member: vec![None; cfg.shocks.len()],
                },
            ))
            .id();
        *world.get_mut::<Bond>(ea).expect("bond") = Bond {
            couple: Some(ce),
            partner: Some(eb),
            partner_id: Some(c.b),
        };
        *world.get_mut::<Bond>(eb).expect("bond") = Bond {
            couple: Some(ce),
            partner: Some(ea),
            partner_id: Some(c.a),
        };
        world.get_mut::<Market>(ea).expect("market").threshold = c.compatibility;
        world.get_mut::<Market>(eb).expect("market").threshold = c.compatibility;
    }
    // The intervention: the only arm-dependent write, logged per parameter.
    let mut logs = std::mem::take(&mut world.resource_mut::<LogStore>().0);
    for a in &pop.agents {
        for ep in &a.initial_episodes {
            logs.episodes.push(crate::log::EpisodeRow {
                day: ep.day,
                couple_id: a.couple_id as i64,
                agent_id: a.id as i64,
                partner_id: ep.partner as i64,
                kind: ep.kind.as_str(),
                intensity: ep.intensity,
                source: "history",
                amplified: false,
            });
        }
    }
    for c in &pop.couples {
        let arm = arms[c.id as usize];
        for aid in [c.a, c.b] {
            let e = index[aid as usize];
            let mut m = world.get_mut::<Memory>(e).expect("memory");
            intervention::apply(cfg, arm, 0, c.id, aid, &mut m, &mut logs);
        }
    }
    world.resource_mut::<LogStore>().0 = logs;
    // Initial satisfaction from day-0 state.
    for (_, e) in agents_by_id(&mut world) {
        let bond = world.get::<Bond>(e).copied().unwrap_or_default();
        let loads = match bond.partner_id {
            Some(p) => world
                .get::<Memory>(e)
                .map(|m| m.loads(0, p))
                .unwrap_or_default(),
            None => Default::default(),
        };
        let mut a = world.get_mut::<Affect>(e).expect("affect");
        a.satisfaction = dynamics::satisfaction(&cfg.dynamics, a.trust, a.affect, loads);
    }
    world.insert_resource(AgentIndex(index));
    (world, pop, arms)
}

/// Run the whole simulation in memory.
pub fn run(cfg: &SimConfig) -> SimResult {
    let (mut world, pop, arms) = build_world(cfg);
    let mut schedule = build_schedule();
    for _ in 0..cfg.days {
        schedule.run(&mut world);
    }
    let last_day = cfg.days as i32 - 1;
    let mut logs = std::mem::take(&mut world.resource_mut::<LogStore>().0);
    let mut couples = Vec::new();
    for (_, ce) in couples_by_id(&mut world) {
        let c = world.get::<Couple>(ce).cloned().expect("couple");
        let r = world.get::<Rel>(ce).cloned().expect("rel");
        if let Some(conf) = r.conflict {
            logs.conflicts.push(ConflictRow {
                couple_id: c.id as i64,
                started_day: conf.started,
                ended_day: None,
                outcome: "open_at_end",
                peak_intensity: conf.peak_intensity,
                escalations: conf.escalations as i32,
                repair_attempts: conf.repair_attempts as i32,
                duration_days: None,
            });
        }
        let years = if c.origin == Origin::Initial {
            pop.couples[c.id as usize].years_married
        } else {
            0.0
        };
        couples.push(CoupleSummary {
            couple_id: c.id as i64,
            agent_a: c.a_id as i64,
            agent_b: c.b_id as i64,
            arm: c.arm.map(|a| a.as_str()),
            origin: c.origin.as_str(),
            formed_day: c.formed_day,
            married_day: c.married_day,
            compatibility: c.compatibility,
            final_state: r.state.as_str(),
            ended_day: r.ended_day,
            years_married_at_start: years,
        });
    }
    logs.conflicts.sort_by_key(|r| (r.couple_id, r.started_day));
    logs.episodes
        .sort_by_key(|x| (x.day, x.couple_id, x.agent_id));
    logs.legacies
        .sort_by_key(|x| (x.day, x.couple_id, x.agent_id));
    let _ = last_day;
    let mut agents = Vec::new();
    for (id, e) in agents_by_id(&mut world) {
        let spec = &pop.agents[id as usize];
        let arm = arms[spec.couple_id as usize];
        let m = world.get::<Memory>(e).expect("memory");
        let k = world.get::<Market>(e).copied().expect("market");
        let a = world.get::<Affect>(e).copied().expect("affect");
        agents.push(AgentSummary {
            agent_id: id as i64,
            couple_id: spec.couple_id as i64,
            arm: arm.as_str(),
            neuroticism: spec.personality.neuroticism,
            agreeableness: spec.personality.agreeableness,
            conscientiousness: spec.personality.conscientiousness,
            openness: spec.personality.openness,
            extraversion: spec.personality.extraversion,
            forgiveness: spec.prefs.forgiveness,
            commitment: spec.prefs.commitment,
            closeness_pref: spec.prefs.closeness_pref,
            conflict_engagement: spec.prefs.conflict_engagement,
            prior_relationships: spec.history.prior_relationships as i32,
            prior_divorces: spec.history.prior_divorces as i32,
            years_married: spec.history.years_married,
            base_trust: spec.base_trust,
            relax_rate: spec.relax_rate,
            initial_episodes: spec.initial_episodes.len() as i32,
            conflict_half_life_days: m.params.conflict_half_life_days,
            repair_half_life_days: m.params.repair_half_life_days,
            positive_half_life_days: m.params.positive_half_life_days,
            divorces_in_sim: k.divorces_in_sim as i32,
            marriages_in_sim: k.marriages_in_sim as i32,
            final_trust: a.trust,
            final_memory_size: m.len() as i32,
        });
    }
    SimResult {
        logs,
        agents,
        couples,
        arms,
        population: pop,
    }
}

/// Quick arm-level counts for the manifest (the real analysis lives in Python).
pub fn summary(res: &SimResult) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for arm in [Arm::Control, Arm::Treatment] {
        let n = res
            .couples
            .iter()
            .filter(|c| c.arm == Some(arm.as_str()))
            .count();
        let divorced = res
            .couples
            .iter()
            .filter(|c| c.arm == Some(arm.as_str()) && c.final_state == "divorced")
            .count();
        let separated = res
            .couples
            .iter()
            .filter(|c| c.arm == Some(arm.as_str()) && c.final_state == "separated")
            .count();
        let conflicts = res
            .logs
            .conflicts
            .iter()
            .filter(|r| {
                res.couples
                    .get(r.couple_id as usize)
                    .map(|c| c.arm == Some(arm.as_str()))
                    .unwrap_or(false)
            })
            .count();
        out.insert(
            arm.as_str().to_string(),
            serde_json::json!({"couples": n, "divorced": divorced, "separated": separated, "conflicts": conflicts}),
        );
    }
    let remarriages = res
        .couples
        .iter()
        .filter(|c| c.origin == "remarriage")
        .count();
    let remarried = res
        .couples
        .iter()
        .filter(|c| c.origin == "remarriage" && c.married_day.is_some())
        .count();
    out.insert(
        "remarriage_couples_formed".into(),
        serde_json::json!(remarriages),
    );
    out.insert("remarriages".into(), serde_json::json!(remarried));
    out.insert("events".into(), serde_json::json!(res.logs.events.len()));
    out.insert(
        "decisions".into(),
        serde_json::json!(res.logs.decisions.len()),
    );
    serde_json::Value::Object(out)
}

/// Run and write every table plus `manifest.json` into `out_dir`.
/// Run a config and write its results directory.
///
/// The target is locked for the whole call, any publication an earlier run left interrupted next
/// to it is repaired first, and the run itself is staged in a hidden sibling and published by
/// rename only once every table, the manifest and the config are written. A failure part-way (a
/// full disk, a serialization error, a crash) therefore never destroys previous results and never
/// leaves a half-written run in their place. See `crate::publish`.
pub fn run_to_dir(cfg: &SimConfig, out_dir: &Path, overwrite: bool) -> Result<serde_json::Value> {
    let (parent, name) = publish::split(out_dir)?;
    let _lock = publish::TargetLock::acquire(&parent, &name)?;
    publish::recover(&parent, &name)?;
    if out_dir.exists() && !overwrite {
        anyhow::bail!(
            "{} exists; pass --overwrite to replace it",
            out_dir.display()
        );
    }
    if out_dir.exists() {
        // Only a LoveWorld results directory (or an empty one) may be replaced, so a mistyped
        // path can never delete unrelated data.
        let is_results = out_dir.join("manifest.json").is_file();
        let is_empty = std::fs::read_dir(out_dir)?.next().is_none();
        anyhow::ensure!(
            is_results || is_empty,
            "{} exists and is not a LoveWorld results directory (no manifest.json); refusing to remove it",
            out_dir.display()
        );
    }
    let staging = publish::Staging::create(&parent, &name)?;
    let res = run(cfg);
    let files = crate::output::write_all(&staging.path, &res.logs, &res.agents, &res.couples)?;
    let manifest = crate::output::manifest_json(
        cfg,
        &files,
        summary(&res),
        crate::policy::spec(&cfg.policy, &cfg.association, &cfg.legacy),
    );
    std::fs::write(
        staging.path.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    std::fs::write(
        staging.path.join("config.json"),
        serde_json::to_string_pretty(cfg)?,
    )?;
    staging.publish(out_dir)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small() -> SimConfig {
        SimConfig {
            n_couples: 40,
            days: 60,
            ..SimConfig::default()
        }
    }

    /// A year of 200 couples, all under the long memory, so divorces and separations occur.
    fn year() -> SimConfig {
        SimConfig {
            n_couples: 200,
            days: 365,
            arm_override: Some(Arm::Treatment),
            ..SimConfig::default()
        }
    }

    #[test]
    fn every_divorce_is_sealed_once_per_member() {
        let res = run(&year());
        let divorces: Vec<i64> = res
            .logs
            .events
            .iter()
            .filter(|e| e.kind == "divorced")
            .map(|e| e.couple_id)
            .collect();
        assert!(!divorces.is_empty(), "the test world must contain divorces");
        assert_eq!(res.logs.legacies.len(), 2 * divorces.len());
        let sealed = res
            .logs
            .events
            .iter()
            .filter(|e| e.kind == "sealed")
            .count();
        assert_eq!(sealed, 2 * divorces.len());
        for c in &divorces {
            let rows: Vec<_> = res
                .logs
                .legacies
                .iter()
                .filter(|l| l.couple_id == *c)
                .collect();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].agent_id, rows[1].partner_id);
            assert_eq!(rows[1].agent_id, rows[0].partner_id);
            assert!(rows.iter().filter(|r| r.ended_by == "self").count() <= 1);
            for r in rows {
                assert!(r.reconciled <= r.conflicts);
                assert!((0.05..=0.95).contains(&r.trust_prior));
                assert_eq!(r.commitment_shift, year().legacy.commitment_shift);
            }
        }
    }

    #[test]
    fn separated_memories_neither_fade_nor_drop() {
        let res = run(&year());
        let mut rows: Vec<&crate::log::DailyRow> = res.logs.daily.iter().collect();
        rows.sort_by_key(|r| (r.couple_id, r.day));
        let mut stretches = 0;
        for w in rows.windows(2) {
            let (p, c) = (w[0], w[1]);
            if p.couple_id != c.couple_id || p.state != "separated" || c.state != "separated" {
                continue;
            }
            stretches += 1;
            for (before, after) in [
                (p.neg_a, c.neg_a),
                (p.neg_b, c.neg_b),
                (p.pos_a, c.pos_a),
                (p.pos_b, c.pos_b),
            ] {
                assert!(
                    after >= before - 1e-12,
                    "couple {} day {}: {before} then {after}",
                    c.couple_id,
                    c.day
                );
            }
        }
        assert!(stretches > 0, "the test world must contain separations");
    }

    #[test]
    fn married_couples_are_offered_leave_only_past_the_gate() {
        let cfg = year();
        let res = run(&cfg);
        let state: std::collections::HashMap<(i64, i32), (&str, i32)> = res
            .logs
            .daily
            .iter()
            .map(|d| ((d.couple_id, d.day), (d.state, d.orphan_days)))
            .collect();
        let gate = &cfg.association;
        let (mut offered, mut withheld) = (0, 0);
        for d in res
            .logs
            .decisions
            .iter()
            .filter(|d| d.context == "conflict")
        {
            let (st, orphan) = state[&(d.couple_id, d.day)];
            if st != "married" && st != "separated" {
                continue; // a dating couple: never gated
            }
            let open =
                orphan >= gate.orphan_days_to_leave as i32 || d.intensity >= gate.unlock_intensity;
            assert_eq!(
                d.u_leave.is_some(),
                open,
                "couple {} day {}",
                d.couple_id,
                d.day
            );
            if open {
                offered += 1;
            } else {
                withheld += 1;
                assert_ne!(d.action, "leave");
            }
        }
        assert!(offered > 0 && withheld > 0);
        // With the gate off every married couple's conflict offers leave.
        let mut off = cfg.clone();
        off.association.orphan_days_to_leave = 0;
        let res = run(&off);
        assert!(res
            .logs
            .decisions
            .iter()
            .filter(|d| d.context == "conflict")
            .all(|d| d.u_leave.is_some()));
    }

    #[test]
    fn every_consolidation_is_logged_once() {
        let res = run(&year());
        let rows = res
            .logs
            .episodes
            .iter()
            .filter(|e| e.source == "consolidated")
            .count();
        let events = res
            .logs
            .events
            .iter()
            .filter(|e| e.kind == "memory_consolidated")
            .count();
        assert!(rows > 0);
        assert_eq!(rows, events);
        let mut off = year();
        off.memory_rules.consolidate_after = 0;
        assert!(run(&off)
            .logs
            .episodes
            .iter()
            .all(|e| e.source != "consolidated"));
    }

    #[test]
    fn run_is_deterministic() {
        let a = run(&small());
        let b = run(&small());
        assert_eq!(a.logs.events, b.logs.events);
        assert_eq!(a.logs.daily, b.logs.daily);
        assert_eq!(a.logs.decisions, b.logs.decisions);
        assert_eq!(a.couples, b.couples);
        assert_eq!(a.agents, b.agents);
    }

    #[test]
    fn dynamics_seed_changes_outcomes_not_population() {
        let a = run(&small());
        let mut c = small();
        c.seeds.dynamics = 1234;
        let b = run(&c);
        assert_eq!(a.population, b.population);
        assert_eq!(a.arms, b.arms);
        assert_ne!(a.logs.events, b.logs.events);
    }

    #[test]
    fn every_couple_day_logged_and_states_legal() {
        let res = run(&small());
        let initial_rows = res.logs.daily.iter().filter(|r| r.couple_id < 40).count();
        // Every initial couple has a row every day until it ends (inclusive).
        let ended: Vec<i32> = res
            .couples
            .iter()
            .take(40)
            .map(|c| c.ended_day.unwrap_or(59))
            .collect();
        let expected: usize = ended.iter().map(|e| (*e + 1) as usize).sum();
        assert_eq!(initial_rows, expected);
        for e in &res.logs.events {
            if let (Some(f), Some(t)) = (e.from_state, e.to_state) {
                let parse = |s: &str| match s {
                    "dating" => RelState::Dating,
                    "married" => RelState::Married,
                    "separated" => RelState::Separated,
                    "divorced" => RelState::Divorced,
                    "broken_up" => RelState::BrokenUp,
                    _ => panic!("unknown state {s}"),
                };
                assert!(
                    parse(f).can_move_to(parse(t)),
                    "illegal transition {f} -> {t}"
                );
            }
        }
    }

    #[test]
    fn interventions_logged_for_every_initial_agent() {
        let res = run(&small());
        assert_eq!(res.logs.interventions.len(), 80 * 4);
        let treated = res.agents.iter().filter(|a| a.arm == "treatment").count();
        assert_eq!(treated, 40);
        for a in &res.agents {
            let expect = if a.arm == "treatment" { 90.0 } else { 14.0 };
            assert_eq!(a.conflict_half_life_days, expect);
        }
    }

    #[test]
    fn every_repair_bid_is_counted_and_logged() {
        let res = run(&small());
        let repair_decisions = res
            .logs
            .decisions
            .iter()
            .filter(|d| d.action == "repair")
            .count();
        let repair_events = res
            .logs
            .events
            .iter()
            .filter(|e| e.kind == "repair_attempted")
            .count();
        assert_eq!(repair_decisions, repair_events);
        let in_conflict = res
            .logs
            .decisions
            .iter()
            .filter(|d| d.context == "conflict" && d.action == "repair")
            .count();
        let counted: i32 = res.logs.conflicts.iter().map(|c| c.repair_attempts).sum();
        assert_eq!(in_conflict as i32, counted);
        assert!(repair_events > 0);
    }

    #[test]
    fn positive_episodes_need_both_members() {
        let res = run(&small());
        let positive_days = res.logs.daily.iter().filter(|d| d.positive_episode).count();
        assert!(positive_days > 0);
    }

    fn with_shocks(json: &str) -> SimConfig {
        let mut cfg = SimConfig::from_json(json).unwrap();
        cfg.n_couples = 40;
        cfg.days = 60;
        cfg
    }

    #[test]
    fn shocks_hit_only_their_target_arm() {
        let cfg = with_shocks(
            r#"{"shocks": [{"kind": "job_loss", "target": "treatment", "member": "a", "start_day": 5}]}"#,
        );
        let res = run(&cfg);
        let rows: Vec<_> = res
            .logs
            .interventions
            .iter()
            .filter(|r| r.parameter == "job_loss")
            .collect();
        assert!(!rows.is_empty());
        assert!(rows.iter().all(|r| r.arm == Arm::Treatment && r.day == 5));
        let shocked: std::collections::HashSet<i64> = rows.iter().map(|r| r.couple_id).collect();
        for c in res.couples.iter().filter(|c| c.origin == "initial") {
            assert_eq!(
                shocked.contains(&c.couple_id),
                c.arm == Some("treatment"),
                "couple {}",
                c.couple_id
            );
        }
        assert_eq!(
            res.logs
                .events
                .iter()
                .filter(|e| e.kind == "shock_job_loss")
                .count(),
            rows.len()
        );
        // Job loss: the shocked member is always agent a.
        assert!(rows.iter().all(|r| r.agent_id % 2 == 0));
    }

    #[test]
    fn financial_crisis_raises_stress_for_everyone() {
        let base = run(&with_shocks("{}"));
        let crisis = run(&with_shocks(
            r#"{"shocks": [{"kind": "financial_crisis", "target": "all", "start_day": 10, "end_day": 40, "magnitude": 2.0}]}"#,
        ));
        let mean = |r: &SimResult| {
            let rows: Vec<_> = r
                .logs
                .daily
                .iter()
                .filter(|d| d.day >= 15 && d.day <= 40)
                .collect();
            rows.iter().map(|d| d.stress_a + d.stress_b).sum::<f64>() / (2.0 * rows.len() as f64)
        };
        assert!(
            mean(&crisis) > mean(&base) + 0.3,
            "crisis {} base {}",
            mean(&crisis),
            mean(&base)
        );
        assert_eq!(
            crisis
                .logs
                .interventions
                .iter()
                .filter(|r| r.parameter == "financial_crisis")
                .count(),
            80
        );
    }

    #[test]
    fn kindness_shocks_store_positive_memories() {
        let res = run(&with_shocks(
            r#"{"shocks": [
            {"kind": "daily_texts", "target": "treatment", "member": "b", "start_day": 0, "end_day": 59},
            {"kind": "anniversary", "target": "all", "start_day": 20},
            {"kind": "date_nights", "target": "control", "start_day": 3, "end_day": 59}]}"#,
        ));
        let arm_of = |cid: i64| res.couples[cid as usize].arm;
        // Shocks act on couples who are together (married or dating) that day.
        let together = |cid: i64, day: i32| {
            // Shocks act at the start of a day on couples who were together at the end of the
            // previous day; every initial couple starts married on day 0.
            day == 0
                || res.logs.daily.iter().any(|d| {
                    d.couple_id == cid
                        && d.day == day - 1
                        && (d.state == "married" || d.state == "dating")
                })
        };
        let expected_texts: usize = (0..40i64)
            .filter(|c| arm_of(*c) == Some("treatment"))
            .map(|c| (0..60).filter(|day| together(c, *day)).count())
            .sum();
        let texts = res
            .logs
            .episodes
            .iter()
            .filter(|e| e.source == "shock:daily_texts")
            .count();
        assert_eq!(
            texts, expected_texts,
            "one text a day for every treated couple while together"
        );
        assert!(texts > 1000);
        assert!(
            res.logs
                .episodes
                .iter()
                .filter(|e| e.source == "shock:daily_texts")
                .all(|e| e.agent_id % 2 == 0),
            "texts from b land in a's memory"
        );
        let expected_anniv = 2 * (0..40i64).filter(|c| together(*c, 20)).count();
        let anniv = res
            .logs
            .episodes
            .iter()
            .filter(|e| e.source == "shock:anniversary")
            .count();
        assert_eq!(anniv, expected_anniv);
        let expected_dates: usize = (0..40i64)
            .filter(|c| arm_of(*c) == Some("control"))
            .map(|c| 2 * (3..60).step_by(7).filter(|day| together(c, *day)).count())
            .sum();
        let dates = res
            .logs
            .episodes
            .iter()
            .filter(|e| e.source == "shock:date_nights")
            .count();
        assert_eq!(dates, expected_dates);
        assert!(dates > 0);
    }

    #[test]
    fn overlapping_shocks_of_one_kind_compose() {
        // Two crises on everyone: the short one ends on day 10, the long one on day 20. Stress on
        // days 14 to 20 must still carry the long one's contribution.
        let two = run(&with_shocks(
            r#"{"shocks": [
            {"kind": "financial_crisis", "target": "all", "start_day": 0, "end_day": 20, "magnitude": 2.0},
            {"kind": "financial_crisis", "target": "all", "start_day": 0, "end_day": 10, "magnitude": 2.0}]}"#,
        ));
        let one = run(&with_shocks(
            r#"{"shocks": [
            {"kind": "financial_crisis", "target": "all", "start_day": 0, "end_day": 20, "magnitude": 2.0}]}"#,
        ));
        let mean = |r: &SimResult, lo: i32, hi: i32| {
            let rows: Vec<_> = r
                .logs
                .daily
                .iter()
                .filter(|d| d.day >= lo && d.day <= hi)
                .collect();
            rows.iter().map(|d| d.stress_a + d.stress_b).sum::<f64>() / (2.0 * rows.len() as f64)
        };
        assert!(
            mean(&two, 0, 10) > mean(&one, 0, 10) + 0.2,
            "both crises stack while both are active"
        );
        assert!(
            (mean(&two, 14, 20) - mean(&one, 14, 20)).abs() < 0.15,
            "after the short one ends the long one still applies"
        );
    }

    #[test]
    fn disappointment_draws_never_touch_the_couple_streams() {
        // The weekly disappointment coin uses its own keyed stream, so switching it off must not
        // change any draw from the couple streams: day-0 conflict onsets are identical.
        let res = run(&small());
        let mut cfg = small();
        cfg.dynamics.disappointment_weekly_rate = 0.0;
        let quiet = run(&cfg);
        let first_day = |r: &SimResult| {
            r.logs
                .daily
                .iter()
                .filter(|d| d.day == 0)
                .map(|d| (d.couple_id, d.in_conflict, d.intensity.to_bits()))
                .collect::<Vec<_>>()
        };
        assert_eq!(first_day(&res), first_day(&quiet));
    }

    #[test]
    fn trait_shift_moves_the_named_trait() {
        let cfg = with_shocks(
            r#"{"shocks": [{"kind": "trait_shift", "target": "treatment", "member": "a", "start_day": 0, "trait": "neuroticism", "magnitude": 1.0}]}"#,
        );
        let res = run(&cfg);
        assert!(res
            .logs
            .interventions
            .iter()
            .any(|r| r.parameter == "trait_shift:neuroticism" && r.applied_value == 1.0));
        let conflicts = |arm: &str| {
            res.logs
                .conflicts
                .iter()
                .filter(|c| res.couples[c.couple_id as usize].arm == Some(arm))
                .count()
        };
        assert!(
            conflicts("treatment") > conflicts("control"),
            "maxed neuroticism should mean more conflict"
        );
    }

    #[test]
    fn episodes_table_has_history_and_run_rows() {
        let res = run(&small());
        assert!(res
            .logs
            .episodes
            .iter()
            .any(|e| e.source == "history" && e.day < 0));
        assert!(res
            .logs
            .episodes
            .iter()
            .any(|e| e.source == "conflict" && e.day >= 0));
        assert!(res.logs.episodes.iter().any(|e| e.source == "affiliation"));
        let mut prev = (i32::MIN, i64::MIN, i64::MIN);
        for e in &res.logs.episodes {
            let key = (e.day, e.couple_id, e.agent_id);
            assert!(key >= prev);
            prev = key;
        }
    }

    #[test]
    fn arm_override_runs_every_couple_in_one_arm() {
        let mut c = small();
        c.arm_override = Some(Arm::Treatment);
        let res = run(&c);
        assert!(res.agents.iter().all(|a| a.arm == "treatment"));
    }
}
