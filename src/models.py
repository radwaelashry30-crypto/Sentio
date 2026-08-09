"""PyTorch model architectures extracted from the Sentio research notebook.

Ported 1:1 from ``notebooks/tf-idf-to-transformers-94-sentiment-accuracy-PYTORCH-VISUALIZED.ipynb``
("Neural Network Model & Tuning" and "GloVe Embeddings" sections). Both
classes return raw logits over 6 classes; ``nn.CrossEntropyLoss`` (which
applies log-softmax internally) is used for training, and callers should
apply ``torch.softmax`` only at evaluation/inference time.

BERT fine-tuning uses ``transformers.BertForSequenceClassification`` directly
(no custom class needed) -- see ``train.py --model bert`` / ``inference.py``.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_CLASSES = 6


class AttentionSentimentClassifier(nn.Module):
    """Embedding -> MultiHeadAttention (self-attention) -> LayerNorm -> Dense ->
    Dropout -> Dense -> GlobalAveragePooling1D -> Dense (classifier).

    Native PyTorch port of the notebook's original Keras functional model, fed
    by the BPE tokenizer (``src/tokenizer.py``). This is the architecture
    behind the shipped ``models/best_model_nn.pt`` checkpoint, selected by a
    5-trial random hyperparameter search (see ``NN_SEARCH_SPACE`` in
    ``train.py``):
    ``embedding_dim=256, num_heads=16, dense_units_1=512, dense_units_2=128,
    embedding_dropout=0.4, dense_dropout=0.4`` (3,021,702 trainable parameters).

    NOTE: ``nn.MultiheadAttention`` requires ``embed_dim % num_heads == 0``,
    unlike Keras's ``MultiHeadAttention``, which uses an independent
    ``key_dim`` per head regardless of the embedding size. The hyperparameter
    search space therefore restricts ``num_heads`` to divisors shared by
    every ``embedding_dim`` candidate (dropping the original 12, which does
    not evenly divide 64/128/256) and drops the separate ``key_dim``
    hyperparameter, since PyTorch derives the per-head dimension
    automatically. This is the one architecture-level change forced by a
    real framework difference; every other hyperparameter is unchanged.
    """

    def __init__(
        self,
        vocab_size: int,
        embedding_dim: int = 128,
        num_heads: int = 8,
        dense_units_1: int = 256,
        dense_units_2: int = 128,
        dropout_embedding: float = 0.3,
        dropout_dense: float = 0.3,
        num_classes: int = NUM_CLASSES,
    ) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, embedding_dim)
        self.embedding_dropout = nn.Dropout(dropout_embedding)
        self.attention = nn.MultiheadAttention(embed_dim=embedding_dim, num_heads=num_heads, batch_first=True)
        self.layer_norm = nn.LayerNorm(embedding_dim, eps=1e-6)
        self.dense1 = nn.Linear(embedding_dim, dense_units_1)
        self.dense_dropout = nn.Dropout(dropout_dense)
        self.dense2 = nn.Linear(dense_units_1, dense_units_2)
        self.classifier = nn.Linear(dense_units_2, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        emb = self.embedding(x)  # (batch, seq, embed_dim)
        emb = self.embedding_dropout(emb)
        attn_out, _ = self.attention(emb, emb, emb, need_weights=False)
        x = self.layer_norm(attn_out)
        x = F.relu(self.dense1(x))
        x = self.dense_dropout(x)
        x = F.relu(self.dense2(x))
        x = x.mean(dim=1)  # GlobalAveragePooling1D
        return self.classifier(x)


class GloveBiLSTMClassifier(nn.Module):
    """Frozen GloVe Embedding -> three stacked Bidirectional LSTM layers
    (256 -> 128 -> 128 units) -> Dense classifier.

    Native PyTorch port of the notebook's original Keras Sequential model.
    This is the architecture behind the shipped ``models/model_glove.pt``
    checkpoint: ``embedding_dim=200`` (``glove-wiki-gigaword-200``),
    ``hidden_sizes=(256, 128, 128)``, ``dropout=0.2``, vocab_size=15,199
    (word-level tokenizer fit on the training split; 14,198/15,199 = 93.4%
    of the vocabulary had a pretrained GloVe vector, the rest randomly
    initialized), 1,992,198 trainable parameters (the frozen embedding table
    adds ~3.04M non-trainable parameters on top, all still saved in the
    checkpoint's state_dict since PyTorch checkpoints all buffers/parameters
    regardless of ``requires_grad``).

    NOTE: PyTorch's ``nn.LSTM`` has no built-in ``recurrent_dropout`` (Keras's
    variational dropout applied to the recurrent connections at every
    timestep) -- there is no equivalent primitive in ``torch.nn``. As the
    closest practical approximation, regular ``nn.Dropout`` is applied to the
    output of each stacked LSTM, the standard idiom for porting this kind of
    architecture; this is documented here since it is not a bit-for-bit
    equivalent of Keras's ``recurrent_dropout``.
    """

    def __init__(
        self,
        embedding_matrix,
        hidden_sizes: tuple[int, int, int] = (256, 128, 128),
        dropout: float = 0.2,
        num_classes: int = NUM_CLASSES,
        pad_idx: int = 0,
    ) -> None:
        super().__init__()
        vocab_size, embedding_dim = embedding_matrix.shape
        self.embedding = nn.Embedding.from_pretrained(
            torch.tensor(embedding_matrix, dtype=torch.float32),
            freeze=True,
            padding_idx=pad_idx,
        )
        self.lstm1 = nn.LSTM(embedding_dim, hidden_sizes[0], batch_first=True, bidirectional=True)
        self.lstm2 = nn.LSTM(hidden_sizes[0] * 2, hidden_sizes[1], batch_first=True, bidirectional=True)
        self.lstm3 = nn.LSTM(hidden_sizes[1] * 2, hidden_sizes[2], batch_first=True, bidirectional=True)
        self.dropout1 = nn.Dropout(dropout)
        self.dropout2 = nn.Dropout(dropout)
        self.dropout3 = nn.Dropout(dropout)
        self.classifier = nn.Linear(hidden_sizes[2] * 2, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        emb = self.embedding(x)
        out, _ = self.lstm1(emb)
        out = self.dropout1(out)
        out, _ = self.lstm2(out)
        out = self.dropout2(out)
        out, (h_n, _) = self.lstm3(out)
        out = self.dropout3(out)
        final_hidden = torch.cat((h_n[-2], h_n[-1]), dim=1)  # concat final fwd/bwd hidden states
        return self.classifier(final_hidden)


_MODEL_BUILDERS = {
    "attention_nn": AttentionSentimentClassifier,
}


def get_torch_model(model_name: str, **kwargs) -> nn.Module:
    """Small factory for the two custom nn.Module architectures.

    ``GloveBiLSTMClassifier`` is intentionally not included here since it
    requires a pre-built embedding matrix, not just a vocab size -- construct
    it directly. ``bert`` is not a custom ``nn.Module``; use
    ``transformers.BertForSequenceClassification.from_pretrained`` instead.
    """
    name = model_name.lower().strip()
    if name not in _MODEL_BUILDERS:
        raise ValueError(f"Unknown torch model_name={model_name!r}. Expected one of {list(_MODEL_BUILDERS)}.")
    return _MODEL_BUILDERS[name](**kwargs)
