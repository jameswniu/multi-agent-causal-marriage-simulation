//! The daily tick. Systems run in a fixed single-threaded order; every stochastic draw
//! comes from the entity's own stream, so the result does not depend on ECS iteration order.

use crate::components::*;
use crate::config::{ShockKind, ShockMember, SimConfig};
use crate::dynamics::{self, AffectInputs, OnsetInputs};
use crate::intervention;
use crate::legacy::{self, EndedBy, Ending, Legacy};
use crate::log::EpisodeRow;
use crate::log::{ConflictRow, DecisionRow, LegacyRow, Logs};
use crate::memory::{Amplified, Episode, EpisodeKind, Loads, Memory};
use crate::policy::{self, Action, AgentView, Context, Decision};
use crate::rng;
use bevy_ecs::prelude::*;
use bevy_ecs::schedule::{ScheduleLabel, SingleThreadedExecutor};
use std::collections::HashMap;

#[derive(ScheduleLabel, Clone, Debug, PartialEq, Eq, Hash)]
pub struct DailyTick;

pub fn build_schedule() -> Schedule {
    let mut s = Schedule::new(DailyTick);
    s.set_executor(SingleThreadedExecutor::new());
    s.add_systems(
        (
            shock_system,
            stress_affect_system,
            couple_system,
            trust_system,
            prune_system,
            crate::market::market_system,
            daily_log_system,
            clock_system,
        )
            .chain(),
    );
    s
}

fn clock_system(mut clock: ResMut<Clock>) {
    clock.day += 1;
}

/// Sorted list of agent entities by id.
pub fn agents_by_id(world: &mut World) -> Vec<(u64, Entity)> {
    let mut v: Vec<(u64, Entity)> = world
        .query::<(Entity, &AgentId)>()
        .iter(world)
        .map(|(e, id)| (id.0, e))
        .collect();
    v.sort_by_key(|(id, _)| *id);
    v
}

/// Sorted list of couple entities by id.
pub fn couples_by_id(world: &mut World) -> Vec<(u64, Entity)> {
    let mut v: Vec<(u64, Entity)> = world
        .query::<(Entity, &Couple)>()
        .iter(world)
        .map(|(e, c)| (c.id, e))
        .collect();
    v.sort_by_key(|(id, _)| *id);
    v
}

fn loads_of(world: &World, agent: Entity, day: i32) -> Loads {
    let bond = world.get::<Bond>(agent).copied().unwrap_or_default();
    match bond.partner_id {
        Some(pid) => world
            .get::<Memory>(agent)
            .map(|m| m.loads(day, pid))
            .unwrap_or_default(),
        None => Loads::default(),
    }
}

// ---------------------------------------------------------------- stress and affect

fn stress_affect_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    let day = world.resource::<Clock>().day;
    let agents = agents_by_id(world);
    let affects: HashMap<Entity, f64> = agents
        .iter()
        .map(|(_, e)| (*e, world.get::<Affect>(*e).map(|a| a.affect).unwrap_or(0.0)))
        .collect();
    for (_, e) in agents {
        let traits = world.get::<Traits>(e).cloned().expect("traits");
        let bond = world.get::<Bond>(e).copied().unwrap_or_default();
        let cur = *world.get::<Affect>(e).expect("affect");
        let loads = loads_of(world, e, day);
        let partner_affect = bond
            .partner
            .and_then(|p| affects.get(&p).copied())
            .unwrap_or(0.0);
        let mods = world.get::<Modifiers>(e).cloned().unwrap_or_default();
        let closeness_gap = bond
            .partner
            .and_then(|p| {
                world
                    .get::<Traits>(p)
                    .map(|t| (traits.prefs.closeness_pref - t.prefs.closeness_pref).abs())
            })
            .unwrap_or(0.0);
        let mut rng = world.get_mut::<AgentRng>(e).expect("rng");
        let stress = (dynamics::stress_step(
            &cfg.dynamics,
            &mut rng.0,
            cur.stress,
            traits.personality.neuroticism,
        ) + mods.extra_stress(day))
        .clamp(0.0, 3.0);
        let affect = if bond.partner.is_some() {
            dynamics::affect_step(
                &cfg.dynamics,
                &mut rng.0,
                &AffectInputs {
                    affect: cur.affect,
                    partner_affect,
                    neuroticism: traits.personality.neuroticism,
                    agreeableness: traits.personality.agreeableness,
                    stress,
                    loads,
                    closeness_gap,
                },
            )
        } else {
            cur.affect * 0.9
        };
        let mut a = world.get_mut::<Affect>(e).expect("affect");
        a.stress = stress;
        a.affect = affect;
    }
}

// ---------------------------------------------------------------- trust and satisfaction

fn trust_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    let day = world.resource::<Clock>().day;
    for (_, e) in agents_by_id(world) {
        let bond = world.get::<Bond>(e).copied().unwrap_or_default();
        if bond.partner.is_none() {
            continue;
        }
        let base = world.get::<Traits>(e).map(|t| t.base_trust).unwrap_or(0.5);
        let loads = loads_of(world, e, day);
        let mut a = world.get_mut::<Affect>(e).expect("affect");
        a.trust = dynamics::trust_step(&cfg.dynamics, a.trust, base, loads, a.affect);
        a.satisfaction = dynamics::satisfaction(&cfg.dynamics, a.trust, a.affect, loads);
    }
}

/// Weekly memory housekeeping: merge long runs of old episodes about the current partner into
/// standing episodes (same load), then forget what has faded and cap the store.
fn prune_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    let day = world.resource::<Clock>().day;
    if cfg.memory.prune_every_days == 0 || day % cfg.memory.prune_every_days as i32 != 0 {
        return;
    }
    let mut logs = std::mem::take(&mut world.resource_mut::<LogStore>().0);
    for (_, e) in agents_by_id(world) {
        if cfg.memory_rules.consolidate_after > 0 {
            consolidate_for(world, &cfg, &mut logs, e, day);
        }
        if let Some(mut m) = world.get_mut::<Memory>(e) {
            m.prune(day, cfg.memory.prune_threshold, cfg.memory.capacity);
        }
        if let Some(mut x) = world.get_mut::<Modifiers>(e) {
            x.expire(day);
        }
    }
    world.resource_mut::<LogStore>().0 = logs;
}

