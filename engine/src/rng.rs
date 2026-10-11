//! Seeded, domain-separated random streams.
//!
//! Every agent, couple and global process draws from its own ChaCha8 stream keyed by
//! (master seed, domain string, id). Streams are independent of ECS iteration order, so a
//! simulation is reproducible regardless of how Bevy schedules the work, and a couple's
//! stream is identical across treatment arms (common random numbers for twin runs).

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use sha2::{Digest, Sha256};

pub type Rng = ChaCha8Rng;

/// Derive a 32-byte seed from (master, domain, id) with SHA-256.
pub fn derive_seed(master: u64, domain: &str, id: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(master.to_le_bytes());
    h.update([0u8]);
    h.update(domain.as_bytes());
    h.update([0u8]);
    h.update(id.to_le_bytes());
    let out = h.finalize();
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&out[..32]);
    seed
}

/// Open the stream for (master, domain, id).
pub fn stream(master: u64, domain: &str, id: u64) -> Rng {
    ChaCha8Rng::from_seed(derive_seed(master, domain, id))
}

/// Standard normal via Box-Muller (two uniforms, one normal; deterministic per stream).
pub fn normal(rng: &mut Rng, mean: f64, sd: f64) -> f64 {
    use rand::RngExt;
    let u1: f64 = rng.random::<f64>().max(1e-12);
    let u2: f64 = rng.random::<f64>();
    let z = (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos();
    mean + sd * z
}

/// Normal draw clipped into [lo, hi].
pub fn clipped_normal(rng: &mut Rng, mean: f64, sd: f64, lo: f64, hi: f64) -> f64 {
    normal(rng, mean, sd).clamp(lo, hi)
}

/// Uniform in [0, 1).
pub fn unit(rng: &mut Rng) -> f64 {
    use rand::RngExt;
    rng.random::<f64>()
}

/// Bernoulli(p) with p clamped into [0, 1].
pub fn coin(rng: &mut Rng, p: f64) -> bool {
    use rand::RngExt;
    let p = if p.is_nan() { 0.0 } else { p.clamp(0.0, 1.0) };
    rng.random_bool(p)
}

/// Uniform integer in [0, n).
pub fn below(rng: &mut Rng, n: usize) -> usize {
    use rand::RngExt;
    if n == 0 {
        return 0;
    }
    rng.random_range(0..n)
}

/// Fisher-Yates shuffle driven by the given stream.
pub fn shuffle<T>(rng: &mut Rng, items: &mut [T]) {
    let n = items.len();
    for i in (1..n).rev() {
        let j = below(rng, i + 1);
        items.swap(i, j);
    }
}

/// Sample an index from unnormalised softmax utilities at the given temperature.
/// Returns the chosen index and the probability vector (for logging).
pub fn softmax_choice(rng: &mut Rng, utilities: &[f64], temperature: f64) -> (usize, Vec<f64>) {
    let t = temperature.max(1e-6);
    // NaN never wins; infinities are clamped so differences stay finite.
    let clean: Vec<f64> = utilities
        .iter()
        .map(|u| {
            if u.is_nan() {
                f64::NEG_INFINITY
            } else {
                u.clamp(-1e300, 1e300)
            }
        })
        .collect();
    let max = clean.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let n = clean.len().max(1) as f64;
    let weights: Vec<f64> = if max.is_finite() {
        clean.iter().map(|u| ((u - max) / t).exp()).collect()
    } else {
        vec![1.0 / n; clean.len()]
    };
    let sum: f64 = weights.iter().sum();
    let probs: Vec<f64> = weights.iter().map(|w| w / sum).collect();
    let r = unit(rng);
    let mut acc = 0.0;
    for (i, p) in probs.iter().enumerate() {
        acc += p;
        if r < acc {
            return (i, probs);
        }
    }
    (probs.len() - 1, probs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_key_same_stream() {
        let mut a = stream(7, "agent", 3);
        let mut b = stream(7, "agent", 3);
        for _ in 0..100 {
            assert_eq!(unit(&mut a).to_bits(), unit(&mut b).to_bits());
        }
    }

    #[test]
    fn different_domain_or_id_differs() {
        let mut a = stream(7, "agent", 3);
        let mut b = stream(7, "couple", 3);
        let mut c = stream(7, "agent", 4);
        let mut d = stream(8, "agent", 3);
        let va = unit(&mut a);
        assert_ne!(va.to_bits(), unit(&mut b).to_bits());
        assert_ne!(va.to_bits(), unit(&mut c).to_bits());
        assert_ne!(va.to_bits(), unit(&mut d).to_bits());
    }

    #[test]
    fn normal_moments_roughly_right() {
        let mut r = stream(1, "test", 0);
        let n = 20_000;
        let xs: Vec<f64> = (0..n).map(|_| normal(&mut r, 2.0, 0.5)).collect();
        let mean = xs.iter().sum::<f64>() / n as f64;
        let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
        assert!((mean - 2.0).abs() < 0.02, "mean {mean}");
        assert!((var.sqrt() - 0.5).abs() < 0.02, "sd {}", var.sqrt());
    }

    #[test]
    fn softmax_prefers_higher_utility() {
        let mut r = stream(1, "test", 1);
        let mut counts = [0usize; 3];
        for _ in 0..5000 {
            let (i, _) = softmax_choice(&mut r, &[0.0, 1.0, 3.0], 1.0);
            counts[i] += 1;
        }
        assert!(counts[2] > counts[1] && counts[1] > counts[0], "{counts:?}");
    }

    #[test]
    fn softmax_survives_nan_and_infinity() {
        let mut r = stream(1, "test", 3);
        let (i, p) = softmax_choice(&mut r, &[f64::NAN, 1.0, f64::INFINITY], 1.0);
        assert_eq!(i, 2);
        assert!((p.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        assert_eq!(p[0], 0.0);
        let (_, p) = softmax_choice(&mut r, &[f64::NAN, f64::NAN], 1.0);
        assert!((p[0] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn coin_handles_out_of_range() {
        let mut r = stream(1, "test", 2);
        assert!(coin(&mut r, 1.5));
        assert!(!coin(&mut r, -0.5));
        assert!(!coin(&mut r, f64::NAN));
    }
}
