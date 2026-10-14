//! Treatment assignment.
//!
//! Couple and block mode read the assignment seed alone. Pairs mode also reads the population,
//! because the pairs are formed from values each couple drew before day 0; the coin inside each
//! pair still reads the assignment seed alone. Nothing here reads the dynamics seed.

use crate::config::{Arm, AssignmentMode, SimConfig};
use crate::population::Population;
use crate::rng;

/// The arm of every couple and, in pairs mode, the pair of every couple.
#[derive(Clone, Debug, PartialEq)]
pub struct Design {
    /// Arm per couple id.
    pub arms: Vec<Arm>,
    /// Pair id per couple id in pairs mode, otherwise `None`. Pairs are numbered from the
    /// lowest risk score up; with an odd count the highest-scoring couple is alone in the last
    /// pair and its own coin decides its arm.
    pub pair_id: Option<Vec<u32>>,
}

/// Assign every couple to an arm. Couple mode shuffles couple ids; block mode shuffles
/// contiguous blocks of `block_size` ids; pairs mode flips one coin per pair. `arm_override`
/// forces every couple into one arm, and pairs mode still records its pairs then.
pub fn assign(cfg: &SimConfig, pop: &Population) -> Design {
    let mut design = match cfg.assignment.mode {
        AssignmentMode::Couple => Design {
            arms: couple_arms(cfg),
            pair_id: None,
        },
        AssignmentMode::Block => Design {
            arms: block_arms(cfg),
            pair_id: None,
        },
        AssignmentMode::Pairs => {
            let pair_id = pairs(cfg, pop);
            Design {
                arms: pair_arms(cfg.seeds.assignment, &pair_id),
                pair_id: Some(pair_id),
            }
        }
    };
    if let Some(arm) = cfg.arm_override {
        design.arms = vec![arm; cfg.n_couples as usize];
    }
    design
}

fn couple_arms(cfg: &SimConfig) -> Vec<Arm> {
    let n = cfg.n_couples as usize;
    let mut r = rng::stream(cfg.seeds.assignment, "assignment", 0);
    let f = cfg.assignment.treatment_fraction;
    let mut ids: Vec<usize> = (0..n).collect();
    rng::shuffle(&mut r, &mut ids);
    let k = (n as f64 * f).round() as usize;
    let mut arms = vec![Arm::Control; n];
    for &i in ids.iter().take(k) {
        arms[i] = Arm::Treatment;
    }
    arms
}

fn block_arms(cfg: &SimConfig) -> Vec<Arm> {
    let n = cfg.n_couples as usize;
    let mut r = rng::stream(cfg.seeds.assignment, "assignment", 0);
    let f = cfg.assignment.treatment_fraction;
    let bs = cfg.assignment.block_size as usize;
    let blocks = n.div_ceil(bs);
    let mut ids: Vec<usize> = (0..blocks).collect();
    rng::shuffle(&mut r, &mut ids);
    let k = (blocks as f64 * f).round() as usize;
    let mut treated = vec![false; blocks];
    for &b in ids.iter().take(k) {
        treated[b] = true;
    }
    (0..n)
        .map(|i| {
            if treated[i / bs] {
                Arm::Treatment
            } else {
                Arm::Control
            }
        })
        .collect()
}

/// The pairing covariates per couple, in `PairWeights` order: the partners' mean
/// neuroticism, conscientiousness, agreeableness, base trust and prior divorces, then the
/// couple's years married. All are drawn by the population before day 0.
pub fn couple_covariates(pop: &Population) -> Vec<[f64; 6]> {
    pop.couples
        .iter()
        .map(|c| {
            let (a, b) = (&pop.agents[c.a as usize], &pop.agents[c.b as usize]);
            let mean = |x: f64, y: f64| (x + y) / 2.0;
            [
                mean(a.personality.neuroticism, b.personality.neuroticism),
                mean(
                    a.personality.conscientiousness,
                    b.personality.conscientiousness,
                ),
                mean(a.personality.agreeableness, b.personality.agreeableness),
                mean(a.base_trust, b.base_trust),
                mean(
                    a.history.prior_divorces as f64,
                    b.history.prior_divorces as f64,
                ),
                c.years_married,
            ]
        })
        .collect()
}

