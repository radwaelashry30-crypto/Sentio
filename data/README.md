# Data Directory

Sentio is trained on the **"Emotions dataset for NLP"** (a widely-distributed
Twitter-emotion corpus, commonly mirrored on Kaggle -- e.g. under names such
as "Emotions dataset for NLP" / dair-ai's `emotion` dataset family), shipped
here as three semicolon-separated text files:

| File | Rows (raw) | Rows (after dedup) |
|------|-----------:|--------------------:|
| `train.txt` | 16,000 | 15,938 |
| `val.txt` | 2,000 | 1,996 |
| `test.txt` | 2,000 | 2,000 |

## Format

No header row. Each line is `<text>;<label>`:

```
i didnt feel humiliated;sadness
im grabbing a minute to post i feel greedy wrong;anger
i am feeling grouchy;anger
```

## Label set

Six emotion classes (alphabetical order, matching `sklearn.preprocessing.LabelEncoder`'s
default sort -- this is the canonical class-index order used throughout
`src/`, `train.py`, `evaluate.py`, and `inference.py`):

```
0 = anger
1 = fear
2 = joy
3 = love
4 = sadness
5 = surprise
```

`joy` and `sadness` are the majority classes; `surprise` is by far the
smallest (about 9.5x rarer than `joy` in the training split) -- this is why
the notebook explores both class-weighting and synthetic augmentation. Exact
post-dedup counts (`src.preprocessing.drop_duplicates` applied to the shipped
files):

| Label | train | val | test |
|---|---:|---:|---:|
| joy | 5,344 | 703 | 695 |
| sadness | 4,662 | 550 | 581 |
| anger | 2,152 | 274 | 275 |
| fear | 1,926 | 211 | 224 |
| love | 1,289 | 177 | 159 |
| surprise | 565 | 81 | 66 |
| **total** | **15,938** | **1,996** | **2,000** |

## Why these files ARE checked into Git

Unlike TruthLens's ISOT CSVs (~98 MB combined), this dataset is small
(~2 MB combined across all three splits), so it is versioned directly rather
than gitignored -- no separate download step is required to run `train.py`,
`evaluate.py`, or the notebook.

## Deduplication

`train.txt` contains one fully-duplicate row and several texts that repeat
with either the same or a different label; `val.txt` contains a few
label-duplicated texts too. `src/preprocessing.drop_duplicates` reproduces
the notebook's exact two-stage removal (drop exact-duplicate rows, then drop
**every** row whose text is duplicated within its split, regardless of label
agreement) before any further cleaning or model training -- see that
function's docstring for the full explanation of a minor mismatch between
the notebook's own markdown ("duplicates with conflicting labels") and what
its code actually does (drops same-label duplicates too).

## Language

The notebook runs a three-way majority-voted language-detection pass
(`langdetect` + `langid` + fastText `lid.176.bin`) over every split, but
concludes after manual inspection that non-English votes were mostly
misclassified English tweets, and **drops no rows** as a result. This step
is preserved in `src/preprocessing.add_language_columns` for documentation
purposes only; it is not called by `train.py` / `evaluate.py` / `inference.py`.
`lid.176.bin` itself (~131 MB, a well-known public fastText model) is not
shipped in this repo -- download it from
`https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin` if
you want to re-run that section of the notebook.

## Dataset source

Commonly distributed as "Emotions dataset for NLP" on Kaggle. Confirm the
redistribution terms of your specific mirror before republishing these files
elsewhere.
