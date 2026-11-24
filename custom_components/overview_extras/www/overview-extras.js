/*
 * Overview Extras for Home Assistant
 *
 * Provides:
 *   - Dashboard strategy  `custom:overview-extras`    (HA's own Overview, auto-updating, plus extras)
 *   - Dashboard strategy  `custom:enhanced-areas`   (standalone fallback: generates everything itself)
 *   - Card                `custom:enhanced-area-card`  (rich room/area card)
 *   - Card                `custom:enhanced-home-summary-card` (whole-home summary strip)
 *
 * No build step, no dependencies. Load as a dashboard resource (type: module).
 */

const VERSION = "0.5.0";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const PRESENCE_CLASSES = ["occupancy", "presence", "motion"];
const OPENING_CLASSES = ["door", "window", "garage_door", "opening"];
const ALERT_CLASSES = ["moisture", "smoke", "gas", "carbon_monoxide", "safety", "problem", "tamper"];
const POWER_FACTORS = { mW: 0.001, W: 1, kW: 1000, MW: 1e6 };

// Domains never shown on generated views (same spirit as the default dashboard).
const HIDDEN_DOMAINS = new Set([
  "automation", "configurator", "device_tracker", "event", "geo_location",
  "persistent_notification", "zone", "tts", "stt", "wake_word", "conversation",
  "assist_satellite", "image", "tag", "ai_task", "notify", "update", "sun",
]);

// How entities are grouped on an area's subview (order matters).
const GROUPS = [
  { key: "lights", title: "Lights", icon: "mdi:lightbulb-group", domains: ["light"] },
  { key: "climate", title: "Climate", icon: "mdi:thermostat", domains: ["climate", "fan", "humidifier", "water_heater"] },
  { key: "covers", title: "Covers", icon: "mdi:window-shutter", domains: ["cover", "valve"] },
  { key: "media", title: "Media", icon: "mdi:play-box-multiple", domains: ["media_player", "remote"] },
  { key: "security", title: "Security", icon: "mdi:shield-home", domains: ["lock", "alarm_control_panel", "camera"] },
  { key: "switches", title: "Switches", icon: "mdi:toggle-switch", domains: ["switch", "input_boolean", "siren"] },
  { key: "cleaning", title: "Cleaning", icon: "mdi:robot-vacuum", domains: ["vacuum", "lawn_mower"] },
  { key: "binary", title: "Status", icon: "mdi:checkbox-marked-circle-outline", domains: ["binary_sensor"] },
  { key: "sensors", title: "Sensors", icon: "mdi:gauge", domains: ["sensor"] },
  { key: "controls", title: "Controls", icon: "mdi:tune-variant", domains: ["input_number", "input_select", "number", "select", "button", "input_button", "scene", "script", "text", "input_text", "input_datetime", "date", "time", "datetime"] },
];

const domainOf = (id) => id.slice(0, id.indexOf("."));
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const isUnavail = (s) => !s || s.state === "unavailable" || s.state === "unknown";
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------------ */
/* Registry helpers                                                          */
/* ------------------------------------------------------------------------ */

const _indexCache = new WeakMap();

/** Map area_id -> [entity_id], respecting device area inheritance. Cached per registry snapshot. */
function areaIndex(hass) {
  const ents = hass.entities || {};
  const devs = hass.devices || {};
  let byDevices = _indexCache.get(ents);
  if (byDevices && byDevices.devs === devs) return byDevices.index;
  const index = new Map();
  for (const e of Object.values(ents)) {
    const areaId = e.area_id || (e.device_id && devs[e.device_id]?.area_id) || null;
    if (!index.has(areaId)) index.set(areaId, []);
    index.get(areaId).push(e.entity_id);
  }
  _indexCache.set(ents, { devs, index });
  return index;
}

/** Entities worth showing (not hidden, not config/diagnostic, not a hidden domain). */
function isVisibleEntity(hass, id, extraHidden = []) {
  const e = hass.entities?.[id];
  if (e && (e.hidden || e.entity_category || e.platform === "overview_extras")) return false;
  if (HIDDEN_DOMAINS.has(domainOf(id))) return false;
  if (extraHidden.includes(id)) return false;
  return true;
}

function entitiesForArea(hass, areaId, exclude = []) {
  return (areaIndex(hass).get(areaId) || []).filter((id) => isVisibleEntity(hass, id, exclude));
}

function sortedFloors(hass) {
  return Object.values(hass.floors || {}).sort(
    (a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name)
  );
}