/// Consolidate one agent's memories of its current partner and log each merge: an episode row
/// (source `consolidated`, dated today, carrying the merged load) and a `memory_consolidated`
/// event whose value is the number of episodes merged.
fn consolidate_for(world: &mut World, cfg: &SimConfig, logs: &mut Logs, e: Entity, day: i32) {
    let bond = world.get::<Bond>(e).copied().unwrap_or_default();
    let (Some(partner), Some(ce)) = (bond.partner_id, bond.couple) else {
        return;
    };
    let couple_id = world.get::<Couple>(ce).map(|c| c.id).unwrap_or(0);
    // The open conflict's episode may still be raised by escalation, so it stays separate.
    let keep = world
        .get::<Rel>(ce)
        .and_then(|r| r.conflict)
        .map(|c| (c.started, EpisodeKind::Conflict));
    let after = cfg.memory_rules.consolidate_after;
    let merges: Vec<(crate::memory::Consolidation, f64)> = world
        .get_mut::<Memory>(e)
        .map(|mut m| {
            let done = m.consolidate(day, partner, after, keep);
            done.into_iter()
                .map(|c| {
                    let load = m.strength(&c.episode, day);
                    (c, load)
                })
                .collect()
        })
        .unwrap_or_default();
    if merges.is_empty() {
        return;
    }
    let me = agent_id_of(world, e);
    for (c, load) in merges {
        logs.episodes.push(EpisodeRow {
            day,
            couple_id: couple_id as i64,
            agent_id: me as i64,
            partner_id: partner as i64,
            kind: c.episode.kind.as_str(),
            intensity: load,
            source: "consolidated",
            amplified: false,
        });
        logs.event(
            day,
            couple_id,
            Some(me),
            "memory_consolidated",
            None,
            None,
            Some(c.merged as f64),
        );
    }
}

// ---------------------------------------------------------------- couples

/// Share of network neighbours (partner excluded) satisfying `pred`.
pub fn neighbour_share(
    world: &World,
    agent: Entity,
    partner: Option<Entity>,
    pred: impl Fn(&World, Entity) -> bool,
) -> f64 {
    let Some(social) = world.get::<Social>(agent) else {
        return 0.0;
    };
    let mut n = 0usize;
    let mut hits = 0usize;
    for &nb in &social.neighbours {
        if Some(nb) == partner {
            continue;
        }
        n += 1;
        if pred(world, nb) {
            hits += 1;
        }
    }
    if n == 0 {
        0.0
    } else {
        hits as f64 / n as f64
    }
}

pub fn divorced_ever(world: &World, agent: Entity) -> bool {
    world
        .get::<Market>(agent)
        .map(|m| m.divorces_in_sim > 0)
        .unwrap_or(false)
}

pub fn currently_married(world: &World, agent: Entity) -> bool {
    let Some(bond) = world.get::<Bond>(agent) else {
        return false;
    };
    bond.couple
        .and_then(|c| world.get::<Rel>(c))
        .map(|r| r.state == RelState::Married)
        .unwrap_or(false)
}

struct MemberSnapshot {
    entity: Entity,
    id: u64,
    traits: Traits,
    affect: Affect,
    loads: Loads,
    last: Option<Action>,
    divorced_share: f64,
    /// The commitment shift of this member's own sealed divorce, 0 without one.
    legacy_shift: f64,
}

fn snapshot_member(
    world: &World,
    e: Entity,
    day: i32,
    partner: Entity,
    network_on: bool,
) -> MemberSnapshot {
    MemberSnapshot {
        entity: e,
        id: world.get::<AgentId>(e).map(|a| a.0).expect("agent id"),
        traits: world.get::<Traits>(e).cloned().expect("traits"),
        affect: *world.get::<Affect>(e).expect("affect"),
        loads: loads_of(world, e, day),
        last: world.get::<LastAction>(e).and_then(|l| l.0),
        divorced_share: if network_on {
            neighbour_share(world, e, Some(partner), divorced_ever)
        } else {
            0.0
        },
        legacy_shift: world
            .get::<Legacy>(e)
            .and_then(|l| l.0.map(|s| s.commitment_shift))
            .unwrap_or(0.0),
    }
}

#[allow(clippy::too_many_arguments)]
fn decide_for(
    world: &mut World,
    cfg: &SimConfig,
    m: &MemberSnapshot,
    partner_last: Option<Action>,
    ctx: Context,
    rel: &Rel,
    dating: bool,
    outside: f64,
    day: i32,
    leave_available: bool,
) -> Decision {
    let (intensity, conflict_days) = rel
        .conflict
        .map(|c| (c.intensity, c.days))
        .unwrap_or((0.0, 0));
    let separation_days = rel
        .separated_since
        .map(|s| (day - s).max(0) as u32)
        .unwrap_or(0);
    let view = AgentView {
        personality: &m.traits.personality,
        prefs: &m.traits.prefs,
        trust: m.affect.trust,
        affect: m.affect.affect,
        stress: m.affect.stress,
        satisfaction: m.affect.satisfaction,
        loads: m.loads,
        context: ctx,
        dating,
        conflict_intensity: intensity,
        conflict_days,
        separation_days,
        partner_last,
        divorced_friend_share: m.divorced_share,
        outside_option: outside,
        leave_available,
        legacy_shift: m.legacy_shift,
    };
    let mut rng = world.get_mut::<AgentRng>(m.entity).expect("rng");
    policy::decide(&view, &cfg.policy, &mut rng.0)
}

fn agent_id_of(world: &World, e: Entity) -> u64 {
    world.get::<AgentId>(e).map(|a| a.0).unwrap_or(0)
}

/// Store an episode in the agent's memory and log it with an explicit source.
fn record_src(
    world: &mut World,
    logs: &mut Logs,
    couple_id: u64,
    agent: Entity,
    ep: Episode,
    source: &'static str,
) {
    if let Some(mut m) = world.get_mut::<Memory>(agent) {
        m.record(ep);
    }
    logs.episodes.push(EpisodeRow {
        day: ep.day,
        couple_id: couple_id as i64,
        agent_id: agent_id_of(world, agent) as i64,
        partner_id: ep.partner as i64,
        kind: ep.kind.as_str(),
        intensity: ep.intensity,
        source,
        amplified: false,
    });
}

fn record(world: &mut World, logs: &mut Logs, couple_id: u64, agent: Entity, ep: Episode) {
    let source = ep.kind.as_str();
    record_src(world, logs, couple_id, agent, ep, source);
}

