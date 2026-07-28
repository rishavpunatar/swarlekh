# Recorded results

## Vocadito baseline

The production Clean settings were evaluated on all 40 solo-vocal excerpts:

| Metric | Score |
| --- | ---: |
| Raw pitch accuracy (50 cents) | 91.2% |
| Raw chroma accuracy | 93.6% |
| Overall accuracy | 89.5% |
| Voicing recall | 96.3% |
| Voicing false alarm | 13.7% |
| Note onset/pitch F1 | 39.0% |
| Note onset/offset/pitch F1 | 26.0% |
| Human onset/pitch agreement | 72.8% |
| Human onset/offset/pitch agreement | 61.9% |

`vocadito-tuning.json` records the fixed singer-disjoint experiment. Parameter
selection uses only the development singers; the selected candidate is then
scored once on seven held-out tracks by five unseen singers.

| Held-out metric | Production | Tuned candidate |
| --- | ---: | ---: |
| Raw pitch accuracy | 96.8% | 96.8% |
| Voicing false alarm | 10.8% | 10.5% |
| Note onset/pitch F1 | 48.2% | 49.3% |
| Note onset/offset/pitch F1 | 32.0% | 32.7% |

The selected candidate changes `clarityThresh` from `0.50` to `0.55` and
`gateCentsPerSec` from `900` to `700`. It improves held-out Vocadito, but it is
not promoted to production yet: an Indian Saraga benchmark must first show that
the stricter plateau decision does not remove real murki notes.

The JSON files are the source of truth and retain metric numerators and
denominators so future changes can be compared on exactly the same corpus.
