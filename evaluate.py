#!/usr/bin/env python
"""Sentio standalone evaluation script.

Loads a trained checkpoint/artifact (never refits) and reports accuracy,
macro precision/recall/F1, and a confusion matrix against data/test.txt (or a
separately supplied test file). Mirrors TruthLens's ``evaluate.py`` pattern.

Examples:
    python evaluate.py --model svm --checkpoint artifacts/svc_grid_best.pkl
    python evaluate.py --model glove_bilstm --checkpoint models/model_glove.pt
    python evaluate.py --model bert --checkpoint models/model_bert --tokenizer artifacts/model_bert_tokenizer
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
from src.tokenizer import encode_with_bpe, load_bpe_tokenizer
from src.utils import get_device, predict_proba, set_seed
from src.utils import SequenceDataset

CLASSIC_MODELS = {"logreg", "decision_tree", "random_forest", "svm"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a trained Sentio checkpoint on test data.")
    parser.add_argument("--test-file", type=Path, default=Path("data/test.txt"))
    parser.add_argument("--train-file", type=Path, default=Path("data/train.txt"),
                         help="Used only by --model glove_bilstm, to deterministically rebuild the "
                              "word-level vocabulary the notebook never persisted (see evaluate_glove_bilstm docstring).")
    parser.add_argument("--model", type=str, required=True,
                         choices=sorted(CLASSIC_MODELS | {"attention_nn", "glove_bilstm", "bert"}))
    parser.add_argument("--checkpoint", type=Path, default=None, help="Path to the model artifact/checkpoint.")
    parser.add_argument("--tokenizer", type=Path, default=None, help="Path to the tokenizer (BPE json / HF dir).")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--no-cuda", action="store_true")
    return parser.parse_args()


DEFAULT_CHECKPOINTS = {
    "logreg": None,  # never saved by the notebook -- see README "Notebook Fidelity Notes"
    "decision_tree": Path("artifacts/dt_best.pkl"),
    "random_forest": Path("artifacts/rf_grid_best.pkl"),  # excluded from repo, see .gitignore
    "svm": Path("artifacts/svc_grid_best.pkl"),
    "attention_nn": Path("models/best_model_nn.pt"),
    "glove_bilstm": Path("models/model_glove.pt"),
    "bert": Path("models/model_bert"),
}
DEFAULT_TOKENIZERS = {
    "attention_nn": Path("artifacts/my_bpe_tokenizer.json"),
    "bert": Path("artifacts/model_bert_tokenizer"),
}


def evaluate_classic(args, checkpoint: Path) -> None:
    import joblib
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
    from sklearn.preprocessing import LabelEncoder

    if not checkpoint.exists():
        raise FileNotFoundError(
            f"{checkpoint} not found. Note: models/{args.model} was fit on a TF-IDF matrix built from the "
            "TRAINING split -- this script cannot re-vectorize test data with a matching vocabulary unless "
            "you first re-run `train.py --model {args.model}`, which persists both the classifier and its "
            "TF-IDF vectorizer's vocabulary is implicitly re-derived on each run (see train.py)."
        )
    model = joblib.load(checkpoint)

    _, _, test_df = drop_duplicates(load_split(args.test_file), load_split(args.test_file), load_split(args.test_file))
    test_df = test_df.copy()
    test_df["clean_text"] = test_df["text"].apply(build_tfidf_clean_text)

    # NOTE: a shipped classic-ML checkpoint only contains the fitted estimator, not the
    # fitted TfidfVectorizer (the notebook never persisted the vectorizer). Re-fitting a
    # fresh TfidfVectorizer on the test split alone (rather than train) will NOT reproduce
    # the exact feature space the model was trained on -- this is a known limitation,
    # documented in the README. For a faithful score, re-run `train.py --model <name>`
    # end-to-end, which fits and evaluates within the same process.
    vectorizer = TfidfVectorizer(max_features=10_000, ngram_range=(1, 2))
    X_test = vectorizer.fit_transform(test_df["clean_text"])
    le = LabelEncoder()
    le.fit(SENTIMENT_LABELS)
    y_test = le.transform(test_df["label"])

    if X_test.shape[1] != getattr(model, "n_features_in_", X_test.shape[1]):
        print(
            "WARNING: the freshly-fit TF-IDF vocabulary does not match the vocabulary the "
            "checkpoint was trained on (n_features_in_ mismatch). Predictions below are NOT "
            "meaningful -- re-run train.py for a faithful evaluation."
        )
        return

    preds = model.predict(X_test)
    print(f"Accuracy: {accuracy_score(y_test, preds):.4f}")
    print(f"F1 (weighted): {f1_score(y_test, preds, average='weighted'):.4f}")
    print(classification_report(y_test, preds, target_names=le.classes_))
    print("Confusion matrix:")
    print(confusion_matrix(y_test, preds))


def evaluate_attention_nn(args, checkpoint: Path, tokenizer_path: Path) -> None:
    import torch
    from torch.utils.data import DataLoader

    device = get_device(prefer_cuda=not args.no_cuda)
    tokenizer = load_bpe_tokenizer(tokenizer_path)

    _, _, test_df = drop_duplicates(load_split(args.test_file), load_split(args.test_file), load_split(args.test_file))
    test_df = test_df.copy()
    test_df["clean_text"] = test_df["text"].apply(build_bpe_clean_text)

    from sklearn.preprocessing import LabelEncoder

    le = LabelEncoder()
    le.fit(SENTIMENT_LABELS)
    y_test = le.transform(test_df["label"])
    X_test = encode_with_bpe(tokenizer, test_df["clean_text"], maxlen=MAXLEN_BPE_GLOVE)

    state_dict = torch.load(checkpoint, map_location=device)
    vocab_size = state_dict["embedding.weight"].shape[0]
    embed_dim = state_dict["embedding.weight"].shape[1]
    dense1_out = state_dict["dense1.weight"].shape[0]
    dense2_out = state_dict["dense2.weight"].shape[0]
    # num_heads cannot be recovered from parameter *shapes* alone (nn.MultiheadAttention's
    # in_proj_weight is (3*embed_dim, embed_dim) regardless of num_heads) -- the default
    # checkpoint (models/best_model_nn.pt) is the notebook's winning random-search
    # configuration, hardcoded in train.py's NN_BEST_HPARAMS; reuse it here for the
    # shipped checkpoint, and override via retraining metadata for any other checkpoint.
    from train import NN_BEST_HPARAMS

    num_heads = NN_BEST_HPARAMS["num_heads"] if embed_dim == NN_BEST_HPARAMS["embedding_dim"] else 8
    model = AttentionSentimentClassifier(
        vocab_size=vocab_size, embedding_dim=embed_dim, num_heads=num_heads,
        dense_units_1=dense1_out, dense_units_2=dense2_out,
    )
    model.load_state_dict(state_dict, strict=True)
    model.to(device).eval()

    loader = DataLoader(SequenceDataset(X_test, y_test), batch_size=args.batch_size, shuffle=False)
    probs = predict_proba(model, loader, device=device)
    preds = probs.argmax(axis=1)
    _report(y_test, preds, probs, le.classes_)


def evaluate_glove_bilstm(args, checkpoint: Path, train_file: Path) -> None:
    """NOTE ON A REAL ARTIFACT GAP: the notebook never persists the GloVe path's
    ``WordLevelTokenizer`` (its word->index mapping) to disk -- the global Python
    name it was assigned to (``tokenizer``) is silently overwritten a few cells
    later by ``BertTokenizer.from_pretrained(...)`` before the "save everything"
    cell runs, so only the BERT tokenizer ends up saved under that name. See the
    README's "Notebook Fidelity Notes" for the full trace.

    ``WordLevelTokenizer.fit_on_texts`` is deterministic given the same input
    order (Python dicts preserve insertion order, and ``sorted(..., reverse=True)``
    is stable), so this function recovers the *exact* original mapping by
    refitting on ``data/train.txt`` with the identical dedup + cleaning steps
    the notebook used -- this is cheap (no model training, just counting) and
    exactly reproduces what ``models/model_glove.pt`` was actually trained
    against, rather than silently failing.
    """
    import torch
    from sklearn.preprocessing import LabelEncoder
    from torch.utils.data import DataLoader

    from src.tokenizer import WordLevelTokenizer

    device = get_device(prefer_cuda=not args.no_cuda)
    state_dict = torch.load(checkpoint, map_location=device)
    vocab_size, embed_dim = state_dict["embedding.weight"].shape

    train_df, _, test_df = drop_duplicates(load_split(train_file), load_split(args.test_file), load_split(args.test_file))
    train_df = train_df.copy(); test_df = test_df.copy()
    train_df["text_clean"] = train_df["text"].apply(build_glove_clean_text)
    test_df["text_clean"] = test_df["text"].apply(build_glove_clean_text)

    tokenizer = WordLevelTokenizer(oov_token="[OOV]")
    tokenizer.fit_on_texts(train_df["text_clean"])
    if len(tokenizer.word_index) + 1 != vocab_size:
        print(
            f"WARNING: refit vocabulary size ({len(tokenizer.word_index) + 1}) does not match the "
            f"checkpoint's embedding table ({vocab_size}). Make sure --test-file's sibling train.txt "
            "matches data/train.txt exactly (same file used to train this checkpoint)."
        )
        return

    le = LabelEncoder()
    le.fit(SENTIMENT_LABELS)
    y_test = le.transform(test_df["label"])
    X_test = tokenizer.encode(test_df["text_clean"], maxlen=MAXLEN_BPE_GLOVE)

    hidden3 = state_dict["classifier.weight"].shape[1] // 2
    hidden1 = state_dict["lstm1.weight_hh_l0"].shape[1]
    hidden2 = state_dict["lstm2.weight_hh_l0"].shape[1]
    embedding_matrix = state_dict["embedding.weight"].cpu().numpy()
    model = GloveBiLSTMClassifier(embedding_matrix, hidden_sizes=(hidden1, hidden2, hidden3), dropout=0.2)
    model.load_state_dict(state_dict, strict=True)
    model.to(device).eval()

    loader = DataLoader(SequenceDataset(X_test, y_test), batch_size=args.batch_size, shuffle=False)
    probs = predict_proba(model, loader, device=device)
    preds = probs.argmax(axis=1)
    _report(y_test, preds, probs, le.classes_)


def evaluate_bert(args, checkpoint: Path, tokenizer_path: Path) -> None:
    import torch
    from transformers import AutoTokenizer, BertForSequenceClassification

    device = get_device(prefer_cuda=not args.no_cuda)
    if not (checkpoint / "model.safetensors").exists() and not (checkpoint / "pytorch_model.bin").exists():
        raise FileNotFoundError(
            f"{checkpoint} does not contain model weights (model.safetensors / pytorch_model.bin). "
            "The fine-tuned BERT weights (~418 MB) are excluded from this repository -- see README "
            "'Models Not Shipped in This Repository'. Re-run `train.py --model bert` to reproduce them, "
            "or fetch them from wherever your team hosts the artifact (Git LFS / Hugging Face Hub)."
        )
    model = BertForSequenceClassification.from_pretrained(checkpoint).to(device).eval()
    # NOTE: artifacts/model_bert_tokenizer/ only contains tokenizer.json +
    # tokenizer_config.json (no vocab.txt) -- the notebook saved it via a slow
    # BertTokenizer instance, but transformers' save_pretrained() only wrote the
    # fast-tokenizer backing file. Loading it back with BertTokenizer (slow)
    # fails; AutoTokenizer / BertTokenizerFast load it correctly. Verified
    # empirically while building this repo -- see README "Notebook Fidelity Notes".
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path)

    _, _, test_df = drop_duplicates(load_split(args.test_file), load_split(args.test_file), load_split(args.test_file))
    test_df = test_df.copy()
    test_df["clean_text"] = test_df["text"].apply(build_bert_clean_text)

    from sklearn.preprocessing import LabelEncoder

    le = LabelEncoder()
    le.fit(SENTIMENT_LABELS)
    y_test = le.transform(test_df["label"])

    all_logits = []
    texts = test_df["clean_text"].tolist()
    with torch.no_grad():
        for i in range(0, len(texts), args.batch_size):
            batch = tokenizer(texts[i : i + args.batch_size], return_tensors="pt", padding="max_length",
                               truncation=True, max_length=MAX_LEN_BERT).to(device)
            all_logits.append(model(**batch).logits.cpu().numpy())
    logits = np.concatenate(all_logits, axis=0)
    from src.utils import softmax_np

    probs = softmax_np(logits, axis=1)
    preds = probs.argmax(axis=1)
    _report(y_test, preds, probs, le.classes_)


def _report(y_test, preds, probs, class_names) -> None:
    from sklearn.metrics import classification_report, confusion_matrix

    from src.utils import compute_full_metrics

    metrics = compute_full_metrics(y_test, preds, probs, class_names, model_name="model")
    print("\n" + "=" * 60)
    print("Sentio Evaluation Results")
    print("=" * 60)
    for k, v in metrics.items():
        if k != "Model":
            print(f"{k:>22}: {v:.4f}")
    print("\nConfusion Matrix:")
    print(confusion_matrix(y_test, preds))
    print("\nClassification Report:")
    print(classification_report(y_test, preds, target_names=class_names))


def main() -> None:
    args = parse_args()
    set_seed(42)
    checkpoint = args.checkpoint or DEFAULT_CHECKPOINTS[args.model]
    if checkpoint is None:
        raise ValueError(
            f"No shipped checkpoint exists for --model {args.model} (Logistic Regression was evaluated in "
            "the notebook but never persisted with joblib -- see README 'Notebook Fidelity Notes'). "
            "Pass --checkpoint after training your own with train.py, or choose a different --model."
        )
    checkpoint = Path(checkpoint)

    if args.model in CLASSIC_MODELS:
        evaluate_classic(args, checkpoint)
    elif args.model == "attention_nn":
        tokenizer_path = args.tokenizer or DEFAULT_TOKENIZERS["attention_nn"]
        evaluate_attention_nn(args, checkpoint, Path(tokenizer_path))
    elif args.model == "glove_bilstm":
        evaluate_glove_bilstm(args, checkpoint, args.train_file)
    elif args.model == "bert":
        tokenizer_path = args.tokenizer or DEFAULT_TOKENIZERS["bert"]
        evaluate_bert(args, checkpoint, Path(tokenizer_path))
    else:
        raise ValueError(f"Unknown model {args.model!r}")


if __name__ == "__main__":
    main()
