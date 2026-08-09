"""Data loading, cleaning, language-ID, and class-balancing pipeline for Sentio.

Ported from ``notebooks/tf-idf-to-transformers-94-sentiment-accuracy-PYTORCH-VISUALIZED.ipynb``:
"Loading and Exploring the Dataset", "Handling Duplicate Text Entries", "Text
Preprocessing Function", "Language Detection and Voting", and "Balancing the
Dataset with Augmentation".

IMPORTANT -- CONFIRMED NOTEBOOK BUG (documented, not silently hidden)
----------------------------------------------------------------------
The notebook defines ``clean_text`` **twice**, with two genuinely different
implementations sharing the same name:

1. Cell 48 ("Text Preprocessing Function"): the full-featured version, with an
   ``is_only_mentions`` short-circuit, a working URL regex (``http\\S+|www\\.\\S+``),
   and a "keep basic punctuation" character class. This version is what was
   actually in scope when the **TF-IDF** cleaning column (``train_df_clean['clean_text']``,
   used to fit the classic ML models -- Logistic Regression, Decision Tree,
   Random Forest, SVM) was computed, a few cells later, in "Data Preprocessing
   for TF-IDF Vectorizer".

2. Cell 88, inside the "Logistic Regression" sub-section (*after* the TF-IDF
   models were already trained on the version-1 output): a **second**
   ``def clean_text(...)`` that silently replaces the first in the global
   namespace. This version drops the ``is_only_mentions`` check entirely
   (the ``remove_only_mentions`` parameter still exists but is never read in
   the function body -- a dead parameter), and its URL regex is
   ``r'https?://\\s+|www\\.\\s+'`` -- note ``\\s+`` (whitespace) where the
   original used ``\\S+`` (non-whitespace). Because a real URL is never
   followed immediately by whitespace right after ``://``, this regex
   essentially never matches anything, so **URLs are never actually removed**
   from any text cleaned after this point, even when ``remove_urls=True`` is
   passed explicitly.

   Every ``clean_text(...)`` call *after* cell 88 -- i.e. the "Adjusted
   Cleaning Strategy for BPE & Neural Networks" cell (BPE/Attention-NN input),
   the GloVe preprocessing cell, and the BERT preprocessing cell -- therefore
   silently uses this second, buggier definition instead of the first, even
   though the surrounding markdown documents the same "remove mentions /
   hashtags / URLs / numbers, keep basic punctuation" behaviour promised for
   the first version. In particular:
     * BPE/Attention-NN's call passes only ``remove_stopwords=False,
       lemmatize=False`` and relies on defaults for everything else -- but
       version 2's defaults for ``remove_numbers`` / ``remove_mentions`` /
       ``remove_hashtags`` / ``remove_urls`` / ``remove_punctuation`` are all
       ``False`` (version 1's defaults were mostly ``True``). So the BPE/NN
       pipeline's "minimal cleaning" is, in practice, closer to "lowercase +
       whitespace-collapse only" than the multi-step cleaning the notebook's
       own markdown describes.
     * GloVe's and BERT's calls pass every flag explicitly (including
       ``remove_urls=True`` and ``remove_only_mentions=True``), but because of
       the bugs above, the URL-removal is a no-op and the only-mentions filter
       is a no-op too.

   This project ships the *existing* trained checkpoints, so
   :func:`clean_text_tfidf` (version 1) and :func:`clean_text_neural`
   (version 2, bugs preserved) are BOTH implemented below, faithfully, and
   routed to the pipeline that actually produced each shipped artifact.
   "Fixing" version 2 here would silently change what BPE/GloVe/BERT
   inference actually receives relative to what the shipped weights were
   fit on.

2b. ``balance_with_augmentation`` is also defined twice (contextual
    DistilBERT word-substitution via ``nlpaug.augmenter.word.ContextualWordEmbsAug``,
    then immediately redefined a few cells later as WordNet synonym
    substitution via ``nlpaug.augmenter.word.SynonymAug``). Only the second
    (synonym) definition is ever actually invoked in the executed notebook --
    the first is dead code, shadowed before use. Only the synonym-based
    version is reproduced here, as :func:`balance_with_augmentation`.

3. Language detection (``langdetect`` + ``langid`` + fastText ``lid.176.bin``,
   majority-voted) is reproduced for completeness/documentation
   (:func:`add_language_columns`), but it never actually filters anything:
   the notebook's own conclusion, after manual inspection, is that most
   "non-English" votes were misclassified English tweets, so **no rows are
   ever dropped** based on language. It has zero effect on the shipped
   artifacts and is not called by ``train.py`` / ``evaluate.py`` /
   ``inference.py``.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional, Union

import numpy as np
import pandas as pd

PathLike = Union[str, Path]

SENTIMENT_LABELS = ["anger", "fear", "joy", "love", "sadness", "surprise"]
"""Canonical class order, matching ``sklearn.preprocessing.LabelEncoder``'s
alphabetical sort of the six raw string labels found in train.txt/val.txt/test.txt."""

MAXLEN_BPE_GLOVE = 32
"""Sequence length used for BPE and GloVe padding/truncation throughout the notebook,
chosen because it covers the large majority of tweets by word count (see the notebook's
'Text Length & Vocabulary Profile' section)."""

MAX_LEN_BERT = 128
RANDOM_SEED = 42


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #

def load_split(path: PathLike) -> pd.DataFrame:
    """Loads one of train.txt / val.txt / test.txt: ``text;label`` per line, no header."""
    return pd.read_csv(path, sep=";", header=None, names=["text", "label"])


def load_splits(
    train_path: PathLike, val_path: PathLike, test_path: PathLike
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Loads all three splits. Raw (pre-dedup) sizes are 16,000 / 2,000 / 2,000 rows."""
    return load_split(train_path), load_split(val_path), load_split(test_path)