#[allow(clippy::too_many_arguments)]
fn amplify(
    world: &mut World,
    logs: &mut Logs,
    couple_id: u64,
    agent: Entity,
    day: i32,
    kind: EpisodeKind,
    partner: u64,
    intensity: f64,
) {
    let outcome = world
        .get_mut::<Memory>(agent)
        .map(|mut m| m.amplify(day, kind, partner, intensity))
        .unwrap_or(Amplified::Unchanged);
    if outcome == Amplified::Unchanged {
        return;
    }
    logs.episodes.push(EpisodeRow {
        day,
        couple_id: couple_id as i64,
        agent_id: agent_id_of(world, agent) as i64,
        partner_id: partner as i64,
        kind: kind.as_str(),
        intensity,
        source: "escalation",
        amplified: outcome == Amplified::Raised,
    });
}

fn bump_trust(world: &mut World, agent: Entity, delta: f64) {
    if let Some(mut a) = world.get_mut::<Affect>(agent) {
        a.trust = (a.trust + delta).clamp(0.0, 1.0);
    }
}

fn set_last(world: &mut World, agent: Entity, action: Action) {
    if let Some(mut l) = world.get_mut::<LastAction>(agent) {
        l.0 = Some(action);
    }
}

#[allow(clippy::too_many_arguments)]
fn log_decision(
    logs: &mut Logs,
    day: i32,
    couple_id: u64,
    m: &MemberSnapshot,
    ctx: Context,
    d: &Decision,
    rel: &Rel,
    partner_last: Option<Action>,
) {
    let u = |a: Action| d.utilities.iter().find(|(x, _)| *x == a).map(|(_, v)| *v);
    let idx = d
        .utilities
        .iter()
        .position(|(x, _)| *x == d.action)
        .unwrap_or(0);
    let (intensity, conflict_days) = rel
        .conflict
        .map(|c| (c.intensity, c.days as i32))
        .unwrap_or((0.0, 0));
    logs.decisions.push(DecisionRow {
        day,
        couple_id: couple_id as i64,
        agent_id: m.id as i64,
        context: match ctx {
            Context::Calm => "calm",
            Context::Conflict => "conflict",
            Context::Separated => "separated",
        },
        action: d.action.as_str(),
        p_chosen: d.probabilities.get(idx).copied().unwrap_or(0.0),
        u_repair: u(Action::Repair),
        u_hold: u(Action::Hold),
        u_escalate: u(Action::Escalate),
        u_withdraw: u(Action::Withdraw),
        u_leave: u(Action::Leave),
        trust: m.affect.trust,
        affect: m.affect.affect,
        neg_load: m.loads.negative,
        pos_load: m.loads.positive,
        intensity,
        conflict_days,
        partner_last: partner_last.map(|a| a.as_str()),
    });
}

/// Close the couple's open conflict with an outcome row.
fn close_conflict(
    logs: &mut Logs,
    couple_id: u64,
    rel: &mut Rel,
    day: i32,
    outcome: &'static str,
) -> Option<i32> {
    let c = rel.conflict.take()?;
    rel.conflicts_closed += 1;
    if outcome == "reconciled" {
        rel.conflicts_reconciled += 1;
    }
    let duration = day - c.started + 1;
    logs.conflicts.push(ConflictRow {
        couple_id: couple_id as i64,
        started_day: c.started,
        ended_day: Some(day),
        outcome,
        peak_intensity: c.peak_intensity,
        escalations: c.escalations as i32,
        repair_attempts: c.repair_attempts as i32,
        duration_days: Some(duration),
    });
    Some(duration)
}

/// Make both members single after a divorce or breakup. Each member's matching threshold is
/// anchored to the compatibility of the relationship that just ended, minus a discount (the
/// relaxing-expectations marriage market of Hills and Todd's MADAM model).
fn release_members(world: &mut World, cfg: &SimConfig, couple: &Couple, day: i32, divorced: bool) {
    for e in [couple.a, couple.b] {
        if let Some(mut b) = world.get_mut::<Bond>(e) {
            *b = Bond::default();
        }
        if let Some(mut m) = world.get_mut::<Market>(e) {
            m.single_since = Some(day);
            m.last_compat = Some(couple.compatibility);
            m.threshold =
                (couple.compatibility - cfg.market.anchor_discount).max(cfg.market.threshold_floor);
            if divorced {
                m.divorces_in_sim += 1;
            }
        }
        if let Some(mut l) = world.get_mut::<LastAction>(e) {
            l.0 = None;
        }
    }
}

fn freeze_memory(world: &mut World, agent: Entity, partner: u64, day: i32) {
    if let Some(mut m) = world.get_mut::<Memory>(agent) {
        m.freeze(partner, day);
    }
}

fn unfreeze_memory(world: &mut World, agent: Entity, day: i32) {
    if let Some(mut m) = world.get_mut::<Memory>(agent) {
        m.unfreeze(day);
    }
}

/// Seal one member's side of a marriage that ends in divorce today, from its live state, and log
/// it (a legacies row and a `sealed` event whose value is the next relationship's trust prior).
#[allow(clippy::too_many_arguments)]
fn seal_marriage(
    world: &mut World,
    cfg: &SimConfig,
    logs: &mut Logs,
    couple: &Couple,
    rel: &Rel,
    agent: Entity,
    partner_id: u64,
    ended_by: EndedBy,
    day: i32,
) {
    let me = agent_id_of(world, agent);
    let ending = Ending {
        couple_id: couple.id,
        partner_id,
        day,
        ended_by,
        conflicts: rel.conflicts_closed,
        reconciled: rel.conflicts_reconciled,
        final_trust: world.get::<Affect>(agent).map(|a| a.trust).unwrap_or(0.5),
        final_loads: world
            .get::<Memory>(agent)
            .map(|m| m.loads(day, partner_id))
            .unwrap_or_default(),
        base_trust: world
            .get::<Traits>(agent)
            .map(|t| t.base_trust)
            .unwrap_or(0.5),
    };
    let seal = legacy::mint(&cfg.legacy, &ending);
    if let Some(mut l) = world.get_mut::<Legacy>(agent) {
        l.0 = Some(seal);
    }
    logs.legacies.push(LegacyRow {
        day,
        couple_id: couple.id as i64,
        agent_id: me as i64,
        partner_id: partner_id as i64,
        ended_by: ended_by.as_str(),
        conflicts: seal.conflicts as i32,
        reconciled: seal.reconciled as i32,
        final_trust: seal.final_trust,
        final_neg_load: seal.final_loads.negative,
        final_pos_load: seal.final_loads.positive,
        match_quality: couple.compatibility,
        commitment_shift: seal.commitment_shift,
        trust_prior: seal.trust_prior,
    });
    logs.event(
        day,
        couple.id,
        Some(me),
        "sealed",
        None,
        None,
        Some(seal.trust_prior),
    );
}

