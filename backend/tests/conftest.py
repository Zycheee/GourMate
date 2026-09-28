"""Shared fixtures for the backend contract suite.

Everything here is offline. The golden contract manifest at
``contracts/ws-events.json`` is loaded once per session so both the backend and
frontend suites assert against the same artifact.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.factories import make_recipe

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "contracts" / "ws-events.json"


@pytest.fixture(scope="session")
def contract() -> dict:
    """The golden wire-contract manifest (architecture §6-§11)."""
    assert CONTRACT_PATH.is_file(), f"missing golden contract at {CONTRACT_PATH}"
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def recipe():
    """A valid, minimal ``Recipe`` for reuse across tests."""
    return make_recipe()
