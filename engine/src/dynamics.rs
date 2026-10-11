//! The world's non-decision dynamics: stress shocks, affect coupling between partners
//! (Gottman and Murray style influence equations), slow trust integration, satisfaction,
//! and the conflict onset and repair acceptance hazards. Pure functions of state and config;
//! none of them read the arm.

use crate::config::DynamicsConfig;
use crate::memory::Loads;
use crate::rng::{self, Rng};

pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Daily stress: geometric decay plus an occasional shock, nudged up by neuroticism.
pub fn stress_step(c: &DynamicsConfig, rng: &mut Rng, stress: f64, neuroticism: f64) -> f64 {
    let mut s = stress * c.stress_decay;
    if rng::coin(rng, c.stress_shock_prob) {
        s += c.stress_shock_mean * (0.5 + rng::unit(rng));
    }
    (s + c.stress_neuro_weight * neuroticism * 0.1).clamp(0.0, 3.0)
}

/// Influence of the partner's affect, steeper below the negativity threshold.
pub fn influence(c: &DynamicsConfig, partner_affect: f64) -> f64 {
    if partner_affect >= 0.0 {
        c.influence_pos * partner_affect
    } else if partner_affect >= c.negativity_threshold {
        c.influence_neg * partner_affect
    } else {
        c.influence_neg * c.negativity_threshold
            + c.influence_neg_below_threshold * (partner_affect - c.negativity_threshold)
    }
}

pub struct AffectInputs {
    pub affect: f64,
    pub partner_affect: f64,
    pub neuroticism: f64,
    pub agreeableness: f64,
    pub stress: f64,
    pub loads: Loads,
    /// Absolute gap between the members' closeness preferences.
    pub closeness_gap: f64,
}

/// Next-day affect: `baseline + inertia * own + influence(partner) + noise`, in [-1, 1].
pub fn affect_step(c: &DynamicsConfig, rng: &mut Rng, x: &AffectInputs) -> f64 {
    let inertia =
        (c.affect_inertia_base + c.affect_inertia_neuro * (x.neuroticism - 0.5)).clamp(0.0, 0.95);
    let baseline = c.affect_baseline_agree * (x.agreeableness - 0.5)
        - c.affect_grudge_weight * x.loads.negative
        + c.affect_pos_weight * x.loads.positive
        - c.affect_stress_weight * x.stress
        - c.affect_closeness_gap_weight * x.closeness_gap;
    let noise = rng::normal(rng, 0.0, c.affect_noise_sd);
    (baseline * (1.0 - inertia) + inertia * x.affect + influence(c, x.partner_affect) + noise)
        .clamp(-1.0, 1.0)
}

/// Slow trust integrator toward a memory- and affect-shaped target.
pub fn trust_step(
    c: &DynamicsConfig,
    trust: f64,
    base_trust: f64,
    loads: Loads,
    affect: f64,
) -> f64 {
    let target = (base_trust + c.trust_pos_weight * loads.positive
        - c.trust_neg_weight * loads.negative
        + c.trust_affect_weight * affect)
        .clamp(0.0, 1.0);
    (trust + c.trust_rate * (target - trust)).clamp(0.0, 1.0)
}

pub fn satisfaction(c: &DynamicsConfig, trust: f64, affect: f64, loads: Loads) -> f64 {
    sigmoid(
        c.sat_trust * (trust - 0.5)
            + c.sat_affect * affect
            + c.sat_memory * (loads.positive - loads.negative),
    )
}

pub struct OnsetInputs {
    pub stress_sum: f64,
    pub neuro_mean: f64,
    pub grudge_mean: f64,
    pub trust_mean: f64,
    pub affect_mean: f64,
    pub agree_mean: f64,
}

/// Daily probability that a calm couple opens a conflict.
pub fn conflict_onset_prob(c: &DynamicsConfig, x: &OnsetInputs) -> f64 {
    sigmoid(
        c.onset_intercept
            + c.onset_stress * x.stress_sum
            + c.onset_neuro * x.neuro_mean
            + c.onset_grudge * x.grudge_mean
            + c.onset_trust * (x.trust_mean - 0.5)
            + c.onset_affect * x.affect_mean
            + c.onset_agree * (x.agree_mean - 0.5),
    )
}

