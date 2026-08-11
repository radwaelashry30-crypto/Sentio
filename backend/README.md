# Sentio Backend (FastAPI)

The serving layer for Sentio: a FastAPI app that wraps a BERT sequence
classifier behind `POST /predict`, for the deployed frontend
(`sentio-chi.vercel.app`) to call.

Merged into this repository from the previously separate `sentio-api`
repo, alongside the model research/training code in the repo root, so the
model and the service that serves it live in one place.

## API

```
GET  /health   -> {"status": "ok", "model": "sentio-bert"}
POST /predict  -> {"text": "..."}
                   {"emotion": "joy", "display_name": "Happy", "emoji": "😊",
                    "color": "#6EE7B7", "confidence": 0.91,
                    "scores": [{"name": "joy", ...}, ...]}
```

CORS is currently open to `localhost:3000` / `127.0.0.1:3000` (Next.js dev
server) in [`main.py`](main.py) — update `allow_origins` there for
production frontend origins.

## Known Issue: served weights are not the fine-tuned checkpoint

**[`download_model.py`](download_model.py) downloads the base
`bert-base-uncased` checkpoint from Hugging Face and attaches a freshly
initialized 6-way classification head** (with the correct `id2label` /
`label2id` emotion names, but random weights on that head — it is never
trained). This is what [`Dockerfile`](Dockerfile) runs at build time:

```dockerfile
RUN python download_model.py
```

This is **not** the fine-tuned checkpoint that the root repo's
`notebooks/` and `train.py --model bert` actually produce, which scored
92.75% test accuracy (see the root [`README.md`](../README.md#results)).
An untrained classification head on top of pretrained BERT encoder weights
will not reproduce that accuracy — its predictions on `/predict` should be
assumed close to chance across the 6 emotions until this is fixed.

This mirrors a gap already documented in the root README's
["Models Not Shipped"](../README.md#models-not-shipped-in-this-repository)
section: the real fine-tuned weights (`model.safetensors`, ~418 MB) were
never committed to either repo because they exceed GitHub's 100 MB/file
limit. `download_model.py` was written against the base checkpoint as a
placeholder and never updated once real weights existed.

### To actually serve the fine-tuned model, pick one:

1. **Git LFS.** Track `backend/model_bert/model.safetensors` with
   [Git LFS](https://git-lfs.github.com/) and commit the real weights
   (produced by `python train.py --model bert` at the repo root, or copy
   an existing `model.safetensors` from a prior training run). Update
   `download_model.py` to skip downloading when a local checkpoint is
   already present.
2. **Hugging Face Hub.** Upload the fine-tuned model to a HF Hub model
   repo (public or private, with a token), then change
   `download_model.py` to `from_pretrained("your-username/sentio-bert")`
   instead of `"bert-base-uncased"`.
3. **Retrain at build time.** Run the training pipeline as part of the
   Docker build (slow, requires the training data and a GPU to be
   practical) — not recommended for a build step.

Options 1 and 2 both require an explicit decision (LFS storage/bandwidth
quota, or a Hugging Face account/token) that this merge intentionally
leaves to the project owner rather than assuming.

## Running Locally

```bash
cd backend
pip install -r requirements.txt
python download_model.py   # downloads bert-base-uncased -- see Known Issue above
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Docker

Build context is `backend/` (not the repo root):

```bash
docker build -t sentio-api -f backend/Dockerfile backend/
docker run -p 8000:8000 sentio-api
```

## Files

| File | Purpose |
|---|---|
| `main.py` | FastAPI app: `/health`, `/predict` |
| `inference.py` | `SentioModel` — loads `model_bert/`, tokenizes, runs inference |
| `clean_text.py` | Light text cleaning applied before tokenization |
| `download_model.py` | Fetches the BERT checkpoint at Docker build time — see Known Issue above |
| `model_bert/` | Model config + tokenizer (weights are downloaded at build time, not committed) |
| `Dockerfile` | Container build for deployment |
