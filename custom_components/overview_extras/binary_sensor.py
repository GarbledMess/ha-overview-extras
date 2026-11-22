"""Per-room occupancy: on when any of the room's chosen presence sensors is on."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import RoomSummaryEntity
from .sources import selected_sources


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    area_reg = ar.async_get(hass)
    async_add_entities(
        RoomOccupancy(area_id, area.name, "presence", "occupancy", cats["presence"])
        for area_id, cats in selected_sources(hass, dict(entry.options)).items()
        if cats["presence"] and (area := area_reg.async_get_area(area_id)) is not None
    )


class RoomOccupancy(RoomSummaryEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    def _platform_domain(self) -> str:
        return "binary_sensor"

    def _recompute(self) -> None:
        states = list(self._states(self.hass))
        self._attr_is_on = any(s.state == "on" for s in states)
        self._attr_available = bool(states)
