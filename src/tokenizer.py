"""Tokenizers used across Sentio's model families.

Ported from the notebook's "Integrating BPE Tokenization with Neural Networks"
(``train_and_tokenize_bpe``) and "GloVe Embeddings" (``WordLevelTokenizer``)
sections. BERT uses ``transformers.BertTokenizer`` directly (see
``artifacts/model_bert_tokenizer/``) and needs no custom wrapper here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Union

import pandas as pd

from .preprocessing import pad_sequences

PathLike = Union[str, Path]


# --------------------------------------------------------------------------- #
# Word-level tokenizer (GloVe path)
# --------------------------------------------------------------------------- #

class WordLevelTokenizer:
    """Pure-Python replacement for ``tensorflow.keras.preprocessing.text.Tokenizer``
    (word-level, whitespace-split). Index 0 is reserved for padding (never assigned
    to a real word) and index 1 for the out-of-vocabulary token, matching the
    original Keras Tokenizer's index convention.

    Ported 1:1 from the notebook's GloVe section (``WordLevelTokenizer``).
    """

    def __init__(self, oov_token: str = "[OOV]") -> None:
        self.oov_token = oov_token
        self.word_index: dict[str, int] = {}

    def fit_on_texts(self, texts) -> None:
        word_counts: dict[str, int] = {}
        for text in texts:
            for word in str(text).split():
                word_counts[word] = word_counts.get(word, 0) + 1
        sorted_words = sorted(word_counts.items(), key=lambda kv: kv[1], reverse=True)
        self.word_index = {self.oov_token: 1}
        for idx, (word, _) in enumerate(sorted_words, start=2):
            self.word_index[word] = idx

    def texts_to_sequences(self, texts) -> list[list[int]]:
        oov_id = self.word_index[self.oov_token]
        return [[self.word_index.get(w, oov_id) for w in str(t).split()] for t in texts]

    def encode(self, texts, maxlen: int) -> "np.ndarray":  # noqa: F821
        return pad_sequences(self.texts_to_sequences(texts), maxlen=maxlen, padding="post", truncating="post")


# --------------------------------------------------------------------------- #
# BPE tokenizer (Attention-NN path)
# --------------------------------------------------------------------------- #

def train_and_tokenize_bpe(
    train_texts,
    val_texts,
    test_texts,
    vocab_size: int = 10_000,
    pad_token: str = "[PAD]",
    unk_token: str = "[UNK]",
    maxlen: int = 32,
):
    """Trains a byte-pair-encoding tokenizer on ``train_texts`` and encodes all
    three splits to padded integer-id arrays. Faithful port of the notebook's
    ``train_and_tokenize_bpe`` (uses the HuggingFace ``tokenizers`` library's
    ``Tokenizer(BPE())`` with a ``Whitespace`` pre-tokenizer).

    Returns:
        ``(tokenizer, pad_token_id, train_padded, val_padded, test_padded)``.
    """
    from tokenizers import Tokenizer, pre_tokenizers, trainers
    from tokenizers.models import BPE

    train_texts = [str(t) for t in train_texts]
    val_texts = [str(t) for t in val_texts]
    test_texts = [str(t) for t in test_texts]

    tokenizer = Tokenizer(BPE())
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    trainer = trainers.BpeTrainer(vocab_size=vocab_size, special_tokens=[pad_token, unk_token])
    tokenizer.train_from_iterator(train_texts, trainer=trainer)

    pad_token_id = tokenizer.token_to_id(pad_token)

    def encode_split(texts):
        ids = [tokenizer.encode(str(t)).ids for t in texts]
        return pad_sequences(ids, maxlen=maxlen, padding="post", truncating="post", value=pad_token_id)

    return (
        tokenizer,
        pad_token_id,
        encode_split(train_texts),
        encode_split(val_texts),
        encode_split(test_texts),
    )


def load_bpe_tokenizer(path: PathLike):
    """Loads a previously-trained BPE tokenizer from a ``tokenizer.json`` file
    (e.g. ``artifacts/my_bpe_tokenizer.json``)."""
    from tokenizers import Tokenizer

    return Tokenizer.from_file(str(path))


def encode_with_bpe(tokenizer, texts, maxlen: int = 32, pad_token: str = "[PAD]"):
    """Encodes texts with a loaded BPE tokenizer, padded/truncated to ``maxlen``."""
    pad_token_id = tokenizer.token_to_id(pad_token)
    ids = [tokenizer.encode(str(t)).ids for t in texts]
    return pad_sequences(ids, maxlen=maxlen, padding="post", truncating="post", value=pad_token_id)