function sortedAreas(hass, order = []) {
  const rank = (id) => {
    const i = order.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  return Object.values(hass.areas || {}).sort(
    (a, b) => rank(a.area_id) - rank(b.area_id) || a.name.localeCompare(b.name)
  );
}

const friendly = (hass, id) => hass.states[id]?.attributes?.friendly_name || id;

/* ------------------------------------------------------------------------ */
/* Summary computation (shared by area + home cards)                         */
/* ------------------------------------------------------------------------ */

function avgSensor(hass, ids, deviceClass, preferred, excluded = []) {
  if (preferred && !isUnavail(hass.states[preferred])) {
    const s = hass.states[preferred];
    return { value: num(s.state), unit: s.attributes.unit_of_measurement || "", entity: preferred };
  }
  const vals = [];
  let unit = "";
  let entity = null;
  for (const id of ids) {
    if (domainOf(id) !== "sensor") continue;
    const s = hass.states[id];
    if (isUnavail(s) || s.attributes.device_class !== deviceClass || excluded.includes(id)) continue;
    const v = num(s.state);
    if (v === null) continue;
    vals.push(v);
    unit ||= s.attributes.unit_of_measurement || "";
    entity = vals.length === 1 ? id : null;
  }
  if (!vals.length) return null;
  return { value: vals.reduce((a, b) => a + b, 0) / vals.length, unit, entity };
}

function summarize(hass, ids, opts = {}) {
  const powerExclude = new Set(opts.power_exclude || []);
  // Per-room source choices from the integration's "Room sources" screen.
  const ex = opts.sources_excluded || {};
  const skip = (cat, id) => ex[cat]?.includes(id);
  const out = {
    lights: { on: [], total: 0 },
    presence: { sensors: [], occupied: false, since: null },
    power: { value: 0, sensors: [] },
    openings: [],
    covers: [],
    media: [],
    climate: [],
    fans: [],
    unlocked: [],
    alerts: [],
    lowBattery: [],
  };

  for (const id of ids) {
    const s = hass.states[id];
    if (!s) continue;
    const d = domainOf(id);
    const dc = s.attributes.device_class;

    switch (d) {
      case "light":
        if (s.state === "unavailable" || skip("lights", id)) break;
        out.lights.total++;
        if (s.state === "on") out.lights.on.push(id);
        break;
      case "binary_sensor":
        if (PRESENCE_CLASSES.includes(dc)) {
          if (skip("presence", id)) break;
          out.presence.sensors.push(id);
          if (s.state === "on") out.presence.occupied = true;
          const t = Date.parse(s.last_changed);
          if (s.state !== "unavailable" && (!out.presence.since || t > out.presence.since)) out.presence.since = t;
        } else if (OPENING_CLASSES.includes(dc) && s.state === "on") out.openings.push(id);
        else if (ALERT_CLASSES.includes(dc) && s.state === "on") out.alerts.push(id);
        else if (dc === "battery" && s.state === "on") out.lowBattery.push(id);
        break;
      case "sensor": {
        if (dc === "power" && !powerExclude.has(id) && !skip("power", id) && !isUnavail(s)) {
          const f = POWER_FACTORS[s.attributes.unit_of_measurement];
          const v = num(s.state);
          if (f && v !== null) {
            out.power.value += v * f;
            out.power.sensors.push(id);
          }
        } else if (dc === "battery" && s.attributes.unit_of_measurement === "%") {
          const v = num(s.state);
          if (v !== null && v <= (opts.battery_threshold ?? 20)) out.lowBattery.push(id);
        }
        break;
      }
      case "cover":
        if (["open", "opening"].includes(s.state) && dc !== "damper") out.covers.push(id);
        break;
      case "media_player":
        if (s.state === "playing") out.media.push(id);
        break;
      case "climate":
        if (s.state !== "off" && !isUnavail(s)) out.climate.push(id);
        break;
      case "fan":
        if (s.state === "on") out.fans.push(id);
        break;
      case "lock":
        if (["unlocked", "open", "opening", "unlocking"].includes(s.state)) out.unlocked.push(id);
        break;
    }
  }
  return out;
}

function fmtPower(w) {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(a >= 10000 ? 1 : 2)} kW`;
  return `${Math.round(w)} W`;
}

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtNum(v, digits = 1) {
  return v === null || v === undefined ? "" : Number(v).toFixed(digits).replace(/\.0+$/, "");
}

/* ------------------------------------------------------------------------ */
/* Actions                                                                   */
/* ------------------------------------------------------------------------ */

function fire(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
function moreInfo(node, entityId) {
  if (entityId) fire(node, "hass-more-info", { entityId });
}
function navigate(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
}

/* ------------------------------------------------------------------------ */
/* Shared styles                                                             */
/* ------------------------------------------------------------------------ */

// Colours come from HA's own state colour tokens (so themes apply), with HA's palette as fallback.
const VARS_CSS = `
  :host {
    --ea-light-color: var(--state-light-active-color, var(--amber-color, #ffc107));
    --ea-presence-color: var(--state-binary_sensor-occupancy-on-color, var(--state-binary_sensor-active-color, var(--amber-color, #ffc107)));
    --ea-power-color: var(--energy-grid-consumption-color, var(--blue-color, #2196f3));
    --ea-opening-color: var(--state-binary_sensor-opening-on-color, var(--state-binary_sensor-active-color, var(--amber-color, #ffc107)));
    --ea-lock-color: var(--state-lock-unlocked-color, var(--red-color, #f44336));
    --ea-media-color: var(--state-media_player-active-color, var(--light-blue-color, #03a9f4));
    --ea-heat-color: var(--state-climate-heat-color, var(--deep-orange-color, #ff6f22));
    --ea-cool-color: var(--state-climate-cool-color, var(--blue-color, #2196f3));
    --ea-fan-color: var(--state-fan-active-color, var(--cyan-color, #00bcd4));
    --ea-cover-color: var(--state-cover-active-color, var(--purple-color, #926bc7));
    --ea-alert-color: var(--error-color, #db4437);
    --ea-battery-color: var(--state-sensor-battery-low-color, var(--red-color, #f44336));
    --ea-neutral-color: var(--state-icon-color, var(--secondary-text-color));
    display: block;
  }
`;

// Maps chip/badge kinds to a colour.
const KIND_CSS = `
  [data-kind] { --chip-color: var(--ea-neutral-color); }
  [data-kind="lights"].on { --chip-color: var(--ea-light-color); }
  [data-kind="presence"].on { --chip-color: var(--ea-presence-color); }
  [data-kind="power"] { --chip-color: var(--ea-power-color); }
  [data-kind="openings"] { --chip-color: var(--ea-opening-color); }
  [data-kind="locks"] { --chip-color: var(--ea-lock-color); }
  [data-kind="media"] { --chip-color: var(--ea-media-color); }
  [data-kind="climate"].heat { --chip-color: var(--ea-heat-color); }
  [data-kind="climate"].cool { --chip-color: var(--ea-cool-color); }
  [data-kind="fans"] { --chip-color: var(--ea-fan-color); }
  [data-kind="covers"] { --chip-color: var(--ea-cover-color); }
  [data-kind="alerts"] { --chip-color: var(--ea-alert-color); }
  [data-kind="battery"] { --chip-color: var(--ea-battery-color); }
`;

// Same look as HA's entity badges (Overview header badges).
const CHIP_CSS = `
  ${KIND_CSS}
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
    height: 36px; padding: 0 12px 0 8px; border-radius: 18px; max-width: 100%;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
    box-shadow: var(--ha-card-box-shadow, none);
    color: var(--primary-text-color); font-family: inherit;
    font-size: var(--ha-font-size-s, 12px); font-weight: var(--ha-font-weight-medium, 500);
    line-height: 1; letter-spacing: 0.1px; white-space: nowrap; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .chip:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .chip ha-icon { --mdc-icon-size: 18px; color: var(--chip-color); flex: none; }
  .chip span { overflow: hidden; text-overflow: ellipsis; }
  .chip.off span { color: var(--secondary-text-color); }
  .chip[data-kind="alerts"] { border-color: var(--ea-alert-color); }
`;

const OPENING_ICONS = { door: "mdi:door-open", window: "mdi:window-open", garage_door: "mdi:garage-open", opening: "mdi:square-outline" };
const ALERT_ICONS = { moisture: "mdi:water-alert", smoke: "mdi:smoke-detector-variant-alert", gas: "mdi:alert-decagram", carbon_monoxide: "mdi:molecule-co", safety: "mdi:alert-circle", problem: "mdi:alert-circle", tamper: "mdi:shield-alert" };

/** Build the chip list from a summary. Returns [{kind, state, icon, text, action, title}] */
function buildChips(hass, sum, cfg, { home = false } = {}) {
  const chips = [];
  const show = (k) => cfg[`show_${k}`] !== false;
  const one = (list) => (list.length === 1 ? list[0] : null);
  const names = (list) => list.map((id) => friendly(hass, id)).join(", ");
  const dc = (id) => hass.states[id]?.attributes?.device_class;

  if (show("lights") && sum.lights.total) {
    const on = sum.lights.on.length;
    chips.push({
      kind: "lights",
      state: on ? "on" : "off",
      icon: on ? "mdi:lightbulb" : "mdi:lightbulb-off",
      text: on ? (home ? `${on} on` : sum.lights.total > 1 ? `${on}/${sum.lights.total} on` : "On") : "Off",
      action: { type: "lights" },
      title: on ? `Lights on: ${names(sum.lights.on)}. Tap to turn off.` : "Lights off",
    });
  }
  if (show("presence") && sum.presence.sensors.length && !home) {
    const occ = sum.presence.occupied;
    chips.push({
      kind: "presence",
      state: occ ? "on" : "off",
      icon: occ ? "mdi:home-account" : "mdi:home-outline",
      text: occ ? "Occupied" : `Clear${sum.presence.since ? " · " + fmtAgo(sum.presence.since) : ""}`,
      action: { type: "more-info", entity: one(sum.presence.sensors) },
      title: names(sum.presence.sensors),
    });
  }
  if (show("power") && sum.power.sensors.length) {
    chips.push({
      kind: "power",
      icon: "mdi:flash",
      text: fmtPower(sum.power.value),
      action: { type: "more-info", entity: one(sum.power.sensors) },
      title: `Sum of ${sum.power.sensors.length} power sensor(s): ${names(sum.power.sensors)}`,
    });
  }
  if (show("climate") && !home) {
    for (const id of sum.climate.slice(0, 1)) {
      const a = hass.states[id].attributes;
      const act = a.hvac_action;
      const state = act === "heating" || act === "preheating" ? "heat" : act === "cooling" ? "cool" : act === "drying" ? "cool" : "idle";
      const icon = state === "heat" ? "mdi:fire" : state === "cool" ? (act === "drying" ? "mdi:water-percent" : "mdi:snowflake") : "mdi:thermostat";
      const target = a.temperature ?? (a.target_temp_low != null ? `${a.target_temp_low}–${a.target_temp_high}` : null);
      chips.push({
        kind: "climate",
        state,
        icon,
        text: target != null ? `${target}°` : hass.states[id].state,
        action: { type: "more-info", entity: id },
        title: `${friendly(hass, id)}: ${act || hass.states[id].state}`,
      });
    }
  }
  if (show("openings") && sum.openings.length) {
    chips.push({
      kind: "openings",
      icon: OPENING_ICONS[dc(sum.openings[0])] || "mdi:door-open",
      text: home || sum.openings.length > 1 ? `${sum.openings.length} open` : shortName(hass, sum.openings[0], cfg._areaName),
      count: sum.openings.length,
      action: { type: "more-info", entity: one(sum.openings) },
      title: `Open: ${names(sum.openings)}`,
    });
  }
  if (show("covers") && sum.covers.length) {
    chips.push({
      kind: "covers",
      icon: "mdi:window-shutter-open",
      text: `${sum.covers.length} open`,
      count: sum.covers.length,
      action: { type: "more-info", entity: one(sum.covers) },
      title: `Open: ${names(sum.covers)}`,
    });
  }
  if (show("locks") && sum.unlocked.length) {
    chips.push({
      kind: "locks",
      icon: "mdi:lock-open-variant",
      text: sum.unlocked.length === 1 ? "Unlocked" : `${sum.unlocked.length} unlocked`,
      count: sum.unlocked.length,
      action: { type: "more-info", entity: one(sum.unlocked) },
      title: `Unlocked: ${names(sum.unlocked)}`,
    });
  }
  if (show("fans") && sum.fans.length) {
    chips.push({
      kind: "fans",
      icon: "mdi:fan",
      text: sum.fans.length === 1 ? "Fan on" : `${sum.fans.length} fans`,
      count: sum.fans.length,
      action: { type: "more-info", entity: one(sum.fans) },
      title: names(sum.fans),
    });
  }
  if (show("media") && sum.media.length) {
    const a = hass.states[sum.media[0]].attributes;
    chips.push({
      kind: "media",
      icon: "mdi:play",
      text: home ? `${sum.media.length} playing` : a.media_title ? `${a.media_title}${a.media_artist ? " · " + a.media_artist : ""}` : "Playing",
      action: { type: "more-info", entity: sum.media[0] },
      title: `Playing: ${names(sum.media)}`,
    });
  }
  if (show("alerts") && sum.alerts.length) {
    chips.push({
      kind: "alerts",
      icon: ALERT_ICONS[dc(sum.alerts[0])] || "mdi:alert-circle",
      text: sum.alerts.length === 1 ? shortName(hass, sum.alerts[0], cfg._areaName) : `${sum.alerts.length} alerts`,
      count: sum.alerts.length,
      action: { type: "more-info", entity: one(sum.alerts) },
      title: names(sum.alerts),
    });
  }
  if (show("battery") && sum.lowBattery.length) {
    chips.push({
      kind: "battery",
      icon: "mdi:battery-alert",
      text: sum.lowBattery.length === 1 ? "Low battery" : `${sum.lowBattery.length} low batteries`,
      count: sum.lowBattery.length,
      action: { type: "more-info", entity: one(sum.lowBattery) },
      title: `Low battery: ${names(sum.lowBattery)}`,
    });
  }
  return chips;
}

/** Strip the area name from an entity's friendly name ("Kitchen Window" -> "Window"). */
function shortName(hass, id, areaName) {
  let n = friendly(hass, id);
  if (areaName && n.toLowerCase().startsWith(areaName.toLowerCase() + " ")) n = n.slice(areaName.length + 1);
  return n.length > 18 ? n.slice(0, 17) + "…" : n;
}

function chipsHtml(chips, cls = "chip", label = (c) => c.text) {
  return chips
    .map((c, i) => {
      const text = label(c);
      return `<button class="${cls} ${c.state || ""}" data-kind="${c.kind}" data-chip="${i}" title="${esc(c.title)}" aria-label="${esc(c.title)}"><ha-icon icon="${c.icon}"></ha-icon>${text ? `<span>${esc(text)}</span>` : ""}</button>`;
    })
    .join("");
}

/** A string that changes whenever anything the card displays changes. */
function signature(hass, ids) {
  let sig = "";
  for (const id of ids) {
    const s = hass.states[id];
    if (!s) continue;
    sig += id + s.state + s.last_changed;
    const d = domainOf(id);
    if (d === "media_player") sig += s.attributes.media_title + s.attributes.media_artist;
    else if (d === "climate") sig += s.attributes.hvac_action + s.attributes.temperature + s.attributes.current_temperature;
  }
  return sig;
}


/* ------------------------------------------------------------------------ */
/* Creating the built-in area card                                          */
/* ------------------------------------------------------------------------ */

/**
 * Build HA's own area card. `hui-card` is HA's generic card host (used by every sections
 * view, so it's defined on the built-in Overview); it lazy-loads the real card itself.
 * `window.loadCardHelpers` only exists once a regular dashboard has been opened.
 */
async function createNativeCard(config) {
  const viaHuiCard = () => {
    const el = document.createElement("hui-card");
    el.config = config;
    return el;
  };
  if (customElements.get("hui-card")) return viaHuiCard();
  try {
    if (window.loadCardHelpers) {
      const helpers = await window.loadCardHelpers();
      const el = await helpers.createCardElement(config);
      if (el) return el;
    }
  } catch (e) {
    /* fall through */
  }
  const defined = await Promise.race([
    customElements.whenDefined("hui-card").then(() => true),
    new Promise((r) => setTimeout(() => r(false), 4000)),
  ]);
  if (defined) return viaHuiCard();
  // Last resort: our own look-alike of the compact area card, so the layout still fits.
  const el = document.createElement("enhanced-compact-area");
  el.setConfig(config);
  return el;
}

/** Look-alike of HA's compact vertical area card. Only used if HA's own can't be created. */
class EnhancedCompactArea extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  _render() {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !cfg) return;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", () => {
        if (cfg.tap_action?.action === "navigate") navigate(cfg.tap_action.navigation_path);
      });
    }
    const area = hass.areas?.[cfg.area];
    if (!area) return;
    const ids = entitiesForArea(hass, cfg.area, cfg.exclude_entities || []);
    const sig = signature(hass, ids) + area.name + area.icon;
    if (sig === this._sig) return;
    this._sig = sig;
    const sum = summarize(hass, ids, { power_exclude: cfg.exclude_entities });
    const parts = [];
    const temp = avgSensor(hass, ids, "temperature", area.temperature_entity_id);
    if (temp && (cfg.sensor_classes || []).includes("temperature")) parts.push(`${fmtNum(temp.value)} ${temp.unit}`);
    if ((cfg.sensor_classes || []).includes("power") && sum.power.sensors.length) parts.push(fmtPower(sum.power.value));
    const alertCls = (cfg.alert_classes || ["moisture", "motion"]).find((c) =>
      ids.some((id) => domainOf(id) === "binary_sensor" && hass.states[id]?.state === "on" && hass.states[id].attributes.device_class === c)
    );
    const alertIcon = { moisture: "mdi:water-alert", motion: "mdi:motion-sensor", occupancy: "mdi:home-account", presence: "mdi:home-account" }[alertCls] || "mdi:alert-circle";
    this.shadowRoot.innerHTML = `
      <style>
        ${VARS_CSS}
        :host { height: 100%; }
        ha-card { height: 100%; box-sizing: border-box; padding: 8px; cursor: pointer; position: relative;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; text-align: center; overflow: hidden; }
        .icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
          color: var(--ea-neutral-color); background: color-mix(in srgb, var(--ea-neutral-color) 20%, transparent); }
        .name { font-size: var(--ha-font-size-m, 14px); font-weight: var(--ha-font-weight-medium, 500); color: var(--primary-text-color);
          max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sensors { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .alert { position: absolute; top: 8px; left: 8px; width: 24px; height: 24px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
          --c: var(--ea-presence-color); color: var(--c); background: color-mix(in srgb, var(--c) 20%, var(--ha-card-background, var(--card-background-color, #fff))); }
        .alert ha-icon { --mdc-icon-size: 16px; }
      </style>
      <ha-card>
        ${alertCls ? `<div class="alert"><ha-icon icon="${alertIcon}"></ha-icon></div>` : ""}
        <div class="icon"><ha-icon icon="${esc(area.icon || "mdi:texture-box")}"></ha-icon></div>
        <div class="name">${esc(area.name)}</div>
        ${parts.length ? `<div class="sensors">${esc(parts.join(" · "))}</div>` : ""}
      </ha-card>`;
  }
  getCardSize() {
    return 2;
  }
}

/* ------------------------------------------------------------------------ */
/* Base card                                                                 */
/* ------------------------------------------------------------------------ */

class EABaseCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sig = null;
    this._chips = [];
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
  }
  connectedCallback() {
    // Re-render periodically so "Clear · 5m ago" stays fresh.
    this._timer = setInterval(() => {
      this._sig = null;
      this._update();
    }, 60000);
  }
  disconnectedCallback() {
    clearInterval(this._timer);
  }
  set hass(hass) {
    this._hass = hass;
    this._update();
  }
  get hass() {
    return this._hass;
  }
  _onClick(ev) {
    const chipEl = ev.composedPath().find((n) => n.dataset && n.dataset.chip !== undefined);
    if (chipEl) {
      ev.stopPropagation();
      const chip = this._chips[Number(chipEl.dataset.chip)];
      if (chip) this._runChip(chip);
      return;
    }
    this._onCardClick?.(ev);
  }
  _runChip(chip) {
    const a = chip.action || {};
    if (a.type === "lights") {
      const on = this._summary.lights.on;
      if (on.length) this._hass.callService("light", "turn_off", { entity_id: on });
      else this._lightsOn();
    } else if (a.type === "more-info") {
      if (a.entity) moreInfo(this, a.entity);
      else this._onCardClick?.();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Area card                                                                 */
/* ------------------------------------------------------------------------ */

class EnhancedAreaCard extends EABaseCard {
  static getStubConfig(hass) {
    const area = Object.values(hass.areas || {})[0];
    return { area: area?.area_id || "" };
  }

  setConfig(config) {
    if (!config || !(config.area || config.base?.area)) throw new Error("enhanced-area-card: 'area' is required");
    const area = config.area || config.base.area;
    this._config = { show_picture: true, ...config, area };
    this._wrapped = !!config.base;
    this._sig = null;
    if (this._wrapped) this._buildInner();
    this._update();
  }

  getCardSize() {
    if (this._wrapped && this._inner?.getCardSize) return this._inner.getCardSize();
    return 2;
  }
  getGridOptions() {
    if (this._wrapped) {
      return this._config.base.grid_options || this._inner?.getGridOptions?.() || { columns: 6, rows: 2 };
    }
    return { columns: 6, min_columns: 4, rows: "auto" };
  }

  /* ---- Wrapped mode: the real built-in area card plus injected extras ---- */

  /** Add our extras to the built-in area card's own options (stays native, follows upstream). */
  _nativeConfig() {
    const cfg = this._config;
    const base = { ...cfg.base };
    const removed = ["temperature", "humidity", "power", "presence"].flatMap((c) => cfg.sources_excluded?.[c] || []);
    const exclude = [...new Set([...(base.exclude_entities || []), ...(cfg.exclude_entities || []), ...(cfg.power_exclude || []), ...removed])];
    if (exclude.length) base.exclude_entities = exclude;
    if (cfg.native_power !== false && cfg.show_power !== false) {
      const sc = base.sensor_classes ? [...base.sensor_classes] : ["temperature", "humidity"];
      if (!sc.includes("power")) sc.push("power");
      base.sensor_classes = sc;
    }
    if (cfg.show_presence !== false) {
      const ac = base.alert_classes ? [...base.alert_classes] : ["moisture", "motion"];
      // Occupancy/presence first-class, ahead of plain motion (compact cards only show the first icon).
      const motionIdx = ac.indexOf("motion");
      const add = ["occupancy", "presence"].filter((c) => !ac.includes(c));
      ac.splice(motionIdx === -1 ? ac.length : motionIdx, 0, ...add);
      base.alert_classes = ac;
    }
    return base;
  }

  async _buildInner() {
    const nativeCfg = this._nativeConfig();
    const key = JSON.stringify(nativeCfg);
    if (key === this._innerKey) return;
    this._innerKey = key;
    const el = await createNativeCard(nativeCfg);
    this._inner = el;
    if (this._hass) el.hass = this._hass;
    this.shadowRoot.innerHTML = `
      <style>
        ${VARS_CSS}
        :host { height: 100%; }
        /* Never grow past the grid cell HA gave us (fixed rows on the Overview). */
        .wrap { position: relative; height: 100%; overflow: hidden; border-radius: var(--ha-card-border-radius, 12px); }
        .wrap > .inner, .inner > * { height: 100%; display: block; }
        /* Lights on: tint the card border with the light colour, as HA does for active tiles. */
        .wrap.lit { --ha-card-border-color: var(--ea-light-color); }
        ${KIND_CSS}
        .badges {
          position: absolute; top: 8px; right: 8px; z-index: 2;
          display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
          pointer-events: none;
        }
        /* Styled like HA's tile/area icons: colour on a 20% tint of the same colour. */
        .badge {
          pointer-events: auto; cursor: pointer; border: none; font-family: inherit;
          display: inline-flex; align-items: center; justify-content: center; gap: 2px;
          min-width: 24px; height: 24px; padding: 0 4px; box-sizing: border-box; border-radius: 12px;
          font-size: var(--ha-font-size-xs, 10px); font-weight: var(--ha-font-weight-bold, 600); line-height: 1;
          color: var(--chip-color);
          background: color-mix(in srgb, var(--chip-color) 20%, var(--ha-card-background, var(--card-background-color, #fff)));
          -webkit-tap-highlight-color: transparent;
        }
        .badge span { padding-right: 2px; }
        .badge:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
        .badge ha-icon { --mdc-icon-size: 16px; }
      </style>
      <div class="wrap"><div class="inner"></div><div class="badges"></div></div>`;
    this.shadowRoot.querySelector(".inner").appendChild(el);
    this._sig = null;
    this._update();
  }

  _updateWrapped() {
    const hass = this._hass;
    const cfg = this._config;
    if (this._inner) this._inner.hass = hass;
    const wrap = this.shadowRoot.querySelector(".wrap");
    if (!wrap) return;
    const area = hass.areas?.[cfg.area];
    const ids = this._ids();
    const sig = signature(hass, ids);
    if (sig === this._sig) return;
    this._sig = sig;
    const sum = summarize(hass, ids, cfg);
    this._summary = sum;

    // Pick the overlay badges. Presence and power are already rendered natively by the
    // area card (alert_classes / sensor_classes), so the overlay covers what it can't show.
    const want = cfg.badges || ["lights", "alerts", "openings", "locks", "media", "climate"];
    const all = buildChips(hass, sum, { ...cfg, show_presence: false, show_power: cfg.native_power === false && cfg.show_power !== false, _areaName: area?.name }, {});
    const byKind = Object.fromEntries(all.map((c) => [c.kind, c]));
    // Lights only earn a badge while on; idle climate isn't worth one.
    if (byKind.lights?.state !== "on") delete byKind.lights;
    if (byKind.climate?.state === "idle") delete byKind.climate;
    const chips = want.map((k) => byKind[k]).filter(Boolean).slice(0, cfg.max_badges ?? 3);
    // Badges are compact: icon, plus a count where it means something.
    const label = (c) => {
      if (c.kind === "lights") return sum.lights.on.length > 1 ? String(sum.lights.on.length) : "";
      if (c.kind === "power") return c.text;
      return c.count > 1 ? String(c.count) : "";
    };
    this._chips = chips;
    wrap.classList.toggle("lit", cfg.show_glow !== false && sum.lights.on.length > 0);
    this.shadowRoot.querySelector(".badges").innerHTML = chipsHtml(chips, "badge", label);
  }

  _ids() {
    const h = this._hass;
    const ids = entitiesForArea(h, this._config.area, this._config.exclude_entities || []);
    return ids.concat(this._config.extra_entities || []);
  }

  _lightsOn() {
    this._hass.callService("light", "turn_on", {}, { area_id: this._config.area });
  }

  _onCardClick(ev) {
    const c = this._config;
    if (this._wrapped) {
      // Real clicks on the built-in card are handled by the card itself.
      if (!ev && c.base.tap_action?.action === "navigate") navigate(c.base.tap_action.navigation_path);
      return;
    }
    if (c.navigation_path) navigate(c.navigation_path);
  }

  _update() {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !cfg) return;
    if (this._wrapped) return this._updateWrapped();
    const area = hass.areas?.[cfg.area];
    const ids = this._ids();
    const sig =
      signature(hass, ids) +
      (area ? area.name + area.icon + area.picture + area.temperature_entity_id + area.humidity_entity_id : "") +
      (hass.themes?.darkMode ? "d" : "l");
    if (sig === this._sig) return;
    this._sig = sig;

    if (!area) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:16px">Area <b>${esc(cfg.area)}</b> not found</div></ha-card>`;
      return;
    }

    const sum = summarize(hass, ids, cfg);
    this._summary = sum;
    const temp = cfg.show_temperature !== false ? avgSensor(hass, ids, "temperature", cfg.temperature_entity || area.temperature_entity_id, cfg.sources_excluded?.temperature) : null;
    const hum = cfg.show_humidity !== false ? avgSensor(hass, ids, "humidity", cfg.humidity_entity || area.humidity_entity_id, cfg.sources_excluded?.humidity) : null;
    const chips = buildChips(hass, sum, { ...cfg, _areaName: area.name });
    this._chips = chips;

    const lit = sum.lights.on.length > 0;
    const occupied = sum.presence.occupied;
    const picture = cfg.show_picture && area.picture;
    const climate = sum.climate[0] ? hass.states[sum.climate[0]].attributes : null;
    const current = temp?.value ?? climate?.current_temperature ?? null;
    const tempUnit = temp?.unit || hass.config?.unit_system?.temperature || "°";

    if (cfg.hide_header) {
      // "Strip" mode: just the chips, used at the top of area pages.
      this.shadowRoot.innerHTML = `
        <style>${VARS_CSS}${CHIP_CSS}</style>
        <div class="chips">${chipsHtml(chips)}</div>`;
      return;
    }

    const meta = [];
    if (current !== null) meta.push(`<span><ha-icon icon="mdi:thermometer"></ha-icon>${fmtNum(current)}${esc(tempUnit)}</span>`);
    if (hum) meta.push(`<span><ha-icon icon="mdi:water-percent"></ha-icon>${fmtNum(hum.value, 0)}%</span>`);

    this.shadowRoot.innerHTML = `
      <style>
        ${VARS_CSS}
        ${CHIP_CSS}
        ha-card {
          position: relative; overflow: hidden; height: 100%; box-sizing: border-box;
          padding: 12px; display: flex; flex-direction: column; gap: 10px;
          cursor: ${cfg.navigation_path ? "pointer" : "default"};
          transition: box-shadow 0.3s, border-color 0.3s;
        }
        ha-card.lit { border-color: var(--ea-light-color); }
        .bg {
          position: absolute; inset: 0; background-size: cover; background-position: center;
          opacity: 0.22; pointer-events: none;
        }
        .top { position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; }
        .icon {
          position: relative; flex: none; width: 36px; height: 36px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          --tile-color: var(--ea-neutral-color);
          color: var(--tile-color);
          background: color-mix(in srgb, var(--tile-color) 20%, transparent);
        }
        .lit .icon { --tile-color: var(--ea-light-color); }
        .icon ha-icon { --mdc-icon-size: 24px; }
        .dot {
          position: absolute; right: -2px; top: -2px; width: 10px; height: 10px; border-radius: 50%;
          background: var(--ea-presence-color);
          border: 2px solid var(--ha-card-background, var(--card-background-color, #fff));
        }
        .name { flex: 1; min-width: 0; }
        .title { font-size: var(--ha-font-size-m, 14px); font-weight: var(--ha-font-weight-medium, 500); letter-spacing: 0.1px; line-height: 20px; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta { display: flex; gap: 8px; font-size: var(--ha-font-size-s, 12px); line-height: 16px; letter-spacing: 0.4px; color: var(--primary-text-color); }
        .meta span { display: inline-flex; align-items: center; gap: 2px; }
        .meta ha-icon { --mdc-icon-size: 14px; color: var(--secondary-text-color); }
        /* Chips inside the card: smaller, tinted, borderless (like tile card features). */
        ha-card .chip { height: 28px; border-radius: 14px; padding: 0 10px 0 6px; border: none; box-shadow: none;
          background: color-mix(in srgb, var(--chip-color) 12%, transparent); }
        ha-card .chip ha-icon { --mdc-icon-size: 16px; }
        .arrow { color: var(--secondary-text-color); --mdc-icon-size: 20px; opacity: 0.6; }
        .chips { position: relative; }
        .chips:empty { display: none; }
      </style>
      <ha-card class="${lit ? "lit" : ""} ${occupied ? "occupied" : ""}">
        ${picture ? `<div class="bg" style="background-image:url('${esc(area.picture)}')"></div>` : ""}
        <div class="top">
          <div class="icon">
            <ha-icon icon="${esc(area.icon || cfg.icon || "mdi:texture-box")}"></ha-icon>
            ${occupied ? `<div class="dot" title="Occupied"></div>` : ""}
          </div>
          <div class="name">
            <div class="title">${esc(cfg.name || area.name)}</div>
            ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
          </div>
          ${cfg.navigation_path ? `<ha-icon class="arrow" icon="mdi:chevron-right"></ha-icon>` : ""}
        </div>
        <div class="chips">${chipsHtml(chips)}</div>
      </ha-card>
    `;
  }
}

/* ------------------------------------------------------------------------ */
/* Home summary card                                                         */
/* ------------------------------------------------------------------------ */

class EnhancedHomeSummaryCard extends EABaseCard {
  static getStubConfig() {
    return {};
  }
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._sig = null;
    this._update();
  }
  getCardSize() {
    return 1;
  }
  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }
  _lightsOn() {
    /* never turn on every light in the house from a single tap */
  }
  _update() {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !cfg) return;
    const exclude = cfg.exclude_entities || [];
    const ids = Object.keys(hass.states).filter((id) => isVisibleEntity(hass, id, exclude));
    const hiddenAreas = new Set(cfg.hide_areas || []);
    const index = areaIndex(hass);
    const sig = signature(hass, ids);
    if (sig === this._sig) return;
    this._sig = sig;

    const sum = summarize(hass, ids, cfg);
    this._summary = sum;
    // Occupied rooms
    let occupiedRooms = [];
    for (const area of Object.values(hass.areas || {})) {
      if (hiddenAreas.has(area.area_id)) continue;
      const aIds = (index.get(area.area_id) || []).filter((id) => {
        const s = hass.states[id];
        return s && domainOf(id) === "binary_sensor" && PRESENCE_CLASSES.includes(s.attributes.device_class) && s.state === "on";
      });
      if (aIds.length) occupiedRooms.push(area.name);
    }
    const chips = buildChips(hass, sum, { show_climate: false, show_battery: false, ...cfg }, { home: true });
    // Home-only: total power uses a dedicated meter if supplied (avoids double counting).
    if (cfg.power_entity && hass.states[cfg.power_entity]) {
      const s = hass.states[cfg.power_entity];
      const f = POWER_FACTORS[s.attributes.unit_of_measurement] ?? 1;
      const i = chips.findIndex((c) => c.kind === "power");
      const chip = { kind: "power", icon: "mdi:home-lightning-bolt", text: fmtPower((num(s.state) ?? 0) * f), action: { type: "more-info", entity: cfg.power_entity }, title: friendly(hass, cfg.power_entity) };
      if (i >= 0) chips[i] = chip;
      else chips.splice(1, 0, chip);
    }
    if (cfg.show_presence !== false && occupiedRooms.length) {
      chips.splice(1, 0, {
        kind: "presence",
        state: "on",
        icon: "mdi:home-account",
        text: occupiedRooms.length === 1 ? occupiedRooms[0] : `${occupiedRooms.length} rooms`,
        action: {},
        title: "Occupied: " + occupiedRooms.join(", "),
      });
    }
    this._chips = chips;

    this.shadowRoot.innerHTML = `
      <style>
        ${VARS_CSS}
        ${CHIP_CSS}
        .wrap { display: flex; align-items: center; min-height: 40px; }
        .empty { color: var(--secondary-text-color); font-size: 14px; }
      </style>
      <div class="wrap">
        ${chips.length ? `<div class="chips">${chipsHtml(chips)}</div>` : `<div class="empty">All quiet</div>`}
      </div>
    `;
  }
}

/* ------------------------------------------------------------------------ */
/* Dashboard strategy                                                        */
/* ------------------------------------------------------------------------ */

function tile(entity, extra = {}) {
  return { type: "tile", entity, ...extra };
}

function cardsForGroup(hass, group, ids) {
  const cards = [];
  for (const id of ids) {
    const d = domainOf(id);
    if (d === "camera") {
      cards.push({ type: "picture-entity", entity: id, show_state: false, grid_options: { columns: 12 } });
    } else if (d === "media_player") {
      cards.push({ type: "media-control", entity: id, grid_options: { columns: 12 } });
    } else if (d === "climate") {
      cards.push({ type: "thermostat", entity: id, grid_options: { columns: 12 } });
    } else if (d === "light") {
      cards.push(tile(id, { features: [{ type: "light-brightness" }], features_position: "inline" }));
    } else if (d === "cover") {
      cards.push(tile(id, { features: [{ type: "cover-open-close" }], features_position: "inline" }));
    } else {
      cards.push(tile(id));
    }
  }
  return cards;
}

function groupEntities(hass, ids) {
  const groups = GROUPS.map((g) => ({ ...g, ids: [] }));
  const other = { key: "other", title: "Other", icon: "mdi:dots-horizontal", ids: [] };
  for (const id of ids) {
    const d = domainOf(id);
    const g = groups.find((x) => x.domains.includes(d));
    (g || other).ids.push(id);
  }
  for (const g of groups.concat(other)) g.ids.sort((a, b) => friendly(hass, a).localeCompare(friendly(hass, b)));
  return groups.concat(other).filter((g) => g.ids.length);
}

function areaSections(hass, ids, config) {
  return groupEntities(hass, ids).map((g) => {
    const heading = { type: "heading", heading: g.title, icon: g.icon };
    // Lights group gets an "all off/on" toggle in the heading.
    if (g.key === "lights" && g.ids.length > 1) {
      heading.badges = [];
      heading.tap_action = { action: "none" };
    }
    return { type: "grid", cards: [heading, ...cardsForGroup(hass, g, g.ids)] };
  });
}

function areaPath(areaId) {
  return `area-${areaId.replace(/[^a-z0-9_-]/gi, "-")}`;
}

class EnhancedAreasStrategy extends HTMLElement {
  /**
   * config: {
   *   title, hide_areas[], area_order[], exclude_entities[], power_exclude[],
   *   home_power_entity, show_unassigned (default true), show_summary (default true),
   *   show_weather (default true), floor_column_span (default 2), card: {...area card options}
   * }
   */
  static async generate(config, hass) {
    const cfg = config || {};
    const hide = new Set(cfg.hide_areas || []);
    const exclude = cfg.exclude_entities || [];
    const cardOpts = { ...(cfg.card || {}), power_exclude: cfg.power_exclude || [], exclude_entities: exclude };
    const areas = sortedAreas(hass, cfg.area_order).filter((a) => !hide.has(a.area_id));
    const floors = sortedFloors(hass);
    const span = cfg.floor_column_span ?? cfg.max_columns ?? 3;

    const areaCard = (a) => ({
      type: "custom:enhanced-area-card",
      area: a.area_id,
      navigation_path: areaPath(a.area_id),
      ...cardOpts,
      grid_options: { columns: cfg.area_card_columns ?? 12, rows: "auto" },
    });

    /* ---- Overview ---- */
    const sections = [];
    const persons = Object.keys(hass.states).filter((id) => domainOf(id) === "person").sort();
    const weather = Object.keys(hass.states).filter((id) => domainOf(id) === "weather").sort();

    const topCards = [];
    if (cfg.show_summary !== false) {
      topCards.push({
        type: "custom:enhanced-home-summary-card",
        power_entity: cfg.home_power_entity,
        power_exclude: cfg.power_exclude || [],
        exclude_entities: exclude,
        hide_areas: cfg.hide_areas || [],
        grid_options: { columns: "full" },
      });
    }
    if (cfg.show_weather !== false && weather.length) {
      topCards.push({ type: "weather-forecast", entity: weather[0], forecast_type: "daily", show_forecast: true, grid_options: { columns: "full" } });
    }
    if (topCards.length) sections.push({ type: "grid", column_span: span, cards: topCards });

    const floorIds = new Set(floors.map((f) => f.floor_id));
    const byFloor = (fid) => areas.filter((a) => (fid === null ? !a.floor_id || !floorIds.has(a.floor_id) : a.floor_id === fid));

    const pushFloorSection = (title, icon, list) => {
      if (!list.length) return;
      const cards = [];
      if (title) cards.push({ type: "heading", heading: title, icon, heading_style: "title" });
      for (const a of list) cards.push(areaCard(a));
      sections.push({ type: "grid", column_span: span, cards });
    };
    for (const f of floors) pushFloorSection(f.name, f.icon || "mdi:home-floor-" + (f.level ?? 0), byFloor(f.floor_id));
    pushFloorSection(floors.length ? "Other areas" : "Areas", "mdi:texture-box", byFloor(null));

    if (!areas.length) {
      sections.push({
        type: "grid",
        cards: [{ type: "markdown", content: "No areas found. Create areas under **Settings → Areas, labels & zones** and assign devices to them." }],
      });
    }

    const overview = {
      title: cfg.overview_title || "Overview",
      path: "home",
      icon: "mdi:home",
      type: "sections",
      max_columns: cfg.max_columns ?? 3,
      badges: persons.map((id) => ({ type: "entity", entity: id, show_name: false, show_state: true, show_icon: true })),
      sections,
    };

    /* ---- Area subviews ---- */
    const areaViews = areas.map((a) => {
      const ids = entitiesForArea(hass, a.area_id, exclude);
      const s = areaSections(hass, ids, cfg);
      return {
        title: a.name,
        path: areaPath(a.area_id),
        icon: a.icon || "mdi:texture-box",
        subview: true,
        back_path: "home",
        type: "sections",
        max_columns: cfg.max_columns ?? 3,
        header: { card: { type: "custom:enhanced-area-card", area: a.area_id, ...cardOpts, show_picture: true } },
        sections: s.length ? s : [{ type: "grid", cards: [{ type: "markdown", content: "No entities in this area yet." }] }],
      };
    });

    const views = [overview, ...areaViews];

    /* ---- Unassigned ---- */
    if (cfg.show_unassigned !== false) {
      const unassigned = (areaIndex(hass).get(null) || [])
        .filter((id) => isVisibleEntity(hass, id, exclude))
        .filter((id) => !["person", "weather"].includes(domainOf(id)) && hass.states[id]);
      // Entities in hidden areas are hidden on purpose; don't resurface them.
      if (unassigned.length) {
        views.push({
          title: "Other",
          path: "other",
          icon: "mdi:devices",
          type: "sections",
          max_columns: cfg.max_columns ?? 3,
          sections: areaSections(hass, unassigned, cfg),
        });
      }
    }

    // Allow users to append their own hand-written views.
    if (Array.isArray(cfg.extra_views)) views.push(...cfg.extra_views);

    return { title: cfg.title, views };
  }
}

/* ------------------------------------------------------------------------ */
/* Upstream injection: wrap Home Assistant's own "home" (Overview) strategies */
/* ------------------------------------------------------------------------ */
/*
 * Home Assistant's default Overview (2026.2+) is the built-in `home` dashboard strategy, which
 * emits views driven by the built-in view strategies `home-overview`, `home-area`, ... .
 * Rather than re-implementing them, we let HA generate them exactly as upstream does, then
 * post-process the output: built-in area cards are swapped for `enhanced-area-card` wrappers
 * (which render the very same native card plus extras), and area pages get a status strip.
 * Whenever HA updates its Overview, this dashboard picks the changes up automatically.
 */

const MARKER = "enhanced_areas";

/** Global opt-in, used to enhance HA's real Overview panel too (see README). */
function globalOptions() {
  if (window.enhancedAreas) return window.enhancedAreas === true ? {} : window.enhancedAreas;
  try {
    // e.g. /local/enhanced-areas.js?enhance_overview=1&power_exclude=sensor.a,sensor.b&badges=lights,media&max_badges=2
    const q = new URL(import.meta.url).searchParams;
    if (q.has("enhance_overview") && q.get("enhance_overview") !== "0") {
      const list = (k) => (q.get(k) ? q.get(k).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
      const bool = (k) => (q.has(k) ? !["0", "false", "no"].includes(q.get(k)) : undefined);
      const card = {};
      if (list("badges")) card.badges = list("badges");
      if (q.has("max_badges")) card.max_badges = Number(q.get("max_badges"));
      for (const k of ["show_glow", "show_power", "show_presence", "native_power"]) if (bool(k) !== undefined) card[k] = bool(k);
      return {
        card,
        power_exclude: list("power_exclude") || [],
        exclude_entities: list("exclude_entities") || [],
        area_strip: bool("area_strip"),
      };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mapCardTree(card, fn) {
  if (!card || typeof card !== "object") return card;
  let c = fn(card);
  if (Array.isArray(c.cards)) c = { ...c, cards: c.cards.map((x) => mapCardTree(x, fn)) };
  if (c.card && typeof c.card === "object") c = { ...c, card: mapCardTree(c.card, fn) };
  return c;
}

function mapViewCards(view, fn) {
  const v = { ...view };
  if (Array.isArray(v.sections)) v.sections = v.sections.map((sec) => mapCardTree(sec, fn));
  if (Array.isArray(v.cards)) v.cards = v.cards.map((c) => mapCardTree(c, fn));
  return v;
}

function cardOptions(opts, areaId) {
  const out = { ...(opts.card || {}), power_exclude: opts.power_exclude, exclude_entities: opts.exclude_entities };
  const ex = opts.sources?.[areaId];
  if (ex) out.sources_excluded = ex;
  return out;
}

/** Per-room source choices made in the integration's Configure dialog (if installed). */
async function fetchSources(hass) {
  try {
    const r = await hass.callWS({ type: "overview_extras/sources" });
    return r?.excluded || {};
  } catch (e) {
    return {}; // integration not installed (plain resource) or older version
  }
}

/** Swap every built-in area card for the enhanced wrapper (keeps its config verbatim). */
function enhanceAreaCards(view, opts) {
  return mapViewCards(view, (c) => {
    if (c.type !== "area" || !c.area) return c;
    const { grid_options, visibility, ...base } = c;
    const out = { type: "custom:enhanced-area-card", ...cardOptions(opts, c.area), area: c.area, base: { ...base, grid_options } };
    if (grid_options) out.grid_options = grid_options;
    if (visibility) out.visibility = visibility;
    return out;
  });
}

const VIEW_TRANSFORMS = {
  // The overview page: floors of area cards, favourites, summaries...
  "home-overview-view-strategy": (view, config, hass, opts) => enhanceAreaCards(view, opts),
  // An area page: add a status strip at the top, and enhance any area cards it may contain.
  "home-area-view-strategy": (view, config, hass, opts) => {
    let v = enhanceAreaCards(view, opts);
    if (opts.area_strip !== false && config?.area && Array.isArray(v.sections)) {
      v.sections = [
        {
          type: "grid",
          column_span: v.max_columns || 3,
          cards: [{ type: "custom:enhanced-area-card", ...cardOptions(opts, config.area), area: config.area, hide_header: true, grid_options: { columns: "full" } }],
        },
        ...v.sections,
      ];
    }
    return v;
  },
};

function patchStrategyClass(name, cls) {
  if (!cls || cls.__enhancedAreasPatched || typeof cls.generate !== "function") return;
  const orig = cls.generate;
  cls.generate = async function (config, hass) {
    const view = await orig.call(this, config, hass);
    const opts = config?.[MARKER] ?? globalOptions();
    if (!opts || !view) return view;
    try {
      const o = { ...(opts === true ? {} : opts) };
      o.sources ??= await fetchSources(hass);
      return VIEW_TRANSFORMS[name](view, config, hass, o);
    } catch (e) {
      console.warn("[enhanced-areas] could not enhance", name, e);
      return view; // never break the upstream dashboard
    }
  };
  cls.__enhancedAreasPatched = true;
}

/* ------------------------------------------------------------------------ */
/* Room sources inside HA's own room (area) settings dialog                  */
/* ------------------------------------------------------------------------ */
/*
 * HA's area dialog has a "related entities" panel with the room's temperature and humidity
 * sensor pickers. We add Overview Extras' source lists right below them, and save them when
 * the dialog's own Save button succeeds. Needs the integration (its websocket commands);
 * without it, or if HA changes the dialog, nothing is added and the dialog works as normal.
 */

const SOURCE_LABELS = {
  temperature: ["Temperature sources", "Averaged for the room's average temperature."],
  humidity: ["Humidity sources", "Averaged for the room's average humidity."],
  power: ["Power sources", "Totalled for the room's power."],
  presence: ["Presence sources", "The room is occupied if any of these is on."],
  lights: ["Lights", "Counted for the room's lights on."],
};

class OverviewExtrasAreaSources extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.selected = null; // {cat: [ids]} once the user changes something
  }
  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll("ha-selector").forEach((el) => (el.hass = hass));
  }
  async load(hass, areaId) {
    this._hass = hass;
    this.areaId = areaId;
    let data;
    try {
      data = await hass.callWS({ type: "overview_extras/area_sources", area_id: areaId });
    } catch (e) {
      this.remove(); // integration not set up, or not an admin
      return;
    }
    this._values = {};
    const cats = Object.keys(SOURCE_LABELS).filter((c) => data.candidates?.[c]?.length);
    if (!cats.length) {
      this.remove();
      return;
    }
    if (!customElements.get("ha-selector")) {
      await Promise.race([customElements.whenDefined("ha-selector"), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .title { font-weight: var(--ha-font-weight-medium, 500); margin: var(--ha-space-2, 8px) 0 var(--ha-space-1, 4px); color: var(--primary-text-color); }
        .description { margin: 0 0 var(--ha-space-4, 16px); color: var(--secondary-text-color); font-size: var(--ha-font-size-s, 12px); }
        ha-selector { display: block; margin-bottom: var(--ha-space-4, 16px); }
      </style>
      <div class="title">Overview Extras sources</div>
      <p class="description">Everything in the room is included, and new entities join automatically. Remove any you don't want.</p>`;
    for (const cat of cats) {
      const excluded = data.excluded?.[cat] || [];
      this._values[cat] = data.candidates[cat].filter((e) => !excluded.includes(e));
      const el = document.createElement("ha-selector");
      el.hass = hass;
      el.selector = { entity: { multiple: true, include_entities: data.candidates[cat] } };
      el.value = this._values[cat];
      el.label = SOURCE_LABELS[cat][0];
      el.helper = SOURCE_LABELS[cat][1];
      el.addEventListener("value-changed", (ev) => {
        ev.stopPropagation(); // keep it away from the dialog's own handlers
        this._values[cat] = ev.detail.value || [];
        el.value = this._values[cat];
        this.selected = { ...this._values };
      });
      this.shadowRoot.appendChild(el);
    }
  }
  async save() {
    if (!this.selected) return;
    await this._hass.callWS({ type: "overview_extras/set_area_sources", area_id: this.areaId, selected: this.selected });
  }
}
customElements.get("overview-extras-area-sources") ||
  customElements.define("overview-extras-area-sources", OverviewExtrasAreaSources);

function patchAreaDialog(cls) {
  if (!cls || cls.__enhancedAreasPatched) return;
  const proto = cls.prototype;
  const origUpdated = proto.updated;
  const origUpdate = proto._updateEntry;
  if (typeof origUpdate !== "function") return; // HA changed the dialog: leave it alone
  proto.updated = function (changed) {
    origUpdated?.call(this, changed);
    try {
      const areaId = this._params?.entry?.area_id;
      const root = this.renderRoot || this.shadowRoot;
      if (!areaId || !root) return;
      // The related-entities panel holds the temperature/humidity pickers.
      const pickers = root.querySelectorAll("ha-entity-picker");
      const anchor = pickers[pickers.length - 1];
      if (!anchor?.parentElement) return;
      let el = anchor.parentElement.querySelector("overview-extras-area-sources");
      if (el && el.areaId === areaId) {
        el.hass = this.hass;
        return;
      }
      el?.remove();
      el = document.createElement("overview-extras-area-sources");
      anchor.parentElement.appendChild(el);
      el.load(this.hass, areaId);
    } catch (e) {
      console.warn("[overview-extras] room dialog", e);
    }
  };
  proto._updateEntry = async function (...args) {
    const root = this.renderRoot || this.shadowRoot;
    const el = root?.querySelector("overview-extras-area-sources");
    const result = await origUpdate.apply(this, args);
    if (el?.selected && !this._error) {
      try {
        await el.save();
      } catch (e) {
        console.warn("[overview-extras] saving room sources failed", e);
      }
    }
    return result;
  };
  cls.__enhancedAreasPatched = true;
}

(function installHooks() {
  if (window.__enhancedAreasHooked) return;
  window.__enhancedAreasHooked = true;
  const AREA_DIALOG = "dialog-area-registry-detail";
  const registry = window.customElements;
  const origDefine = registry.define;
  registry.define = function (name, cls, options) {
    if (VIEW_TRANSFORMS[name]) patchStrategyClass(name, cls);
    if (name === AREA_DIALOG) patchAreaDialog(cls);
    return origDefine.call(this, name, cls, options);
  };
  // In case HA loaded them before us.
  for (const name of Object.keys(VIEW_TRANSFORMS)) patchStrategyClass(name, registry.get(name));
  patchAreaDialog(registry.get(AREA_DIALOG));
})();

/** What HA's built-in `home` dashboard strategy produces; only used if it isn't loaded yet. */
function fallbackHomeDashboard(hass, favorite_entities) {
  const areas = Object.values(hass.areas || {}).map((a) => ({
    title: a.name,
    path: `areas-${a.area_id}`,
    subview: true,
    strategy: { type: "home-area", area: a.area_id },
  }));
  return {
    views: [
      { icon: "mdi:home", path: "overview", strategy: { type: "home-overview", favorite_entities } },
      ...areas,
      { title: hass.localize?.("ui.panel.lovelace.strategy.home.media_players") || "Media players", path: "media-players", subview: true, strategy: { type: "home-media-players" }, icon: "mdi:play-box-multiple" },
      { title: hass.localize?.("ui.panel.lovelace.strategy.home.devices") || "Devices", path: "other-devices", subview: true, strategy: { type: "home-other-devices" }, icon: "mdi:devices" },
    ],
  };
}

class EnhancedHomeStrategy extends HTMLElement {
  /**
   * The built-in Overview, with extras. config: {
   *   favorite_entities?, power_exclude[], exclude_entities[], area_strip (default true),
   *   card: { show_lights, show_openings, show_media, show_climate, show_locks, show_glow, badges[], max_badges, ... }
   * }
   */
  static async generate(config, hass) {
    const cfg = config || {};
    const opts = {
      card: cfg.card || {},
      power_exclude: cfg.power_exclude || [],
      exclude_entities: cfg.exclude_entities || [],
      area_strip: cfg.area_strip,
    };

    // Same favourites as the real Overview ("Edit Overview page" dialog stores them here).
    let favorite_entities = cfg.favorite_entities;
    if (favorite_entities === undefined) {
      try {
        const r = await hass.callWS({ type: "frontend/get_system_data", key: "home" });
        favorite_entities = (r && "value" in r ? r.value : r)?.favorite_entities;
      } catch (e) {
        /* older HA or no data */
      }
    }

    const Builtin = customElements.get("home-dashboard-strategy");
    let dash;
    try {
      dash = Builtin?.generate ? await Builtin.generate({ type: "home", favorite_entities }, hass) : null;
    } catch (e) {
      dash = null;
    }
    if (!dash?.views) dash = fallbackHomeDashboard(hass, favorite_entities);

    const views = dash.views.map((v) =>
      v.strategy && typeof v.strategy.type === "string" && v.strategy.type.startsWith("home-")
        ? { ...v, strategy: { ...v.strategy, [MARKER]: opts } }
        : v
    );
    if (Array.isArray(cfg.extra_views)) views.push(...cfg.extra_views);
    return { ...dash, title: cfg.title ?? dash.title, views };
  }

  static getCreateSuggestions() {
    return { title: "Overview Extras", icon: "mdi:home-plus" };
  }
}

/* ------------------------------------------------------------------------ */
/* Registration                                                              */
/* ------------------------------------------------------------------------ */

const define = (name, cls) => {
  if (!customElements.get(name)) customElements.define(name, cls);
};
define("enhanced-area-card", EnhancedAreaCard);
define("enhanced-compact-area", EnhancedCompactArea);
define("enhanced-home-summary-card", EnhancedHomeSummaryCard);
define("ll-strategy-dashboard-enhanced-areas", EnhancedAreasStrategy);
define("ll-strategy-dashboard-overview-extras", EnhancedHomeStrategy);

// Shows both in "Add dashboard → Community dashboards" (HA 2026.5+).
window.customStrategies = window.customStrategies || [];
for (const s of [
  { type: "overview-extras", strategyType: "dashboard", name: "Overview Extras (built-in Overview + extras)", description: "The built-in Overview, kept in sync with Home Assistant, with richer room cards." },
  { type: "enhanced-areas", strategyType: "dashboard", name: "Enhanced Areas (standalone)", description: "Self-contained area dashboard with rich room cards." },
]) {
  if (!window.customStrategies.some((x) => x.type === s.type)) window.customStrategies.push({ documentationURL: undefined, ...s });
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "enhanced-area-card")) {
  window.customCards.push(
    {
      type: "enhanced-area-card",
      name: "Enhanced Area Card",
      description: "Room card showing lights on, presence, total power, climate, open doors/windows and media.",
      preview: true,
    },
    {
      type: "enhanced-home-summary-card",
      name: "Enhanced Home Summary",
      description: "Whole-home strip: lights on, occupied rooms, total power, open doors/windows.",
    }
  );
}

console.info(`%c OVERVIEW-EXTRAS %c v${VERSION} `, "background:#f2a20c;color:#000;font-weight:700", "background:#333;color:#fff");

// Exposed for tests.
export { summarize, entitiesForArea, areaIndex, EnhancedAreasStrategy, EnhancedHomeStrategy, fmtPower, VERSION };
