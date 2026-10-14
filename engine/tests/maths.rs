//! The engine's maths gives the same bits on every platform. Every exp, log, power and cosine the
//! engine computes goes through the libm crate (see engine/Cargo.toml), never the platform's own maths
//! library, and the values below were computed with it. A platform, or a libm release, that rounded any
//! of them differently would move every table hash, so this test names the function first. Three of the
//! inputs are ones where macOS's own library gives a different last bit, as marked.

use loveworld_engine::{dynamics, rng};
use std::f64::consts::TAU;

#[test]
fn the_maths_gives_the_same_bits_everywhere() {
    let mut stream = rng::stream(11, "agent", 7);
    let cases: Vec<(&str, f64, u64)> = vec![
        (
            "memory decay exp2(-35 / 90)",
            libm::exp2(-(35.0 / 90.0)),
            0x3fe8705fd1e0a350,
        ),
        (
            "memory decay exp2(-3 / 14)",
            libm::exp2(-(3.0 / 14.0)),
            0x3feb954806a97df0,
        ),
        (
            "memory decay exp2(-198 / 14)",
            libm::exp2(-(198.0 / 14.0)),
            0x3f0cfbb031a741a7,
        ),
        (
            "load saturation exp(-0.7 / 1.5)",
            libm::exp(-0.7 / 1.5),
            0x3fe4111d211da482,
        ),
        (
            "load saturation exp(-3.2 / 1.5)",
            libm::exp(-3.2 / 1.5),
            0x3fbe52342617bbe6,
        ),
        (
            "softmax weight exp(-1.75), macOS differs",
            libm::exp(-1.75),
            0x3fc63e397e022072,
        ),
        (
            "Box-Muller log(0.123456789)",
            libm::log(0.123456789),
            0xc000bc233add5d72,
        ),
        (
            "Box-Muller log(0.00028999855000724995), macOS differs",
            libm::log(0.00028999855000724995),
            0xc0204a909f74bb9e,
        ),
        (
            "Box-Muller cos(TAU * 0.987654321)",
            libm::cos(TAU * 0.987654321),
            0x3fefe75dbd95e615,
        ),
        (
            "Box-Muller cos(TAU * 0.010124949375253123), macOS differs",
            libm::cos(TAU * 0.010124949375253123),
            0x3fefef6db9677d64,
        ),
        ("repair bias log(2.5)", libm::log(2.5), 0x3fed5240f0e0e078),
        ("sigmoid(0.37)", dynamics::sigmoid(0.37), 0x3fe2ed3b61296b65),
        ("sigmoid(-2.5)", dynamics::sigmoid(-2.5), 0x3fb36b7112534847),
        (
            "normal draw from stream (11, agent, 7)",
            rng::normal(&mut stream, 0.5, 0.15),
            0x3fe0c6e3bf8fc4e0,
        ),
    ];
    let wrong: Vec<String> = cases
        .iter()
        .filter(|(_, got, want)| got.to_bits() != *want)
        .map(|(what, got, want)| {
            format!(
                "{what}: got {:#018x} ({got:e}), want {want:#018x}",
                got.to_bits()
            )
        })
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
