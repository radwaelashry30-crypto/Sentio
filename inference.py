#!/usr/bin/env python
"""Sentio real-time inference CLI: classifies free text into one of six emotions
(anger, fear, joy, love, sadness, surprise) with a confidence score.

Default model: GloVe + BiLSTM (``models/model_glove.pt``, 90.60% test accuracy,
see README). This is a deliberate choice, not a claim that it is the strongest
architecture in the notebook -- the notebook's own best model is the fine-tuned
BERT classifier (92.75% test accuracy / 93.44% validation accuracy), but its
~418 MB weights file is excluded from this repository (GitHub's 100 MB/file
limit) and is NOT present unless you fetch/retrain it separately (see README
"Models Not Shipped in This Repository"). GloVe + BiLSTM is the strongest
model whose full weights actually ship in this repo, so it is the safe default
for a fresh clone. Pass --model bert once you have placed the weights under
models/model_bert/model.safetensors.

Usage:
    python inference.py --text "I can't believe how happy I am right now!"
    python inference.py --text "I'm terrified of what happens next" --model attention_nn
    python inference.py --text "This is unbelievable, I did not expect that at all" --model bert
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.preprocessing import (
    MAXLEN_BPE_GLOVE,
    MAX_LEN_BERT,
    SENTIMENT_LABELS,
    build_bert_clean_text,
    build_bpe_clean_text,
    build_glove_clean_text,
    build_tfidf_clean_text,
    drop_duplicates,
    load_split,
)
from src.models import AttentionSentimentClassifier, GloveBiLSTMClassifier
from src.tokenizer import WordLevelTokenizer, encode_with_bpe, load_bpe_tokenizer
from src.utils import get_device, softmax_np

DEFAULT_TRAIN_FILE = Path("data/train.txt")

_cache: dict[str, object] = {}


def _predict_classic(text: str, checkpoint: Path) -> dict:
    import joblib

    key = f"classic::{checkpoint}"
    if key not in _cache:
        _cache[key] = joblib.load(checkpoint)
    model = _cache[key]
    cleaned = build_tfidf_clean_text(text)

    raise RuntimeError(
        "Classic (TF-IDF) models cannot score a single new sentence from the shipped "
        "checkpoint alone: the notebook never persisted the fitted TfidfVectorizer "
        "vocabulary alongside the estimator, only the estimator itself (see README "
        "'Notebook Fidelity Notes'). Re-run `train.py --model svm` (or decision_tree) "
        "end-to-end, which fits the vectorizer and the estimator together in one process, "
        "then adapt this function to reuse that in-memory vectorizer."
    )


def _predict_attention_nn(text: str, checkpoint: Path, tokenizer_path: Path, device) -> dict:
    import torch

    key = f"attn::{checkpoint}"
    if key not in _cache:
        from train import NN_BEST_HPARAMS

        state_dict = torch.load(checkpoint, map_location=device)
        vocab_size = state_dict["embedding.weight"].shape[0]
        embed_dim = state_dict["embedding.weight"].shape[1]
        num_heads = NN_BEST_HPARAMS["num_heads"] if embed_dim == NN_BEST_HPARAMS["embedding_dim"] else 8
        model = AttentionSentimentClassifier(
            vocab_size=vocab_size, embedding_dim=embed_dim, num_heads=num_heads,
            dense_units_1=state_dict["dense1.weight"].shape[0],
            dense_units_2=state_dict["dense2.weight"].shape[0],
        )
        model.load_state_dict(state_dict, strict=True)
        model.to(device).eval()
        _cache[key] = model
    model = _cache[key]

    tok_key = f"bpe_tok::{tokenizer_path}"
    if tok_key not in _cache:
        _cache[tok_key] = load_bpe_tokenizer(tokenizer_path)
    tokenizer = _cache[tok_key]

    cleaned = build_bpe_clean_text(text)
    x = encode_with_bpe(tokenizer, [cleaned], maxlen=MAXLEN_BPE_GLOVE)
    x_t = torch.as_tensor(x, dtype=torch.long, device=device)
    with torch.no_grad():
        probs = torch.softmax(model(x_t), dim=1).cpu().numpy()[0]
    return {"probs": probs, "cleaned_text": cleaned}


def _fit_glove_tokenizer(train_file: Path) -> WordLevelTokenizer:
    """Deterministically rebuilds the GloVe path's word-level vocabulary from
    data/train.txt, since the notebook never persisted it separately -- see
    evaluate.py's evaluate_glove_bilstm docstring for the full explanation."""
    train_df, _, _ = drop_duplicates(load_split(train_file), load_split(train_file), load_split(train_file))
    train_df = train_df.copy()
    train_df["text_clean"] = train_df["text"].apply(build_glove_clean_text)
    tokenizer = WordLevelTokenizer(oov_token="[OOV]")
    tokenizer.fit_on_texts(train_df["text_clean"])
    return tokenizer


