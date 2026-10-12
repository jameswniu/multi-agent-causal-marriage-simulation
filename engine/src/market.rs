//! The remarriage market, after Hills and Todd's MADAM. Singles past a cooldown meet a few
//! other singles a day and pair when compatibility clears both personal thresholds. A
//! threshold relaxes by the agent's own rate each day alone, starts anchored to the match
//! quality of the relationship that just ended, and is set to the new match level on
//! pairing. Dating couples marry on a daily hazard after a minimum courtship.

use crate::components::*;
use crate::legacy::Legacy;
use crate::population::{compatibility, trait_vector};
use crate::rng;
use crate::systems::{agents_by_id, couples_by_id, currently_married, neighbour_share};
use bevy_ecs::prelude::*;
use std::collections::{HashMap, HashSet};

/// A new pairing: both members (id, entity) and their compatibility.
type Match = ((u64, Entity), (u64, Entity), f64);

pub fn market_system(world: &mut World) {
    let cfg = world.resource::<Config>().0.clone();
    let day = world.resource::<Clock>().day;
    let m = &cfg.market;

    // Eligible singles, thresholds relaxed for the day.
    let mut pool: Vec<(u64, Entity)> = Vec::new();
    for (id, e) in agents_by_id(world) {
        let bond = world.get::<Bond>(e).copied().unwrap_or_default();
        if bond.couple.is_some() {
            continue;
        }
        let relax = world.get::<Traits>(e).map(|t| t.relax_rate).unwrap_or(0.0);
        let Some(mut mk) = world.get_mut::<Market>(e) else {
            continue;
        };
        let Some(since) = mk.single_since else {
            continue;
        };
        // The threshold relaxes every day alone; the cooldown only gates eligibility.
        mk.threshold = (mk.threshold * (1.0 - relax)).max(m.threshold_floor);
        if day - since < m.cooldown_days as i32 {
            continue;
        }
        pool.push((id, e));
    }

    // Meetings.
    if pool.len() >= 2 {
        let traits: HashMap<Entity, [f64; 9]> = pool
            .iter()
            .map(|(_, e)| {
                let t = world.get::<Traits>(*e).expect("traits");
                (*e, trait_vector(&t.personality, &t.prefs))
            })
            .collect();
        let thresholds: HashMap<Entity, f64> = pool
            .iter()
            .map(|(_, e)| {
                (
                    *e,
                    world.get::<Market>(*e).map(|k| k.threshold).unwrap_or(1.0),
                )
            })
            .collect();
        let mut paired: HashSet<Entity> = HashSet::new();
        let mut matches: Vec<Match> = Vec::new();
        for (i, (id_i, e_i)) in pool.iter().enumerate() {
            if paired.contains(e_i) {
                continue;
            }
            for _ in 0..m.meet_per_day {
                let j = {
                    let mut mr = world.resource_mut::<MarketRng>();
                    rng::below(&mut mr.0, pool.len())
                };
                if j == i {
                    continue;
                }
                let (id_j, e_j) = pool[j];
                if paired.contains(&e_j) {
                    continue;
                }
                let compat = compatibility(&traits[e_i], &traits[&e_j]);
                if compat >= thresholds[e_i] && compat >= thresholds[&e_j] {
                    paired.insert(*e_i);
                    paired.insert(e_j);
                    matches.push(((*id_i, *e_i), (id_j, e_j), compat));
                    break;
                }
            }
        }
        for ((id_a, e_a), (id_b, e_b), compat) in matches {
            let couple_id = {
                let mut next = world.resource_mut::<NextCoupleId>();
                let id = next.0;
                next.0 += 1;
                id
            };
            let ce = world
                .spawn((
                    Couple {
                        id: couple_id,
                        a: e_a,
                        b: e_b,
                        a_id: id_a,
                        b_id: id_b,
                        origin: Origin::Remarriage,
                        arm: None,
                        formed_day: day,
                        married_day: None,
                        compatibility: compat,
                    },
                    Rel::new(RelState::Dating),
                    CoupleRng(rng::stream(cfg.seeds.dynamics, "couple", couple_id)),
                    ShockState {
                        member: vec![None; cfg.shocks.len()],
                    },
                ))
                .id();
            for (e, partner, partner_id) in [(e_a, e_b, id_b), (e_b, e_a, id_a)] {
                let base = world.get::<Traits>(e).map(|t| t.base_trust).unwrap_or(0.5);
                // A sealed divorce sets the starting trust; otherwise the agent's base trust.
                let prior = world
                    .get::<Legacy>(e)
                    .and_then(|l| l.0.map(|s| s.trust_prior));
                if let Some(mut b) = world.get_mut::<Bond>(e) {
                    *b = Bond {
                        couple: Some(ce),
                        partner: Some(partner),
                        partner_id: Some(partner_id),
                    };
                }
                if let Some(mut k) = world.get_mut::<Market>(e) {
                    k.single_since = None;
                    k.threshold = compat;
                }
                if let Some(mut a) = world.get_mut::<Affect>(e) {
                    a.trust = prior.unwrap_or(base).clamp(0.05, 0.95);
                    a.affect = 0.1;
                }
                if let Some(mut l) = world.get_mut::<LastAction>(e) {
                    l.0 = None;
                }
            }
            world.resource_mut::<LogStore>().0.event(
                day,
                couple_id,
                None,
                "matched",
                None,
                Some(RelState::Dating.as_str()),
                Some(compat),
            );
        }
    }

    // Courtship to marriage.
    for (couple_id, ce) in couples_by_id(world) {
        let couple = world.get::<Couple>(ce).cloned().expect("couple");
        let rel = world.get::<Rel>(ce).cloned().expect("rel");
        if rel.state != RelState::Dating
            || rel.conflict.is_some()
            || day - couple.formed_day < m.dating_min_days as i32
        {
            continue;
        }
        let commit = [couple.a, couple.b]
            .iter()
            .map(|e| {
                world
                    .get::<Traits>(*e)
                    .map(|t| t.prefs.commitment)
                    .unwrap_or(0.5)
            })
            .sum::<f64>()
            / 2.0;
        let married_share = if m.marry_network_weight == 0.0 {
            0.0
        } else {
            (neighbour_share(world, couple.a, Some(couple.b), currently_married)
                + neighbour_share(world, couple.b, Some(couple.a), currently_married))
                / 2.0
        };
        let hazard = m.marry_hazard_base
            + m.marry_hazard_compat * couple.compatibility
            + m.marry_hazard_commit * commit
            + m.marry_network_weight * married_share;
        let marry = {
            let mut crng = world.get_mut::<CoupleRng>(ce).expect("couple rng");
            rng::coin(&mut crng.0, hazard)
        };
        if marry {
            {
                let mut c = world.get_mut::<Couple>(ce).expect("couple");
                c.married_day = Some(day);
            }
            {
                // The marriage's own history starts today: courtship conflicts are not sealed as
                // conflicts of the marriage.
                let mut r = world.get_mut::<Rel>(ce).expect("rel");
                r.state = RelState::Married;
                r.conflicts_closed = 0;
                r.conflicts_reconciled = 0;
            }
            for e in [couple.a, couple.b] {
                if let Some(mut k) = world.get_mut::<Market>(e) {
                    k.marriages_in_sim += 1;
                }
            }
            world.resource_mut::<LogStore>().0.event(
                day,
                couple_id,
                None,
                "married",
                Some(RelState::Dating.as_str()),
                Some(RelState::Married.as_str()),
                Some(couple.compatibility),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SimConfig;
    use crate::log::Logs;

    #[test]
    fn marrying_starts_the_marriage_conflict_counts_from_zero() {
        let mut cfg = SimConfig::default();
        cfg.market.marry_hazard_base = 1.0;
        cfg.market.marry_network_weight = 0.0;
        let mut world = World::new();
        world.insert_resource(Clock { day: 100 });
        world.insert_resource(Config(cfg.clone()));
        world.insert_resource(NextCoupleId(1));
        world.insert_resource(MarketRng(rng::stream(1, "market", 0)));
        world.insert_resource(LogStore(Logs::default()));
        let a = world.spawn(AgentId(0)).id();
        let b = world.spawn(AgentId(1)).id();
        let mut rel = Rel::new(RelState::Dating);
        rel.conflicts_closed = 3;
        rel.conflicts_reconciled = 1;
        let ce = world
            .spawn((
                Couple {
                    id: 0,
                    a,
                    b,
                    a_id: 0,
                    b_id: 1,
                    origin: Origin::Remarriage,
                    arm: None,
                    formed_day: 0,
                    married_day: None,
                    compatibility: 0.8,
                },
                rel,
                CoupleRng(rng::stream(1, "couple", 0)),
            ))
            .id();
        market_system(&mut world);
        let r = world.get::<Rel>(ce).unwrap();
        assert_eq!(r.state, RelState::Married);
        assert_eq!((r.conflicts_closed, r.conflicts_reconciled), (0, 0));
    }
}
