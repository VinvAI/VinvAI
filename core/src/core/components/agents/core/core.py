"""Core utilities for agents."""

import logging

__all__ = ["log_agent_model_usage"]

logger = logging.getLogger(__name__)


def log_agent_model_usage(agent_name: str, method_name: str) -> None:
    """Log agent model usage for tracking and debugging."""
    logger.debug("log_agent_model_usage entry: agent_name=%s, method_name=%s", agent_name, method_name)
    logger.debug(f"Agent {agent_name} called method {method_name}")
