"""Shared PyTorch training/evaluation infrastructure for Sentio.

Ported from the notebook's "Shared PyTorch Utilities (Datasets, Training Loop,
Evaluation)" cell -- reused by both the Attention-NN and GloVe+BiLSTM models
(BERT uses HuggingFace's own ``Trainer`` instead, see ``train.py``).
"""
from __future__ import annotations

import os
import random
from typing import Any, Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset as TorchDataset

DEFAULT_SEED = 42


def set_seed(seed: int = DEFAULT_SEED) -> None:
    """Fixes Python/NumPy/PyTorch RNG state, matching the notebook's global SEED=42 setup."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def get_device(prefer_cuda: bool = True) -> torch.device:
    """CUDA if available and requested, otherwise CPU (matches the notebook's DEVICE global)."""
    if prefer_cuda and torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class SequenceDataset(TorchDataset):
    """Wraps a padded-id matrix and integer labels for use with DataLoader. Ported 1:1."""

    def __init__(self, sequences, labels) -> None:
        self.sequences = torch.as_tensor(sequences, dtype=torch.long)
        self.labels = torch.as_tensor(labels, dtype=torch.long)

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, idx):
        return self.sequences[idx], self.labels[idx]


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def class_weight_dict_to_array(weight_dict: dict[int, float]) -> np.ndarray:
    return np.array([weight_dict[i] for i in sorted(weight_dict)])


def train_torch_classifier(
    model: nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    class_weights: Optional[np.ndarray] = None,
    epochs: int = 50,
    patience: int = 5,
    lr: float = 1e-3,
    device: Optional[torch.device] = None,
    verbose: bool = True,
) -> tuple[nn.Module, dict[str, Any]]:
    """Generic supervised training loop: Adam + (optionally class-weighted) cross-entropy,
    with early stopping on validation loss and restoration of the best-epoch weights -- the
    PyTorch equivalent of Keras's ``EarlyStopping(monitor='val_loss', patience=..., restore_best_weights=True)``.

    Ported 1:1 from the notebook's ``train_torch_classifier``.
    """
    device = device or get_device()
    model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    weight_tensor = None
    if class_weights is not None:
        weight_tensor = torch.as_tensor(class_weights, dtype=torch.float32, device=device)
    criterion = nn.CrossEntropyLoss(weight=weight_tensor)

    best_val_loss = float("inf")
    best_val_acc_at_best = 0.0
    best_state = None
    epochs_without_improvement = 0
    history: dict[str, Any] = {"train_loss": [], "val_loss": [], "val_accuracy": []}

    for epoch in range(1, epochs + 1):
        model.train()
        train_loss_total = 0.0
        for batch_x, batch_y in train_loader:
            batch_x, batch_y = batch_x.to(device), batch_y.to(device)
            optimizer.zero_grad()
            logits = model(batch_x)
            loss = criterion(logits, batch_y)
            loss.backward()
            optimizer.step()
            train_loss_total += loss.item() * batch_x.size(0)
        train_loss = train_loss_total / len(train_loader.dataset)

        model.eval()
        val_loss_total = 0.0
        correct = 0
        with torch.no_grad():
            for batch_x, batch_y in val_loader:
                batch_x, batch_y = batch_x.to(device), batch_y.to(device)
                logits = model(batch_x)
                loss = criterion(logits, batch_y)
                val_loss_total += loss.item() * batch_x.size(0)
                correct += (logits.argmax(dim=1) == batch_y).sum().item()
        val_loss = val_loss_total / len(val_loader.dataset)
        val_acc = correct / len(val_loader.dataset)

        history["train_loss"].append(train_loss)
        history["val_loss"].append(val_loss)
        history["val_accuracy"].append(val_acc)

        if verbose:
            print(
                f"Epoch {epoch:3d}/{epochs} - train_loss: {train_loss:.4f} "
                f"- val_loss: {val_loss:.4f} - val_accuracy: {val_acc:.4f}"
            )

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_val_acc_at_best = val_acc
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= patience:
                if verbose:
                    print(f"Early stopping at epoch {epoch} (patience={patience}).")
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    history["best_val_loss"] = best_val_loss
    history["best_val_accuracy"] = best_val_acc_at_best
    return model, history


