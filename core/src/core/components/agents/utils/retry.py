"""Retry utility functions for agents."""

__all__ = ["is_timeout_error"]


def is_timeout_error(error: Exception) -> bool:
    error_type = type(error).__name__
    error_message = str(error).lower()
    timeout_indicators = ["timeout", "timed out", "504", "gateway timeout", "request timeout"]
    return "Timeout" in error_type or any(ind in error_message for ind in timeout_indicators)
