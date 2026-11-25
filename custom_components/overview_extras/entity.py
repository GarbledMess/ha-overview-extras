"""Base for the per-room summary entities."""

from __future__ import annotations

import time

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import DOMAIN


class RoomSummaryEntity(Entity):
    """Follows a room's chosen sources and recomputes on any change.

    These entities are deliberately not assigned to the room themselves, so they never
    feed back into the room's own totals (or into HA's area card sums).
    """

    _attr_should_poll = False
    _attr_has_entity_name = False
    # Seconds between state writes. 0 = immediately (occupancy and lights, which change rarely
    # and should feel instant). Measurements are coalesced so a chatty power plug doesn't turn
    # into a database write every second.
    throttle: float = 0

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

    _pending = None
    _last_write = 0.0

    @callback
    def _on_change(self, event: Event[EventStateChangedData]) -> None:
        if not self.throttle:
            self._recompute()
            self.async_write_ha_state()
            return
        if self._pending is not None:
            return  # an update is already scheduled; it will pick this change up
        delay = self._last_write + self.throttle - time.monotonic()
        if delay <= 0:
            self._flush()  # quiet for a while: update straight away
        else:
            self._pending = async_call_later(self.hass, delay, self._flush)

    @callback
    def _flush(self, _now=None) -> None:
        self._pending = None
        self._last_write = time.monotonic()
        self._recompute()
        # HA doesn't record a new row when state and attributes are unchanged,
        # so rounding in _recompute keeps steady readings from writing at all.
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        if self._pending is not None:
            self._pending()
            self._pending = None

    def _recompute(self) -> None:
        raise NotImplementedError

    def _states(self, hass: HomeAssistant):
        for entity_id in self._sources:
            state = hass.states.get(entity_id)
            if state is not None and state.state not in ("unavailable", "unknown"):
                yield state
