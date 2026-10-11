from __future__ import annotations

import numpy as np
import pytest

from loveworld.analysis import estimate_effect


def _data(
    rng: np.random.Generator, n: int, diff: float, binary: bool = False
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    treated = np.zeros(2 * n, dtype=bool)
    treated[rng.permutation(2 * n)[:n]] = True
    if binary:
        p = np.where(treated, 0.3 + diff, 0.3)
        values = (rng.random(2 * n) < p).astype(float)
    else:
        values = rng.normal(0.0, 1.0, 2 * n) + np.where(treated, diff, 0.0)
    return values, np.ones(2 * n), treated


@pytest.mark.parametrize("sign", [1.0, -1.0])
def test_known_difference_is_recovered_in_both_directions(sign: float) -> None:
    rng = np.random.default_rng(1)
    num, den, treated = _data(rng, 400, 0.5 * sign)
    e = estimate_effect(num, den, treated, np.random.default_rng(2), n_boot=600, n_perm=600)
    assert e.n_control == 400 and e.n_treatment == 400
    assert e.ci_low <= 0.5 * sign <= e.ci_high
    assert (e.ci_low > 0.0) if sign > 0 else (e.ci_high < 0.0)
    assert e.p_permutation < 0.01
    assert abs(e.ate - (e.treatment_mean - e.control_mean)) < 1e-12


def test_null_difference_has_unremarkable_p() -> None:
    rng = np.random.default_rng(3)
    num, den, treated = _data(rng, 300, 0.0)
    e = estimate_effect(num, den, treated, np.random.default_rng(4), n_boot=400, n_perm=800)
    assert e.ci_low < 0.0 < e.ci_high
    assert e.p_permutation > 0.05


def test_all_ties_give_two_sided_p_of_one() -> None:
    num = np.full(40, 0.7)
    den = np.ones(40)
    treated = np.array([True] * 20 + [False] * 20)
    e = estimate_effect(num, den, treated, np.random.default_rng(0), n_boot=100, n_perm=200)
    assert e.ate == 0.0
    assert e.p_permutation == 1.0
    assert e.ci_low == 0.0 == e.ci_high


def test_binary_outcome_difference() -> None:
    rng = np.random.default_rng(5)
    num, den, treated = _data(rng, 500, 0.2, binary=True)
    e = estimate_effect(num, den, treated, np.random.default_rng(6), n_boot=400, n_perm=400)
    assert 0.1 < e.ate < 0.3
    assert e.ci_low > 0.0


def test_bootstrap_coverage_over_many_draws() -> None:
    covered = 0
    for i in range(100):
        rng = np.random.default_rng(100 + i)
        num, den, treated = _data(rng, 100, 0.3)
        e = estimate_effect(num, den, treated, np.random.default_rng(1000 + i), n_boot=300, n_perm=0)
        if e.ci_low <= 0.3 <= e.ci_high:
            covered += 1
    assert covered >= 90, covered


def test_ratio_of_sums_cluster_estimator() -> None:
    # Two clusters per arm with different sizes: the estimator pools sums, not cluster means.
    num = np.array([10.0, 1.0, 20.0, 2.0])
    den = np.array([10.0, 1.0, 10.0, 1.0])
    treated = np.array([False, False, True, True])
    e = estimate_effect(num, den, treated, np.random.default_rng(0), n_boot=50, n_perm=50)
    assert abs(e.control_mean - 1.0) < 1e-12
    assert abs(e.treatment_mean - 2.0) < 1e-12


def test_block_clusters_widen_inference_when_blocks_carry_the_effect() -> None:
    # 20 blocks of 10 couples; the whole outcome is a block-level shock, so couple-level
    # inference is overconfident and block-level inference is not.
    rng = np.random.default_rng(11)
    blocks = np.repeat(np.arange(20), 10)
    block_effect = rng.normal(0.0, 1.0, 20)
    treated_block = np.zeros(20, dtype=bool)
    treated_block[rng.permutation(20)[:10]] = True
    treated = treated_block[blocks]
    values = block_effect[blocks] + rng.normal(0.0, 0.05, 200)
    den = np.ones(200)
    naive = estimate_effect(values, den, treated, np.random.default_rng(1), n_boot=400, n_perm=400)
    blocked = estimate_effect(values, den, treated, np.random.default_rng(1), n_boot=400, n_perm=400, cluster=blocks)
    assert blocked.ate == pytest.approx(naive.ate)
    assert (blocked.ci_high - blocked.ci_low) > 2 * (naive.ci_high - naive.ci_low)
    assert blocked.p_permutation > naive.p_permutation
    assert blocked.n_control == 100 and blocked.n_treatment == 100


def test_cluster_spanning_both_arms_is_rejected() -> None:
    with pytest.raises(ValueError):
        estimate_effect(
            np.ones(4),
            np.ones(4),
            np.array([True, False, True, False]),
            np.random.default_rng(0),
            10,
            10,
            cluster=np.array([0, 0, 1, 1]),
        )


def test_bad_settings_are_rejected() -> None:
    num, den, treated = _data(np.random.default_rng(0), 10, 0.0)
    for bad in ({"ci_level": 0.0}, {"ci_level": 1.0}, {"n_boot": -1}, {"n_perm": -5}):
        kwargs = {"n_boot": 10, "n_perm": 10, "ci_level": 0.95, **bad}
        with pytest.raises(ValueError):
            estimate_effect(num, den, treated, np.random.default_rng(0), **kwargs)


def test_empty_denominator_yields_nan_not_crash() -> None:
    num = np.zeros(10)
    den = np.zeros(10)
    treated = np.array([True] * 5 + [False] * 5)
    e = estimate_effect(num, den, treated, np.random.default_rng(0), n_boot=20, n_perm=20)
    assert np.isnan(e.ate) and np.isnan(e.p_permutation)
