"""Beat-grid reconciliation for tempo, sam, and Hindustani taal candidates."""

from __future__ import annotations

import numpy as np


TAALS = {
    16: ("Teentaal", None),
    14: ("Deepchandi", "Dhamar/Jhoomra"),
    12: ("Ektaal", "Chautaal"),
    10: ("Jhaptaal", None),
    8: ("Keherwa", "Bhajani theka"),
    7: ("Rupak", None),
    6: ("Dadra", None),
}


def _finite_times(values):
    times = np.asarray(values, dtype=float).reshape(-1)
    return np.sort(times[np.isfinite(times)])


def _match_events_to_grid(grid, events):
    """Return unique grid indices and model times that land near those indices."""
    grid = _finite_times(grid)
    events = _finite_times(events)
    if len(grid) < 2 or not len(events):
        return np.array([], dtype=int), np.array([], dtype=float)

    interval = float(np.median(np.diff(grid)))
    tolerance = float(np.clip(0.35 * interval, 0.07, 0.16))
    right = np.searchsorted(grid, events)
    right = np.clip(right, 1, len(grid) - 1)
    left = right - 1
    choose_right = np.abs(grid[right] - events) < np.abs(grid[left] - events)
    indices = np.where(choose_right, right, left)
    residual = np.abs(grid[indices] - events)
    indices = indices[residual <= tolerance]
    events = events[residual <= tolerance]

    # Models occasionally emit two close events around one beat. Keep the one
    # nearest the accompaniment grid so those duplicates cannot invent a meter.
    unique_indices = []
    unique_events = []
    for index in np.unique(indices):
        positions = np.flatnonzero(indices == index)
        best = positions[np.argmin(np.abs(events[positions] - grid[index]))]
        unique_indices.append(int(index))
        unique_events.append(float(events[best]))
    return np.asarray(unique_indices, dtype=int), np.asarray(unique_events)


def _felt_tempo(grid, matra_bpm, model_beats):
    indices, times = _match_events_to_grid(grid, model_beats)
    if len(indices) < 8:
        return float(matra_bpm), 1, None

    index_gaps = np.diff(indices)
    close = index_gaps[(index_gaps >= 1) & (index_gaps <= 4)]
    if not len(close):
        return float(matra_bpm), 1, None
    counts = np.bincount(close, minlength=5)
    subdivision = int(np.argmax(counts[1:]) + 1)
    support = counts[subdivision] / max(int(counts[1:].sum()), 1)
    if support < 0.45:
        subdivision = 1

    event_gaps = np.diff(times)
    matching = index_gaps == subdivision
    rates = 60.0 / event_gaps[matching]
    rates = rates[np.isfinite(rates) & (rates >= 35.0) & (rates <= 210.0)]
    if len(rates) < 4:
        bpm = float(matra_bpm) / subdivision
        return bpm, subdivision, None

    median = float(np.median(rates))
    central = rates[(rates >= 0.8 * median) & (rates <= 1.2 * median)]
    if len(central):
        median = float(np.median(central))
    tempo_range = None
    if len(central) >= 8:
        lo, hi = np.percentile(central, [25, 75])
        tempo_range = [round(float(lo), 1), round(float(hi), 1)]
    return median, subdivision, tempo_range


def _cycle_score(index_gaps, cycle):
    usable = index_gaps[
        (index_gaps >= min(TAALS)) &
        (index_gaps <= 3 * max(TAALS))
    ]
    if not len(usable):
        return 0.0, 0
    exact = int(np.count_nonzero(index_gaps == cycle))
    multiples = sum(
        int(np.count_nonzero(index_gaps == multiple * cycle))
        for multiple in (2, 3)
    )
    near = sum(
        int(np.count_nonzero(np.abs(index_gaps - multiple * cycle) == 1))
        for multiple in (1, 2, 3)
    )
    score = (exact + 0.6 * multiples + 0.1 * near) / len(usable)
    return float(score), exact


def _sam_indices(indices, cycle, grid_length):
    """Build a clean local sam grid only where one phase clearly dominates."""
    sam = []
    window = 8 * cycle
    for start in range(0, grid_length, window):
        end = min(grid_length, start + window)
        local = indices[(indices >= start) & (indices < end)]
        if len(local) < 4:
            continue
        histogram = np.bincount(local % cycle, minlength=cycle)
        phase = int(np.argmax(histogram))
        concentration = histogram[phase] / len(local)
        if histogram[phase] < 3 or concentration < 0.45:
            continue
        first = start + ((phase - start) % cycle)
        sam.extend(range(first, end, cycle))
    return sam


def summarize_neural_rhythm(fine_beats, fine_bpm, model_beats, model_downbeats):
    """Reconcile fine accompaniment ticks with learned beats and downbeats.

    ``fine_beats`` follows audible percussion subdivisions and is ideal for the
    contour ruler. The learned model supplies the slower felt pulse plus
    downbeat evidence. Matching both on one grid resolves half/double-tempo
    ambiguity and turns repeated downbeat distances into taal-cycle evidence.
    """
    grid = _finite_times(fine_beats)
    if len(grid) < 16:
        return None

    bpm, subdivision, tempo_range = _felt_tempo(
        grid,
        fine_bpm,
        model_beats,
    )
    downbeat_indices, _ = _match_events_to_grid(grid, model_downbeats)
    index_gaps = np.diff(downbeat_indices)

    scored = {
        cycle: _cycle_score(index_gaps, cycle)
        for cycle in TAALS
    }
    cycle = max(scored, key=lambda value: scored[value][0])
    score, exact = scored[cycle]
    if score < 0.32 or exact < 4:
        cycle = None

    result = {
        "bpm": round(float(bpm), 1),
        "matraBpm": round(float(bpm * subdivision), 1),
        "pulseSubdivision": int(subdivision),
        "tempoRange": tempo_range,
        "cycle": None,
        "taal": None,
        "alt": None,
        "conf": None,
        "sam": None,
        "cycleConfidence": round(float(score), 3),
        "beatSource": "beat-this-small0",
    }
    if cycle is None:
        return result

    sam_indices = _sam_indices(downbeat_indices, cycle, len(grid))
    name, alternative = TAALS[cycle]
    result.update(
        cycle=int(cycle),
        taal=name,
        alt=alternative,
        conf="likely" if score >= 0.55 else "possibly",
        sam=[round(float(grid[index]), 3) for index in sam_indices],
    )
    return result
