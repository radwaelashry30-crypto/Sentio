# Sentio

**Understand the feeling behind every word.**

A PyTorch + scikit-learn + Hugging Face pipeline for classifying English text into
one of **six emotions** -- anger, fear, joy, love, sadness, surprise -- spanning
four model families: classical TF-IDF baselines (Logistic Regression, Decision
Tree, Random Forest, SVM), a custom BPE-tokenizer + self-attention PyTorch
network, a GloVe-embedding BiLSTM, and a fine-tuned BERT transformer.

This project was developed internally under the working title **"ReviewSense
AI"** (see [`ReviewSense_AI_Report.docx`](ReviewSense_AI_Report.docx), the
original written report) before shipping as **Sentio**.

**Product / live demo:** [sentio-chi.vercel.app](https://sentio-chi.vercel.app)
-- the deployed marketing/sign-up site for this project, reporting "93.5%
accuracy" across the same six emotions on a fine-tuned BERT backbone. That
number lines up closely with what this repo independently verifies below: the
notebook's own BERT run logged **93.44% validation accuracy** at its
best checkpoint (rounds to ~93.5%) and **92.75% test accuracy** (see
[Results](#results) and `results/bert_trainer_state_checkpoint-1994.json`).
This README states the product page's number as *the product's own claim*
and separately reports what was verified from the notebook -- it does not
assume they are computed on identical splits.

**Serving layer:** [`backend/`](backend/) is the FastAPI service the live
demo calls (`POST /predict`), merged into this repository from a
previously separate `sentio-api` repo. **It currently serves an untrained
classification head, not the fine-tuned checkpoint reported below** --
see [`backend/README.md`](backend/README.md#known-issue-served-weights-are-not-the-fine-tuned-checkpoint)
for why and how to fix it.

---

## Project Overview

Sentio scores the emotional tone of a piece of text (originally built and
benchmarked on a Twitter-style short-text corpus) using four increasingly
sophisticated approaches, developed and benchmarked side-by-side in the
research notebook under [`notebooks/`](notebooks/):

1. **Classical ML on TF-IDF features** -- Logistic Regression, Decision Tree,
   Random Forest, and Linear SVM, each tuned with `GridSearchCV`.
2. **A custom Attention neural network** -- a from-scratch BPE tokenizer
   feeding an Embedding -> Multi-Head Self-Attention -> Dense classifier,
   tuned with a random hyperparameter search.
3. **GloVe + BiLSTM** -- frozen pretrained `glove-wiki-gigaword-200` word
   vectors feeding three stacked bidirectional LSTM layers.
4. **Fine-tuned BERT** -- `bert-base-uncased` fine-tuned end-to-end for 3
   epochs; the notebook's own best-performing model.

## Problem Statement

Understanding the emotion behind a piece of text -- not just its polarity
(positive/negative), but which specific feeling it expresses -- is useful for
content moderation triage, customer-feedback analysis, and research
applications. Sentio explores the full spectrum of NLP techniques, from
sparse bag-of-words features to a fully fine-tuned transformer, to compare
how much each additional layer of modeling sophistication actually buys on a
compact, imbalanced, six-class emotion corpus.

## Dataset

The **"Emotions dataset for NLP"** (a widely-mirrored Twitter-emotion corpus,
commonly distributed on Kaggle), shipped directly in [`data/`](data/) as
three semicolon-separated `text;label` files (see [`data/README.md`](data/README.md)
for the full format spec):

| Split | Raw rows | After dedup |
|-------|---------:|-------------:|
| `train.txt` | 16,000 | 15,938 |
| `val.txt` | 2,000 | 1,996 |
| `test.txt` | 2,000 | 2,000 |

### Class distribution (post-dedup, verified against the shipped files)

| Label | train | val | test |
|---|---:|---:|---:|
| joy | 5,344 | 703 | 695 |
| sadness | 4,662 | 550 | 581 |
| anger | 2,152 | 274 | 275 |
| fear | 1,926 | 211 | 224 |
| love | 1,289 | 177 | 159 |
| surprise | 565 | 81 | 66 |
| **total** | **15,938** | **1,996** | **2,000** |

`joy` and `sadness` dominate; `surprise` is ~9.5x rarer than `joy` in
training, which is why the notebook explores both class-weighted loss and
synthetic (WordNet-synonym) augmentation as imbalance mitigations (see
[Preprocessing Pipeline](#preprocessing-pipeline) below).

### Label mapping

```
0 = anger   1 = fear   2 = joy   3 = love   4 = sadness   5 = surprise
```

(alphabetical order, matching `sklearn.preprocessing.LabelEncoder`'s default sort.)

## Preprocessing Pipeline

1. **Load** `train.txt` / `val.txt` / `test.txt` (semicolon-separated,
   no header).
2. **Deduplicate.** Drop every row whose `text` is duplicated within its
   split, *regardless of whether the label agrees* (`duplicated(keep=False)`
   on `val`, then `train`, then `test`) -- see
   [`src/preprocessing.drop_duplicates`](src/preprocessing.py) for the exact,
   verified-faithful reproduction (15,938 / 1,996 / 2,000 rows survive).
3. **Missing-value check.** Both columns are already fully populated in every
   split -- no rows are dropped for missingness.
4. **Text cleaning** -- a configurable `clean_text(...)` toggling lowercasing,
   mention/hashtag/URL/number/punctuation removal, stopword removal, and
   lemmatization, applied with a *different preset per downstream model*:
   heavy cleaning (stopwords + lemmatize) for TF-IDF, light cleaning for
   BPE/Attention-NN, and cleaning tuned for GloVe/BERT vocabulary coverage.
   **See [Notebook Fidelity Notes](#notebook-fidelity-notes) below -- the
   notebook actually defines `clean_text` twice with materially different
   behavior, and the second definition silently governs BPE/GloVe/BERT
   preprocessing.**
5. **Language detection and voting** (`langdetect` + `langid` + fastText
   `lid.176.bin`, majority vote, English wins on any single "en" vote) is run
   and reported, but **drops nothing** -- manual inspection in the notebook
   concluded most non-English votes were misclassified English tweets. Kept
   here for documentation only (`src/preprocessing.add_language_columns`).
6. **Class balancing via augmentation** (TF-IDF and Attention-NN paths only,
   `--use-augmentation` in `train.py`): every minority class is upsampled to
   the size of `joy` using WordNet-synonym substitution
   (`nlpaug.augmenter.word.SynonymAug`).

## Models Evaluated

### 1. Classical Baselines (TF-IDF, `max_features=10,000`, `ngram_range=(1,2)`)
- Logistic Regression, Decision Tree, Random Forest, Linear SVM -- each tuned
  with 3-fold `GridSearchCV` (`scoring='f1_weighted'`).

### 2. Attention Neural Network (custom BPE tokenizer)
```
BPE Tokenizer (vocab_size=10,000, maxlen=32)
        |
Embedding(vocab_size -> embedding_dim)
        |
Dropout(embedding_dropout)
        |
Multi-Head Self-Attention(embed_dim, num_heads)  [+ residual via LayerNorm]
        |
LayerNorm
        |
Linear(embed_dim -> dense_units_1) -> ReLU -> Dropout(dense_dropout)
        |
Linear(dense_units_1 -> dense_units_2) -> ReLU
        |
GlobalAveragePooling1D (mean over sequence)
        |
Linear(dense_units_2 -> 6)  [raw logits]
```
Selected by a 5-trial random hyperparameter search (`src/models.AttentionSentimentClassifier`,
best config: `embedding_dim=256, num_heads=16, dense_units_1=512,
dense_units_2=128, embedding_dropout=0.4, dense_dropout=0.4, lr=1e-4`,
3,021,702 trainable parameters). Shipped as `models/best_model_nn.pt`.

### 3. GloVe + BiLSTM
```
Word-level Tokenizer (vocab_size=15,199, maxlen=32)
        |
Frozen Embedding(15,199 -> 200)  [glove-wiki-gigaword-200; 93.4% vocab coverage]
        |
BiLSTM(200 -> 256x2) -> Dropout(0.2)
        |
BiLSTM(512 -> 128x2) -> Dropout(0.2)
        |
BiLSTM(256 -> 128x2) -> Dropout(0.2)  [final hidden state, fwd+bwd concat]
        |
Linear(256 -> 6)  [raw logits]
```
`src/models.GloveBiLSTMClassifier`, 1,992,198 trainable parameters (plus a
frozen ~3.04M-parameter embedding table saved alongside them). Shipped as
`models/model_glove.pt`. **This is the strongest model whose full weights
ship in this repository** -- see [Models Not Shipped](#models-not-shipped-in-this-repository).

### 4. Fine-tuned BERT
`bert-base-uncased` (`transformers.BertForSequenceClassification`, 6-way
classification head), fine-tuned for 3 epochs, batch size 16, learning rate
2e-5, `max_length=128`, best checkpoint selected by `eval_loss`. **The
notebook's own best-performing model overall.** Weights are *not* shipped in
this repository -- see below.

## Results

All figures below are taken directly from the notebook's own printed cell
outputs (parsed from the `.ipynb` JSON, not re-derived or estimated) or from
`results/bert_trainer_state_checkpoint-*.json` (the HuggingFace `Trainer`'s
own logged metrics, copied verbatim from the notebook's `results/checkpoint-*/`
directories).

### Classic ML (TF-IDF, validation set, non-augmented)

| Model | Best params | Best CV F1 (weighted) | Val Accuracy | Val F1 (weighted) | Shipped? |
|---|---|---:|---:|---:|---|
| Logistic Regression | `C=10, class_weight=balanced, max_iter=100` | 0.8999 | 0.9073 | 0.9080 | **No** -- see [Notebook Fidelity Notes](#notebook-fidelity-notes) |
| Decision Tree | `max_depth=None, min_samples_split=10, min_samples_leaf=1` | 0.8724 | 0.8818 | 0.8822 | `artifacts/dt_best.pkl` |
| Random Forest | `n_estimators=200, max_depth=None, min_samples_split=2, min_samples_leaf=1` | 0.8890 | 0.8993 | 0.8992 | **No** -- 167 MB, excluded |
| Linear SVM | `C=1, class_weight=balanced, max_iter=1000` | 0.9052 | 0.9063 | 0.9068 | `artifacts/svc_grid_best.pkl` |

### Neural models (test set)

| Model | Accuracy | Precision (macro) | Recall (macro) | F1 (macro) | MCC | ROC-AUC (OvR) | PR-AUC | Shipped? |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Attention NN (class-weighted) | 0.8590 | 0.7968 | 0.8691 | 0.8225 | 0.8184 | 0.9857 | 0.9132 | `models/best_model_nn.pt` |
| Attention NN (augmented) | 0.7080 | 0.6989 | 0.7641 | 0.7198 | 0.6200 | 0.9304 | 0.7976 | **No** -- see [Notebook Fidelity Notes](#notebook-fidelity-notes) |
| GloVe + BiLSTM | 0.9060 | 0.8437 | 0.9060 | 0.8674 | 0.8785 | 0.9936 | 0.9526 | `models/model_glove.pt` |
| **BERT (fine-tuned)** | **0.9275** | 0.8940 | 0.8797 | 0.8838 | 0.9040 | 0.9934 | 0.9609 | Config only -- weights excluded (418 MB) |

The Attention NN's *augmented* variant scoring markedly worse than its
class-weighted counterpart (70.8% vs 85.9% accuracy) is a genuine, notebook-reported
result, not a copy error -- it ran for only 3 search trials x 5 epochs
(vs. 5 trials x up to 50 epochs for the class-weighted run) and optimized for
`val_accuracy` rather than `val_loss`, so it is not a fully comparable/tuned run.

### BERT fine-tuning, epoch by epoch (from `results/bert_trainer_state_checkpoint-2991.json`)

| Epoch | Step | eval_loss | eval_accuracy | eval_f1 (macro) | eval_precision | eval_recall | eval_roc_auc |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 997 | 0.2058 | 0.9299 | 0.8992 | 0.9161 | 0.8871 | 0.9941 |
| 2 (**best**, by `eval_loss`) | 1994 | **0.1757** | **0.9344** | 0.9099 | 0.9175 | 0.9076 | 0.9964 |
| 3 | 2991 | 0.1774 | 0.9349 | 0.9072 | 0.9117 | 0.9047 | 0.9955 |

`load_best_model_at_end=True` restores checkpoint-1994 (epoch 2, lowest
`eval_loss`) as the model actually evaluated on the **test** set, which is
where the headline 92.75% test accuracy comes from (`trainer.evaluate(tokenized_test)`,
matching the `compute_full_metrics` table above).

### Grand comparison (all 8 models, sorted by accuracy)

| Model | Family | Accuracy | F1 |
|---|---|---:|---:|
| BERT (fine-tuned) | Transformer | 0.9275 | 0.8838 (macro) |
| GloVe + BiLSTM | Deep Learning | 0.9060 | 0.8674 (macro) |
| Attention NN (class-weighted) | Deep Learning | 0.8590 | 0.8225 (macro) |
| Logistic Regression | Classic ML (TF-IDF) | 0.9073† | 0.9080† (weighted) |
| Linear SVM | Classic ML (TF-IDF) | 0.9063† | 0.9068† (weighted) |
| Random Forest | Classic ML (TF-IDF) | 0.8993† | 0.8992† (weighted) |
| Decision Tree | Classic ML (TF-IDF) | 0.8818† | 0.8822† (weighted) |
| Attention NN (augmented) | Deep Learning | 0.7080 | 0.7198 (macro) |

† Classic ML figures are **validation**-set scores (weighted F1); the deep
models are **test**-set scores (macro F1) -- the notebook itself evaluates
the two tracks on different splits (see its own "Grand Comparison" section),
so treat the classic-ML row as directionally comparable, not a strictly
apples-to-apples ranking against the neural rows.

## Notebook Fidelity Notes

In the same spirit as an honest data/leakage audit: several real
discrepancies between what the notebook's markdown *describes* and what its
*code actually executes* were found and verified while porting this project.
None are papered over -- the faithful (bug-preserving) behavior is what ships
in `src/`, with the actual bug documented in code and here.

1. **`clean_text` is defined twice, and the second definition silently wins.**
   Cell 48 ("Text Preprocessing Function") defines a `clean_text(...)` with a
   working URL regex and an `is_only_mentions` short-circuit; this is the
   version in effect when the TF-IDF cleaning column was computed. Cell 88
   (inside the "Logistic Regression" sub-section, *after* TF-IDF training)
   defines a **second** `clean_text(...)` under the same name, which (a) has
   no `is_only_mentions` check at all -- the parameter is accepted but never
   read -- and (b) has a broken URL regex, `r'https?://\s+|www\.\s+'`
   (`\s+` instead of `\S+`), which essentially never matches a real URL.
   Every `clean_text(...)` call *after* cell 88 -- i.e. all of BPE/Attention-NN,
   GloVe, and BERT preprocessing -- silently uses this second, buggier
   version, even though each section's own markdown promises the same
   mention/hashtag/URL-stripping behavior as the first. **Verified
   empirically**: `test_clean_text_neural_url_bug_is_preserved` in
   `tests/test_inference.py` confirms a URL survives cleaning even with
   `remove_urls=True`. Reproduced faithfully as `clean_text_tfidf` (v1) and
   `clean_text_neural` (v2, bug preserved) in `src/preprocessing.py`.

2. **`balance_with_augmentation` is also defined twice.** The first version
   (contextual DistilBERT word-substitution via `nlpaug`'s
   `ContextualWordEmbsAug`) is immediately shadowed by a second version
   (WordNet-synonym substitution via `SynonymAug`) a few cells later, before
   the function is ever called. Only the synonym-based version is reproduced
   in `src/preprocessing.balance_with_augmentation`; the contextual version
   is dead code in the notebook and is not ported.

3. **The augmented Attention-NN checkpoint was never actually saved --
   variable-name bug.** The notebook trains a second Attention-NN on the
   augmented data and assigns the result to `best_model_nn2` (cell 146), but
   the "save everything" cell later checks for a *different* variable name,
   `best_model2_nn` (`"model2_nn"` vs. `"model_nn2"`), which was never
   defined. `torch.save(best_model2_nn.state_dict(), 'best_model2_nn.pt')`
   therefore silently never runs. Its BPE tokenizer (`my_bpe_tokenizer_aug.json`)
   *does* get saved (a different, correctly-named variable,
   `tokenizer2_BPE`), so this repo ships a tokenizer with no corresponding
   model checkpoint -- included for completeness (`artifacts/my_bpe_tokenizer_aug.json`),
   but there is no `best_model_nn2.pt` to pair it with. `train.py --model
   attention_nn --use-augmentation` reproduces the training run and would
   save the checkpoint the notebook's own bug prevented.

4. **Logistic Regression is trained and evaluated but never persisted.** The
   "save everything" cell's `models_to_save` dict lists
   `rf_grid_best.pkl`, `dt_best.pkl`, `svc_grid_best.pkl`, plus four more
   names (`log_best2.pkl`, `dt_best2.pkl`, `rf_best2.pkl`, `svc_best2.pkl`)
   that were never assigned by any executed cell (skipped with "Variable is
   not defined") -- but critically, `log_best` (the actual, trained,
   evaluated Logistic Regression model) is not in the dict under *any* name.
   It is one of "the four" classic baselines the notebook compares, with
   real reported metrics (see the results table above), but no `.pkl` for it
   exists anywhere in the source artifact set. Not shippable; retrain via
   `train.py --model logreg` if you need the checkpoint.

5. **The GloVe path's word-level vocabulary was never persisted, either --
   overwritten by a name collision.** `WordLevelTokenizer` is assigned to
   the global name `tokenizer` in the GloVe section (cell 160). A later cell
   (BERT section, cell 187) reassigns the same global name,
   `tokenizer = BertTokenizer.from_pretrained('bert-base-uncased')`. By the
   time the "save everything" cell checks `if 'tokenizer' in globals():
   tokenizer.save_pretrained('model_bert_tokenizer')`, `tokenizer` now
   refers to the BERT tokenizer, and the GloVe vocabulary is gone --
   `models/model_glove.pt` ships the trained embedding weights, but no
   `word_index` mapping. `WordLevelTokenizer.fit_on_texts` is deterministic
   given the same input order, so `evaluate.py --model glove_bilstm` and
   `inference.py --model glove_bilstm` both **recover the exact original
   mapping** by refitting on `data/train.txt` at load time (cheap -- no
   training involved) rather than silently failing; see the docstrings on
   `evaluate.evaluate_glove_bilstm` / `inference._fit_glove_tokenizer`.

6. **The notebook prints a dedup finding it never acts on via the API that
   implies.** `train_df.duplicated().sum()` reports exactly 1 fully-identical
   row, and the notebook displays it -- but never calls `.drop_duplicates()`.
   The only removal that happens is `duplicated(keep=False)` on `text` alone
   (val, then train, then test), which happens to also remove that one exact
   duplicate (a row is trivially "duplicated" with itself). Verified against
   the shipped files: this produces exactly the notebook's own reported
   shapes (15,938 / 1,996 / 2,000); adding an explicit `.drop_duplicates()`
   pre-pass changes the train count by +1 and does **not** match. See
   `src/preprocessing.drop_duplicates`'s docstring and
   `test_drop_duplicates_matches_notebook_reported_shapes`.

7. **`model_bert/config.json`'s `id2label`/`label2id` are placeholders,
   not emotion names.** `model_bert.save_pretrained('model_bert')` runs in
   the "save everything" cell *before* the later ONNX-export cell, which is
   the one that actually sets `model_bert.config.id2label = {...}` with real
   emotion names. The shipped `config.json` therefore has generic
   `LABEL_0`..`LABEL_5`, not `anger`..`surprise`. This repo's own code never
   relies on `config.json` for label names (`SENTIMENT_LABELS` in
   `src/preprocessing.py` is the source of truth throughout `train.py` /
   `evaluate.py` / `inference.py`), but anyone inspecting `config.json`
   directly should be aware of the gap.

8. **`artifacts/model_bert_tokenizer/` cannot be loaded with the slow
   `BertTokenizer` class.** Only `tokenizer.json` + `tokenizer_config.json`
   were saved (no `vocab.txt`); `transformers.BertTokenizer.from_pretrained(...)`
   requires `vocab.txt` and raises a `TypeError` trying to load this
   directory. `AutoTokenizer` / `BertTokenizerFast` load it correctly (fast
   tokenizers read directly from `tokenizer.json`). `evaluate.py` and
   `inference.py` both use `AutoTokenizer` for this reason -- verified while
   building this repo (`python -c "from transformers import BertTokenizer;
   BertTokenizer.from_pretrained('artifacts/model_bert_tokenizer')"` fails;
   the `AutoTokenizer` equivalent succeeds).

9. **A `tokenizers`/`transformers` version conflict, verified empirically.**
   `artifacts/my_bpe_tokenizer.json` / `my_bpe_tokenizer_aug.json` were
   serialized by a `tokenizers` release new enough to store BPE merges as
   `[a, b]` pairs; `tokenizers==0.19.x` (the version `transformers==4.40.x`
   pins to) expects the older `"a b"` string format and fails with
   `Exception: data did not match any variant of untagged enum ModelWrapper`.
   `requirements.txt` pins `tokenizers>=0.20` and `transformers>=4.45`
   accordingly (verified: both import cleanly together and load every
   shipped artifact).

10. **The notebook's ONNX-export cell was never persisted to disk.** The
    final section exports the fine-tuned BERT model to `onnx_model/` and
    verifies it against the PyTorch model, but no `onnx_model/` directory
    exists anywhere in the source artifact set -- it is not shipped here
    either. The export code itself is preserved as-is in `notebooks/` for
    reference; `onnx` / `onnxruntime` are listed as optional dependencies in
    `requirements.txt` if you want to re-run it.

## Models Not Shipped in This Repository

Three artifacts exceed practical Git/GitHub size limits and are excluded via
`.gitignore` (never committed, not merely deleted after the fact -- see
[Reproducibility](#reproducibility)):

| Artifact | Size | Why excluded | How to get it |
|---|---:|---|---|
| `artifacts/rf_grid_best.pkl` | ~167 MB | Exceeds GitHub's 100 MB/file hard limit | `python train.py --model random_forest` |
| `models/model_bert/model.safetensors` | ~418 MB | Exceeds GitHub's 100 MB/file hard limit | `python train.py --model bert`, or host via Git LFS / the Hugging Face Hub and download separately |
| `results/checkpoint-*/` (3 HF Trainer checkpoints) | ~3.7 GB total | Full optimizer/scheduler/model state per epoch, far beyond any reasonable repo size | Re-run BERT training; only the small `trainer_state.json` per checkpoint is kept, copied to `results/bert_trainer_state_checkpoint-*.json` |
| `lid.176.bin` (fastText language-ID model) | ~131 MB | A well-known public third-party file, not this project's own artifact | `https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin` |

`models/model_bert/config.json` (architecture + hyperparameters, ~1 KB) *is*
shipped on its own, since it is small and useful as a reference even without
the weights.

## Project Structure

```
Sentio/
├── README.md
├── requirements.txt
├── .gitignore
├── train.py                       # CLI: --model {logreg,decision_tree,random_forest,svm,attention_nn,glove_bilstm,bert}
├── evaluate.py                    # CLI: evaluate a saved checkpoint against data/test.txt
├── inference.py                   # CLI: --text "..." -> predicted emotion + confidence
├── src/
│   ├── __init__.py
│   ├── preprocessing.py           # load/dedup/clean_text (both versions)/augmentation/lang-ID
│   ├── tokenizer.py                # WordLevelTokenizer (GloVe) + BPE training/loading (Attention-NN)
│   ├── models.py                   # AttentionSentimentClassifier, GloveBiLSTMClassifier
│   └── utils.py                     # SequenceDataset, train_torch_classifier, metrics, seeding
├── models/
│   ├── best_model_nn.pt            # Attention NN (class-weighted), 12 MB
│   ├── model_glove.pt              # GloVe + BiLSTM, 20 MB -- strongest fully-shipped model
│   └── model_bert/
│       └── config.json             # BERT architecture/config only -- weights excluded, see above
├── artifacts/
│   ├── dt_best.pkl                 # Decision Tree (TF-IDF)
│   ├── svc_grid_best.pkl           # Linear SVM (TF-IDF)
│   ├── my_bpe_tokenizer.json       # BPE vocab for models/best_model_nn.pt
│   ├── my_bpe_tokenizer_aug.json   # BPE vocab for the augmented NN run -- no matching checkpoint, see Notebook Fidelity Notes #3
│   └── model_bert_tokenizer/       # tokenizer.json + tokenizer_config.json (load with AutoTokenizer, not BertTokenizer)
├── notebooks/
│   └── tf-idf-to-transformers-94-sentiment-accuracy-PYTORCH-VISUALIZED.ipynb
├── results/
│   ├── bert_trainer_state_checkpoint-997.json    # epoch 1 eval log
│   ├── bert_trainer_state_checkpoint-1994.json   # epoch 2 eval log (best, by eval_loss)
│   └── bert_trainer_state_checkpoint-2991.json   # epoch 3 eval log
├── data/
│   ├── README.md
│   ├── train.txt
│   ├── val.txt
│   └── test.txt
├── tests/
│   └── test_inference.py
├── backend/                         # FastAPI serving layer -- see backend/README.md
│   ├── README.md
│   ├── main.py                      # FastAPI app: /health, /predict
│   ├── inference.py                 # SentioModel -- loads model_bert/, tokenizes, predicts
│   ├── clean_text.py
│   ├── download_model.py            # fetches BERT checkpoint at Docker build time (see backend/README.md)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── model_bert/                  # config + tokenizer (weights downloaded at build time)
└── ReviewSense_AI_Report.docx      # original written project report
```

## Installation

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate   |   macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

### CPU vs GPU

`requirements.txt` pins a platform-neutral `torch` range. For a GPU build,
install PyTorch separately **before** `requirements.txt`, per the official
selector at https://pytorch.org/get-started/locally/, e.g.:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
```

`src/utils.get_device()` automatically falls back to CPU when CUDA is unavailable.

### fastText language-ID model (optional)

Only needed to re-run the notebook's "Language Detection and Voting" section
(which, as documented above, drops no rows either way):

```bash
# from the repo root
curl -L -o lid.176.bin https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin
```

## Training

```bash
# Classical (TF-IDF + GridSearchCV)
python train.py --model svm
python train.py --model decision_tree
python train.py --model random_forest    # ~167 MB checkpoint, not committed by default
python train.py --model logreg           # never shipped by the notebook -- see Notebook Fidelity Notes #4

# Attention NN (BPE tokenizer)
python train.py --model attention_nn --epochs 50 --patience 5
python train.py --model attention_nn --use-augmentation --epochs 5 --patience 15

# GloVe + BiLSTM (downloads glove-wiki-gigaword-200 via gensim on first run, ~660 MB)
python train.py --model glove_bilstm --epochs 50 --patience 15

# BERT fine-tuning
python train.py --model bert --epochs 3 --batch-size 16
```

## Evaluation

```bash
python evaluate.py --model svm --checkpoint artifacts/svc_grid_best.pkl
python evaluate.py --model attention_nn --checkpoint models/best_model_nn.pt --tokenizer artifacts/my_bpe_tokenizer.json
python evaluate.py --model glove_bilstm --checkpoint models/model_glove.pt
python evaluate.py --model bert --checkpoint models/model_bert --tokenizer artifacts/model_bert_tokenizer
```

## Inference

```bash
# Default model: GloVe + BiLSTM (strongest fully-shipped checkpoint, 90.60% test accuracy)
python inference.py --text "I can't believe how happy I am right now!"

python inference.py --text "I'm terrified of what happens next" --model attention_nn
python inference.py --text "This is unbelievable, I did not expect that at all" --model bert   # requires model.safetensors, see above
```

### Example prediction

Real output of `python inference.py --text "I can't believe how happy I am right now!"`
(default model, GloVe + BiLSTM):

```
Text        : I can't believe how happy I am right now!
Predicted   : JOY
Confidence  : 46.23%
Probabilities:
        joy: 46.23%
       love: 14.64%
      anger: 14.14%
    sadness: 13.99%
   surprise:  5.70%
       fear:  5.30%
```

The correct class wins, but confidence is modest -- a reminder that even the
strongest fully-shipped model (90.60% test accuracy) is calibrated on short,
simple, unambiguous training examples, and a slightly more complex sentence
("I can't believe how happy...", which also carries a mild surprise/disbelief
framing) can genuinely split probability mass across several plausible
emotions. Compare with `--model attention_nn`, which is far more confident on
the same sentence (see `tests/test_inference.py`'s attention_nn example: >99.9%).

## Reproducibility

- Random seed: **42** (Python `random`, NumPy, PyTorch, CUDA) throughout
  `src/utils.set_seed`.
- The TF-IDF vectorizer, BPE tokenizer, and GloVe word-level tokenizer are
  all fit on the **training split only**; validation/test text is only ever
  transformed, never used to (re)fit vocabulary -- matching the notebook.
- All large/regenerable artifacts (Random Forest pickle, BERT safetensors,
  HF Trainer checkpoints, fastText model) were **never added to Git history**
  in this repository -- they are excluded via `.gitignore` from the first
  commit, not deleted after being committed once, so the tracked repository
  size stays small.

## Limitations

- **Short-text domain.** The dataset consists of short, informal,
  Twitter-style text. Performance on long-form reviews, formal writing, or
  non-English text is unverified and likely to degrade.
- **Class imbalance.** `surprise` has ~9.5x fewer training examples than
  `joy`; even the best models' per-class recall on `surprise` is weaker than
  on the majority classes (see the notebook's own per-class F1 breakdown,
  `notebooks/`).
- **Not sarcasm- or context-aware.** Every model scores a single piece of
  text in isolation, with no conversational or author context -- sarcasm,
  irony, and mixed emotions within one message are not modeled.
- **Preprocessing quirks preserved for fidelity.** As documented above,
  several of the notebook's cleaning/persistence steps have real bugs (a
  shadowed `clean_text` redefinition, a broken URL regex, an unpersisted
  GloVe vocabulary, an unsaved augmented-NN checkpoint). This repo ships the
  *actual* behavior the checkpoints were trained/evaluated against, not a
  silently "corrected" version, to avoid a train-serve mismatch with the
  real weights.
- **Default inference model is not the notebook's best model.** `inference.py`
  defaults to GloVe + BiLSTM (90.60% test accuracy) rather than BERT
  (92.75%) purely because BERT's weights are too large to ship in this
  repository -- see [Models Not Shipped](#models-not-shipped-in-this-repository).

## Responsible-Use Disclaimer

Sentio is a research and educational project. Emotion classification from
text is inherently noisy and culturally/contextually dependent -- do not use
its predictions as the sole basis for moderation, mental-health, HR,
or any other decision with real-world consequences for individuals. Always
pair automated emotion scoring with human review.

## Report

- [`ReviewSense_AI_Report.docx`](ReviewSense_AI_Report.docx) -- the original
  written project report (working-title era), included in this repository.

## License

No license has been specified for this project. All rights reserved by the
author(s) unless a `LICENSE` file is added.
