"""Smoke tests for the Sentio preprocessing/model/inference pipeline.

Checkpoint-dependent tests are skipped with a clear reason when the relevant
artifact is not present (e.g. the fine-tuned BERT weights, which are excluded
from this repository -- see README "Models Not Shipped in This Repository")
-- they are never faked as passing.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.preprocessing import (
    SENTIMENT_LABELS,
    build_bpe_clean_text,
    build_glove_clean_text,
    build_tfidf_clean_text,
    clean_text_neural,
    clean_text_tfidf,
    drop_duplicates,
    is_only_mentions,
    load_split,
)
from src.models import AttentionSentimentClassifier, GloveBiLSTMClassifier
from src.tokenizer import WordLevelTokenizer, load_bpe_tokenizer, encode_with_bpe
from src.utils import get_device, set_seed

DATA_DIR = ROOT / "data"
GLOVE_CHECKPOINT = ROOT / "models" / "model_glove.pt"
ATTENTION_CHECKPOINT = ROOT / "models" / "best_model_nn.pt"
BPE_TOKENIZER = ROOT / "artifacts" / "my_bpe_tokenizer.json"
BERT_WEIGHTS = ROOT / "models" / "model_bert" / "model.safetensors"

SKIP_NO_DATA = "data/{train,val,test}.txt not found -- run from the repo root."
SKIP_NO_BERT = "models/model_bert/model.safetensors not shipped in this repo (see README); skipping."


# --------------------------------------------------------------------------- #
# Preprocessing
# --------------------------------------------------------------------------- #

def test_is_only_mentions_true_for_mentions_only():
    assert is_only_mentions("@alice @bob")


def test_is_only_mentions_false_for_real_text():
    assert not is_only_mentions("i am so happy today")


def test_clean_text_tfidf_lowercases_and_strips_urls():
    out = clean_text_tfidf("Check this out http://example.com NOW!!")
    assert out == out.lower()
    assert "http" not in out


def test_clean_text_neural_url_bug_is_preserved():
    """Documents the confirmed notebook bug: version-2 clean_text's URL regex
    (`https?://\\s+`) never actually matches a real URL. See src/preprocessing.py
    module docstring."""
    out = clean_text_neural("visit http://example.com today", remove_urls=True)
    assert "http://example.com" in out  # NOT stripped -- this is the documented bug


def test_build_tfidf_clean_text_is_a_string():
    assert isinstance(build_tfidf_clean_text("I feel great today"), str)


def test_build_bpe_clean_text_is_a_string():
    assert isinstance(build_bpe_clean_text("I feel great today"), str)


def test_build_glove_clean_text_is_a_string():
    assert isinstance(build_glove_clean_text("I feel great today"), str)


@pytest.mark.skipif(not DATA_DIR.exists(), reason=SKIP_NO_DATA)
def test_drop_duplicates_matches_notebook_reported_shapes():
    train_df = load_split(DATA_DIR / "train.txt")
    val_df = load_split(DATA_DIR / "val.txt")
    test_df = load_split(DATA_DIR / "test.txt")
    train_df, val_df, test_df = drop_duplicates(train_df, val_df, test_df)
    assert len(train_df) == 15938
    assert len(val_df) == 1996
    assert len(test_df) == 2000


# --------------------------------------------------------------------------- #
# Model construction
# --------------------------------------------------------------------------- #

def test_attention_sentiment_classifier_forward_shape():
    set_seed(42)
    model = AttentionSentimentClassifier(vocab_size=100, embedding_dim=32, num_heads=4)
    x = torch.randint(0, 100, (4, 32))
    logits = model(x)
    assert logits.shape == (4, 6)


def test_glove_bilstm_classifier_forward_shape():
    import numpy as np

    set_seed(42)
    embedding_matrix = np.random.randn(50, 16).astype("float32")
    model = GloveBiLSTMClassifier(embedding_matrix, hidden_sizes=(8, 8, 8))
    x = torch.randint(0, 50, (4, 32))
    logits = model(x)
    assert logits.shape == (4, 6)


def test_word_level_tokenizer_roundtrip():
    tok = WordLevelTokenizer()
    tok.fit_on_texts(["i am happy", "i am sad"])
    seqs = tok.texts_to_sequences(["i am happy", "unknown word here"])
    assert len(seqs) == 2
    assert all(isinstance(i, int) for i in seqs[0])


# --------------------------------------------------------------------------- #
# Shipped-artifact loading
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(not GLOVE_CHECKPOINT.exists(), reason="models/model_glove.pt not found")
def test_glove_checkpoint_loads_strict():
    device = torch.device("cpu")
    state_dict = torch.load(GLOVE_CHECKPOINT, map_location=device)
    embedding_matrix = state_dict["embedding.weight"].numpy()
    model = GloveBiLSTMClassifier(embedding_matrix, hidden_sizes=(256, 128, 128), dropout=0.2)
    result = model.load_state_dict(state_dict, strict=True)
    assert len(result.missing_keys) == 0
    assert len(result.unexpected_keys) == 0


@pytest.mark.skipif(not ATTENTION_CHECKPOINT.exists(), reason="models/best_model_nn.pt not found")
def test_attention_nn_checkpoint_loads_strict():
    from train import NN_BEST_HPARAMS

    device = torch.device("cpu")
    state_dict = torch.load(ATTENTION_CHECKPOINT, map_location=device)
    model = AttentionSentimentClassifier(
        vocab_size=state_dict["embedding.weight"].shape[0],
        embedding_dim=NN_BEST_HPARAMS["embedding_dim"],
        num_heads=NN_BEST_HPARAMS["num_heads"],
        dense_units_1=NN_BEST_HPARAMS["dense_units_1"],
        dense_units_2=NN_BEST_HPARAMS["dense_units_2"],
    )
    result = model.load_state_dict(state_dict, strict=True)
    assert len(result.missing_keys) == 0
    assert len(result.unexpected_keys) == 0


@pytest.mark.skipif(not BPE_TOKENIZER.exists(), reason="artifacts/my_bpe_tokenizer.json not found")
def test_bpe_tokenizer_loads_and_encodes():
    tokenizer = load_bpe_tokenizer(BPE_TOKENIZER)
    encoded = encode_with_bpe(tokenizer, ["i am feeling great today"], maxlen=32)
    assert encoded.shape == (1, 32)


# --------------------------------------------------------------------------- #
# End-to-end inference (uses the shipped GloVe + BiLSTM model, the strongest
# checkpoint whose full weights actually ship in this repo -- see inference.py)
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(
    not (GLOVE_CHECKPOINT.exists() and DATA_DIR.exists()),
    reason="models/model_glove.pt or data/train.txt not found",
)
class TestEndToEndGloveInference:
    @classmethod
    def setup_class(cls):
        from inference import predict_emotion

        cls.predict_emotion = staticmethod(predict_emotion)

    def test_returns_a_known_label(self):
        result = self.predict_emotion("I am so incredibly happy and excited right now!", model_name="glove_bilstm")
        assert result["label"] in SENTIMENT_LABELS

    def test_confidence_in_valid_range(self):
        result = self.predict_emotion("I am terrified and scared of what comes next", model_name="glove_bilstm")
        assert 0.0 <= result["confidence"] <= 1.0

    def test_probabilities_sum_to_one(self):
        result = self.predict_emotion("This is such a heartwarming, loving moment", model_name="glove_bilstm")
        total = sum(result["probabilities"].values())
        assert total == pytest.approx(1.0, abs=1e-4)

    def test_deterministic_repeated_predictions(self):
        text = "I can't believe this happened, what a shock"
        r1 = self.predict_emotion(text, model_name="glove_bilstm")
        r2 = self.predict_emotion(text, model_name="glove_bilstm")
        assert r1["confidence"] == pytest.approx(r2["confidence"], abs=1e-6)


@pytest.mark.skipif(not BERT_WEIGHTS.exists(), reason=SKIP_NO_BERT)
def test_bert_inference_smoke():
    from inference import predict_emotion

    result = predict_emotion("I feel so grateful and joyful today", model_name="bert")
    assert result["label"] in SENTIMENT_LABELS