fn couple_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    let day = world.resource::<Clock>().day;
    let d = &cfg.dynamics;
    for (couple_id, ce) in couples_by_id(world) {
        let couple = world.get::<Couple>(ce).cloned().expect("couple");
        let mut rel = world.get::<Rel>(ce).cloned().expect("rel");
        if !rel.state.is_active() {
            continue;
        }
        let a = snapshot_member(
            world,
            couple.a,
            day,
            couple.b,
            cfg.policy.leave_network != 0.0,
        );
        let b = snapshot_member(
            world,
            couple.b,
            day,
            couple.a,
            cfg.policy.leave_network != 0.0,
        );
        let mut logs = std::mem::take(&mut world.resource_mut::<LogStore>().0);

        // Association: both members stored a warm memory about each other within the window.
        let since = day - cfg.association.window_days as i32 + 1;
        let warm = |e: Entity, partner: u64| {
            world
                .get::<Memory>(e)
                .map(|m| m.warm_since(partner, since))
                .unwrap_or(false)
        };
        let associated = warm(couple.a, b.id) && warm(couple.b, a.id);
        rel.orphan_days = if associated {
            0
        } else {
            rel.orphan_days.saturating_add(1)
        };
        let gate = &cfg.association;
        let leave_unlocked =
            gate.orphan_days_to_leave == 0 || rel.orphan_days >= gate.orphan_days_to_leave;

        match rel.state {
            RelState::Dating | RelState::Married => {
                let dating = rel.state == RelState::Dating;
                if rel.conflict.is_none() {
                    // Outside options: an encounter whose compatibility beats the current match.
                    let mut outside = [0.0; 2];
                    let outside_params: [(f64, f64); 2] = [couple.a, couple.b].map(|m| {
                        world
                            .get::<Modifiers>(m)
                            .and_then(|x| x.outside(day))
                            .unwrap_or((d.outside_encounter_prob, 0.0))
                    });
                    {
                        let mut crng = world.get_mut::<CoupleRng>(ce).expect("couple rng");
                        for (i, slot) in outside.iter_mut().enumerate() {
                            let (p_out, bonus) = outside_params[i];
                            if rng::coin(&mut crng.0, p_out) {
                                let cand =
                                    rng::clipped_normal(&mut crng.0, 0.6 + bonus, 0.15, 0.0, 1.0);
                                *slot = (cand - couple.compatibility).max(0.0);
                                if *slot > 0.0 {
                                    let who = if i == 0 { a.id } else { b.id };
                                    logs.event(
                                        day,
                                        couple_id,
                                        Some(who),
                                        "outside_encounter",
                                        None,
                                        None,
                                        Some(*slot),
                                    );
                                }
                            }
                        }
                    }
                    rel.outside_option = outside;
                    // Conflict onset.
                    let p = dynamics::conflict_onset_prob(
                        d,
                        &OnsetInputs {
                            stress_sum: a.affect.stress + b.affect.stress,
                            neuro_mean: (a.traits.personality.neuroticism
                                + b.traits.personality.neuroticism)
                                / 2.0,
                            grudge_mean: (a.loads.negative + b.loads.negative) / 2.0,
                            trust_mean: (a.affect.trust + b.affect.trust) / 2.0,
                            affect_mean: (a.affect.affect + b.affect.affect) / 2.0,
                            agree_mean: (a.traits.personality.agreeableness
                                + b.traits.personality.agreeableness)
                                / 2.0,
                        },
                    );
                    let onset = {
                        let mut crng = world.get_mut::<CoupleRng>(ce).expect("couple rng");
                        if rng::coin(&mut crng.0, p) {
                            let neuro_mean = (a.traits.personality.neuroticism
                                + b.traits.personality.neuroticism)
                                / 2.0;
                            Some(dynamics::initial_intensity(
                                d,
                                &mut crng.0,
                                a.affect.stress + b.affect.stress,
                                neuro_mean,
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some(intensity) = onset {
                        rel.conflict = Some(Conflict {
                            started: day,
                            intensity,
                            peak_intensity: intensity,
                            days: 0,
                            escalations: 0,
                            repair_attempts: 0,
                        });
                        record(
                            world,
                            &mut logs,
                            couple_id,
                            couple.a,
                            Episode {
                                day,
                                kind: EpisodeKind::Conflict,
                                intensity,
                                partner: b.id,
                            },
                        );
                        record(
                            world,
                            &mut logs,
                            couple_id,
                            couple.b,
                            Episode {
                                day,
                                kind: EpisodeKind::Conflict,
                                intensity,
                                partner: a.id,
                            },
                        );
                        logs.event(
                            day,
                            couple_id,
                            None,
                            "conflict_started",
                            None,
                            None,
                            Some(intensity),
                        );
                    } else {
                        // Calm day: invest or not.
                        let da = decide_for(
                            world,
                            &cfg,
                            &a,
                            b.last,
                            Context::Calm,
                            &rel,
                            dating,
                            outside[0],
                            day,
                            true,
                        );
                        let db = decide_for(
                            world,
                            &cfg,
                            &b,
                            a.last,
                            Context::Calm,
                            &rel,
                            dating,
                            outside[1],
                            day,
                            true,
                        );
                        let n_aff = [da.action, db.action]
                            .iter()
                            .filter(|x| **x == Action::Affiliate)
                            .count();
                        // Only mutual affiliation stores a positive episode.
                        if n_aff == 2 {
                            let intensity = d.positive_episode_intensity;
                            record_src(
                                world,
                                &mut logs,
                                couple_id,
                                couple.a,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Positive,
                                    intensity,
                                    partner: b.id,
                                },
                                "affiliation",
                            );
                            record_src(
                                world,
                                &mut logs,
                                couple_id,
                                couple.b,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Positive,
                                    intensity,
                                    partner: a.id,
                                },
                                "affiliation",
                            );
                            rel.positive_today = true;
                        }
                        // Intimacy mismatch: once a week the member who wants more closeness may
                        // store a disappointment, with probability proportional to the gap.
                        if day % 7 == 0 {
                            let gap = a.traits.prefs.closeness_pref - b.traits.prefs.closeness_pref;
                            let p = d.disappointment_weekly_rate * gap.abs();
                            let hit = gap.abs() > 0.0 && {
                                // A stateless draw keyed by (seed, couple, day) keeps the couple's own
                                // stream exactly as it was before this term existed.
                                let key = (couple_id << 20) ^ (day as u64);
                                let mut r = rng::stream(cfg.seeds.dynamics, "disappointment", key);
                                rng::coin(&mut r, p)
                            };
                            if hit {
                                let (who, who_id, pid) = if gap > 0.0 {
                                    (couple.a, a.id, b.id)
                                } else {
                                    (couple.b, b.id, a.id)
                                };
                                record_src(
                                    world,
                                    &mut logs,
                                    couple_id,
                                    who,
                                    Episode {
                                        day,
                                        kind: EpisodeKind::Disappointment,
                                        intensity: d.disappointment_intensity * gap.abs(),
                                        partner: pid,
                                    },
                                    "disappointment",
                                );
                                logs.event(
                                    day,
                                    couple_id,
                                    Some(who_id),
                                    "disappointed",
                                    None,
                                    None,
                                    Some(gap.abs()),
                                );
                            }
                        }
                        set_last(world, couple.a, da.action);
                        set_last(world, couple.b, db.action);
                    }
                }
                if let Some(mut c) = rel.conflict {
                    c.days += 1;
                    rel.conflict = Some(c);
                    // Married couples may leave only after sustained distance or past the hard line.
                    let leave_available =
                        dating || leave_unlocked || c.intensity >= gate.unlock_intensity;
                    let da = decide_for(
                        world,
                        &cfg,
                        &a,
                        b.last,
                        Context::Conflict,
                        &rel,
                        dating,
                        rel.outside_option[0],
                        day,
                        leave_available,
                    );
                    let db = decide_for(
                        world,
                        &cfg,
                        &b,
                        a.last,
                        Context::Conflict,
                        &rel,
                        dating,
                        rel.outside_option[1],
                        day,
                        leave_available,
                    );
                    {
                        log_decision(
                            &mut logs,
                            day,
                            couple_id,
                            &a,
                            Context::Conflict,
                            &da,
                            &rel,
                            b.last,
                        );
                        log_decision(
                            &mut logs,
                            day,
                            couple_id,
                            &b,
                            Context::Conflict,
                            &db,
                            &rel,
                            a.last,
                        );
                    }
                    let acts = [da.action, db.action];
                    let members = [(couple.a, a.id, &a), (couple.b, b.id, &b)];
                    // Every repair bid is counted and logged, whatever the partner does.
                    for (i, act) in acts.iter().enumerate() {
                        if *act == Action::Repair {
                            let (_, who, _) = members[i];
                            logs.event(
                                day,
                                couple_id,
                                Some(who),
                                "repair_attempted",
                                None,
                                None,
                                None,
                            );
                            if let Some(mut c) = rel.conflict {
                                c.repair_attempts += 1;
                                rel.conflict = Some(c);
                            }
                        }
                    }
                    if acts.contains(&Action::Leave) {
                        let leaver = if da.action == Action::Leave { 0 } else { 1 };
                        let left = 1 - leaver;
                        let (le, lid, _) = members[leaver];
                        let (fe, fid, _) = members[left];
                        if dating {
                            close_conflict(&mut logs, couple_id, &mut rel, day, "breakup");
                            logs.event(
                                day,
                                couple_id,
                                Some(lid),
                                "broke_up",
                                Some(rel.state.as_str()),
                                Some(RelState::BrokenUp.as_str()),
                                None,
                            );
                            rel.state = RelState::BrokenUp;
                            rel.ended_day = Some(day);
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                le,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Separation,
                                    intensity: 0.6,
                                    partner: fid,
                                },
                            );
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                fe,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Separation,
                                    intensity: 0.8,
                                    partner: lid,
                                },
                            );
                            release_members(world, &cfg, &couple, day, false);
                        } else {
                            close_conflict(&mut logs, couple_id, &mut rel, day, "separated");
                            logs.event(
                                day,
                                couple_id,
                                Some(lid),
                                "separated",
                                Some(rel.state.as_str()),
                                Some(RelState::Separated.as_str()),
                                None,
                            );
                            rel.state = RelState::Separated;
                            rel.separated_since = Some(day);
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                le,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Separation,
                                    intensity: 0.8,
                                    partner: fid,
                                },
                            );
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                fe,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Separation,
                                    intensity: 1.0,
                                    partner: lid,
                                },
                            );
                            bump_trust(world, fe, -d.trust_hit_separate);
                            bump_trust(world, le, -d.trust_hit_separate / 2.0);
                            if cfg.memory_rules.freeze_during_separation {
                                freeze_memory(world, le, fid, day);
                                freeze_memory(world, fe, lid, day);
                            }
                        }
                    } else if acts.contains(&Action::Escalate) {
                        let mut c = rel.conflict.expect("conflict");
                        c.intensity = (c.intensity + d.escalation_step).min(1.0);
                        c.peak_intensity = c.peak_intensity.max(c.intensity);
                        c.escalations += 1;
                        rel.conflict = Some(c);
                        for i in 0..2 {
                            if acts[i] == Action::Escalate {
                                let (_, who, _) = members[i];
                                let (pe, _, _) = members[1 - i];
                                logs.event(
                                    day,
                                    couple_id,
                                    Some(who),
                                    "escalated",
                                    None,
                                    None,
                                    Some(c.intensity),
                                );
                                bump_trust(world, pe, -d.trust_hit_escalate * c.intensity);
                            }
                        }
                        // The memory of this fight gets worse; no new episode per escalation day.
                        amplify(
                            world,
                            &mut logs,
                            couple_id,
                            couple.a,
                            c.started,
                            EpisodeKind::Conflict,
                            b.id,
                            c.intensity,
                        );
                        amplify(
                            world,
                            &mut logs,
                            couple_id,
                            couple.b,
                            c.started,
                            EpisodeKind::Conflict,
                            a.id,
                            c.intensity,
                        );
                    } else {
                        let repairs = acts.iter().filter(|x| **x == Action::Repair).count();
                        let mut reconciled = false;
                        if repairs == 2 {
                            reconciled = true;
                        } else if repairs == 1 {
                            let r = if da.action == Action::Repair { 0 } else { 1 };
                            let (re, rid, _) = members[r];
                            let (_, _, recv) = members[1 - r];
                            let intensity = rel.conflict.map(|c| c.intensity).unwrap_or(0.0);
                            let p = dynamics::accept_prob(
                                d,
                                recv.affect.trust,
                                recv.traits.prefs.forgiveness,
                                recv.loads.negative,
                                intensity,
                            );
                            let accepted = {
                                let mut crng = world.get_mut::<CoupleRng>(ce).expect("couple rng");
                                rng::coin(&mut crng.0, p)
                            };
                            if accepted {
                                reconciled = true;
                            } else {
                                logs.event(
                                    day,
                                    couple_id,
                                    Some(rid),
                                    "repair_rejected",
                                    None,
                                    None,
                                    Some(p),
                                );
                                let (_, pid, _) = members[1 - r];
                                record(
                                    world,
                                    &mut logs,
                                    couple_id,
                                    re,
                                    Episode {
                                        day,
                                        kind: EpisodeKind::Rejection,
                                        intensity: d.rejection_episode_intensity,
                                        partner: pid,
                                    },
                                );
                                bump_trust(world, re, -d.trust_hit_rejection);
                            }
                        }
                        if reconciled {
                            let peak = rel.conflict.map(|c| c.peak_intensity).unwrap_or(0.0);
                            let duration =
                                close_conflict(&mut logs, couple_id, &mut rel, day, "reconciled")
                                    .unwrap_or(0);
                            logs.event(
                                day,
                                couple_id,
                                None,
                                "reconciled",
                                None,
                                None,
                                Some(duration as f64),
                            );
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                couple.a,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Reconciliation,
                                    intensity: peak,
                                    partner: b.id,
                                },
                            );
                            record(
                                world,
                                &mut logs,
                                couple_id,
                                couple.b,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Reconciliation,
                                    intensity: peak,
                                    partner: a.id,
                                },
                            );
                            bump_trust(world, couple.a, d.trust_gain_reconcile);
                            bump_trust(world, couple.b, d.trust_gain_reconcile);
                        } else {
                            // Withdrawals wound the partner; holds let the conflict cool.
                            for i in 0..2 {
                                if acts[i] == Action::Withdraw {
                                    let (_, who, _) = members[i];
                                    let (pe, _, _) = members[1 - i];
                                    logs.event(
                                        day,
                                        couple_id,
                                        Some(who),
                                        "withdrew",
                                        None,
                                        None,
                                        None,
                                    );
                                    record(
                                        world,
                                        &mut logs,
                                        couple_id,
                                        pe,
                                        Episode {
                                            day,
                                            kind: EpisodeKind::Withdrawal,
                                            intensity: d.withdraw_episode_intensity,
                                            partner: who,
                                        },
                                    );
                                    bump_trust(world, pe, -d.trust_hit_withdraw);
                                }
                            }
                            if let Some(mut c) = rel.conflict {
                                if repairs == 0 {
                                    c.intensity *= d.intensity_decay;
                                }
                                rel.conflict = Some(c);
                                if c.intensity < d.fade_threshold {
                                    close_conflict(&mut logs, couple_id, &mut rel, day, "faded");
                                    logs.event(
                                        day,
                                        couple_id,
                                        None,
                                        "conflict_faded",
                                        None,
                                        None,
                                        None,
                                    );
                                }
                            }
                        }
                    }
                    set_last(world, couple.a, da.action);
                    set_last(world, couple.b, db.action);
                }
            }
            RelState::Separated => {
                let da = decide_for(
                    world,
                    &cfg,
                    &a,
                    b.last,
                    Context::Separated,
                    &rel,
                    false,
                    0.0,
                    day,
                    true,
                );
                let db = decide_for(
                    world,
                    &cfg,
                    &b,
                    a.last,
                    Context::Separated,
                    &rel,
                    false,
                    0.0,
                    day,
                    true,
                );
                {
                    log_decision(
                        &mut logs,
                        day,
                        couple_id,
                        &a,
                        Context::Separated,
                        &da,
                        &rel,
                        b.last,
                    );
                    log_decision(
                        &mut logs,
                        day,
                        couple_id,
                        &b,
                        Context::Separated,
                        &db,
                        &rel,
                        a.last,
                    );
                }
                let acts = [da.action, db.action];
                let members = [(couple.a, a.id, &a), (couple.b, b.id, &b)];
                let days_sep = rel.separated_since.map(|s| day - s).unwrap_or(0);
                for (i, act) in acts.iter().enumerate() {
                    if *act == Action::Repair {
                        let (_, who, _) = members[i];
                        logs.event(
                            day,
                            couple_id,
                            Some(who),
                            "repair_attempted",
                            None,
                            None,
                            None,
                        );
                    }
                }
                let repairs = acts.iter().filter(|x| **x == Action::Repair).count();
                let mut reunite = repairs == 2;
                if repairs == 1 && !acts.contains(&Action::Leave) {
                    let r = if da.action == Action::Repair { 0 } else { 1 };
                    let (re, rid, _) = members[r];
                    let (_, pid, recv) = members[1 - r];
                    let p = dynamics::accept_prob(
                        d,
                        recv.affect.trust,
                        recv.traits.prefs.forgiveness,
                        recv.loads.negative,
                        0.5,
                    );
                    let accepted = {
                        let mut crng = world.get_mut::<CoupleRng>(ce).expect("couple rng");
                        rng::coin(&mut crng.0, p)
                    };
                    if accepted {
                        reunite = true;
                    } else {
                        logs.event(
                            day,
                            couple_id,
                            Some(rid),
                            "repair_rejected",
                            None,
                            None,
                            Some(p),
                        );
                        record(
                            world,
                            &mut logs,
                            couple_id,
                            re,
                            Episode {
                                day,
                                kind: EpisodeKind::Rejection,
                                intensity: d.rejection_episode_intensity,
                                partner: pid,
                            },
                        );
                    }
                }
                if reunite {
                    logs.event(
                        day,
                        couple_id,
                        None,
                        "reunited",
                        Some(RelState::Separated.as_str()),
                        Some(RelState::Married.as_str()),
                        Some(days_sep as f64),
                    );
                    rel.state = RelState::Married;
                    rel.separated_since = None;
                    unfreeze_memory(world, couple.a, day);
                    unfreeze_memory(world, couple.b, day);
                    record(
                        world,
                        &mut logs,
                        couple_id,
                        couple.a,
                        Episode {
                            day,
                            kind: EpisodeKind::Reconciliation,
                            intensity: 1.0,
                            partner: b.id,
                        },
                    );
                    record(
                        world,
                        &mut logs,
                        couple_id,
                        couple.b,
                        Episode {
                            day,
                            kind: EpisodeKind::Reconciliation,
                            intensity: 1.0,
                            partner: a.id,
                        },
                    );
                    bump_trust(world, couple.a, d.trust_gain_reconcile);
                    bump_trust(world, couple.b, d.trust_gain_reconcile);
                } else if acts.contains(&Action::Leave)
                    || days_sep >= d.separation_days_to_divorce as i32
                {
                    let who = if da.action == Action::Leave {
                        Some(a.id)
                    } else if db.action == Action::Leave {
                        Some(b.id)
                    } else {
                        None
                    };
                    logs.event(
                        day,
                        couple_id,
                        who,
                        "divorced",
                        Some(RelState::Separated.as_str()),
                        Some(RelState::Divorced.as_str()),
                        Some(days_sep as f64),
                    );
                    rel.state = RelState::Divorced;
                    rel.ended_day = Some(day);
                    let side = |me: u64| match who {
                        Some(w) if w == me => EndedBy::SelfLeft,
                        Some(_) => EndedBy::PartnerLeft,
                        None => EndedBy::Time,
                    };
                    seal_marriage(
                        world,
                        &cfg,
                        &mut logs,
                        &couple,
                        &rel,
                        couple.a,
                        b.id,
                        side(a.id),
                        day,
                    );
                    seal_marriage(
                        world,
                        &cfg,
                        &mut logs,
                        &couple,
                        &rel,
                        couple.b,
                        a.id,
                        side(b.id),
                        day,
                    );
                    record(
                        world,
                        &mut logs,
                        couple_id,
                        couple.a,
                        Episode {
                            day,
                            kind: EpisodeKind::Divorce,
                            intensity: 1.0,
                            partner: b.id,
                        },
                    );
                    record(
                        world,
                        &mut logs,
                        couple_id,
                        couple.b,
                        Episode {
                            day,
                            kind: EpisodeKind::Divorce,
                            intensity: 1.0,
                            partner: a.id,
                        },
                    );
                    unfreeze_memory(world, couple.a, day);
                    unfreeze_memory(world, couple.b, day);
                    release_members(world, &cfg, &couple, day, true);
                }
                set_last(world, couple.a, da.action);
                set_last(world, couple.b, db.action);
            }
            RelState::Divorced | RelState::BrokenUp => {}
        }
        world.resource_mut::<LogStore>().0 = logs;
        *world.get_mut::<Rel>(ce).expect("rel") = rel;
    }
}