@torch.no_grad()
def predict_proba(model: nn.Module, data_loader: DataLoader, device: Optional[torch.device] = None) -> np.ndarray:
    """Softmax class-probability predictions for a DataLoader of ``(x, y)`` pairs."""
    device = device or get_device()
    model.to(device).eval()
    all_probs = []
    for batch_x, _ in data_loader:
        batch_x = batch_x.to(device)
        probs = F.softmax(model(batch_x), dim=1)
        all_probs.append(probs.cpu().numpy())
    return np.concatenate(all_probs, axis=0)


@torch.no_grad()
def evaluate_loss(
    model: nn.Module,
    data_loader: DataLoader,
    class_weights: Optional[np.ndarray] = None,
    device: Optional[torch.device] = None,
) -> tuple[float, float]:
    """Returns (loss, accuracy) for a DataLoader -- the PyTorch equivalent of ``model.evaluate()``."""
    device = device or get_device()
    model.to(device).eval()
    weight_tensor = None
    if class_weights is not None:
        weight_tensor = torch.as_tensor(class_weights, dtype=torch.float32, device=device)
    criterion = nn.CrossEntropyLoss(weight=weight_tensor)
    total_loss, correct, n = 0.0, 0, 0
    for batch_x, batch_y in data_loader:
        batch_x, batch_y = batch_x.to(device), batch_y.to(device)
        logits = model(batch_x)
        loss = criterion(logits, batch_y)
        total_loss += loss.item() * batch_x.size(0)
        correct += (logits.argmax(dim=1) == batch_y).sum().item()
        n += batch_x.size(0)
    return total_loss / n, correct / n


def softmax_np(x: np.ndarray, axis: int = -1) -> np.ndarray:
    """NumPy softmax, used to turn raw logits (e.g. from the HF Trainer) into probabilities."""
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / np.sum(e, axis=axis, keepdims=True)


def compute_full_metrics(
    y_true: np.ndarray, y_pred: np.ndarray, y_proba: np.ndarray, class_names, model_name: str = "Model"
) -> dict[str, Any]:
    """Accuracy, macro precision/recall/F1, multi-class ROC-AUC (OvR), macro PR-AUC (average
    precision), and Matthews Correlation Coefficient -- the full evaluation suite the notebook
    computes for every neural model. Ported from ``compute_full_metrics`` (plotting omitted;
    see the notebook / README for confusion-matrix and calibration figures)."""
    from sklearn.metrics import (
        accuracy_score,
        average_precision_score,
        f1_score,
        matthews_corrcoef,
        precision_score,
        recall_score,
        roc_auc_score,
    )
    from sklearn.preprocessing import label_binarize

    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    y_proba = np.asarray(y_proba)

    metrics: dict[str, Any] = {
        "Model": model_name,
        "Accuracy": accuracy_score(y_true, y_pred),
        "Precision (macro)": precision_score(y_true, y_pred, average="macro", zero_division=0),
        "Recall (macro)": recall_score(y_true, y_pred, average="macro", zero_division=0),
        "F1 (macro)": f1_score(y_true, y_pred, average="macro"),
        "MCC": matthews_corrcoef(y_true, y_pred),
    }
    try:
        y_true_bin = label_binarize(y_true, classes=np.arange(len(class_names)))
        metrics["ROC-AUC (macro, OvR)"] = roc_auc_score(y_true_bin, y_proba, average="macro", multi_class="ovr")
        metrics["PR-AUC (macro)"] = average_precision_score(y_true_bin, y_proba, average="macro")
    except ValueError as e:
        metrics["ROC-AUC (macro, OvR)"] = float("nan")
        metrics["PR-AUC (macro)"] = float("nan")
        print(f"[{model_name}] ROC-AUC/PR-AUC skipped: {e}")
    return metrics
