"""Download BERT model and NLTK data during Docker build."""

from transformers import BertForSequenceClassification, BertTokenizerFast
import nltk

# Download NLTK data
nltk.download("stopwords")
nltk.download("wordnet")
nltk.download("omw-1.4")

# Download base BERT model (will be fine-tuned at runtime if needed)
model_name = "bert-base-uncased"
tokenizer = BertTokenizerFast.from_pretrained(model_name)
model = BertForSequenceClassification.from_pretrained(
    model_name,
    num_labels=6,
    problem_type="single_label_classification",
    id2label={
        "0": "anger",
        "1": "fear",
        "2": "joy",
        "3": "love",
        "4": "sadness",
        "5": "surprise",
    },
    label2id={
        "anger": 0,
        "fear": 1,
        "joy": 2,
        "love": 3,
        "sadness": 4,
        "surprise": 5,
    },
)

model.save_pretrained("model_bert")
tokenizer.save_pretrained("model_bert")
print("Model downloaded successfully!")
