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
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.selector import (
    AreaSelector,
    AreaSelectorConfig,
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

from .sources import candidates_by_area
from .const import (
    BADGE_OPTIONS,
    CONF_AREA_STRIP,
    CONF_BADGES,
    CONF_EXCLUDE_ENTITIES,
    CONF_MAX_BADGES,
    CONF_SHOW_GLOW,
    CONF_SHOW_POWER,
    CONF_SHOW_PRESENCE,
    CONF_SET_PRIMARY,
    CONF_SOURCES_EXCLUDED,
    CATEGORIES,
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
    """Settings. Saving reloads the entry, which re-injects the module and rebuilds the room entities."""

    def __init__(self) -> None:
        self._options: dict[str, Any] | None = None
        self._area_id: str | None = None

    @property
    def _opts(self) -> dict[str, Any]:
        if self._options is None:
            self._options = dict(self.config_entry.options)
        return self._options

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose what to change."""
        return self.async_show_menu(step_id="init", menu_options=["room_sources", "settings", "save"])

    async def async_step_save(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_create_entry(data=self._opts)

    # ---- Room sources -------------------------------------------------------

    async def async_step_room_sources(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick a room."""
        if user_input is not None:
            self._area_id = user_input["area"]
            return await self.async_step_room()
        return self.async_show_form(
            step_id="room_sources",
            data_schema=vol.Schema({vol.Required("area"): AreaSelector(AreaSelectorConfig())}),
        )

    async def async_step_room(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Untick sources to leave them out. Everything is ticked by default; new entities join automatically."""
        area_id = self._area_id
        candidates = candidates_by_area(self.hass).get(area_id, {c: [] for c in CATEGORIES})
        all_excluded = self._opts.get(CONF_SOURCES_EXCLUDED, {})
        room_excluded = all_excluded.get(area_id, {})

        if user_input is not None:
            new_room = {}
            for cat in CATEGORIES:
                chosen = set(user_input.get(cat, []))
                removed = sorted(e for e in candidates[cat] if e not in chosen)
                # Keep earlier removals of entities that are temporarily gone, so they stay removed.
                removed += [e for e in room_excluded.get(cat, []) if e not in candidates[cat]]
                if removed:
                    new_room[cat] = sorted(set(removed))
            all_excluded = {k: v for k, v in all_excluded.items() if k != area_id}
            if new_room:
                all_excluded[area_id] = new_room
            self._opts[CONF_SOURCES_EXCLUDED] = all_excluded
            return await self.async_step_init()

        fields: dict = {}
        for cat in CATEGORIES:
            if not candidates[cat]:
                continue
            default = [e for e in candidates[cat] if e not in room_excluded.get(cat, [])]
            fields[vol.Optional(cat, default=default)] = EntitySelector(
                EntitySelectorConfig(include_entities=candidates[cat], multiple=True)
            )
        area = ar.async_get(self.hass).async_get_area(area_id)
        name = area.name if area else area_id
        if not fields:
            return self.async_abort(reason="no_sources", description_placeholders={"area": name})
        return self.async_show_form(
            step_id="room",
            data_schema=vol.Schema(fields),
            description_placeholders={"area": name},
        )

    # ---- General settings ---------------------------------------------------

    async def async_step_settings(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show and save the general settings."""
        if user_input is not None:
            self._opts.update(user_input)
            return await self.async_step_init()

        o = self._opts
        schema = vol.Schema(
            {
                vol.Optional(CONF_SHOW_GLOW, default=o.get(CONF_SHOW_GLOW, True)): BooleanSelector(),
                vol.Optional(CONF_SHOW_POWER, default=o.get(CONF_SHOW_POWER, True)): BooleanSelector(),
                vol.Optional(CONF_SHOW_PRESENCE, default=o.get(CONF_SHOW_PRESENCE, True)): BooleanSelector(),
                vol.Optional(CONF_AREA_STRIP, default=o.get(CONF_AREA_STRIP, True)): BooleanSelector(),
                vol.Optional(CONF_SET_PRIMARY, default=o.get(CONF_SET_PRIMARY, True)): BooleanSelector(),
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
                vol.Optional(CONF_EXCLUDE_ENTITIES, default=o.get(CONF_EXCLUDE_ENTITIES, [])): EntitySelector(
                    EntitySelectorConfig(multiple=True)
                ),
            }
        )
        return self.async_show_form(step_id="settings", data_schema=schema)
