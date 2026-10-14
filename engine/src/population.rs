//! Agent and couple generation from the population seed only.
//!
//! Heterogeneity comes from clipped-normal trait draws, assortative mixing between partners,
//! a relationship history (prior relationships, prior divorces, years married) and a
//! history-seeded episodic memory. A Watts-Strogatz ring over agent ids gives each agent a
//! small social network for contagion terms.

use crate::config::{PopulationConfig, SimConfig, TraitDist};
use crate::memory::{Episode, EpisodeKind};
use crate::rng::{self, Rng};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Personality {
    pub neuroticism: f64,
    pub agreeableness: f64,
    pub conscientiousness: f64,
    pub openness: f64,
    pub extraversion: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preferences {
    pub forgiveness: f64,
    pub commitment: f64,
    pub closeness_pref: f64,
    pub conflict_engagement: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub prior_relationships: u32,
    pub prior_divorces: u32,
    /// Length of the marriage the agent starts the simulation in.
    pub years_married: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    pub id: u64,
    pub couple_id: u64,
    pub personality: Personality,
    pub prefs: Preferences,
    pub history: History,
    pub base_trust: f64,
    /// How fast this agent lowers the compatibility it asks of a new partner, as a share per day spent
    /// single, as in Hills and Todd's MADAM marriage-market model (see market.rs).
    pub relax_rate: f64,
    pub initial_episodes: Vec<Episode>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CoupleSpec {
    pub id: u64,
    pub a: u64,
    pub b: u64,
    pub years_married: f64,
    pub compatibility: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Population {
    pub agents: Vec<AgentSpec>,
    pub couples: Vec<CoupleSpec>,
    /// Adjacency list by agent id (sorted, no duplicates, no self loops).
    pub network: Vec<Vec<u64>>,
}

fn draw(rng: &mut Rng, d: TraitDist) -> f64 {
    rng::clipped_normal(rng, d.mean, d.sd, 0.0, 1.0)
}

fn mix(rng: &mut Rng, anchor: f64, d: TraitDist, w: f64) -> f64 {
    let fresh = draw(rng, d);
    (w * anchor + (1.0 - w) * fresh).clamp(0.0, 1.0)
}

/// Nine-trait vector used for compatibility.
pub fn trait_vector(p: &Personality, q: &Preferences) -> [f64; 9] {
    [
        p.neuroticism,
        p.agreeableness,
        p.conscientiousness,
        p.openness,
        p.extraversion,
        q.forgiveness,
        q.commitment,
        q.closeness_pref,
        q.conflict_engagement,
    ]
}

/// 1 minus mean absolute trait distance, in [0, 1].
pub fn compatibility(a: &[f64; 9], b: &[f64; 9]) -> f64 {
    let d: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).abs())
        .sum::<f64>()
        / 9.0;
    (1.0 - d).clamp(0.0, 1.0)
}

fn sample_personality(
    rng: &mut Rng,
    p: &PopulationConfig,
    anchor: Option<&Personality>,
    w: f64,
) -> Personality {
    match anchor {
        None => Personality {
            neuroticism: draw(rng, p.neuroticism),
            agreeableness: draw(rng, p.agreeableness),
            conscientiousness: draw(rng, p.conscientiousness),
            openness: draw(rng, p.openness),
            extraversion: draw(rng, p.extraversion),
        },
        Some(a) => Personality {
            neuroticism: mix(rng, a.neuroticism, p.neuroticism, w),
            agreeableness: mix(rng, a.agreeableness, p.agreeableness, w),
            conscientiousness: mix(rng, a.conscientiousness, p.conscientiousness, w),
            openness: mix(rng, a.openness, p.openness, w),
            extraversion: mix(rng, a.extraversion, p.extraversion, w),
        },
    }
}

fn sample_prefs(
    rng: &mut Rng,
    p: &PopulationConfig,
    anchor: Option<&Preferences>,
    w: f64,
) -> Preferences {
    match anchor {
        None => Preferences {
            forgiveness: draw(rng, p.forgiveness),
            commitment: draw(rng, p.commitment),
            closeness_pref: draw(rng, p.closeness_pref),
            conflict_engagement: draw(rng, p.conflict_engagement),
        },
        Some(a) => Preferences {
            forgiveness: mix(rng, a.forgiveness, p.forgiveness, w),
            commitment: mix(rng, a.commitment, p.commitment, w),
            closeness_pref: mix(rng, a.closeness_pref, p.closeness_pref, w),
            conflict_engagement: mix(rng, a.conflict_engagement, p.conflict_engagement, w),
        },
    }
}

fn sample_history(rng: &mut Rng, p: &PopulationConfig, years_married: f64) -> History {
    let prior = rng::clipped_normal(
        rng,
        p.prior_relationships.mean,
        p.prior_relationships.sd,
        0.0,
        10.0,
    )
    .round() as u32;
    let mut prior_divorces = 0;
    for _ in 0..prior {
        if rng::coin(rng, p.prior_divorce_prob) {
            prior_divorces += 1;
        }
    }
    History {
        prior_relationships: prior,
        prior_divorces,
        years_married,
    }
}

fn base_trust(rng: &mut Rng, p: &PopulationConfig, pers: &Personality, hist: &History) -> f64 {
    let raw = rng::normal(rng, p.base_trust.mean, p.base_trust.sd);
    // Agreeable agents trust a little more; each prior divorce costs a little.
    (raw + 0.1 * (pers.agreeableness - 0.5) - 0.03 * hist.prior_divorces as f64).clamp(0.05, 0.95)
}

fn shared_history(
    rng: &mut Rng,
    p: &PopulationConfig,
    years: f64,
    a: u64,
    b: u64,
) -> (Vec<Episode>, Vec<Episode>) {
    let span_days = (years * 365.0).max(1.0);
    let n_pos = (years * p.history_positive_per_year).round() as usize;
    let n_conf = (years * p.history_conflict_per_year).round() as usize;
    let mut for_a = Vec::with_capacity(n_pos + n_conf);
    let mut for_b = Vec::with_capacity(n_pos + n_conf);
    for i in 0..(n_pos + n_conf) {
        let day = -(1.0 + rng::unit(rng) * span_days).floor() as i32;
        let (kind, intensity) = if i < n_pos {
            (EpisodeKind::Positive, 0.08 + 0.12 * rng::unit(rng))
        } else {
            (EpisodeKind::Conflict, 0.2 + 0.5 * rng::unit(rng))
        };
        for_a.push(Episode {
            day,
            kind,
            intensity,
            partner: b,
        });
        for_b.push(Episode {
            day,
            kind,
            intensity,
            partner: a,
        });
    }
    for_a.sort_by_key(|e| e.day);
    for_b.sort_by_key(|e| e.day);
    (for_a, for_b)
}

/// Watts-Strogatz small world over `n` nodes with even degree `k` and rewiring prob `p`.
pub fn small_world(rng: &mut Rng, n: usize, k: usize, p: f64) -> Vec<Vec<u64>> {
    let mut adj: Vec<std::collections::BTreeSet<u64>> = vec![Default::default(); n];
    if n < 2 || k == 0 {
        return adj.into_iter().map(|s| s.into_iter().collect()).collect();
    }
    let half = (k / 2).min(n - 1);
    for i in 0..n {
        for j in 1..=half {
            let t = (i + j) % n;
            adj[i].insert(t as u64);
            adj[t].insert(i as u64);
        }
    }
    // Rewire each lattice edge (i, i+j) with probability p to a uniformly random non-neighbour.
    for i in 0..n {
        for j in 1..=half {
            let t = (i + j) % n;
            if rng::coin(rng, p) {
                let mut tries = 0;
                loop {
                    let cand = rng::below(rng, n);
                    tries += 1;
                    if cand != i && !adj[i].contains(&(cand as u64)) {
                        adj[i].remove(&(t as u64));
                        adj[t].remove(&(i as u64));
                        adj[i].insert(cand as u64);
                        adj[cand].insert(i as u64);
                        break;
                    }
                    if tries > 50 {
                        break;
                    }
                }
            }
        }
    }
    adj.into_iter().map(|s| s.into_iter().collect()).collect()
}

/// Generate the whole population from `cfg.seeds.population`. Nothing here reads the
/// assignment or dynamics seeds, and nothing reads an arm.
pub fn generate(cfg: &SimConfig) -> Population {
    let p = &cfg.population;
    let seed = cfg.seeds.population;
    let n = cfg.n_couples as usize;
    let mut agents = Vec::with_capacity(2 * n);
    let mut couples = Vec::with_capacity(n);
    for c in 0..n as u64 {
        let a_id = 2 * c;
        let b_id = 2 * c + 1;
        let mut ra = rng::stream(seed, "agent", a_id);
        let mut rb = rng::stream(seed, "agent", b_id);
        let mut rc = rng::stream(seed, "couple", c);

        let years =
            rng::clipped_normal(&mut rc, p.years_married.mean, p.years_married.sd, 0.5, 40.0);

        let pa = sample_personality(&mut ra, p, None, 0.0);
        let qa = sample_prefs(&mut ra, p, None, 0.0);
        let ha = sample_history(&mut ra, p, years);
        let ta = base_trust(&mut ra, p, &pa, &ha);
        let la = rng::clipped_normal(
            &mut ra,
            cfg.market.relax_rate_mean,
            cfg.market.relax_rate_sd,
            0.0,
            1.0,
        );

        let pb = sample_personality(&mut rb, p, Some(&pa), p.assortative_mixing);
        let qb = sample_prefs(&mut rb, p, Some(&qa), p.assortative_mixing);
        let hb = sample_history(&mut rb, p, years);
        let tb = base_trust(&mut rb, p, &pb, &hb);
        let lb = rng::clipped_normal(
            &mut rb,
            cfg.market.relax_rate_mean,
            cfg.market.relax_rate_sd,
            0.0,
            1.0,
        );

        let (ea, eb) = shared_history(&mut rc, p, years, a_id, b_id);
        let compat = compatibility(&trait_vector(&pa, &qa), &trait_vector(&pb, &qb));

        agents.push(AgentSpec {
            id: a_id,
            couple_id: c,
            personality: pa,
            prefs: qa,
            history: ha,
            base_trust: ta,
            relax_rate: la,
            initial_episodes: ea,
        });
        agents.push(AgentSpec {
            id: b_id,
            couple_id: c,
            personality: pb,
            prefs: qb,
            history: hb,
            base_trust: tb,
            relax_rate: lb,
            initial_episodes: eb,
        });
        couples.push(CoupleSpec {
            id: c,
            a: a_id,
            b: b_id,
            years_married: years,
            compatibility: compat,
        });
    }
    let mut rn = rng::stream(seed, "network", 0);
    let network = small_world(&mut rn, 2 * n, p.network_k, p.network_rewire_p);
    Population {
        agents,
        couples,
        network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(n: u32) -> SimConfig {
        SimConfig {
            n_couples: n,
            days: 10,
            ..SimConfig::default()
        }
    }

    #[test]
    fn deterministic_for_same_seed() {
        let a = generate(&cfg(50));
        let b = generate(&cfg(50));
        assert_eq!(a, b);
    }

    #[test]
    fn different_population_seed_changes_agents() {
        let a = generate(&cfg(50));
        let mut c = cfg(50);
        c.seeds.population = 999;
        let b = generate(&c);
        assert_ne!(a.agents[0].personality, b.agents[0].personality);
    }

    #[test]
    fn assignment_and_dynamics_seeds_do_not_touch_population() {
        let a = generate(&cfg(50));
        let mut c = cfg(50);
        c.seeds.assignment = 1;
        c.seeds.dynamics = 2;
        let b = generate(&c);
        assert_eq!(a, b);
    }

    #[test]
    fn traits_are_heterogeneous_and_in_range() {
        let pop = generate(&cfg(300));
        let xs: Vec<f64> = pop
            .agents
            .iter()
            .map(|a| a.personality.neuroticism)
            .collect();
        let mean = xs.iter().sum::<f64>() / xs.len() as f64;
        let var = xs.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / xs.len() as f64;
        assert!(var > 0.01, "variance {var}");
        for a in &pop.agents {
            for t in trait_vector(&a.personality, &a.prefs) {
                assert!((0.0..=1.0).contains(&t));
            }
            assert!((0.0..=1.0).contains(&a.base_trust));
        }
        let divorced = pop
            .agents
            .iter()
            .filter(|a| a.history.prior_divorces > 0)
            .count();
        assert!(divorced > 0);
    }

    #[test]
    fn partners_are_assortative() {
        let pop = generate(&cfg(400));
        let within: f64 = pop
            .couples
            .iter()
            .map(|c| {
                let a = &pop.agents[c.a as usize];
                let b = &pop.agents[c.b as usize];
                (a.personality.openness - b.personality.openness).abs()
            })
            .sum::<f64>()
            / pop.couples.len() as f64;
        let across: f64 = pop
            .couples
            .iter()
            .zip(pop.couples.iter().skip(1))
            .map(|(c, d)| {
                let a = &pop.agents[c.a as usize];
                let b = &pop.agents[d.b as usize];
                (a.personality.openness - b.personality.openness).abs()
            })
            .sum::<f64>()
            / (pop.couples.len() - 1) as f64;
        assert!(within < across, "within {within} across {across}");
    }

    #[test]
    fn history_episodes_are_in_the_past_and_shared() {
        let pop = generate(&cfg(20));
        for c in &pop.couples {
            let a = &pop.agents[c.a as usize];
            let b = &pop.agents[c.b as usize];
            assert_eq!(a.initial_episodes.len(), b.initial_episodes.len());
            for (ea, eb) in a.initial_episodes.iter().zip(b.initial_episodes.iter()) {
                assert!(ea.day < 0);
                assert_eq!(ea.day, eb.day);
                assert_eq!(ea.kind, eb.kind);
                assert_eq!(ea.partner, b.id);
                assert_eq!(eb.partner, a.id);
            }
        }
    }

    #[test]
    fn network_is_symmetric_without_self_loops() {
        let pop = generate(&cfg(100));
        assert_eq!(pop.network.len(), 200);
        for (i, nbrs) in pop.network.iter().enumerate() {
            assert!(!nbrs.is_empty());
            for &j in nbrs {
                assert_ne!(j as usize, i);
                assert!(pop.network[j as usize].contains(&(i as u64)));
            }
        }
    }

    #[test]
    fn compatibility_bounds() {
        let x = [0.0; 9];
        let y = [1.0; 9];
        assert_eq!(compatibility(&x, &x), 1.0);
        assert_eq!(compatibility(&x, &y), 0.0);
    }
}
