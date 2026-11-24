"""Overview Extras: richer room cards injected into Home Assistant's built-in Overview.

The integration serves a single frontend module and registers it as an "extra module",
so it loads on every page, including the built-in Overview (which does not load dashboard
resources). Options from the UI are passed to the module as URL query parameters.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, config_validation as cv
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.device_registry import EVENT_DEVICE_REGISTRY_UPDATED
from homeassistant.helpers.entity_registry import EVENT_ENTITY_REGISTRY_UPDATED
from homeassistant.helpers.typing import ConfigType

from .sources import apply_selection, candidates_by_area
from .const import (
    CONF_AREA_STRIP,
    CONF_BADGES,
    CONF_EXCLUDE_ENTITIES,
    CONF_MAX_BADGES,
    CONF_POWER_EXCLUDE,
    CONF_SHOW_GLOW,
    CONF_SHOW_POWER,
    CONF_SHOW_PRESENCE,
    CONF_SOURCES_EXCLUDED,
    DOMAIN,
    PLATFORMS,
    JS_FILE,
    URL_BASE,
    VERSION,
)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type OverviewExtrasConfigEntry = ConfigEntry[str]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the frontend module (once per Home Assistant start)."""
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(Path(__file__).parent / "www"), False)]
    )
    websocket_api.async_register_command(hass, ws_sources)
    websocket_api.async_register_command(hass, ws_area_sources)
    websocket_api.async_register_command(hass, ws_set_area_sources)
    return True


@websocket_api.websocket_command({vol.Required("type"): "overview_extras/sources"})
@callback
def ws_sources(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Tell the frontend which sources were removed per room and category."""
    entries = hass.config_entries.async_entries(DOMAIN)
    excluded = entries[0].options.get(CONF_SOURCES_EXCLUDED, {}) if entries else {}
    connection.send_result(msg["id"], {"excluded": excluded})


@websocket_api.websocket_command({vol.Required("type"): "overview_extras/area_sources", vol.Required("area_id"): str})
@websocket_api.require_admin
@callback
def ws_area_sources(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """For the room settings dialog: a room's candidate sources and which were removed."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_error(msg["id"], "not_set_up", "Overview Extras is not set up")
        return
    area_id = msg["area_id"]
    candidates = candidates_by_area(hass).get(area_id, {})
    excluded = entries[0].options.get(CONF_SOURCES_EXCLUDED, {}).get(area_id, {})
    connection.send_result(msg["id"], {"candidates": candidates, "excluded": excluded})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "overview_extras/set_area_sources",
        vol.Required("area_id"): str,
        vol.Required("selected"): {str: [str]},
    }
)
@websocket_api.require_admin
@callback
def ws_set_area_sources(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Save a room's sources from the room settings dialog."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_error(msg["id"], "not_set_up", "Overview Extras is not set up")
        return
    entry = entries[0]
    area_id = msg["area_id"]
    candidates = candidates_by_area(hass).get(area_id, {})
    new_options = apply_selection(dict(entry.options), area_id, candidates, msg["selected"])
    if new_options != dict(entry.options):
        hass.config_entries.async_update_entry(entry, options=new_options)
        hass.config_entries.async_schedule_reload(entry.entry_id)
    connection.send_result(msg["id"], {"excluded": new_options.get(CONF_SOURCES_EXCLUDED, {}).get(area_id, {})})


def module_url(options: dict) -> str:
    """Build the module URL, carrying the options as query parameters."""
    params: dict[str, str] = {"enhance_overview": "1"}
    for key in (CONF_POWER_EXCLUDE, CONF_EXCLUDE_ENTITIES, CONF_BADGES):
        if options.get(key):
            params[key] = ",".join(options[key])
    if options.get(CONF_MAX_BADGES) is not None:
        params[CONF_MAX_BADGES] = str(int(options[CONF_MAX_BADGES]))
    for key in (CONF_SHOW_GLOW, CONF_SHOW_POWER, CONF_SHOW_PRESENCE, CONF_AREA_STRIP):
        if key in options:
            params[key] = "1" if options[key] else "0"
    # Version last: busts the browser cache on upgrade.
    params["v"] = VERSION
    return f"{URL_BASE}/{JS_FILE}?{urlencode(params, safe=',')}"


async def async_setup_entry(hass: HomeAssistant, entry: OverviewExtrasConfigEntry) -> bool:
    """Inject the module into every frontend page and create the per-room entities."""
    url = module_url(dict(entry.options))
    add_extra_js_url(hass, url)
    entry.runtime_data = url
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _watch_for_new_sources(hass, entry)
    return True


def _watch_for_new_sources(hass: HomeAssistant, entry: OverviewExtrasConfigEntry) -> None:
    """Reload when rooms gain or lose candidate entities, so new ones are included automatically."""
    snapshot = candidates_by_area(hass)

    async def _check() -> None:
        nonlocal snapshot
        current = candidates_by_area(hass)
        if current != snapshot:
            snapshot = current
            hass.config_entries.async_schedule_reload(entry.entry_id)

    debouncer = Debouncer(hass, __name__, cooldown=10, immediate=False, function=_check)

    @callback
    def _registry_changed(event: Event) -> None:
        debouncer.async_schedule_call()

    entry.async_on_unload(hass.bus.async_listen(EVENT_ENTITY_REGISTRY_UPDATED, _registry_changed))
    entry.async_on_unload(hass.bus.async_listen(EVENT_DEVICE_REGISTRY_UPDATED, _registry_changed))
    entry.async_on_unload(debouncer.async_shutdown)


async def async_unload_entry(hass: HomeAssistant, entry: OverviewExtrasConfigEntry) -> bool:
    """Stop injecting the module and remove the per-room entities."""
    try:
        remove_extra_js_url(hass, entry.runtime_data)
    except (KeyError, ValueError):
        pass
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: OverviewExtrasConfigEntry) -> None:
    """Give rooms back their own temperature/humidity setting when the integration is removed."""
    area_reg = ar.async_get(hass)
    prefix = f"sensor.{DOMAIN}_"
    for area in list(area_reg.areas.values()):
        changes = {}
        if (area.temperature_entity_id or "").startswith(prefix):
            changes["temperature_entity_id"] = None
        if (area.humidity_entity_id or "").startswith(prefix):
            changes["humidity_entity_id"] = None
        if changes:
            area_reg.async_update(area.id, **changes)