// ---------------------------------------------------------------- shocks

/// Apply scheduled shocks. The only place besides the day-0 intervention where the arm decides
/// what happens to a couple; the decision itself is delegated to `intervention::shock_applies`.
fn shock_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    if cfg.shocks.is_empty() {
        return;
    }
    let day = world.resource::<Clock>().day;
    for (couple_id, ce) in couples_by_id(world) {
        let couple = world.get::<Couple>(ce).cloned().expect("couple");
        let rel = world.get::<Rel>(ce).cloned().expect("rel");
        if !rel.state.is_together() {
            continue;
        }
        let mut logs = std::mem::take(&mut world.resource_mut::<LogStore>().0);
        for (si, shock) in cfg.shocks.iter().enumerate() {
            if !intervention::shock_applies(shock.target, couple.arm) {
                continue;
            }
            let start = shock.start_day as i32;
            let last = shock.last_day(cfg.days);
            if day < start || day > last {
                continue;
            }
            // Kinds with a cadence only act (and only resolve their member) on their days.
            let fires_today = match shock.kind {
                ShockKind::Anniversary => (day - start) % 365 == 0,
                ShockKind::DateNights => (day - start) % 7 == 0,
                _ => true,
            };
            if !fires_today {
                continue;
            }
            // Resolve the member once per couple, from a stateless stream keyed by (seed, shock,
            // couple) so that resolving it never moves the couple's own stream: a shock that does
            // nothing must leave every other draw, and so every other row, exactly as it was.
            let resolved = world
                .get::<ShockState>(ce)
                .and_then(|st| st.member.get(si).copied().flatten());
            let first_time = resolved.is_none();
            let member_idx = match resolved {
                Some(m) => m,
                None => {
                    let m = match shock.member {
                        ShockMember::A => 0u8,
                        ShockMember::B => 1u8,
                        ShockMember::Random => {
                            let domain = format!("shock_member_{si}");
                            let mut r = rng::stream(cfg.seeds.dynamics, &domain, couple_id);
                            if rng::coin(&mut r, 0.5) {
                                1u8
                            } else {
                                0u8
                            }
                        }
                    };
                    if let Some(mut st) = world.get_mut::<ShockState>(ce) {
                        if st.member.len() <= si {
                            st.member.resize(si + 1, None);
                        }
                        st.member[si] = Some(m);
                    }
                    m
                }
            };
            let (me, me_id, pe, pe_id) = if member_idx == 0 {
                (couple.a, couple.a_id, couple.b, couple.b_id)
            } else {
                (couple.b, couple.b_id, couple.a, couple.a_id)
            };
            let m = shock.magnitude();
            let both = [
                (couple.a, couple.a_id, couple.b_id),
                (couple.b, couple.b_id, couple.a_id),
            ];
            match shock.kind {
                ShockKind::JobLoss => {
                    if first_time {
                        if let Some(mut a) = world.get_mut::<Affect>(me) {
                            a.stress = (a.stress + m).clamp(0.0, 3.0);
                        }
                        if let Some(mut x) = world.get_mut::<Modifiers>(me) {
                            x.extra_stress.push((0.1 * m, last));
                        }
                        intervention::log_shock_start(
                            day, couple_id, me_id, couple.arm, shock, &mut logs,
                        );
                    }
                }
                ShockKind::FinancialCrisis => {
                    if first_time {
                        for (e, id, _) in both {
                            if let Some(mut x) = world.get_mut::<Modifiers>(e) {
                                x.extra_stress.push((0.3 * m, last));
                            }
                            intervention::log_shock_start(
                                day, couple_id, id, couple.arm, shock, &mut logs,
                            );
                        }
                    }
                }
                ShockKind::Temptation => {
                    if first_time {
                        if let Some(mut x) = world.get_mut::<Modifiers>(me) {
                            x.outside.push((m, 0.1, last));
                        }
                        intervention::log_shock_start(
                            day, couple_id, me_id, couple.arm, shock, &mut logs,
                        );
                    }
                }
                ShockKind::IntimacyMismatch => {
                    if first_time {
                        if let Some(mut t) = world.get_mut::<Traits>(me) {
                            t.prefs.closeness_pref = (t.prefs.closeness_pref + m).clamp(0.0, 1.0);
                        }
                        intervention::log_shock_start(
                            day, couple_id, me_id, couple.arm, shock, &mut logs,
                        );
                    }
                }
                ShockKind::TraitShift => {
                    if first_time {
                        if let Some(mut t) = world.get_mut::<Traits>(me) {
                            let slot: &mut f64 = match shock.trait_name.as_deref().unwrap_or("") {
                                "neuroticism" => &mut t.personality.neuroticism,
                                "agreeableness" => &mut t.personality.agreeableness,
                                "conscientiousness" => &mut t.personality.conscientiousness,
                                "openness" => &mut t.personality.openness,
                                "extraversion" => &mut t.personality.extraversion,
                                "forgiveness" => &mut t.prefs.forgiveness,
                                "commitment" => &mut t.prefs.commitment,
                                "closeness_pref" => &mut t.prefs.closeness_pref,
                                _ => &mut t.prefs.conflict_engagement,
                            };
                            *slot = (*slot + m).clamp(0.0, 1.0);
                        }
                        intervention::log_shock_start(
                            day, couple_id, me_id, couple.arm, shock, &mut logs,
                        );
                    }
                }
                ShockKind::DailyTexts => {
                    if first_time {
                        intervention::log_shock_start(
                            day, couple_id, me_id, couple.arm, shock, &mut logs,
                        );
                    }
                    record_src(
                        world,
                        &mut logs,
                        couple_id,
                        pe,
                        Episode {
                            day,
                            kind: EpisodeKind::Positive,
                            intensity: 0.05 * m,
                            partner: me_id,
                        },
                        intervention::shock_source(shock.kind),
                    );
                    if let Some(mut a) = world.get_mut::<Affect>(pe) {
                        a.affect = (a.affect + 0.02 * m).clamp(-1.0, 1.0);
                    }
                    let _ = pe_id;
                }
                ShockKind::Anniversary => {
                    if first_time {
                        for (_, id, _) in both {
                            intervention::log_shock_start(
                                day, couple_id, id, couple.arm, shock, &mut logs,
                            );
                        }
                    } else {
                        logs.event(
                            day,
                            couple_id,
                            None,
                            "shock_anniversary",
                            None,
                            None,
                            Some(m),
                        );
                    }
                    for (e, _, pid) in both {
                        record_src(
                            world,
                            &mut logs,
                            couple_id,
                            e,
                            Episode {
                                day,
                                kind: EpisodeKind::Positive,
                                intensity: 0.5 * m,
                                partner: pid,
                            },
                            intervention::shock_source(shock.kind),
                        );
                        bump_trust(world, e, 0.02 * m);
                    }
                }
                ShockKind::DateNights => {
                    if first_time {
                        for (_, id, _) in both {
                            intervention::log_shock_start(
                                day, couple_id, id, couple.arm, shock, &mut logs,
                            );
                        }
                    }
                    {
                        for (e, _, pid) in both {
                            record_src(
                                world,
                                &mut logs,
                                couple_id,
                                e,
                                Episode {
                                    day,
                                    kind: EpisodeKind::Positive,
                                    intensity: 0.15 * m,
                                    partner: pid,
                                },
                                intervention::shock_source(shock.kind),
                            );
                        }
                    }
                }
            }
        }
        world.resource_mut::<LogStore>().0 = logs;
    }
}