/// Risk score per couple: `pair_weights` applied to the covariates standardised over the
/// population (mean zero, population standard deviation one). A covariate that is the same for
/// every couple contributes nothing.
pub fn risk_scores(cfg: &SimConfig, pop: &Population) -> Vec<f64> {
    let rows = couple_covariates(pop);
    let w = cfg.assignment.pair_weights.as_array();
    let n = rows.len() as f64;
    let mut score = vec![0.0; rows.len()];
    for (k, &wk) in w.iter().enumerate() {
        let mean = rows.iter().map(|r| r[k]).sum::<f64>() / n;
        let squares: f64 = rows.iter().map(|r| (r[k] - mean) * (r[k] - mean)).sum();
        let sd = (squares / n).sqrt();
        if sd > 0.0 {
            for (s, r) in score.iter_mut().zip(&rows) {
                *s += wk * (r[k] - mean) / sd;
            }
        }
    }
    score
}

/// Pair id per couple: couples sorted by risk score (ties broken by couple id) and cut into
/// consecutive pairs, numbered from the lowest score up. With an odd count the highest-scoring
/// couple is alone in the last pair.
pub fn pairs(cfg: &SimConfig, pop: &Population) -> Vec<u32> {
    let score = risk_scores(cfg, pop);
    let mut order: Vec<usize> = (0..score.len()).collect();
    order.sort_by(|&i, &j| score[i].total_cmp(&score[j]).then(i.cmp(&j)));
    let mut pair_id = vec![0u32; score.len()];
    for (rank, &c) in order.iter().enumerate() {
        pair_id[c] = (rank / 2) as u32;
    }
    pair_id
}

