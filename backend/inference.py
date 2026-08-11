"""
BERT inference engine for Sentio sentiment analysis.
Loads the fine-tuned model and runs prediction.
"""

import os
from pathlib import Path
from typing import NamedTuple

import torch
from transformers import BertForSequenceClassification, BertTokenizerFast

from clean_text import clean_text

# Emotion labels — alphabetical order matching LabelEncoder from training
EMOTIONS = ["anger", "fear", "joy", "love", "sadness", "surprise"]

# Emoji mapping for each emotion
EMOTION_EMOJI = {
    "anger": "😠",
    "fear": "😨",
    "joy": "😊",
    "love": "🥰",
    "sadness": "😢",
    "surprise": "😲",
}

# Human-readable display names
EMOTION_DISPLAY = {
    "anger": "Angry",
    "fear": "Fear",
    "joy": "Happy",
    "love": "Love",
    "sadness": "Sad",
    "surprise": "Surprise",
}

# Color hex for each emotion (matches DESIGN-SYSTEM.md)
EMOTION_COLORS = {
    "anger": "#F87171",
    "fear": "#C4B5FD",
    "joy": "#6EE7B7",
    "love": "#F9A8D4",
    "sadness": "#93C5FD",
    "surprise": "#FDBA74",
}


class PredictionResult(NamedTuple):
    emotion: str
    confidence: float
    probabilities: dict[str, float]


class SentioModel:
    """Singleton BERT model wrapper for sentiment prediction."""

    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._device = torch.device("cpu")

    def load(self, model_dir: str | Path | None = None):
        """Load model and tokenizer from disk."""
        if self._model is not None:
            return  # already loaded

        if model_dir is None:
            model_dir = Path(__file__).parent / "model_bert"
        else:
            model_dir = Path(model_dir)

        print(f"[sentio] Loading BERT model from {model_dir}...")

        self._tokenizer = BertTokenizerFast.from_pretrained(str(model_dir))
        self._model = BertForSequenceClassification.from_pretrained(str(model_dir))
        self._model.to(self._device)
        self._model.eval()

        print(f"[sentio] Model loaded on {self._device}")

    def predict(self, text: str) -> PredictionResult:
        """
        Predict sentiment for a single text input.

        Args:
            text: Raw text input

        Returns:
            PredictionResult with emotion, confidence, and all probabilities
        """
        if self._model is None:
            raise RuntimeError("Model not loaded. Call load() first.")

        # Preprocess — light cleaning for BERT
        cleaned = clean_text(text)

        if not cleaned.strip():
            # Empty text after cleaning — return neutral/unknown
            return PredictionResult(
                emotion="joy",
                confidence=0.0,
                probabilities={e: round(1.0 / len(EMOTIONS), 4) for e in EMOTIONS},
            )

        # Tokenize
        inputs = self._tokenizer(
            cleaned,
            return_tensors="pt",
            truncation=True,
            max_length=128,
            padding=True,
        ).to(self._device)

        # Inference
        with torch.no_grad():
            outputs = self._model(**inputs)
            probs = torch.nn.functional.softmax(outputs.logits, dim=-1)

        # Convert to dict
        probs_np = probs.cpu().numpy().flatten()
        prob_dict = {
            EMOTIONS[i]: round(float(probs_np[i]), 4) for i in range(len(EMOTIONS))
        }

        # Get top prediction
        top_idx = int(probs_np.argmax())
        top_emotion = EMOTIONS[top_idx]
        top_confidence = float(probs_np[top_idx])

        return PredictionResult(
            emotion=top_emotion,
            confidence=round(top_confidence, 4),
            probabilities=prob_dict,
        )


# Global model instance
_model = SentioModel()


def get_model() -> SentioModel:
    """Get the global model instance, loading if needed."""
    _model.load()
    return _model


def predict(text: str) -> PredictionResult:
    """Convenience function — predict sentiment for text."""
    return get_model().predict(text)