// ---------------------------------------------------------------- daily log

fn daily_log_system(world: &mut World) {
    let day = world.resource::<Clock>().day;
    for (couple_id, ce) in couples_by_id(world) {
        let couple = world.get::<Couple>(ce).cloned().expect("couple");
        let rel = world.get::<Rel>(ce).cloned().expect("rel");
        let live = rel.state.is_active() || rel.ended_day == Some(day);
        if live {
            let aa = *world.get::<Affect>(couple.a).expect("affect");
            let ab = *world.get::<Affect>(couple.b).expect("affect");
            let la = world
                .get::<Memory>(couple.a)
                .map(|m| m.loads(day, couple.b_id))
                .unwrap_or_default();
            let lb = world
                .get::<Memory>(couple.b)
                .map(|m| m.loads(day, couple.a_id))
                .unwrap_or_default();
            let (in_conflict, conflict_days, intensity) = rel
                .conflict
                .map(|c| (true, c.days as i32, c.intensity))
                .unwrap_or((false, 0, 0.0));
            world
                .resource_mut::<LogStore>()
                .0
                .daily
                .push(crate::log::DailyRow {
                    day,
                    couple_id: couple_id as i64,
                    state: rel.state.as_str(),
                    in_conflict,
                    conflict_days,
                    intensity,
                    positive_episode: rel.positive_today,
                    trust_a: aa.trust,
                    trust_b: ab.trust,
                    affect_a: aa.affect,
                    affect_b: ab.affect,
                    satisfaction_a: aa.satisfaction,
                    satisfaction_b: ab.satisfaction,
                    neg_a: la.negative,
                    neg_b: lb.negative,
                    pos_a: la.positive,
                    pos_b: lb.positive,
                    stress_a: aa.stress,
                    stress_b: ab.stress,
                    orphan_days: rel.orphan_days as i32,
                });
        }
        let mut r = world.get_mut::<Rel>(ce).expect("rel");
        r.positive_today = false;
        r.outside_option = [0.0; 2];
    }
}
