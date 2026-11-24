"""Per-room sources: defaults to everything, user can remove, new entities join automatically."""

from datetime import timedelta

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import area_registry as ar, entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.overview_extras.const import DOMAIN


def _sensor(hass, ent_reg, area_id, object_id, device_class, value, unit):
    entry = ent_reg.async_get_or_create(
        "sensor", "test", object_id, suggested_object_id=object_id, original_device_class=device_class
    )
    ent_reg.async_update_entity(entry.entity_id, area_id=area_id)
    hass.states.async_set(entry.entity_id, value, {"device_class": device_class, "unit_of_measurement": unit})
    return entry.entity_id


async def test_room_sources(hass: HomeAssistant, hass_ws_client) -> None:
    assert await async_setup_component(hass, "frontend", {})
    area_reg = ar.async_get(hass)
    ent_reg = er.async_get(hass)
    living = area_reg.async_create("Living Room")

    t1 = _sensor(hass, ent_reg, living.id, "lr_temp_1", "temperature", "20.0", "°C")
    t2 = _sensor(hass, ent_reg, living.id, "lr_temp_2", "temperature", "22.0", "°C")
    t3 = _sensor(hass, ent_reg, living.id, "lr_temp_3", "temperature", "30.0", "°C")  # by the radiator
    p1 = _sensor(hass, ent_reg, living.id, "tv_power", "power", "100", "W")
    p2 = _sensor(hass, ent_reg, living.id, "amp_power", "power", "0.05", "kW")
    occ = ent_reg.async_get_or_create("binary_sensor", "test", "lr_occ", suggested_object_id="lr_occ", original_device_class="occupancy")
    ent_reg.async_update_entity(occ.entity_id, area_id=living.id)
    hass.states.async_set(occ.entity_id, "on", {"device_class": "occupancy"})

    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]

    temp_id = f"sensor.{DOMAIN}_{living.id}_temperature"
    power_id = f"sensor.{DOMAIN}_{living.id}_power"
    occ_id = f"binary_sensor.{DOMAIN}_{living.id}_presence"

    # Defaults: everything included. Average of 20, 22, 30; power 100 W + 50 W.
    assert float(hass.states.get(temp_id).state) == 24.0
    assert float(hass.states.get(power_id).state) == 150.0
    assert hass.states.get(occ_id).state == "on"
    # The average became the room's temperature sensor (none was set).
    assert area_reg.async_get_area(living.id).temperature_entity_id == temp_id
    # Our own entities are not in the room, so they never count themselves.
    assert ent_reg.async_get(temp_id).area_id is None

    # Live updates
    hass.states.async_set(t1, "21.0", {"device_class": "temperature", "unit_of_measurement": "°C"})
    await hass.async_block_till_done()
    assert float(hass.states.get(temp_id).state) == round((21 + 22 + 30) / 3, 2)

    # Configure -> Room sources -> Living Room: untick the radiator sensor and the amp.
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "room_sources"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"area": living.id})
    assert result["type"] is FlowResultType.FORM and result["step_id"] == "room"
    schema_defaults = {str(k): k.default() for k in result["data_schema"].schema}
    assert sorted(schema_defaults["temperature"]) == sorted([t1, t2, t3])  # all ticked by default
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"temperature": [t1, t2], "power": [p1], "presence": [occ.entity_id]},
    )
    assert result["type"] is FlowResultType.MENU
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "save"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()

    assert entry.options["sources_excluded"] == {living.id: {"temperature": [t3], "power": [p2]}}
    assert float(hass.states.get(temp_id).state) == 21.5
    assert float(hass.states.get(power_id).state) == 100.0

    # The frontend gets the same choices.
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "overview_extras/sources"})
    msg = await client.receive_json()
    assert msg["result"]["excluded"] == {living.id: {"temperature": [t3], "power": [p2]}}

    # The room settings dialog reads and saves the same choices.
    await client.send_json({"id": 2, "type": "overview_extras/area_sources", "area_id": living.id})
    msg = await client.receive_json()
    assert sorted(msg["result"]["candidates"]["temperature"]) == sorted([t1, t2, t3])
    assert msg["result"]["excluded"] == {"temperature": [t3], "power": [p2]}
    # Dialog: put the radiator sensor back, leave power alone (not sent = unchanged).
    await client.send_json(
        {"id": 3, "type": "overview_extras/set_area_sources", "area_id": living.id, "selected": {"temperature": [t1, t2, t3]}}
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    await hass.async_block_till_done()
    assert entry.options["sources_excluded"] == {living.id: {"power": [p2]}}
    assert float(hass.states.get(temp_id).state) == round((21 + 22 + 30) / 3, 2)
    # ...and take it out again
    await client.send_json(
        {"id": 4, "type": "overview_extras/set_area_sources", "area_id": living.id, "selected": {"temperature": [t1, t2]}}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert entry.options["sources_excluded"] == {living.id: {"temperature": [t3], "power": [p2]}}

    # A new temperature sensor added to the room joins automatically.
    t4 = _sensor(hass, ent_reg, living.id, "lr_temp_4", "temperature", "23.0", "°C")
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=15))
    await hass.async_block_till_done()
    assert float(hass.states.get(temp_id).state) == round((21 + 22 + 23) / 3, 2)
    assert t4 in hass.states.get(temp_id).attributes["sources"]
    assert t3 not in hass.states.get(temp_id).attributes["sources"]

    # A room sensor the user picked themselves is never overwritten.
    kitchen = area_reg.async_create("Kitchen")
    k_temp = _sensor(hass, ent_reg, kitchen.id, "k_temp", "temperature", "19.0", "°C")
    area_reg.async_update(kitchen.id, temperature_entity_id=k_temp)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=30))
    await hass.async_block_till_done()
    assert hass.states.get(f"sensor.{DOMAIN}_{kitchen.id}_temperature") is not None
    assert area_reg.async_get_area(kitchen.id).temperature_entity_id == k_temp

    # Removing the integration hands the rooms back.
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert area_reg.async_get_area(living.id).temperature_entity_id is None
    assert area_reg.async_get_area(kitchen.id).temperature_entity_id == k_temp