pub fn initial_intensity(
    c: &DynamicsConfig,
    rng: &mut Rng,
    stress_sum: f64,
    neuro_mean: f64,
) -> f64 {
    rng::clipped_normal(
        rng,
        c.intensity_base
            + c.intensity_stress * stress_sum.min(2.0)
            + c.intensity_neuro * neuro_mean,
        c.intensity_sd,
        0.05,
        1.0,
    )
}

/// Probability the receiver accepts a repair attempt, from the receiver's private state.
pub fn accept_prob(
    c: &DynamicsConfig,
    trust: f64,
    forgiveness: f64,
    grudge: f64,
    intensity: f64,
) -> f64 {
    sigmoid(
        c.accept_intercept
            + c.accept_trust * (trust - 0.5)
            + c.accept_forgive * (forgiveness - 0.5)
            + c.accept_grudge * grudge
            + c.accept_intensity * intensity,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn influence_is_steeper_below_threshold() {
        let c = DynamicsConfig::default();
        let above = influence(&c, -0.2) - influence(&c, -0.3);
        let below = influence(&c, -0.6) - influence(&c, -0.7);
        assert!(below > above, "below {below} above {above}");
        assert!(influence(&c, 0.5) > 0.0);
        assert!((influence(&c, 0.0)).abs() < 1e-12);
    }

    #[test]
    fn grudge_lowers_affect_and_trust_targets() {
        let c = DynamicsConfig::default();
        let mut r1 = rng::stream(1, "d", 1);
        let mut r2 = rng::stream(1, "d", 1);
        let calm = AffectInputs {
            affect: 0.0,
            partner_affect: 0.0,
            neuroticism: 0.5,
            agreeableness: 0.5,
            stress: 0.0,
            loads: Loads::default(),
            closeness_gap: 0.0,
        };
        let grudge = AffectInputs {
            loads: Loads {
                negative: 1.0,
                positive: 0.0,
            },
            ..calm
        };
        assert!(affect_step(&c, &mut r2, &grudge) < affect_step(&c, &mut r1, &calm));
        let t0 = trust_step(&c, 0.6, 0.6, Loads::default(), 0.0);
        let t1 = trust_step(
            &c,
            0.6,
            0.6,
            Loads {
                negative: 1.0,
                positive: 0.0,
            },
            0.0,
        );
        assert!(t1 < t0);
    }

    #[test]
    fn onset_probability_is_bounded_and_monotone() {
        let c = DynamicsConfig::default();
        let base = OnsetInputs {
            stress_sum: 0.0,
            neuro_mean: 0.5,
            grudge_mean: 0.0,
            trust_mean: 0.6,
            affect_mean: 0.0,
            agree_mean: 0.5,
        };
        let p0 = conflict_onset_prob(&c, &base);
        let p1 = conflict_onset_prob(
            &c,
            &OnsetInputs {
                stress_sum: 1.5,
                ..base
            },
        );
        let p2 = conflict_onset_prob(
            &c,
            &OnsetInputs {
                grudge_mean: 1.0,
                ..base
            },
        );
        assert!(p0 > 0.0 && p0 < 0.2, "{p0}");
        assert!(p1 > p0 && p2 > p0);
    }

    #[test]
    fn acceptance_rises_with_trust_and_falls_with_grudge() {
        let c = DynamicsConfig::default();
        assert!(accept_prob(&c, 0.9, 0.5, 0.0, 0.3) > accept_prob(&c, 0.3, 0.5, 0.0, 0.3));
        assert!(accept_prob(&c, 0.6, 0.5, 0.0, 0.3) > accept_prob(&c, 0.6, 0.5, 1.5, 0.3));
    }

    #[test]
    fn stress_decays_without_shocks() {
        let c = DynamicsConfig {
            stress_shock_prob: 0.0,
            ..DynamicsConfig::default()
        };
        let mut r = rng::stream(1, "d", 2);
        let s = stress_step(&c, &mut r, 1.0, 0.0);
        assert!(s < 1.0 && s > 0.0);
    }
}
