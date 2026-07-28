# Recorded results

## Protocol

Vocadito's 40 solo-vocal excerpts are partitioned by singer before any model
selection. The development set has 33 tracks from 24 singers. The held-out set
has seven tracks from five unseen singers. Model choice and confidence
thresholds use development singers only; the selected configuration is then
evaluated once on the held-out singers.

The replacement is deliberately structural rather than a parameter fit:

- RMVPE estimates the continuous vocal pitch and Praat supports only
  low-confidence frames.
- GAME supplies singing-specific note boundaries.
- Continuous pitch inside those boundaries still drives meend and andolan
  rendering, while short GAME regions preserve murki notes and repeated
  articulations.

The five development acceptance metrics all improve by at least five absolute
percentage points:

| Development metric | Previous | Neural pipeline | Gain |
| --- | ---: | ---: | ---: |
| Raw pitch accuracy (50 cents) | 89.78% | 97.65% | +7.87 |
| Raw chroma accuracy | 92.74% | 97.76% | +5.02 |
| Overall accuracy | 88.35% | 93.41% | +5.06 |
| Note onset/pitch F1 | 37.03% | 71.02% | +33.99 |
| Note onset/offset/pitch F1 | 24.78% | 36.71% | +11.93 |

## Untouched holdout

These scores use the frozen development configuration on unseen singers:

| Held-out metric | Previous | Neural pipeline | Gain |
| --- | ---: | ---: | ---: |
| Raw pitch accuracy (50 cents) | 96.84% | 98.87% | +2.02 |
| Raw chroma accuracy | 97.15% | 98.87% | +1.72 |
| Overall accuracy | 94.40% | 94.85% | +0.45 |
| Note onset/pitch F1 | 48.19% | 70.53% | +22.34 |
| Note onset/offset/pitch F1 | 32.00% | 35.34% | +3.33 |

The pitch holdout starts near the metric ceiling, so five additional absolute
points are mathematically impossible for raw pitch and chroma accuracy. The
changes correspond to 64.1%, 60.5%, and 8.1% error reduction for raw pitch,
raw chroma, and overall accuracy respectively. The strict note score improves
10.4% relative.

## All tracks

This aggregate is for comparison and is not used to select the model:

| Metric | Previous | Neural pipeline | Gain |
| --- | ---: | ---: | ---: |
| Raw pitch accuracy (50 cents) | 91.15% | 97.89% | +6.73 |
| Raw chroma accuracy | 93.60% | 97.98% | +4.38 |
| Overall accuracy | 89.49% | 93.68% | +4.19 |
| Note onset/pitch F1 | 38.98% | 70.94% | +31.96 |
| Note onset/offset/pitch F1 | 26.04% | 36.48% | +10.44 |
| Voicing false alarm | 13.74% | 14.50% | -0.76 |

Voicing false alarm is the one known regression. An energy gate reduced it in
development experiments, but also removed correct quiet vocal frames and
failed the raw-chroma acceptance target, so it was not promoted. Vocadito's
second human annotation has 72.79% onset/pitch F1 and 61.90% strict F1 against
the first annotation, which provides context rather than a model ceiling.

## Independent VocalSet check

After freezing the Vocadito-selected model and parameters, the same GAME model
was run without tuning on Annotated VocalSet. The sample contains one scale and
one arpeggio for every one of its 20 male and female singers. Files are selected
by the lowest SHA-256 filename rank before loading note labels, and include
straight, breathy, belt, vibrato, lip-trill, fast, slow, loud, and quiet singing.

| 40-track VocalSet metric | Previous | Neural pipeline | Gain |
| --- | ---: | ---: | ---: |
| Note onset/pitch F1 | 12.70% | 17.15% | +4.45 |
| Note onset/offset/pitch F1 | 4.80% | 12.65% | +7.85 |

This is a cross-corpus generalization check, not another tuning set. It uses the
manually corrected `Sound` note regions from the release's fixed `extended 1`
annotation tree. The onset/pitch change is a 35.0% relative gain and 5.1% error
reduction even though its absolute change is under five points.
The exact sample ranks, per-track scores, aggregate counts, model fingerprint,
and frozen parameters are recorded in `vocalset-independent.json`.

The JSON files are the source of truth and retain configurations, metric
numerators, denominators, and model fingerprints.
