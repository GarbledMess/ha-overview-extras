"""Work out which entities feed each room's extras."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import CATEGORIES, CONF_SOURCES_EXCLUDED, DOMAIN, PRESENCE_CLASSES


def _category(hass: HomeAssistant, entry: er.RegistryEntry) -> str | None:
    domain = entry.domain
    if domain == "light":
        return "lights"
    if domain not in ("sensor", "binary_sensor"):
        return None
    device_class = entry.device_class or entry.original_device_class
    if device_class is None and (state := hass.states.get(entry.entity_id)):
        device_class = state.attributes.get("device_class")
    if domain == "sensor" and device_class in ("temperature", "humidity", "power"):
        return device_class
    if domain == "binary_sensor" and device_class in PRESENCE_CLASSES:
        return "presence"
    return None


def candidates_by_area(hass: HomeAssistant) -> dict[str, dict[str, list[str]]]:
    """Every entity that could feed a room, grouped by room and category.

    Same rules as the frontend: an entity belongs to a room if it, or its device, is
    assigned there. Hidden, disabled, config/diagnostic and our own entities are skipped.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    out: dict[str, dict[str, list[str]]] = {}
    for entry in ent_reg.entities.values():
        if entry.platform == DOMAIN or entry.disabled_by or entry.hidden_by or entry.entity_category:
            continue
        area_id = entry.area_id
        if area_id is None and entry.device_id and (device := dev_reg.async_get(entry.device_id)):
            area_id = device.area_id
        if area_id is None:
            continue
        if (category := _category(hass, entry)) is None:
            continue
        out.setdefault(area_id, {c: [] for c in CATEGORIES})[category].append(entry.entity_id)
    for cats in out.values():
        for ids in cats.values():
            ids.sort()
    return out


def excluded(options: dict, area_id: str, category: str) -> set[str]:
    """Sources the user removed for this room and category."""
    return set(options.get(CONF_SOURCES_EXCLUDED, {}).get(area_id, {}).get(category, []))


def selected_sources(hass: HomeAssistant, options: dict) -> dict[str, dict[str, list[str]]]:
    """Candidates minus what the user removed."""
    return {
        area_id: {cat: [e for e in ids if e not in excluded(options, area_id, cat)] for cat, ids in cats.items()}
        for area_id, cats in candidates_by_area(hass).items()
    }


def apply_selection(
    options: dict, area_id: str, candidates: dict[str, list[str]], selected: dict[str, list[str]]
) -> dict:
    """New options after the user picked `selected` for a room (stores only what was removed)."""
    all_excluded = dict(options.get(CONF_SOURCES_EXCLUDED, {}))
    room_excluded = all_excluded.get(area_id, {})
    new_room: dict[str, list[str]] = {}
    for cat in CATEGORIES:
        cands = candidates.get(cat, [])
        if cat in selected:
            chosen = set(selected[cat])
            removed = {e for e in cands if e not in chosen}
        else:  # category not shown/edited: keep what was there
            removed = {e for e in room_excluded.get(cat, []) if e in cands}
        # Keep earlier removals of entities that are temporarily gone, so they stay removed.
        removed |= {e for e in room_excluded.get(cat, []) if e not in cands}
        if removed:
            new_room[cat] = sorted(removed)
    all_excluded.pop(area_id, None)
    if new_room:
        all_excluded[area_id] = new_room
    return {**options, CONF_SOURCES_EXCLUDED: all_excluded}
