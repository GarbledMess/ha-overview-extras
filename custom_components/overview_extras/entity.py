"""Base for the per-room summary entities."""

from __future__ import annotations

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN


class RoomSummaryEntity(Entity):
    """Follows a room's chosen sources and recomputes on any change.

    These entities are deliberately not assigned to the room themselves, so they never
    feed back into the room's own totals (or into HA's area card sums).
    """

    _attr_should_poll = False
    _attr_has_entity_name = False

    def __init__(self, area_id: str, area_name: str, category: str, label: str, sources: list[str]) -> None:
        self._area_id = area_id
        self._category = category
        self._sources = sources
        self._attr_unique_id = f"{area_id}_{category}"
        self._attr_name = f"{area_name} {label}"
        self.entity_id = f"{self._platform_domain()}.{DOMAIN}_{area_id}_{category}"

    def _platform_domain(self) -> str:
        raise NotImplementedError

    @property
    def extra_state_attributes(self) -> dict:
        return {"area_id": self._area_id, "sources": self._sources}

    async def async_added_to_hass(self) -> None:
        self._recompute()
        if self._sources:
            self.async_on_remove(async_track_state_change_event(self.hass, self._sources, self._on_change))

    @callback
    def _on_change(self, event: Event[EventStateChangedData]) -> None:
        self._recompute()
        self.async_write_ha_state()

    def _recompute(self) -> None:
        raise NotImplementedError

    def _states(self, hass: HomeAssistant):
        for entity_id in self._sources:
            state = hass.states.get(entity_id)
            if state is not None and state.state not in ("unavailable", "unknown"):
                yield state
