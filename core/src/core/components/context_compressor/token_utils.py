"""Vinv Engine / components / context_compressor / token_utils — Token counting utilities.

Provides:
    - count_tokens()       : Accurate token estimation via tiktoken
    - estimate_tokens_fast(): Fast approximation (~4 chars per token)
    - fit_for_logging()    : Identity function for logging (no truncation)

ZERO TRUNCATION POLICY: smart_content_fit(), truncate_to_token_limit(),
and fit_for_memory() have been removed. Content is either compressed
via the AIOC algorithm or an InfeasibleCompressionError is raised.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

_tokenizer = None
_tokenizer_resolved = False


def _get_tokenizer():
    """Lazy-load tiktoken cl100k_base encoder (single attempt).

    Catches SSL errors from corporate proxies (Zscaler) that intercept the
    tiktoken encoding download. Falls back to char-based estimation.
    The result is cached so a failed download is never retried.
    """
    global _tokenizer, _tokenizer_resolved
    if _tokenizer_resolved:
        return _tokenizer
    try:
        import tiktoken
        import os

        if not os.environ.get("TIKTOKEN_CACHE_DIR"):
            cache_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), ".tiktoken_cache"
            )
            os.makedirs(cache_dir, exist_ok=True)
            os.environ["TIKTOKEN_CACHE_DIR"] = cache_dir

        try:
            _tokenizer = tiktoken.get_encoding("cl100k_base")
        except Exception:
            import certifi
            os.environ.setdefault("SSL_CERT_FILE", certifi.where())
            os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
            _tokenizer = tiktoken.get_encoding("cl100k_base")

        return _tokenizer
    except ImportError:
        logger.debug("tiktoken or certifi not installed — using char-based fallback")
        return None
    except Exception as exc:
        logger.warning(
            "tiktoken encoding download failed (SSL/proxy?): %s — using char-based fallback",
            exc,
        )
        return None
    finally:
        _tokenizer_resolved = True


# Memoization for count_tokens — the same text is counted 3-4x per
# compression pass (feasibility, chunk sizing, ref budget).  Keyed on
# (len, hash) and stores only the int, so caching is lossless and cheap.
_count_cache: dict = {}
_COUNT_CACHE_MAX = 4096


def count_tokens(text: str, model: Optional[str] = None) -> int:
    """Count tokens accurately using tiktoken (memoized), fallback to len//4."""
    if not text:
        return 0
    cache_key = (len(text), hash(text))
    cached = _count_cache.get(cache_key)
    if cached is not None:
        return cached
    enc = _get_tokenizer()
    count: Optional[int] = None
    if enc is not None:
        try:
            count = len(enc.encode(text))
            logger.debug("count_tokens: tiktoken count=%d for %d chars", count, len(text))
        except Exception as exc:
            logger.debug("count_tokens: tiktoken failed, using char fallback: %s", exc)
    if count is None:
        count = len(text) // 4 + 1
        logger.debug("count_tokens: char-based fallback=%d for %d chars", count, len(text))
    if len(_count_cache) >= _COUNT_CACHE_MAX:
        _count_cache.clear()
    _count_cache[cache_key] = count
    return count


def estimate_tokens_fast(text: str) -> int:
    """Fast approximation: ~4 chars per token."""
    result = len(text) // 4 + 1
    logger.debug("estimate_tokens_fast: %d tokens for %d chars", result, len(text))
    return result


def fit_for_logging(text: str, max_chars: int = 0) -> str:
    """Return full text — no truncation so errors and reasoning are preserved."""
    if not text:
        return ""
    return str(text)


__all__ = [
    "count_tokens",
    "estimate_tokens_fast",
    "fit_for_logging",
]
