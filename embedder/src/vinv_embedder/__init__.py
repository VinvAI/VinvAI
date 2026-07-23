"""vinv-embedder: local embedding sidecar for the Vinv index engine.

Serves an OpenAI-compatible POST /v1/embeddings (and /embeddings) endpoint on
127.0.0.1 so the Rust index engine can embed code chunks locally.

Prefix contract: the CALLER (Rust index) is responsible for adding any query
instruction prefix (e.g. CodeRankEmbed's "Represent this query for searching
relevant code:"). This sidecar embeds exactly the strings it receives.
"""

__version__ = "0.1.0"
