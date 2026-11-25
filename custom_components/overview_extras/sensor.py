"""Per-room average temperature, average humidity, total power and lights-on count."""

from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_SET_PRIMARY, CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL, POWER_FACTORS
from .entity import RoomSummaryEntity
from .sources import selected_sources


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    area_reg = ar.async_get(hass)
    interval = float(entry.options.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL))
    entities: list[SensorEntity] = []
    for area_id, cats in selected_sources(hass, dict(entry.options)).items():
        if (area := area_reg.async_get_area(area_id)) is None:
            continue
        if cats["temperature"]:
            entities.append(RoomAverage(area_id, area.name, "temperature", "temperature", cats["temperature"], entry))
        if cats["humidity"]:
            entities.append(RoomAverage(area_id, area.name, "humidity", "humidity", cats["humidity"], entry))
        if cats["power"]:
            entities.append(RoomPower(area_id, area.name, "power", "power", cats["power"]))
        if cats["lights"]:
            entities.append(RoomLightsOn(area_id, area.name, "lights", "lights on", cats["lights"]))
    for entity in entities:
        if not isinstance(entity, RoomLightsOn):
            entity.throttle = interval
    async_add_entities(entities)


class _RoomSensor(RoomSummaryEntity, SensorEntity):
    def _platform_domain(self) -> str:
        return "sensor"


class RoomAverage(_RoomSensor):
    """Mean of the room's chosen temperature or humidity sensors."""

    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, area_id, area_name, category, label, sources, entry) -> None:
        super().__init__(area_id, area_name, category, f"average {label}", sources)
        self._entry = entry
        self._attr_device_class = SensorDeviceClass.TEMPERATURE if category == "temperature" else SensorDeviceClass.HUMIDITY
        self._attr_suggested_display_precision = 1 if category == "temperature" else 0
        if category == "humidity":
            self._attr_native_unit_of_measurement = PERCENTAGE

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if self._entry.options.get(CONF_SET_PRIMARY, True):
            # The area registry only accepts entities that already have a state, so wait one tick.
            self.hass.loop.call_soon(self._claim_area_primary)

    def _claim_area_primary(self) -> None:
        """Make this the room's temperature/humidity sensor, unless the user picked their own."""
        if self.hass is None or self.hass.states.get(self.entity_id) is None:
            return
        area_reg = ar.async_get(self.hass)
        area = area_reg.async_get_area(self._area_id)
        if area is None:
            return
        field = f"{self._category}_entity_id"
        current = getattr(area, field, None)
        if current is None or current.startswith(f"sensor.{self.platform.platform_name}_"):
            if current != self.entity_id:
                area_reg.async_update(self._area_id, **{field: self.entity_id})

    def _recompute(self) -> None:
        values, unit = [], None
        for state in self._states(self.hass):
            try:
                value = float(state.state)
            except ValueError:
                continue
            state_unit = state.attributes.get("unit_of_measurement")
            unit = unit or state_unit
            if state_unit == unit:  # never average °C with °F
                values.append(value)
        if self._category == "temperature":
            self._attr_native_unit_of_measurement = unit
        digits = 1 if self._category == "temperature" else 0
        self._attr_native_value = round(sum(values) / len(values), digits) if values else None
        self._attr_available = bool(values)


class RoomPower(_RoomSensor):
    """Sum of the room's chosen power sensors, in watts."""

    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfPower.WATT
    _attr_suggested_display_precision = 0

    def __init__(self, area_id, area_name, category, label, sources) -> None:
        super().__init__(area_id, area_name, category, f"total {label}", sources)

    def _recompute(self) -> None:
        total, count = 0.0, 0
        for state in self._states(self.hass):
            factor = POWER_FACTORS.get(state.attributes.get("unit_of_measurement"))
            try:
                value = float(state.state)
            except ValueError:
                continue
            if factor is not None:
                total += value * factor
                count += 1
        self._attr_native_value = round(total) if count else None
        self._attr_available = bool(count)


class RoomLightsOn(_RoomSensor):
    """How many of the room's chosen lights are on."""

    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:lightbulb-group"

    def _recompute(self) -> None:
        self._attr_native_value = sum(1 for s in self._states(self.hass) if s.state == "on")
