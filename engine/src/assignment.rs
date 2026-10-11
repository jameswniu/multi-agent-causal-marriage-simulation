//! Treatment assignment from the assignment seed alone.

use crate::config::{Arm, AssignmentMode, SimConfig};
use crate::rng;

/// Arm per couple id. Couple mode shuffles couple ids; block mode shuffles contiguous
/// blocks of `block_size` ids. `arm_override` forces every couple into one arm.
pub fn assign(cfg: &SimConfig) -> Vec<Arm> {
    let n = cfg.n_couples as usize;
    if let Some(arm) = cfg.arm_override {
        return vec![arm; n];
    }
    let mut r = rng::stream(cfg.seeds.assignment, "assignment", 0);
    let f = cfg.assignment.treatment_fraction;
    match cfg.assignment.mode {
        AssignmentMode::Couple => {
            let mut ids: Vec<usize> = (0..n).collect();
            rng::shuffle(&mut r, &mut ids);
            let k = (n as f64 * f).round() as usize;
            let mut arms = vec![Arm::Control; n];
            for &i in ids.iter().take(k) {
                arms[i] = Arm::Treatment;
            }
            arms
        }
        AssignmentMode::Block => {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(n: u32) -> SimConfig {
        SimConfig {
            n_couples: n,
            ..SimConfig::default()
        }
    }

    #[test]
    fn exact_half_split_and_deterministic() {
        let a = assign(&cfg(1000));
        let b = assign(&cfg(1000));
        assert_eq!(a, b);
        assert_eq!(a.iter().filter(|x| **x == Arm::Treatment).count(), 500);
    }

    #[test]
    fn assignment_seed_changes_arms_but_population_seed_does_not() {
        let base = assign(&cfg(200));
        let mut c = cfg(200);
        c.seeds.assignment = 7;
        assert_ne!(assign(&c), base);
        let mut c = cfg(200);
        c.seeds.population = 7;
        c.seeds.dynamics = 9;
        assert_eq!(assign(&c), base);
    }

    #[test]
    fn block_mode_keeps_blocks_together() {
        let mut c = cfg(100);
        c.assignment.mode = AssignmentMode::Block;
        c.assignment.block_size = 10;
        let arms = assign(&c);
        for b in 0..10 {
            let first = arms[b * 10];
            assert!(arms[b * 10..(b + 1) * 10].iter().all(|a| *a == first));
        }
        assert_eq!(arms.iter().filter(|x| **x == Arm::Treatment).count(), 50);
    }

    #[test]
    fn override_forces_one_arm() {
        let mut c = cfg(50);
        c.arm_override = Some(Arm::Treatment);
        assert!(assign(&c).iter().all(|a| *a == Arm::Treatment));
    }
}
