"""Overview Extras: richer room cards injected into Home Assistant's built-in Overview.

The integration serves a single frontend module and registers it as an "extra module",
so it loads on every page, including the built-in Overview (which does not load dashboard
resources). Options from the UI are passed to the module as URL query parameters.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_AREA_STRIP,
    CONF_BADGES,
    CONF_EXCLUDE_ENTITIES,
    CONF_MAX_BADGES,
    CONF_POWER_EXCLUDE,
    CONF_SHOW_GLOW,
    CONF_SHOW_POWER,
    CONF_SHOW_PRESENCE,
    DOMAIN,
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
    return True


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
    """Inject the module into every frontend page."""
    url = module_url(dict(entry.options))
    add_extra_js_url(hass, url)
    entry.runtime_data = url
    return True


async def async_unload_entry(hass: HomeAssistant, entry: OverviewExtrasConfigEntry) -> bool:
    """Stop injecting the module."""
    try:
        remove_extra_js_url(hass, entry.runtime_data)
    except (KeyError, ValueError):
        pass
    return True
