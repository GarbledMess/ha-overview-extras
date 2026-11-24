"""Constants for Overview Extras."""

DOMAIN = "overview_extras"
VERSION = "0.5.0"

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

# Per-room sources. Options store what was *removed* per room and category, so anything
# new that appears in a room is included automatically.
CONF_SOURCES_EXCLUDED = "sources_excluded"
CONF_SET_PRIMARY = "set_primary"

CATEGORIES = ["temperature", "humidity", "power", "presence", "lights"]
PRESENCE_CLASSES = {"occupancy", "presence", "motion"}
POWER_FACTORS = {"mW": 0.001, "W": 1.0, "kW": 1000.0, "MW": 1_000_000.0}

PLATFORMS = ["sensor", "binary_sensor"]
