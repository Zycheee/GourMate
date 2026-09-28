"""Trusted client-IP resolution shared by the REST and WebSocket paths.

A single resolver is used everywhere a client IP keys a per-IP cap (REST token
bucket, slowapi health limiter, WebSocket connection registry). This prevents a
client from inflating its allowance by spoofing ``x-forwarded-for`` and keeps
the REST and WS paths consistent behind a proxy.

Resolution order (architecture sections 7, 10):

1. ``fly-client-ip`` - injected by Fly.io's edge proxy; not client-spoofable,
   so it is always honored when present.
2. ``x-forwarded-for`` - client-supplied and therefore only honored when
   ``settings.trust_proxy_headers`` is true; the **rightmost** comma-separated
   hop (the one added by the trusted proxy closest to us) is used.
3. The direct peer address from the socket.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .config import Settings, get_settings

#: Injected by Fly.io's edge; always trusted when present.
FLY_CLIENT_IP_HEADER = "fly-client-ip"
#: Standard proxy-chain header; trusted only behind a configured proxy.
XFF_HEADER = "x-forwarded-for"

#: Returned when no IP can be determined at all.
UNKNOWN_IP = "unknown"


def _header_value(headers: Mapping[str, str], name: str) -> str | None:
    """Case-insensitive lookup that works with plain dicts and Starlette Headers."""
    # Starlette's Headers is already case-insensitive; dicts are not.
    try:
        value = headers.get(name)
    except Exception:  # noqa: BLE001 - defensive: unusual mapping implementations
        value = None
    if value:
        return value
    wanted = name.lower()
    for key, candidate in headers.items():
        if isinstance(key, str) and key.lower() == wanted and candidate:
            return candidate
    return None


def client_ip_from_headers(
    headers: Mapping[str, str],
    peer: str,
    *,
    trust_proxy_headers: bool,
) -> str:
    """Resolve the client IP from request headers and the direct peer address.

    Pure and synchronous so it is trivially unit-testable. See module docstring
    for the precedence rules.
    """
    fly_ip = _header_value(headers, FLY_CLIENT_IP_HEADER)
    if fly_ip and fly_ip.strip():
        return fly_ip.strip()

    if trust_proxy_headers:
        forwarded = _header_value(headers, XFF_HEADER)
        if forwarded:
            hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
            if hops:
                # Rightmost hop: the value appended by the trusted proxy nearest us.
                return hops[-1]

    peer = (peer or "").strip()
    return peer or UNKNOWN_IP


def _peer_address(connection: Any) -> str:
    """Best-effort direct peer address for a Starlette Request/WebSocket."""
    client = getattr(connection, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    return host or ""


def client_ip(connection: Any, *, settings: Settings | None = None) -> str:
    """Adapter: resolve the client IP for a Starlette Request or WebSocket."""
    resolved = settings if settings is not None else get_settings()
    headers = getattr(connection, "headers", {}) or {}
    return client_ip_from_headers(
        headers,
        _peer_address(connection),
        trust_proxy_headers=resolved.trust_proxy_headers,
    )


__all__ = [
    "FLY_CLIENT_IP_HEADER",
    "UNKNOWN_IP",
    "XFF_HEADER",
    "client_ip",
    "client_ip_from_headers",
]
