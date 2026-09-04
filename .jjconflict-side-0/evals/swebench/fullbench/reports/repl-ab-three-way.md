# Three ledgers, one population

r94: `fullbench/rerun-r94/manifest.jsonl`
r95: `fullbench/rerun-r95/manifest.jsonl`
r95repl: `fullbench/rerun-r95repl/manifest.jsonl`

45 of 45 instances compared
Scored: 43 of 45 run. Excluded by name, for every arm and every column: psf__requests-1766, psf__requests-2317.

| | r94 | r95 | r95repl |
| --- | ---: | ---: | ---: |
| resolved | 34/43 | 31/43 | 34/43 |
| resolved (raw) | 36/45 | 33/45 | 36/45 |
| total cost | $24.96 | $24.98 | $20.37 |
| total cost (raw) | $25.31 | $26.61 | $21.14 |
| agent wall | 9981 s | 14232 s | 5168 s |
| instance wall | 11120 s | 15618 s | 5914 s |
| frames | 327 | 323 | 340 |

- recovered (2): django__django-14351, sphinx-doc__sphinx-7757
- still lost (2): django__django-13128, django__django-15732
- newly lost (0): —
- gained over r94 (2): django__django-11815, sympy__sympy-19495

## Excluded from the scoreboard, by name

These instances were run and graded; their verdicts are statements about the grading environment rather than about a harness, so they are outside every rate above. The exclusion applies to both arms equally, and the raw count is printed beside the scored one everywhere.

| instance | cause | reported in |
| --- | --- | --- |
| psf__requests-1766 | grading environment: the container has no https httpbin route, so `test_mixed_case_scheme_acceptable` cannot pass against the documented local fallback, and the public service was degraded when the re-grade appealed to it. The r92 patch is byte-identical to r90's and r91's, which graded resolved. Excluded for both arms. | `fullbench/reports/rerun-r92.md` |
| psf__requests-2317 | grading environment: same httpbin dependency. A re-grade against the public service refused 22 of 133 PASS_TO_PASS and 5 of 8 FAIL_TO_PASS, so no healthy environment existed to appeal to in either direction. Excluded for both arms. | `fullbench/reports/rerun-r92.md` |

## Per instance

