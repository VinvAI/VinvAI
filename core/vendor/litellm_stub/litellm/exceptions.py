"""Exception aliases compatible with common litellm / OpenAI error typing."""

from openai import APITimeoutError, RateLimitError as OpenAIRateLimitError

Timeout = APITimeoutError
RateLimitError = OpenAIRateLimitError


class ContextWindowExceededError(Exception):
    """Legacy marker type; real overflows surface as OpenAI BadRequestError with message heuristics."""
