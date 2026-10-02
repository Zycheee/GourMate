"""Offline lookup and REST contract checks for remote preview photos."""
import json
from pathlib import Path

import httpx
import pytest

from app.recipe import photos
from app.schemas import FoodImageRequest, FoodImageResponse


def info(**changes):
    return {"url": "https://upload.wikimedia.org/photo.jpg", "mime": "image/jpeg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Lentil_stew.jpg",
            "extmetadata": {"Artist": {"value": "<a>Test Author</a>"},
                            "LicenseShortName": {"value": "CC BY 4.0"}}, **changes}


def mock_lookup(monkeypatch, pages=None, error=None):
    photos._cache.clear()
    calls = []
    original = httpx.AsyncClient

    def handle(request):
        calls.append(request)
        if error:
            raise error
        return httpx.Response(200, json={"query": {"pages": pages or {}}})

    monkeypatch.setattr(photos.httpx, "AsyncClient", lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(handle)))
    return calls


async def test_matching_photo_and_cache(monkeypatch):
    calls = mock_lookup(monkeypatch, {"1": {"title": "File:Lentil stew.jpg", "imageinfo": [info()]}})
    result = await photos.lookup_photo("Lentil stew")
    assert result.image_url == "https://upload.wikimedia.org/photo.jpg"
    assert result.image_credit == "Test Author"
    assert await photos.lookup_photo("LENTIL STEW") == result
    assert len(calls) == 1
    assert calls[0].url.params["gsrsearch"] == '"lentil stew" filetype:bitmap'


@pytest.mark.parametrize("page", [
    {"title": "File:Chicken.jpg", "imageinfo": [info()]},
    {"title": "File:Lentil stew.jpg", "imageinfo": [info(extmetadata={})]},
    {"title": "File:Lentil stew.jpg", "imageinfo": [info(url="https://example.com/photo.jpg")]},
    {"title": "File:Lentil stew.jpg", "imageinfo": [info(mime="image/svg+xml")]},
])
async def test_unrelated_or_unusable_photos_return_placeholder(monkeypatch, page):
    mock_lookup(monkeypatch, {"1": page})
    assert (await photos.lookup_photo("Lentil stew")).image_url is None


@pytest.mark.parametrize("error", [httpx.ConnectError("offline"), httpx.ReadTimeout("timeout")])
async def test_network_failures_are_text_only(monkeypatch, error):
    mock_lookup(monkeypatch, error=error)
    assert (await photos.lookup_photo("Lentil stew")).image_url is None


async def test_cache_is_bounded(monkeypatch):
    mock_lookup(monkeypatch)
    for i in range(130):
        await photos.lookup_photo(f"Dish {i}")
    assert len(photos._cache) == 128
    assert "dish 0" not in photos._cache


async def test_gallery_uses_verified_urls_without_search(monkeypatch):
    calls = mock_lookup(monkeypatch)
    assert (await photos.lookup_photo("Chicken Adobo")).image_url.startswith(("https://upload.wikimedia.org/", "https://thumb.wikimedia.org/"))
    assert not calls


def test_lookup_contract():
    golden = json.loads((Path(__file__).parents[2] / "contracts/ws-events.json").read_text())["food_image_lookup"]
    assert set(FoodImageRequest.model_fields) == set(golden["request_required"])
    assert set(FoodImageResponse.model_fields) == set(golden["response_required"])
    from app.main import router
    route = next(r for r in router.routes if r.path == golden["endpoint"])
    assert golden["method"] in route.methods