def _predict_glove_bilstm(text: str, checkpoint: Path, train_file: Path, device) -> dict:
    import torch

    key = f"glove::{checkpoint}"
    if key not in _cache:
        state_dict = torch.load(checkpoint, map_location=device)
        hidden3 = state_dict["classifier.weight"].shape[1] // 2
        hidden1 = state_dict["lstm1.weight_hh_l0"].shape[1]
        hidden2 = state_dict["lstm2.weight_hh_l0"].shape[1]
        embedding_matrix = state_dict["embedding.weight"].cpu().numpy()
        model = GloveBiLSTMClassifier(embedding_matrix, hidden_sizes=(hidden1, hidden2, hidden3), dropout=0.2)
        model.load_state_dict(state_dict, strict=True)
        model.to(device).eval()
        _cache[key] = model
    model = _cache[key]

    tok_key = f"glove_tok::{train_file}"
    if tok_key not in _cache:
        _cache[tok_key] = _fit_glove_tokenizer(train_file)
    tokenizer = _cache[tok_key]

    cleaned = build_glove_clean_text(text)
    x = tokenizer.encode([cleaned], maxlen=MAXLEN_BPE_GLOVE)
    x_t = torch.as_tensor(x, dtype=torch.long, device=device)
    with torch.no_grad():
        probs = torch.softmax(model(x_t), dim=1).cpu().numpy()[0]
    return {"probs": probs, "cleaned_text": cleaned}


def _predict_bert(text: str, checkpoint: Path, tokenizer_path: Path, device) -> dict:
    import torch
    from transformers import AutoTokenizer, BertForSequenceClassification

    if not (checkpoint / "model.safetensors").exists() and not (checkpoint / "pytorch_model.bin").exists():
        raise FileNotFoundError(
            f"{checkpoint} has no model weights. The fine-tuned BERT weights (~418 MB) are "
            "excluded from this repository -- see README 'Models Not Shipped in This "
            "Repository'. Re-run `train.py --model bert` or fetch the weights from wherever "
            "your team hosts them (Git LFS / Hugging Face Hub), then place them at "
            f"{checkpoint}/model.safetensors."
        )

    key = f"bert::{checkpoint}"
    if key not in _cache:
        model = BertForSequenceClassification.from_pretrained(checkpoint).to(device).eval()
        # AutoTokenizer (not BertTokenizer) -- artifacts/model_bert_tokenizer/ ships only
        # tokenizer.json + tokenizer_config.json (no vocab.txt), which the slow
        # BertTokenizer class cannot load. See README "Notebook Fidelity Notes".
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_path)
        _cache[key] = (model, tokenizer)
    model, tokenizer = _cache[key]

    cleaned = build_bert_clean_text(text)
    batch = tokenizer(cleaned, return_tensors="pt", padding="max_length", truncation=True, max_length=MAX_LEN_BERT).to(device)
    with torch.no_grad():
        logits = model(**batch).logits.cpu().numpy()
    probs = softmax_np(logits, axis=1)[0]
    return {"probs": probs, "cleaned_text": cleaned}


def predict_emotion(
    text: str,
    model_name: str = "glove_bilstm",
    checkpoint: Path = None,
    tokenizer_path: Path = None,
    train_file: Path = DEFAULT_TRAIN_FILE,
    device=None,
) -> dict:
    """Classifies ``text`` into one of :data:`SENTIMENT_LABELS`.

    Returns a dict with ``label``, ``confidence``, and ``probabilities`` (a
    dict of every class's probability), plus ``cleaned_text`` for transparency.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("predict_emotion received empty input text.")
    device = device or get_device()

    if model_name == "attention_nn":
        checkpoint = checkpoint or Path("models/best_model_nn.pt")
        tokenizer_path = tokenizer_path or Path("artifacts/my_bpe_tokenizer.json")
        result = _predict_attention_nn(text, checkpoint, tokenizer_path, device)
    elif model_name == "glove_bilstm":
        checkpoint = checkpoint or Path("models/model_glove.pt")
        result = _predict_glove_bilstm(text, checkpoint, train_file, device)
    elif model_name == "bert":
        checkpoint = checkpoint or Path("models/model_bert")
        tokenizer_path = tokenizer_path or Path("artifacts/model_bert_tokenizer")
        result = _predict_bert(text, checkpoint, tokenizer_path, device)
    elif model_name in {"svm", "decision_tree"}:
        checkpoint = checkpoint or Path(f"artifacts/{'svc_grid_best' if model_name == 'svm' else 'dt_best'}.pkl")
        result = _predict_classic(text, checkpoint)
    else:
        raise ValueError(f"Unknown model {model_name!r}")

    probs = result["probs"]
    pred_idx = int(np.argmax(probs))
    return {
        "label": SENTIMENT_LABELS[pred_idx],
        "confidence": float(probs[pred_idx]),
        "probabilities": {label: float(p) for label, p in zip(SENTIMENT_LABELS, probs)},
        "cleaned_text": result["cleaned_text"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Sentio real-time emotion inference on a piece of text.")
    parser.add_argument("--text", type=str, required=True, help="Raw text to classify.")
    parser.add_argument("--model", type=str, default="glove_bilstm",
                         choices=["glove_bilstm", "attention_nn", "bert", "svm", "decision_tree"])
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--tokenizer", type=Path, default=None)
    parser.add_argument("--train-file", type=Path, default=DEFAULT_TRAIN_FILE)
    parser.add_argument("--device", type=str, default=None, choices=[None, "cpu", "cuda"])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import torch

    device = torch.device(args.device) if args.device else None
    result = predict_emotion(
        args.text, model_name=args.model, checkpoint=args.checkpoint,
        tokenizer_path=args.tokenizer, train_file=args.train_file, device=device,
    )
    print(f"\nText        : {args.text}")
    print(f"Predicted   : {result['label'].upper()}")
    print(f"Confidence  : {result['confidence'] * 100:.2f}%")
    print("Probabilities:")
    for label, p in sorted(result["probabilities"].items(), key=lambda kv: -kv[1]):
        print(f"  {label:>9}: {p * 100:5.2f}%")


if __name__ == "__main__":
    main()
