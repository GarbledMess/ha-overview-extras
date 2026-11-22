"""Tests for Overview Extras: setup, injection, options flow, unload."""

from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component

from custom_components.overview_extras.const import DOMAIN


def _module_urls(hass: HomeAssistant) -> list[str]:
    return [u for u in hass.data[DATA_EXTRA_MODULE_URL].urls if "/overview_extras/" in u]


async def test_full_lifecycle(hass: HomeAssistant, hass_client) -> None:
    assert await async_setup_component(hass, "frontend", {})

    # Add from the UI
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]

    urls = _module_urls(hass)
    assert len(urls) == 1
    assert urls[0].startswith("/overview_extras/overview-extras.js?enhance_overview=1")

    # The module is actually served
    client = await hass_client()
    resp = await client.get(urls[0])
    assert resp.status == 200
    body = await resp.text()
    assert "home-overview-view-strategy" in body

    # ...and is in the page HTML the browser loads (so it runs on the built-in Overview too)
    with patch("homeassistant.components.onboarding.async_is_onboarded", return_value=True):
        index = await (await client.get("/")).text()
    assert urls[0].replace("&", "&amp;") in index or urls[0] in index

    # Only one instance allowed
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT

    # Change settings from the Configure dialog
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "show_glow": False,
            "show_power": True,
            "show_presence": True,
            "area_strip": True,
            "badges": ["lights", "media"],
            "max_badges": 2,
            "power_exclude": ["sensor.kitchen_circuit_power"],
            "exclude_entities": [],
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()

    urls = _module_urls(hass)
    assert len(urls) == 1, urls  # old URL removed, new one added
    url = urls[0]
    assert "show_glow=0" in url
    assert "badges=lights,media" in url
    assert "max_badges=2" in url
    assert "power_exclude=sensor.kitchen_circuit_power" in url

    # Removing the integration stops the injection
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert _module_urls(hass) == []