/// One fair coin per pair, each on its own stream keyed by the assignment seed and the pair id.
/// Heads treats the member with the lower couple id and leaves the other in control; a couple
/// alone in its pair is treated on heads.
pub fn pair_arms(seed: u64, pair_id: &[u32]) -> Vec<Arm> {
    let n_pairs = pair_id.iter().map(|&p| p as usize + 1).max().unwrap_or(0);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); n_pairs];
    for (c, &p) in pair_id.iter().enumerate() {
        members[p as usize].push(c);
    }
    let mut arms = vec![Arm::Control; pair_id.len()];
    for (p, m) in members.iter().enumerate() {
        let mut r = rng::stream(seed, "pair", p as u64);
        let heads = rng::coin(&mut r, 0.5);
        for (k, &c) in m.iter().enumerate() {
            if (k == 0) == heads {
                arms[c] = Arm::Treatment;
            }
        }
    }
    arms
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::population;

    fn cfg(n: u32) -> SimConfig {
        SimConfig {
            n_couples: n,
            ..SimConfig::default()
        }
    }

    fn paired(n: u32) -> SimConfig {
        let mut c = cfg(n);
        c.assignment.mode = AssignmentMode::Pairs;
        c
    }

    fn design(c: &SimConfig) -> Design {
        assign(c, &population::generate(c))
    }

    fn arms(c: &SimConfig) -> Vec<Arm> {
        design(c).arms
    }

    fn treated(a: &[Arm]) -> usize {
        a.iter().filter(|x| **x == Arm::Treatment).count()
    }

    #[test]
    fn exact_half_split_and_deterministic() {
        let a = arms(&cfg(1000));
        let b = arms(&cfg(1000));
        assert_eq!(a, b);
        assert_eq!(treated(&a), 500);
        assert_eq!(design(&cfg(1000)).pair_id, None);
    }

    #[test]
    fn assignment_seed_changes_arms_but_population_seed_does_not() {
        let base = arms(&cfg(200));
        let mut c = cfg(200);
        c.seeds.assignment = 7;
        assert_ne!(arms(&c), base);
        let mut c = cfg(200);
        c.seeds.population = 7;
        c.seeds.dynamics = 9;
        assert_eq!(arms(&c), base);
    }

    #[test]
    fn block_mode_keeps_blocks_together() {
        let mut c = cfg(100);
        c.assignment.mode = AssignmentMode::Block;
        c.assignment.block_size = 10;
        let arms = arms(&c);
        for b in 0..10 {
            let first = arms[b * 10];
            assert!(arms[b * 10..(b + 1) * 10].iter().all(|a| *a == first));
        }
        assert_eq!(treated(&arms), 50);
    }

    #[test]
    fn override_forces_one_arm() {
        let mut c = cfg(50);
        c.arm_override = Some(Arm::Treatment);
        assert!(arms(&c).iter().all(|a| *a == Arm::Treatment));
        let mut p = paired(50);
        p.arm_override = Some(Arm::Control);
        let d = design(&p);
        assert!(d.arms.iter().all(|a| *a == Arm::Control));
        assert_eq!(d.pair_id, design(&paired(50)).pair_id);
    }

    #[test]
    fn pairs_split_every_pair_across_the_arms() {
        let c = paired(1000);
        let d = design(&c);
        let ids = d.pair_id.clone().expect("pairs mode records pairs");
        assert_eq!(treated(&d.arms), 500);
        let mut seen = vec![Vec::new(); 500];
        for (couple, &p) in ids.iter().enumerate() {
            seen[p as usize].push(d.arms[couple]);
        }
        for (p, members) in seen.iter().enumerate() {
            assert_eq!(members.len(), 2, "pair {p} must hold two couples");
            assert_ne!(members[0], members[1], "pair {p} must span both arms");
        }
        assert_eq!(design(&c), d, "pairs mode is deterministic");
    }

    #[test]
    fn pairs_are_neighbours_in_risk_score() {
        let c = paired(301);
        let pop = population::generate(&c);
        let score = risk_scores(&c, &pop);
        let ids = pairs(&c, &pop);
        let n_pairs = 151;
        let mut lo = vec![f64::INFINITY; n_pairs];
        let mut hi = vec![f64::NEG_INFINITY; n_pairs];
        let mut size = vec![0; n_pairs];
        for (couple, &p) in ids.iter().enumerate() {
            let p = p as usize;
            lo[p] = lo[p].min(score[couple]);
            hi[p] = hi[p].max(score[couple]);
            size[p] += 1;
        }
        for p in 1..n_pairs {
            assert!(hi[p - 1] <= lo[p], "pair {p} overlaps the pair below it");
        }
        // An odd count leaves the highest-scoring couple alone in the last pair.
        assert!(size[..150].iter().all(|&s| s == 2));
        assert_eq!(size[150], 1);
        let top = (0..301)
            .max_by(|&i, &j| score[i].total_cmp(&score[j]))
            .unwrap();
        assert_eq!(ids[top], 150);
    }

    #[test]
    fn an_unpaired_couple_gets_its_own_coin() {
        let mut arms_of_last = Vec::new();
        for seed in 0..40 {
            let mut c = paired(7);
            c.seeds.assignment = seed;
            let d = design(&c);
            let ids = d.pair_id.unwrap();
            let last = ids.iter().position(|&p| p == 3).unwrap();
            assert_eq!(ids.iter().filter(|&&p| p == 3).count(), 1);
            arms_of_last.push(d.arms[last]);
            let t = treated(&d.arms);
            assert!(
                t == 3 || t == 4,
                "three pairs split evenly plus one coin, got {t}"
            );
        }
        assert!(arms_of_last.contains(&Arm::Treatment) && arms_of_last.contains(&Arm::Control));
    }

    #[test]
    fn pairs_follow_the_population_and_coins_follow_the_assignment_seed() {
        let base = design(&paired(200));
        // The assignment seed moves the coins and never the pairs.
        let mut c = paired(200);
        c.seeds.assignment = 7;
        let moved = design(&c);
        assert_eq!(moved.pair_id, base.pair_id);
        assert_ne!(moved.arms, base.arms);
        // The dynamics seed moves nothing.
        let mut c = paired(200);
        c.seeds.dynamics = 9;
        assert_eq!(design(&c), base);
        // The population seed moves the pairs, because the pairs are made from the population.
        let mut c = paired(200);
        c.seeds.population = 7;
        assert_ne!(design(&c).pair_id, base.pair_id);
    }

    #[test]
    fn pair_weights_change_the_pairs() {
        let base = design(&paired(200)).pair_id;
        let mut c = paired(200);
        c.assignment.pair_weights.years_married = 5.0;
        assert_ne!(design(&c).pair_id, base);
    }

    #[test]
    fn pairs_mode_needs_an_even_split() {
        let mut c = paired(10);
        assert!(c.validate().is_ok());
        c.assignment.treatment_fraction = 0.4;
        let err = c.validate().unwrap_err().to_string();
        assert!(err.contains("treatment_fraction must be 0.5"), "{err}");
        let mut c = paired(10);
        c.assignment.pair_weights.base_trust = f64::NAN;
        assert!(c.validate().is_err());
    }
}