# --------------------------------------------------------------------------- #
# Deduplication ("Handling Duplicate Text Entries")
# --------------------------------------------------------------------------- #

def drop_duplicates(
    train_df: pd.DataFrame, val_df: pd.DataFrame, test_df: pd.DataFrame
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Reproduces the notebook's dedup, exactly as executed -- including a
    real gap between what it prints and what it does:

    The notebook first *reports* (``train_df.duplicated().sum()``) that
    ``train_df`` has exactly one fully-identical row, and displays it, but
    **never actually calls** ``.drop_duplicates()`` on it. The only removal
    that happens is: drop **every** row whose ``text`` is duplicated within
    its split, regardless of whether the labels agree (``duplicated(keep=False)``
    removes both copies, not just the extras) -- run on val, then train,
    then test, in that order. This happens to also remove the single exact
    duplicate (its text is trivially "duplicated" with itself), so the
    reported 1-row finding is not lost, it just isn't dropped via the
    dedicated API the notebook's own narration implies.

    Verified against the shipped data files: this produces exactly
    train=15,938, val=1,996, test=2,000 rows, matching the notebook's own
    printed shapes. Adding an explicit ``.drop_duplicates()`` pre-pass (which
    would seem like the "more correct" reading of the notebook's markdown)
    changes the result by +1 train row and does NOT match the notebook's
    reported output -- so it is deliberately not done here.
    """
    val_df = val_df[~val_df["text"].duplicated(keep=False)]
    train_df = train_df[~train_df["text"].duplicated(keep=False)]
    test_df = test_df[~test_df["text"].duplicated(keep=False)]
    return train_df.reset_index(drop=True), val_df.reset_index(drop=True), test_df.reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Text Preprocessing Function -- version 1 (cell 48), in effect for TF-IDF
# --------------------------------------------------------------------------- #

def is_only_mentions(text: str) -> bool:
    """True if ``text`` is nothing but one or more ``@mentions`` (used only by v1)."""
    return bool(re.fullmatch(r"(@\w+\s*)+", str(text).strip()))


def clean_text_tfidf(
    text: str,
    remove_numbers: bool = True,
    remove_stopwords: bool = False,
    remove_mentions: bool = True,
    remove_hashtags: bool = True,
    remove_urls: bool = True,
    remove_only_mentions: bool = True,
    lemmatize: bool = False,
    remove_punctuation: bool = True,
) -> str:
    """Faithful port of the notebook's FIRST ``clean_text`` (cell 48).

    This is the version in scope when ``train_df_clean['clean_text']`` was
    computed for TF-IDF (see module docstring): a working URL regex and a
    real only-mentions short-circuit. Used by :func:`build_tfidf_clean_text`
    with ``remove_stopwords=True, lemmatize=True`` (the actual call made in
    "Data Preprocessing for TF-IDF Vectorizer").
    """
    if not isinstance(text, str):
        return ""

    if remove_only_mentions and is_only_mentions(text):
        return ""

    text = text.lower()
    if remove_mentions:
        text = re.sub(r"@\w+", "", text)
    if remove_hashtags:
        text = re.sub(r"#\w+", "", text)
    if remove_urls:
        text = re.sub(r"http\S+|www\.\S+", "", text)
    if remove_punctuation:
        text = re.sub(r"[^\w\s.,!?'’\"…-]", "", text)
    if remove_numbers:
        text = re.sub(r"\d+", "", text)
    text = re.sub(r"\s+", " ", text).strip()

    words = text.split()
    if remove_stopwords:
        from nltk.corpus import stopwords

        stop_words = set(stopwords.words("english"))
        words = [w for w in words if w not in stop_words]
    if lemmatize:
        from nltk.stem import WordNetLemmatizer

        lemmatizer = WordNetLemmatizer()
        words = [lemmatizer.lemmatize(w) for w in words]
    return " ".join(words)


def build_tfidf_clean_text(text: str) -> str:
    """The exact call the notebook makes for TF-IDF: heavy cleaning (stopwords + lemmatize)."""
    return clean_text_tfidf(text, remove_stopwords=True, lemmatize=True)


# --------------------------------------------------------------------------- #
# Text Preprocessing Function -- version 2 (cell 88), in effect for
# BPE / Attention-NN, GloVe, and BERT (bugs preserved, see module docstring)
# --------------------------------------------------------------------------- #

def clean_text_neural(
    text: str,
    remove_numbers: bool = False,
    remove_stopwords: bool = False,
    remove_mentions: bool = False,
    remove_hashtags: bool = False,
    remove_urls: bool = False,
    remove_only_mentions: bool = False,  # noqa: ARG001 -- accepted but unused, see docstring
    lemmatize: bool = True,
    remove_punctuation: bool = False,
) -> str:
    """Faithful port of the notebook's SECOND ``clean_text`` (cell 88).

    Silently shadows :func:`clean_text_tfidf` from this point on in the
    notebook. Two bugs are preserved on purpose (see module docstring):
    the URL regex uses ``\\s+`` instead of ``\\S+`` and therefore never
    actually strips URLs, and ``remove_only_mentions`` is accepted as a
    parameter but never read in the body. This is the version that
    actually ran for the BPE/Attention-NN, GloVe, and BERT pipelines.
    """
    text = str(text).lower()
    if remove_urls:
        text = re.sub(r"https?://\s+|www\.\s+", "", text)  # bug: \s+ never matches real URLs
    if remove_mentions:
        text = re.sub(r"@\w+", "", text)
    if remove_hashtags:
        text = re.sub(r"#\w+", "", text)
    if remove_numbers:
        text = re.sub(r"\d+", "", text)
    if remove_punctuation:
        text = re.sub(r"[^\w\s]", "", text)

    words = text.split()
    if remove_stopwords:
        from nltk.corpus import stopwords

        stop_words = set(stopwords.words("english"))
        words = [w for w in words if w not in stop_words]
    if lemmatize:
        from nltk.stem import WordNetLemmatizer

        lemmatizer = WordNetLemmatizer()
        words = [lemmatizer.lemmatize(w) for w in words]
    return " ".join(words)


def build_bpe_clean_text(text: str) -> str:
    """Exact call used for BPE/Attention-NN input ("Adjusted Cleaning Strategy" cell):
    ``clean_text(x, remove_stopwords=False, lemmatize=False)`` -- every other flag
    falls through to version 2's (mostly False) defaults. See module docstring."""
    return clean_text_neural(text, remove_stopwords=False, lemmatize=False)


def build_glove_clean_text(text: str) -> str:
    """Exact call used for GloVe preprocessing -- every flag passed explicitly."""
    return clean_text_neural(
        text,
        remove_numbers=True,
        remove_stopwords=False,
        remove_mentions=True,
        remove_hashtags=True,
        remove_urls=True,
        remove_only_mentions=True,
        lemmatize=False,
        remove_punctuation=True,
    )


def build_bert_clean_text(text: str) -> str:
    """Exact call used for BERT preprocessing -- every flag passed explicitly."""
    return clean_text_neural(
        text,
        remove_numbers=False,
        remove_stopwords=False,
        remove_mentions=True,
        remove_hashtags=False,
        remove_urls=True,
        remove_only_mentions=True,
        lemmatize=False,
        remove_punctuation=False,
    )


# --------------------------------------------------------------------------- #
# Language Detection and Voting (documentation-only -- drops nothing)
# --------------------------------------------------------------------------- #

def langdetect_detect(text: str) -> str:
    from langdetect import detect

    try:
        return detect(str(text))
    except Exception:
        return "unknown"


def langid_detect(text: str) -> str:
    import langid

    try:
        return langid.classify(str(text))[0]
    except Exception:
        return "unknown"


def fasttext_detect(text: str, ft_model) -> str:
    try:
        return ft_model.predict(str(text))[0][0].replace("__label__", "")
    except Exception:
        return "unknown"


def vote_lang(lang_langdetect: str, lang_langid: str, lang_fasttext: str) -> str:
    """Majority vote across the three detectors; English wins if ANY detector says 'en'."""
    langs = [lang_langdetect, lang_langid, lang_fasttext]
    if "en" in langs:
        return "en"
    langs = [lang for lang in langs if lang != "unknown"]
    if not langs:
        return "unknown"
    modes = pd.Series(langs).mode()
    if len(modes) > 1:
        return "unknown"
    return modes[0]


def add_language_columns(df: pd.DataFrame, ft_model=None) -> pd.DataFrame:
    """Adds lang_langdetect / lang_langid / lang_fasttext / lang_final columns.

    Requires ``lid.176.bin`` (fastText language-ID model, ~131 MB, not shipped
    in this repo -- see requirements.txt / README for the public download URL)
    passed in as a loaded ``fasttext`` model via ``ft_model``. NOTE: as
    documented in the module docstring, the notebook never actually drops any
    rows based on this column -- it is informational only.
    """
    df = df.copy()
    df["lang_langdetect"] = df["text"].apply(langdetect_detect)
    df["lang_langid"] = df["text"].apply(langid_detect)
    df["lang_fasttext"] = df["text"].apply(lambda t: fasttext_detect(t, ft_model) if ft_model else "unknown")
    df["lang_final"] = df.apply(
        lambda r: vote_lang(r["lang_langdetect"], r["lang_langid"], r["lang_fasttext"]), axis=1
    )
    return df


# --------------------------------------------------------------------------- #
# Balancing the Dataset with Augmentation (WordNet-synonym version -- the
# only one actually invoked; see module docstring)
# --------------------------------------------------------------------------- #

def balance_with_augmentation(
    df: pd.DataFrame,
    text_col: str = "text",
    label_col: str = "label",
    clean_col: str = "clean_text",
    seed: Optional[int] = None,
) -> pd.DataFrame:
    """Upsamples every minority class to the size of the largest class using
    WordNet synonym substitution (``nlpaug.augmenter.word.SynonymAug``).

    Faithful port of the notebook's active ``balance_with_augmentation``
    (the WordNet-synonym redefinition that shadows the earlier, dead,
    DistilBERT-contextual-substitution version -- see module docstring).
    """
    import nlpaug.augmenter.word as naw

    target_count = df[label_col].value_counts().max()
    aug = naw.SynonymAug(aug_src="wordnet")

    balanced_chunks = [df]
    for label, group in df.groupby(label_col):
        current_count = len(group)
        if current_count < target_count:
            needed = target_count - current_count
            samples = group.sample(n=needed, replace=True, random_state=seed)
            aug_texts, aug_clean_texts = [], []
            for _, row in samples.iterrows():
                try:
                    aug_text = aug.augment(str(row[text_col]))[0]
                    aug_clean = aug.augment(str(row[clean_col]))[0]
                except Exception:
                    aug_text = row[text_col]
                    aug_clean = row[clean_col]
                aug_texts.append(aug_text)
                aug_clean_texts.append(aug_clean)
            aug_df = pd.DataFrame({text_col: aug_texts, label_col: label, clean_col: aug_clean_texts})
            balanced_chunks.append(aug_df)
    return pd.concat(balanced_chunks, ignore_index=True)


# --------------------------------------------------------------------------- #
# pad_sequences -- pure NumPy stand-in for keras.preprocessing.sequence.pad_sequences
# --------------------------------------------------------------------------- #

def pad_sequences(
    sequences: list[list[int]],
    maxlen: int,
    padding: str = "post",
    truncating: str = "post",
    value: int = 0,
) -> np.ndarray:
    """Pads/truncates a list of integer-id sequences to a fixed length (cell 2)."""
    padded = np.full((len(sequences), maxlen), value, dtype=np.int64)
    for i, seq in enumerate(sequences):
        seq = list(seq)
        if len(seq) > maxlen:
            seq = seq[:maxlen] if truncating == "post" else seq[-maxlen:]
        if padding == "post":
            padded[i, : len(seq)] = seq
        else:
            padded[i, -len(seq):] = seq
    return padded
