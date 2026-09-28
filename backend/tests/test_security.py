"""Trusted client-IP resolver contract (app/security.py).

The resolver is pure and synchronous, so precedence is asserted directly with
plain header mappings. Covers the security-critical cases:

* ``fly-client-ip`` always wins (the edge-injected, non-spoofable value);
* ``x-forwarded-for`` is ignored unless ``trust_proxy_headers`` is enabled;
* when trusted, the rightmost XFF hop is used (closest to our proxy);
* the direct peer address is the final fallback.
"""

from __future__ import annotations

from app.security import UNKNOWN_IP, client_ip_from_headers


def test_fly_client_ip_wins_over_forwarded_for_and_peer():
    headers = {
        "fly-client-ip": "203.0.113.7",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    }
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=True)
    assert resolved == "203.0.113.7"


def test_fly_client_ip_wins_even_when_trust_disabled():
    headers = {
        "fly-client-ip": "203.0.113.7",
        "x-forwarded-for": "1.2.3.4",
    }
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=False)
    assert resolved == "203.0.113.7"


def test_forwarded_for_ignored_when_trust_disabled():
    headers = {"x-forwarded-for": "1.2.3.4, 5.6.7.8"}
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=False)
    assert resolved == "10.0.0.1"


def test_forwarded_for_uses_rightmost_hop_when_trusted():
    headers = {"x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9"}
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=True)
    assert resolved == "9.9.9.9"


def test_forwarded_for_trims_whitespace_when_trusted():
    headers = {"x-forwarded-for": "  1.2.3.4 ,  5.6.7.8  "}
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=True)
    assert resolved == "5.6.7.8"


def test_peer_fallback_when_no_usable_headers():
    assert (
        client_ip_from_headers({}, "10.0.0.1", trust_proxy_headers=False) == "10.0.0.1"
    )
    assert (
        client_ip_from_headers({}, "10.0.0.1", trust_proxy_headers=True) == "10.0.0.1"
    )


def test_unknown_when_peer_and_headers_missing():
    assert client_ip_from_headers({}, "", trust_proxy_headers=False) == UNKNOWN_IP
    assert (
        client_ip_from_headers({"x-forwarded-for": "  "}, "  ", trust_proxy_headers=True)
        == UNKNOWN_IP
    )


def test_header_lookup_is_case_insensitive():
    headers = {"Fly-Client-IP": "203.0.113.7"}
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=False)
    assert resolved == "203.0.113.7"


def test_empty_fly_header_falls_through_to_forwarded_for():
    headers = {"fly-client-ip": "   ", "x-forwarded-for": "1.2.3.4, 5.6.7.8"}
    resolved = client_ip_from_headers(headers, "10.0.0.1", trust_proxy_headers=True)
    assert resolved == "5.6.7.8"
