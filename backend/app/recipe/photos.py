"""Commons photo lookup, separate from client-owned Recipe state (§8).

Only dish names leave the app. Cache metadata, never image bytes or preferences.
"""
from __future__ import annotations

import asyncio
import html
import re
import time
from collections import OrderedDict
from urllib.parse import urlparse

import httpx

from .discovery import gallery_food
from ..schemas import FoodImageResponse

API = "https://commons.wikimedia.org/w/api.php"
_cache: OrderedDict[str, tuple[float, FoodImageResponse]] = OrderedDict()
_slots = asyncio.Semaphore(4)


def plain(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()[:500]


def photo(info: dict) -> FoodImageResponse | None:
    metadata = info.get("extmetadata", {})
    credit = plain(metadata.get("Artist", {}).get("value", ""))
    license = plain(metadata.get("LicenseShortName", {}).get("value", ""))
    url = info.get("thumburl") or info.get("url", "")
    source = info.get("descriptionurl", "")
    if (not credit or not re.fullmatch(r"CC BY(?:-SA)? [\d.]+|CC0|Public domain", license, re.I)
            or info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}
            or urlparse(url).hostname not in {"upload.wikimedia.org", "thumb.wikimedia.org"} or not url.startswith("https://")
            or urlparse(source).hostname != "commons.wikimedia.org" or not source.startswith("https://")):
        return None
    return FoodImageResponse(image_url=url, image_credit=credit, image_source=source, image_license=license)


async def lookup_photo(dish: str) -> FoodImageResponse:
    key = " ".join(re.findall(r"[a-z0-9]+", dish.lower()))
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        _cache.move_to_end(key)
        return cached[1]
    known = gallery_food(dish)
    if known and known.get("image_url"):
        return FoodImageResponse(**{field: known.get(field) for field in FoodImageResponse.model_fields})
    result = FoodImageResponse()
    try:
        async with asyncio.timeout(5):
            async with _slots, httpx.AsyncClient(timeout=4, headers={"User-Agent": "GourMate/1.0 (food preview metadata lookup)"}) as client:
                response = await client.get(API, params={
                    "action": "query", "format": "json", "generator": "search",
                    "gsrnamespace": "6", "gsrlimit": "6", "gsrsearch": f'"{key}" filetype:bitmap',
                    "prop": "imageinfo", "iiprop": "url|mime|extmetadata", "iiurlwidth": "800",
                })
                response.raise_for_status()
                pages = response.json().get("query", {}).get("pages", {}).values()
                for page in sorted(pages, key=lambda p: p.get("index", 100)):
                    title = set(re.findall(r"[a-z0-9]+", page.get("title", "").lower()))
                    # All dish words must appear in the filename. Descriptions alone
                    # can mention unrelated food; never use an arbitrary top result.
                    if not key or not set(key.split()).issubset(title):
                        continue
                    for info in page.get("imageinfo", []):
                        candidate = photo(info)
                        if candidate:
                            result = candidate
                            break
                    if result.image_url:
                        break
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, AttributeError):
        pass  # A missing photo is a successful text-only preview.
    _cache[key] = (time.monotonic() + (3600 if result.image_url else 60), result)
    _cache.move_to_end(key)
    while len(_cache) > 128:
        _cache.popitem(last=False)
    return result
