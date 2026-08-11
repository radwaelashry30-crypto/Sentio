"""
Text preprocessing for Sentio sentiment analysis.
Extracted from the training notebook — applies the same cleaning
pipeline used during BERT fine-tuning.
"""

import re


def is_only_mentions(text: str) -> bool:
    """Check if text consists solely of @mentions."""
    return bool(re.fullmatch(r"(@\w+\s*)+", text.strip()))


def clean_text(
    text: str,
    remove_numbers: bool = False,
    remove_stopwords: bool = False,
    remove_mentions: bool = True,
    remove_hashtags: bool = True,
    remove_urls: bool = True,
    remove_only_mentions: bool = True,
    lemmatize: bool = False,
    remove_punctuation: bool = True,
) -> str:
    """
    Clean text input for BERT inference.

    BERT preprocessing is light — we keep most structure intact.
    The model learned to handle punctuation, casing, etc. during fine-tuning.
    """
    if not isinstance(text, str):
        return ""

    # Remove if only mentions
    if remove_only_mentions and is_only_mentions(text):
        return ""

    text = text.lower()

    # Remove mentions
    if remove_mentions:
        text = re.sub(r"@\w+", "", text)

    # Remove hashtags
    if remove_hashtags:
        text = re.sub(r"#\w+", "", text)

    # Remove URLs
    if remove_urls:
        text = re.sub(r"http\S+|www\.\S+", "", text)

    # Remove special symbols
    if remove_punctuation:
        text = re.sub(r"[^\w\s.,!?''\"…-]", "", text)

    # Remove numbers
    if remove_numbers:
        text = re.sub(r"\d+", "", text)

    # Remove extra spaces
    text = re.sub(r"\s+", " ", text).strip()

    # Remove stopwords (typically NOT used for BERT)
    if remove_stopwords:
        from nltk.corpus import stopwords
        stop_words = set(stopwords.words("english"))
        words = text.split()
        words = [w for w in words if w not in stop_words]
        text = " ".join(words)

    # Lemmatize (typically NOT used for BERT)
    if lemmatize:
        from nltk.stem import WordNetLemmatizer

        lemmatizer = WordNetLemmatizer()
        words = text.split()
        words = [lemmatizer.lemmatize(w) for w in words]
        text = " ".join(words)

    return text
