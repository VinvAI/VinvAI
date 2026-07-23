"""Vinv Engine / components / common / exceptions — Base exception hierarchy.

Only genuinely shared exceptions live here. Component-specific exceptions
(MailboxFullError, ActorNotFoundError, etc.) stay in their own component
but inherit from VinvEngineError.
"""


class VinvEngineError(Exception):
    """Base exception for all Vinv Engine errors."""


class PersistenceError(VinvEngineError):
    """Raised when a filesystem persistence operation fails."""


class ConfigurationError(VinvEngineError):
    """Raised when a configuration value is invalid or missing."""


class ChannelError(VinvEngineError):
    """Raised when an inbound/outbound channel operation fails."""
