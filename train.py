#!/usr/bin/env python
"""Sentio training script.

Reproduces the notebook's model-training cells for a single selected model
family. Mirrors TruthLens's ``train.py`` pattern: a ``--model`` flag selects
which architecture to (re)train from data/{train,val,test}.txt.

Examples:
    python train.py --model svm
    python train.py --model attention_nn --epochs 50 --patience 5
    python train.py --model glove_bilstm --epochs 50 --patience 15
    python train.py --model bert --epochs 3 --batch-size 16
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.preprocessing import (
    MAXLEN_BPE_GLOVE,
    MAX_LEN_BERT,
    RANDOM_SEED,
    balance_with_augmentation,
    build_bert_clean_text,
    build_bpe_clean_text,
    build_glove_clean_text,
    build_tfidf_clean_text,
    drop_duplicates,
    load_splits,
)
from src.tokenizer import WordLevelTokenizer, train_and_tokenize_bpe
from src.models import AttentionSentimentClassifier, GloveBiLSTMClassifier
from src.utils import (
    SequenceDataset,
    compute_full_metrics,
    count_parameters,
    get_device,
    predict_proba,
    set_seed,
    train_torch_classifier,
)

CLASSIC_MODELS = {"logreg", "decision_tree", "random_forest", "svm"}
NEURAL_MODELS = {"attention_nn", "glove_bilstm", "bert"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a Sentio emotion classifier.")
    parser.add_argument("--train-file", type=Path, default=Path("data/train.txt"))
    parser.add_argument("--val-file", type=Path, default=Path("data/val.txt"))
    parser.add_argument("--test-file", type=Path, default=Path("data/test.txt"))
    parser.add_argument(
        "--model",
        type=str,
        default="svm",
        choices=sorted(CLASSIC_MODELS | NEURAL_MODELS),
        help="Which model family to train.",
    )
    parser.add_argument("--use-augmentation", action="store_true",
                         help="Balance classes via WordNet-synonym augmentation before training "
                              "(classic/attention_nn only -- matches the notebook's augmented-data run).")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--patience", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=RANDOM_SEED)
    parser.add_argument("--models-dir", type=Path, default=Path("models"))
    parser.add_argument("--artifacts-dir", type=Path, default=Path("artifacts"))
    parser.add_argument("--results-dir", type=Path, default=Path("results"))
    parser.add_argument("--no-cuda", action="store_true")
    return parser.parse_args()


def load_clean_splits(args):
    train_df, val_df, test_df = load_splits(args.train_file, args.val_file, args.test_file)
    return drop_duplicates(train_df, val_df, test_df)


# --------------------------------------------------------------------------- #
# Classic ML (TF-IDF + GridSearchCV)
# --------------------------------------------------------------------------- #

CLASSIC_PARAM_GRIDS = {
    "logreg": ("LogisticRegression", {"C": [0.1, 1, 10], "max_iter": [100, 200, 500], "class_weight": [None, "balanced"]}),
    "decision_tree": ("DecisionTreeClassifier", {"max_depth": [None, 10, 20, 50], "min_samples_split": [2, 5, 10],
                                                  "min_samples_leaf": [1, 2, 5], "class_weight": [None, "balanced"]}),
    "random_forest": ("RandomForestClassifier", {"n_estimators": [100, 200], "max_depth": [None, 20, 50],
                                                  "class_weight": [None, "balanced"], "min_samples_split": [2, 5],
                                                  "min_samples_leaf": [1, 2]}),
    "svm": ("LinearSVC", {"C": [0.1, 1, 10], "class_weight": [None, "balanced"], "max_iter": [1000, 2000]}),
}


def build_classic_estimator(name: str, seed: int):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.svm import LinearSVC
    from sklearn.tree import DecisionTreeClassifier

    if name == "logreg":
        return LogisticRegression(solver="lbfgs", random_state=seed)
    if name == "decision_tree":
        return DecisionTreeClassifier(random_state=seed)
    if name == "random_forest":
        return RandomForestClassifier(random_state=seed)
    if name == "svm":
        return LinearSVC(dual=False, random_state=seed)
    raise ValueError(name)


def train_classic(args) -> None:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics import accuracy_score, classification_report, f1_score
    from sklearn.model_selection import GridSearchCV
    from sklearn.preprocessing import LabelEncoder

    train_df, val_df, test_df = load_clean_splits(args)
    train_df = train_df.copy()
    val_df = val_df.copy()
    test_df = test_df.copy()
    train_df["clean_text"] = train_df["text"].apply(build_tfidf_clean_text)
    val_df["clean_text"] = val_df["text"].apply(build_tfidf_clean_text)
    test_df["clean_text"] = test_df["text"].apply(build_tfidf_clean_text)

    if args.use_augmentation:
        train_df = balance_with_augmentation(train_df, seed=args.seed)
        text_col = "final_text" if "final_text" in train_df.columns else "clean_text"
    else:
        text_col = "clean_text"

    vectorizer = TfidfVectorizer(max_features=10_000, ngram_range=(1, 2))
    X_train = vectorizer.fit_transform(train_df[text_col])
    X_val = vectorizer.transform(val_df["clean_text"])
    X_test = vectorizer.transform(test_df["clean_text"])

    le = LabelEncoder()
    y_train = le.fit_transform(train_df["label"])
    y_val = le.transform(val_df["label"])
    y_test = le.transform(test_df["label"])

    estimator = build_classic_estimator(args.model, args.seed)
    _, param_grid = CLASSIC_PARAM_GRIDS[args.model]
    grid = GridSearchCV(estimator, param_grid, scoring="f1_weighted", cv=3, verbose=1, n_jobs=-1)
    grid.fit(X_train, y_train)
    best = grid.best_estimator_
    print(f"Best params: {grid.best_params_}")
    print(f"Best CV score (f1_weighted): {grid.best_score_:.4f}")

    val_pred = best.predict(X_val)
    print(f"Validation accuracy: {accuracy_score(y_val, val_pred):.4f}")
    print(f"Validation F1 (weighted): {f1_score(y_val, val_pred, average='weighted'):.4f}")
    print(classification_report(y_val, val_pred, target_names=le.classes_))

    test_pred = best.predict(X_test)
    print(f"Test accuracy: {accuracy_score(y_test, test_pred):.4f}")

    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.artifacts_dir / f"{args.model}{'_aug' if args.use_augmentation else ''}.pkl"
    joblib.dump(best, out_path)
    print(f"Saved -> {out_path}")


# --------------------------------------------------------------------------- #
# Attention NN (BPE tokenizer)
# --------------------------------------------------------------------------- #

NN_SEARCH_SPACE = {
    "embedding_dim": [64, 128, 256],
    "num_heads": [4, 8, 16],
    "dense_units_1": [128, 192, 256, 320, 384, 448, 512],
    "dense_units_2": [64, 128, 192, 256],
    "embedding_dropout": [0.1, 0.2, 0.3, 0.4, 0.5],
    "dense_dropout": [0.1, 0.2, 0.3, 0.4, 0.5],
    "learning_rate": [1e-2, 1e-3, 1e-4],
}
# Best configuration found by the notebook's 5-trial random search (class-weighted,
# non-augmented run) -- the architecture behind the shipped models/best_model_nn.pt:
NN_BEST_HPARAMS = {
    "embedding_dim": 256, "num_heads": 16, "dense_units_1": 512, "dense_units_2": 128,
    "embedding_dropout": 0.4, "dense_dropout": 0.4, "learning_rate": 1e-4,
}


def train_attention_nn(args) -> None:
    from sklearn.preprocessing import LabelEncoder
    from sklearn.utils import class_weight
    from torch.utils.data import DataLoader

    set_seed(args.seed)
    device = get_device(prefer_cuda=not args.no_cuda)
    train_df, val_df, test_df = load_clean_splits(args)
    train_df = train_df.copy(); val_df = val_df.copy(); test_df = test_df.copy()
    train_df["clean_text"] = train_df["text"].apply(build_bpe_clean_text)
    val_df["clean_text"] = val_df["text"].apply(build_bpe_clean_text)
    test_df["clean_text"] = test_df["text"].apply(build_bpe_clean_text)

    if args.use_augmentation:
        train_df = balance_with_augmentation(train_df, seed=args.seed)
        train_text_col = "final_text" if "final_text" in train_df.columns else "clean_text"
    else:
        train_text_col = "clean_text"

    tokenizer, pad_id, train_padded, val_padded, test_padded = train_and_tokenize_bpe(
        train_df[train_text_col], val_df["clean_text"], test_df["clean_text"], maxlen=MAXLEN_BPE_GLOVE
    )
    le = LabelEncoder()
    y_train = le.fit_transform(train_df["label"])
    y_val = le.transform(val_df["label"])
    y_test = le.transform(test_df["label"])
    vocab_size = int(train_padded.max() + 1)

    train_loader = DataLoader(SequenceDataset(train_padded, y_train), batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(SequenceDataset(val_padded, y_val), batch_size=args.batch_size, shuffle=False)
    test_loader = DataLoader(SequenceDataset(test_padded, y_test), batch_size=args.batch_size, shuffle=False)

    class_weights_arr = class_weight.compute_class_weight("balanced", classes=np.unique(y_train), y=y_train)

    model = AttentionSentimentClassifier(vocab_size=vocab_size, **NN_BEST_HPARAMS_WITHOUT_LR())
    print(model)
    print(f"Trainable parameters: {count_parameters(model):,}")

    model, history = train_torch_classifier(
        model, train_loader, val_loader, class_weights=class_weights_arr,
        epochs=args.epochs, patience=args.patience, lr=NN_BEST_HPARAMS["learning_rate"], device=device,
    )

    test_probs = predict_proba(model, test_loader, device=device)
    test_preds = test_probs.argmax(axis=1)
    metrics = compute_full_metrics(y_test, test_preds, test_probs, le.classes_, model_name="AttentionNN")
    print(metrics)

    args.models_dir.mkdir(parents=True, exist_ok=True)
    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    suffix = "_aug" if args.use_augmentation else ""
    import torch
    torch.save(model.state_dict(), args.models_dir / f"attention_nn{suffix}.pt")
    tokenizer.save(str(args.artifacts_dir / f"bpe_tokenizer{suffix}.json"))
    print(f"Saved -> {args.models_dir / f'attention_nn{suffix}.pt'}")


def NN_BEST_HPARAMS_WITHOUT_LR():
    return {k: v for k, v in NN_BEST_HPARAMS.items() if k != "learning_rate"}


# --------------------------------------------------------------------------- #
# GloVe + BiLSTM
# --------------------------------------------------------------------------- #

def train_glove_bilstm(args) -> None:
    from sklearn.preprocessing import LabelEncoder
    from sklearn.utils import class_weight
    from torch.utils.data import DataLoader

    set_seed(args.seed)
    device = get_device(prefer_cuda=not args.no_cuda)
    train_df, val_df, test_df = load_clean_splits(args)
    train_df = train_df.copy(); val_df = val_df.copy(); test_df = test_df.copy()
    train_df["text_clean"] = train_df["text"].apply(build_glove_clean_text)
    val_df["text_clean"] = val_df["text"].apply(build_glove_clean_text)
    test_df["text_clean"] = test_df["text"].apply(build_glove_clean_text)

    tokenizer = WordLevelTokenizer(oov_token="[OOV]")
    tokenizer.fit_on_texts(train_df["text_clean"])
    vocab_size = len(tokenizer.word_index) + 1

    print("Loading GloVe vectors (glove-wiki-gigaword-200) via gensim.downloader ...")
    import gensim.downloader as api

    glove_vectors = api.load("glove-wiki-gigaword-200")
    embedding_dim = 200
    embedding_matrix = np.zeros((vocab_size, embedding_dim))
    found = 0
    rng = np.random.RandomState(args.seed)
    for word, i in tokenizer.word_index.items():
        if word in glove_vectors:
            embedding_matrix[i] = glove_vectors[word]
            found += 1
        else:
            embedding_matrix[i] = rng.normal(scale=0.6, size=(embedding_dim,))
    print(f"GloVe coverage: {found}/{vocab_size} ({100 * found / vocab_size:.1f}%)")

    train_padded = tokenizer.encode(train_df["text_clean"], maxlen=MAXLEN_BPE_GLOVE)
    val_padded = tokenizer.encode(val_df["text_clean"], maxlen=MAXLEN_BPE_GLOVE)
    test_padded = tokenizer.encode(test_df["text_clean"], maxlen=MAXLEN_BPE_GLOVE)

    le = LabelEncoder()
    y_train = le.fit_transform(train_df["label"])
    y_val = le.transform(val_df["label"])
    y_test = le.transform(test_df["label"])

    train_loader = DataLoader(SequenceDataset(train_padded, y_train), batch_size=64, shuffle=True)
    val_loader = DataLoader(SequenceDataset(val_padded, y_val), batch_size=64, shuffle=False)
    test_loader = DataLoader(SequenceDataset(test_padded, y_test), batch_size=64, shuffle=False)

    class_weights_arr = class_weight.compute_class_weight("balanced", classes=np.unique(y_train), y=y_train)

    model = GloveBiLSTMClassifier(embedding_matrix, hidden_sizes=(256, 128, 128), dropout=0.2)
    print(f"Trainable parameters: {count_parameters(model):,}")

    model, history = train_torch_classifier(
        model, train_loader, val_loader, class_weights=class_weights_arr,
        epochs=args.epochs, patience=args.patience, lr=0.005, device=device,
    )

    test_probs = predict_proba(model, test_loader, device=device)
    test_preds = test_probs.argmax(axis=1)
    metrics = compute_full_metrics(y_test, test_preds, test_probs, le.classes_, model_name="GloVeBiLSTM")
    print(metrics)

    args.models_dir.mkdir(parents=True, exist_ok=True)
    import torch
    torch.save(model.state_dict(), args.models_dir / "glove_bilstm.pt")
    print(f"Saved -> {args.models_dir / 'glove_bilstm.pt'}")


# --------------------------------------------------------------------------- #
# BERT fine-tuning
# --------------------------------------------------------------------------- #

def train_bert(args) -> None:
    from datasets import Dataset
    from sklearn.metrics import accuracy_score, average_precision_score, f1_score, matthews_corrcoef, precision_score, recall_score, roc_auc_score
    from sklearn.preprocessing import LabelEncoder, label_binarize
    from transformers import BertForSequenceClassification, BertTokenizer, Trainer, TrainingArguments

    from src.utils import softmax_np

    train_df, val_df, test_df = load_clean_splits(args)
    train_df = train_df.copy(); val_df = val_df.copy(); test_df = test_df.copy()
    train_df["clean_text"] = train_df["text"].apply(build_bert_clean_text)
    val_df["clean_text"] = val_df["text"].apply(build_bert_clean_text)
    test_df["clean_text"] = test_df["text"].apply(build_bert_clean_text)

    le = LabelEncoder()
    train_df["label_id"] = le.fit_transform(train_df["label"])
    val_df["label_id"] = le.transform(val_df["label"])
    test_df["label_id"] = le.transform(test_df["label"])
    id2label = dict(enumerate(le.classes_))
    label2id = {v: k for k, v in id2label.items()}

    tokenizer = BertTokenizer.from_pretrained("bert-base-uncased")
    model = BertForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=len(label2id))

    def tokenize_fn(examples):
        return tokenizer(examples["clean_text"], padding="max_length", truncation=True, max_length=MAX_LEN_BERT)

    rename = {"label_id": "labels"}
    train_ds = Dataset.from_pandas(train_df.rename(columns=rename)).map(tokenize_fn, batched=True)
    val_ds = Dataset.from_pandas(val_df.rename(columns=rename)).map(tokenize_fn, batched=True)
    test_ds = Dataset.from_pandas(test_df.rename(columns=rename)).map(tokenize_fn, batched=True)

    def compute_metrics(eval_pred):
        logits, labels = eval_pred
        probs = softmax_np(logits, axis=1)
        preds = np.argmax(logits, axis=1)
        metrics = {
            "accuracy": accuracy_score(labels, preds),
            "f1": f1_score(labels, preds, average="macro"),
            "precision": precision_score(labels, preds, average="macro", zero_division=0),
            "recall": recall_score(labels, preds, average="macro", zero_division=0),
            "mcc": matthews_corrcoef(labels, preds),
        }
        try:
            labels_bin = label_binarize(labels, classes=np.arange(probs.shape[1]))
            metrics["roc_auc"] = roc_auc_score(labels_bin, probs, average="macro", multi_class="ovr")
            metrics["pr_auc"] = average_precision_score(labels_bin, probs, average="macro")
        except ValueError:
            metrics["roc_auc"] = float("nan")
            metrics["pr_auc"] = float("nan")
        return metrics

    training_args = TrainingArguments(
        output_dir=str(args.results_dir),
        eval_strategy="epoch",
        save_strategy="epoch",
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        num_train_epochs=args.epochs,
        learning_rate=2e-5,
        weight_decay=0.01,
        logging_dir="./logs",
        load_best_model_at_end=True,
        report_to="none",
        metric_for_best_model="eval_loss",
        greater_is_better=False,
    )
    trainer = Trainer(model=model, args=training_args, train_dataset=train_ds, eval_dataset=val_ds, compute_metrics=compute_metrics)
    trainer.train()

    test_results = trainer.evaluate(test_ds)
    print(f"Test results: {test_results}")

    args.models_dir.mkdir(parents=True, exist_ok=True)
    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    model.config.id2label = {int(k): str(v) for k, v in id2label.items()}
    model.config.label2id = {str(k): int(v) for k, v in label2id.items()}
    model.save_pretrained(args.models_dir / "model_bert")
    tokenizer.save_pretrained(args.artifacts_dir / "model_bert_tokenizer")
    print(f"Saved -> {args.models_dir / 'model_bert'}")


def main() -> None:
    args = parse_args()
    if args.model in CLASSIC_MODELS:
        train_classic(args)
    elif args.model == "attention_nn":
        train_attention_nn(args)
    elif args.model == "glove_bilstm":
        train_glove_bilstm(args)
    elif args.model == "bert":
        train_bert(args)
    else:
        raise ValueError(f"Unknown model {args.model!r}")


if __name__ == "__main__":
    main()
