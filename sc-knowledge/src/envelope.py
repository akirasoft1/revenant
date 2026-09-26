"""Uniform result/error envelopes. Tools never raise across the MCP boundary."""
from .cache import CacheResult


def error(code: str, detail: str, stale_fallback: bool = False, **extra) -> dict:
    return {"error": code, "detail": detail, "stale_fallback": stale_fallback, **extra}


def freshness(res: CacheResult) -> dict:
    if res.status == "stale":
        return {"stale": True, "age_minutes": round(res.age_s / 60)}
    return {}
