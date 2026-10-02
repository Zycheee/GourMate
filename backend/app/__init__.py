"""GourMate (Kef) FastAPI backend package.

The backend owns the always-listening voice loop: audio in, STT, Gemini turns
with tool calls, and sentence-streamed edge-tts audio out. It is intentionally
stateless across restarts and never persists raw audio, transcripts or recipes.
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
