"""Config and options flow for Overview Extras."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    BADGE_OPTIONS,
    CONF_AREA_STRIP,
    CONF_BADGES,
    CONF_EXCLUDE_ENTITIES,
    CONF_MAX_BADGES,
    CONF_POWER_EXCLUDE,
    CONF_SHOW_GLOW,
    CONF_SHOW_POWER,
    CONF_SHOW_PRESENCE,
    DEFAULT_BADGES,
    DEFAULT_MAX_BADGES,
    DOMAIN,
)


class OverviewExtrasConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add Overview Extras from the UI."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm and create the (single) entry."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Overview Extras", data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OverviewExtrasOptionsFlow:
        """Settings dialog."""
        return OverviewExtrasOptionsFlow()


class OverviewExtrasOptionsFlow(OptionsFlowWithReload):
    """Settings: changes reload the entry, which re-injects the module with new options."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show and save the settings."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        o = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Optional(CONF_SHOW_GLOW, default=o.get(CONF_SHOW_GLOW, True)): BooleanSelector(),
                vol.Optional(CONF_SHOW_POWER, default=o.get(CONF_SHOW_POWER, True)): BooleanSelector(),
                vol.Optional(CONF_SHOW_PRESENCE, default=o.get(CONF_SHOW_PRESENCE, True)): BooleanSelector(),
                vol.Optional(CONF_AREA_STRIP, default=o.get(CONF_AREA_STRIP, True)): BooleanSelector(),
                vol.Optional(CONF_BADGES, default=o.get(CONF_BADGES, DEFAULT_BADGES)): SelectSelector(
                    SelectSelectorConfig(
                        options=BADGE_OPTIONS,
                        multiple=True,
                        mode=SelectSelectorMode.LIST,
                        translation_key=CONF_BADGES,
                    )
                ),
                vol.Optional(CONF_MAX_BADGES, default=o.get(CONF_MAX_BADGES, DEFAULT_MAX_BADGES)): NumberSelector(
                    NumberSelectorConfig(min=1, max=6, step=1, mode=NumberSelectorMode.BOX)
                ),
                vol.Optional(CONF_POWER_EXCLUDE, default=o.get(CONF_POWER_EXCLUDE, [])): EntitySelector(
                    EntitySelectorConfig(domain="sensor", device_class="power", multiple=True)
                ),
                vol.Optional(CONF_EXCLUDE_ENTITIES, default=o.get(CONF_EXCLUDE_ENTITIES, [])): EntitySelector(
                    EntitySelectorConfig(multiple=True)
                ),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
