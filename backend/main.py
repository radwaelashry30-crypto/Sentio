"""
Sentio — FastAPI Backend
BERT-based sentiment analysis API.

Run: uvicorn main:app --host 0.0.0.0 --port 8000
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from inference import (
    EMOTION_COLORS,
    EMOTION_DISPLAY,
    EMOTION_EMOJI,
    EMOTIONS,
    predict,
)

# NLTK data not needed for BERT inference — stopwords/lemmatization disabled

# ── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Sentio API",
    description="BERT-based sentiment analysis — understand the feeling behind every word.",
    version="1.0.0",
)

# CORS — allow Next.js dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Schemas ──────────────────────────────────────────────────────────────────


class PredictRequest(BaseModel):
    text: str = Field(
        ..., min_length=1, max_length=5000, description="Text to analyze"
    )


class EmotionScore(BaseModel):
    name: str
    display_name: str
    emoji: str
    color: str
    score: float


class PredictResponse(BaseModel):
    emotion: str
    display_name: str
    emoji: str
    color: str
    confidence: float
    scores: list[EmotionScore]


# ── Routes ───────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok", "model": "sentio-bert"}


@app.post("/predict", response_model=PredictResponse)
def predict_sentiment(req: PredictRequest):
    """
    Analyze sentiment of text input.

    Returns the predicted emotion, confidence score,
    and all emotion probabilities.
    """
    result = predict(req.text)

    # Build scored list sorted by score descending
    scores = [
        EmotionScore(
            name=emotion,
            display_name=EMOTION_DISPLAY[emotion],
            emoji=EMOTION_EMOJI[emotion],
            color=EMOTION_COLORS[emotion],
            score=result.probabilities[emotion],
        )
        for emotion in EMOTIONS
    ]
    scores.sort(key=lambda s: s.score, reverse=True)

    return PredictResponse(
        emotion=result.emotion,
        display_name=EMOTION_DISPLAY[result.emotion],
        emoji=EMOTION_EMOJI[result.emotion],
        color=EMOTION_COLORS[result.emotion],
        confidence=result.confidence,
        scores=scores,
    )


# ── Startup ──────────────────────────────────────────────────────────────────


@app.on_event("startup")
def startup():
    """Pre-load the BERT model on server start."""
    from inference import get_model

    get_model()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