| instance | r94 | r95 | r95repl | $ r94 | $ r95 | $ r95repl | Δ$ vs r94 | frames | agent s |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| astropy__astropy-14365 | unresolved | unresolved | unresolved | $0.49 | $0.26 | $0.24 | -0.25 | 4 → 4 → 6 | 187 → 172 → 48 |
| astropy__astropy-14369 | unresolved | unresolved | unresolved | $0.67 | $0.57 | $0.59 | -0.08 | 10 → 9 → 9 | 252 → 244 → 110 |
| astropy__astropy-7166 | resolved | resolved | resolved | $0.32 | $0.20 | $0.19 | -0.14 | 5 → 4 → 5 | 119 → 111 → 47 |
| astropy__astropy-8707 | resolved | resolved | resolved | $0.36 | $0.51 | $0.40 | +0.05 | 6 → 6 → 8 | 150 → 452 → 108 |
| django__django-10914 | resolved | resolved | resolved | $0.15 | $0.75 | $0.66 | +0.51 | 3 → 11 → 13 | 52 → 387 → 117 |
| django__django-11299 | resolved | resolved | resolved | $0.34 | $0.65 | $0.47 | +0.13 | 5 → 7 → 11 | 123 → 328 → 102 |
| django__django-11490 | resolved | resolved | resolved | $0.28 | $0.42 | $0.39 | +0.11 | 5 → 6 → 8 | 107 → 213 → 77 |
| django__django-11815 | unresolved | resolved | resolved | $0.45 | $0.35 | $0.41 | -0.04 | 6 → 5 → 3 | 172 → 260 → 157 |
| django__django-12273 | unresolved | unresolved | unresolved | $0.79 | $0.34 | $0.28 | -0.51 | 8 → 5 → 6 | 310 → 159 → 121 |
| django__django-12741 | resolved | resolved | resolved | $0.31 | $0.46 | $0.36 | +0.05 | 5 → 8 → 9 | 122 → 256 → 83 |
| django__django-13128 | resolved | unresolved | unresolved | $0.47 | $0.90 | $0.53 | +0.06 | 6 → 14 → 11 | 193 → 399 → 117 |
| django__django-13212 | unresolved | unresolved | unresolved | $0.74 | $0.92 | $0.40 | -0.34 | 9 → 12 → 9 | 333 → 473 → 71 |
| django__django-13343 | resolved | resolved | resolved | $0.20 | $0.22 | $0.24 | +0.04 | 3 → 3 → 5 | 58 → 104 → 66 |
| django__django-13346 | resolved | resolved | resolved | $0.86 | $0.44 | $0.85 | -0.01 | 10 → 6 → 12 | 312 → 192 → 160 |
| django__django-13406 | resolved | resolved | resolved | $0.29 | $0.82 | $0.34 | +0.05 | 4 → 10 → 8 | 105 → 409 → 74 |
| django__django-13821 | resolved | resolved | resolved | $1.94 | $0.50 | $0.36 | -1.58 | 24 → 7 → 8 | 803 → 249 → 72 |
| django__django-14351 | resolved | unresolved | resolved | $2.34 | $2.19 | $1.65 | -0.69 | 27 → 25 → 15 | 934 → 1075 → 232 |
| django__django-15380 | resolved | resolved | resolved | $1.30 | $0.40 | $0.50 | -0.80 | 17 → 8 → 12 | 490 → 209 → 81 |
| django__django-15569 | resolved | resolved | resolved | $0.23 | $0.39 | $0.28 | +0.05 | 4 → 7 → 6 | 77 → 235 → 84 |
| django__django-15732 | resolved | unresolved | unresolved | $0.46 | $0.38 | $0.69 | +0.23 | 7 → 6 → 12 | 188 → 207 → 145 |
| django__django-15987 | resolved | resolved | resolved | $0.17 | $0.17 | $0.32 | +0.15 | 3 → 3 → 3 | 61 → 111 → 106 |
| django__django-16612 | resolved | resolved | resolved | $0.17 | $0.18 | $0.16 | -0.00 | 3 → 3 → 1 | 55 → 123 → 92 |
| django__django-16662 | resolved | resolved | resolved | $0.15 | $0.36 | $0.27 | +0.12 | 3 → 5 → 7 | 53 → 267 → 76 |
| django__django-16899 | resolved | resolved | resolved | $0.48 | $0.36 | $0.39 | -0.09 | 6 → 5 → 9 | 198 → 284 → 114 |
| django__django-16901 | resolved | resolved | resolved | $0.28 | $0.23 | $0.70 | +0.42 | 6 → 4 → 5 | 95 → 134 → 276 |
| matplotlib__matplotlib-20826 | resolved | resolved | resolved | $0.26 | $0.29 | $0.91 | +0.66 | 4 → 4 → 14 | 78 → 189 → 134 |
| matplotlib__matplotlib-20859 | resolved | resolved | resolved | $0.13 | $0.16 | $0.21 | +0.08 | 2 → 2 → 6 | 38 → 76 → 63 |
| matplotlib__matplotlib-22865 | resolved | resolved | resolved | $0.36 | $0.16 | $0.18 | -0.19 | 5 → 2 → 5 | 151 → 101 → 62 |
| matplotlib__matplotlib-24970 | resolved | resolved | resolved | $0.51 | $0.22 | $0.30 | -0.21 | 6 → 3 → 6 | 225 → 103 → 87 |
| psf__requests-1766 **excluded** | resolved | resolved | resolved | $0.16 | $0.14 | $0.21 | +0.04 | 3 → 3 → 6 | 56 → 55 → 50 |
| psf__requests-2317 **excluded** | resolved | resolved | resolved | $0.19 | $1.49 | $0.57 | +0.38 | 3 → 16 → 12 | 61 → 1038 → 216 |
| pydata__xarray-7229 | unresolved | unresolved | unresolved | $0.44 | $0.84 | $0.72 | +0.28 | 6 → 9 → 11 | 129 → 538 → 161 |
| pydata__xarray-7233 | resolved | resolved | resolved | $0.20 | $0.18 | $0.22 | +0.02 | 4 → 4 → 6 | 67 → 87 → 57 |
| pydata__xarray-7393 | resolved | resolved | resolved | $0.60 | $0.70 | $0.55 | -0.05 | 8 → 7 → 9 | 222 → 549 → 97 |
| pytest-dev__pytest-6197 | resolved | resolved | resolved | $0.22 | $1.31 | $0.80 | +0.58 | 4 → 18 → 9 | 70 → 1154 → 211 |
| sphinx-doc__sphinx-11445 | resolved | resolved | resolved | $0.38 | $0.27 | $0.31 | -0.06 | 5 → 4 → 6 | 130 → 215 → 136 |
| sphinx-doc__sphinx-7590 | unresolved | unresolved | unresolved | $2.00 | $0.98 | $0.80 | -1.20 | 26 → 10 → 12 | 737 → 466 → 167 |
| sphinx-doc__sphinx-7757 | resolved | empty patch | resolved | $0.51 | $2.16 | $0.91 | +0.39 | 5 → 24 → 6 | 201 → 1177 → 250 |
| sphinx-doc__sphinx-8721 | resolved | resolved | resolved | $0.27 | $1.37 | $0.31 | +0.04 | 5 → 17 → 7 | 95 → 718 → 74 |
| sympy__sympy-13372 | resolved | resolved | resolved | $0.10 | $0.15 | $0.10 | -0.00 | 2 → 2 → 3 | 26 → 65 → 43 |
| sympy__sympy-13878 | resolved | resolved | resolved | $1.79 | $1.63 | $1.20 | -0.59 | 17 → 13 → 13 | 1102 → 956 → 649 |
| sympy__sympy-16450 | resolved | resolved | resolved | $0.24 | $0.14 | $0.19 | -0.05 | 3 → 2 → 4 | 86 → 46 → 59 |
| sympy__sympy-18763 | unresolved | unresolved | unresolved | $0.17 | $0.33 | $0.51 | +0.34 | 3 → 5 → 10 | 57 → 146 → 87 |
| sympy__sympy-19495 | unresolved | unresolved | resolved | $2.20 | $0.69 | $0.19 | -2.01 | 29 → 10 → 6 | 893 → 369 → 42 |
| sympy__sympy-20154 | resolved | resolved | resolved | $0.32 | $0.45 | $0.26 | -0.06 | 4 → 4 → 6 | 125 → 224 → 53 |

