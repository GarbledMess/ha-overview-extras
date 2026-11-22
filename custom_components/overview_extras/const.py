"""Constants for Overview Extras."""

DOMAIN = "overview_extras"
VERSION = "0.3.2"

URL_BASE = "/overview_extras"
JS_FILE = "overview-extras.js"

CONF_SHOW_GLOW = "show_glow"
CONF_SHOW_POWER = "show_power"
CONF_SHOW_PRESENCE = "show_presence"
CONF_AREA_STRIP = "area_strip"
CONF_BADGES = "badges"
CONF_MAX_BADGES = "max_badges"
CONF_POWER_EXCLUDE = "power_exclude"
CONF_EXCLUDE_ENTITIES = "exclude_entities"

BADGE_OPTIONS = [
    "lights",
    "alerts",
    "openings",
    "locks",
    "media",
    "climate",
    "fans",
    "covers",
    "battery",
]
DEFAULT_BADGES = ["lights", "alerts", "openings", "locks", "media", "climate"]
DEFAULT_MAX_BADGES = 3
