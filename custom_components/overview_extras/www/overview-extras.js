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

const VERSION = "0.3.0";

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
  if (e && (e.hidden || e.entity_category)) return false;
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

function avgSensor(hass, ids, deviceClass, preferred) {
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
    if (isUnavail(s) || s.attributes.device_class !== deviceClass) continue;
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
        if (s.state === "unavailable") break;
        out.lights.total++;
        if (s.state === "on") out.lights.on.push(id);
        break;
      case "binary_sensor":
        if (PRESENCE_CLASSES.includes(dc)) {
          out.presence.sensors.push(id);
          if (s.state === "on") out.presence.occupied = true;
          const t = Date.parse(s.last_changed);
          if (s.state !== "unavailable" && (!out.presence.since || t > out.presence.since)) out.presence.since = t;
        } else if (OPENING_CLASSES.includes(dc) && s.state === "on") out.openings.push(id);
        else if (ALERT_CLASSES.includes(dc) && s.state === "on") out.alerts.push(id);
        else if (dc === "battery" && s.state === "on") out.lowBattery.push(id);
        break;
      case "sensor": {
        if (dc === "power" && !powerExclude.has(id) && !isUnavail(s)) {
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

const CHIP_CSS = `
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    height: 28px; padding: 0 10px 0 8px; border-radius: 14px;
    font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap;
    color: var(--primary-text-color);
    background: rgba(var(--rgb-primary-text-color, 33,33,33), 0.06);
    border: none; cursor: pointer; font-family: inherit;
    transition: background 0.2s;
  }
  .chip:hover { background: rgba(var(--rgb-primary-text-color, 33,33,33), 0.12); }
  .chip ha-icon { --mdc-icon-size: 16px; }
  .chip.light { color: var(--ea-light-color); background: rgba(var(--ea-light-rgb), 0.16); }
  .chip.presence { color: var(--ea-presence-color); background: rgba(var(--ea-presence-rgb), 0.16); }
  .chip.power { color: var(--ea-power-color); background: rgba(var(--ea-power-rgb), 0.14); }
  .chip.warn { color: var(--ea-warn-color); background: rgba(var(--ea-warn-rgb), 0.16); }
  .chip.alert { color: #fff; background: var(--error-color, #db4437); }
  .chip.media { color: var(--ea-media-color); background: rgba(var(--ea-media-rgb), 0.14); max-width: 100%; }
  .chip.media span { overflow: hidden; text-overflow: ellipsis; }
  .chip.climate { color: var(--ea-climate-color); background: rgba(var(--ea-climate-rgb), 0.14); }
  .chip.muted { color: var(--secondary-text-color); }
`;

const VARS_CSS = `
  :host {
    --ea-light-color: var(--state-light-on-color, #f2a20c);  --ea-light-rgb: 242,162,12;
    --ea-presence-color: #2e9e5b;                             --ea-presence-rgb: 46,158,91;
    --ea-power-color: var(--energy-grid-consumption-color, #488fc2); --ea-power-rgb: 72,143,194;
    --ea-warn-color: var(--warning-color, #e07b00);           --ea-warn-rgb: 224,123,0;
    --ea-media-color: #8b5cf6;                                --ea-media-rgb: 139,92,246;
    --ea-climate-color: #ef6c3c;                              --ea-climate-rgb: 239,108,60;
    display: block;
  }
`;

/** Build the chip list from a summary. Returns [{cls, icon, text, action, title}] */
function buildChips(hass, sum, cfg, { home = false } = {}) {
  const chips = [];
  const show = (k) => cfg[`show_${k}`] !== false;

  if (show("lights") && sum.lights.total) {
    const on = sum.lights.on.length;
    chips.push({
      cls: on ? "light" : "muted",
      icon: on ? "mdi:lightbulb-on" : "mdi:lightbulb-outline",
      text: on ? (home ? `${on} on` : sum.lights.total > 1 ? `${on}/${sum.lights.total} on` : "On") : "Off",
      action: { type: "lights" },
      title: on ? "Lights on — tap to turn off" : "Lights off — tap to turn on",
    });
  }
  if (show("presence") && sum.presence.sensors.length && !home) {
    chips.push({
      cls: sum.presence.occupied ? "presence" : "muted",
      icon: sum.presence.occupied ? "mdi:account" : "mdi:account-outline",
      text: sum.presence.occupied ? "Occupied" : `Clear${sum.presence.since ? " · " + fmtAgo(sum.presence.since) : ""}`,
      action: { type: "more-info", entity: sum.presence.sensors.length === 1 ? sum.presence.sensors[0] : null },
      title: sum.presence.sensors.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("power") && sum.power.sensors.length) {
    chips.push({
      cls: "power",
      icon: "mdi:flash",
      text: fmtPower(sum.power.value),
      action: { type: "more-info", entity: sum.power.sensors.length === 1 ? sum.power.sensors[0] : null },
      title: `Sum of ${sum.power.sensors.length} power sensor(s)`,
    });
  }
  if (show("climate") && !home) {
    for (const id of sum.climate.slice(0, 1)) {
      const a = hass.states[id].attributes;
      const action = a.hvac_action;
      const icon = action === "heating" ? "mdi:fire" : action === "cooling" ? "mdi:snowflake" : action === "drying" ? "mdi:water-percent" : "mdi:thermostat";
      const target = a.temperature ?? (a.target_temp_low != null ? `${a.target_temp_low}–${a.target_temp_high}` : null);
      chips.push({
        cls: "climate",
        icon,
        text: target != null ? `→ ${target}°` : hass.states[id].state,
        action: { type: "more-info", entity: id },
        title: `${friendly(hass, id)}: ${action || hass.states[id].state}`,
      });
    }
  }
  if (show("openings") && sum.openings.length) {
    chips.push({
      cls: "warn",
      icon: "mdi:door-open",
      text: home ? `${sum.openings.length} open` : sum.openings.length === 1 ? shortName(hass, sum.openings[0], cfg._areaName) : `${sum.openings.length} open`,
      action: { type: "more-info", entity: sum.openings.length === 1 ? sum.openings[0] : null },
      title: sum.openings.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("covers") && sum.covers.length) {
    chips.push({
      cls: "muted",
      icon: "mdi:window-shutter-open",
      text: `${sum.covers.length} open`,
      action: { type: "more-info", entity: sum.covers.length === 1 ? sum.covers[0] : null },
      title: sum.covers.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("locks") && sum.unlocked.length) {
    chips.push({
      cls: "warn",
      icon: "mdi:lock-open-variant",
      text: sum.unlocked.length === 1 ? "Unlocked" : `${sum.unlocked.length} unlocked`,
      action: { type: "more-info", entity: sum.unlocked.length === 1 ? sum.unlocked[0] : null },
      title: sum.unlocked.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("fans") && sum.fans.length) {
    chips.push({
      cls: "climate",
      icon: "mdi:fan",
      text: sum.fans.length === 1 ? "Fan on" : `${sum.fans.length} fans`,
      action: { type: "more-info", entity: sum.fans.length === 1 ? sum.fans[0] : null },
      title: sum.fans.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("media") && sum.media.length) {
    const s = hass.states[sum.media[0]];
    const a = s.attributes;
    const title = home ? `${sum.media.length} playing` : a.media_title ? `${a.media_title}${a.media_artist ? " · " + a.media_artist : ""}` : "Playing";
    chips.push({
      cls: "media",
      icon: "mdi:play-circle",
      text: title,
      action: { type: "more-info", entity: sum.media[0] },
      title: sum.media.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("alerts") && sum.alerts.length) {
    chips.push({
      cls: "alert",
      icon: "mdi:alert",
      text: sum.alerts.length === 1 ? shortName(hass, sum.alerts[0], cfg._areaName) : `${sum.alerts.length} alerts`,
      action: { type: "more-info", entity: sum.alerts.length === 1 ? sum.alerts[0] : null },
      title: sum.alerts.map((id) => friendly(hass, id)).join(", "),
    });
  }
  if (show("battery") && sum.lowBattery.length) {
    chips.push({
      cls: "warn",
      icon: "mdi:battery-alert-variant-outline",
      text: `${sum.lowBattery.length}`,
      action: { type: "more-info", entity: sum.lowBattery.length === 1 ? sum.lowBattery[0] : null },
      title: "Low battery: " + sum.lowBattery.map((id) => friendly(hass, id)).join(", "),
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

function chipsHtml(chips) {
  return chips
    .map(
      (c, i) =>
        `<button class="chip ${c.cls}" data-chip="${i}" title="${esc(c.title)}"><ha-icon icon="${c.icon}"></ha-icon><span>${esc(c.text)}</span></button>`
    )
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
    const exclude = [...new Set([...(base.exclude_entities || []), ...(cfg.exclude_entities || []), ...(cfg.power_exclude || [])])];
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
    let el;
    try {
      const helpers = await window.loadCardHelpers?.();
      el = helpers ? await helpers.createCardElement(nativeCfg) : null;
    } catch (e) {
      el = null;
    }
    if (!el) {
      const Native = customElements.get("hui-area-card");
      if (Native) {
        el = new Native();
        el.setConfig(nativeCfg);
      }
    }
    if (!el) {
      // Built-in area card unavailable (unexpected upstream change): fall back to our own card.
      this._wrapped = false;
      this._sig = null;
      this._update();
      return;
    }
    this._inner = el;
    if (this._hass) el.hass = this._hass;
    this.shadowRoot.innerHTML = `
      <style>
        ${VARS_CSS}
        :host { height: 100%; }
        .wrap { position: relative; height: 100%; }
        .wrap > .inner, .inner > * { height: 100%; display: block; }
        .wrap.lit {
          --ha-card-border-color: rgba(var(--ea-light-rgb), 0.75);
          --ha-card-box-shadow: 0 0 0 1px rgba(var(--ea-light-rgb), 0.55), 0 0 14px rgba(var(--ea-light-rgb), 0.30);
        }
        .badges {
          position: absolute; top: 6px; right: 6px; z-index: 2;
          display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
          pointer-events: none;
        }
        .badge {
          pointer-events: auto; cursor: pointer; border: none; font-family: inherit;
          display: inline-flex; align-items: center; justify-content: center; gap: 2px;
          min-width: 22px; height: 22px; padding: 0 5px; box-sizing: border-box; border-radius: 11px;
          font-size: 11px; font-weight: 600; line-height: 1;
          color: var(--primary-text-color);
          background: var(--ha-card-background, var(--card-background-color, #fff));
          box-shadow: 0 0 0 1px rgba(var(--rgb-primary-text-color, 33,33,33), 0.12);
        }
        .badge ha-icon { --mdc-icon-size: 14px; }
        .badge.light { color: #1a1200; background: var(--ea-light-color); box-shadow: none; }
        .badge.warn { color: #fff; background: var(--ea-warn-color); box-shadow: none; }
        .badge.media { color: #fff; background: var(--ea-media-color); box-shadow: none; }
        .badge.climate { color: #fff; background: var(--ea-climate-color); box-shadow: none; }
        .badge.alert { color: #fff; background: var(--error-color, #db4437); box-shadow: none; }
        .badge.power { color: #fff; background: var(--ea-power-color); box-shadow: none; }
        .badge.presence { color: #fff; background: var(--ea-presence-color); box-shadow: none; }
        .badge.muted { color: var(--secondary-text-color); }
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
    const byKind = {
      lights: all.find((c) => c.action?.type === "lights" && c.cls === "light"),
      alerts: all.find((c) => c.cls === "alert"),
      openings: all.find((c) => c.icon === "mdi:door-open"),
      locks: all.find((c) => c.icon === "mdi:lock-open-variant"),
      media: all.find((c) => c.cls === "media"),
      climate: all.find((c) => c.cls === "climate" && c.icon !== "mdi:fan" && c.icon !== "mdi:thermostat"),
      fans: all.find((c) => c.icon === "mdi:fan"),
      covers: all.find((c) => c.icon === "mdi:window-shutter-open"),
      power: all.find((c) => c.cls === "power"),
      battery: all.find((c) => c.icon === "mdi:battery-alert-variant-outline"),
    };
    const chips = want.map((k) => byKind[k]).filter(Boolean).slice(0, cfg.max_badges ?? 3);
    // Badges are compact: icon + a count where it means something.
    const label = (c) => {
      if (c.action?.type === "lights") return sum.lights.on.length > 1 ? String(sum.lights.on.length) : "";
      if (c.icon === "mdi:door-open") return sum.openings.length > 1 ? String(sum.openings.length) : "";
      if (c.cls === "power") return c.text;
      return "";
    };
    this._chips = chips;
    wrap.classList.toggle("lit", cfg.show_glow !== false && sum.lights.on.length > 0);
    this.shadowRoot.querySelector(".badges").innerHTML = chips
      .map((c, i) => `<button class="badge ${c.cls}" data-chip="${i}" title="${esc(c.title)}"><ha-icon icon="${c.icon}"></ha-icon>${label(c) ? `<span>${esc(label(c))}</span>` : ""}</button>`)
      .join("");
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
    const temp = cfg.show_temperature !== false ? avgSensor(hass, ids, "temperature", cfg.temperature_entity || area.temperature_entity_id) : null;
    const hum = cfg.show_humidity !== false ? avgSensor(hass, ids, "humidity", cfg.humidity_entity || area.humidity_entity_id) : null;
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
        <style>${VARS_CSS}${CHIP_CSS}
          .chip { height: 32px; font-size: 14px; border-radius: 16px; padding: 0 12px 0 9px; }
          .chip ha-icon { --mdc-icon-size: 18px; }
        </style>
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
          padding: 14px; display: flex; flex-direction: column; gap: 12px;
          cursor: ${cfg.navigation_path ? "pointer" : "default"};
          transition: box-shadow 0.3s, border-color 0.3s;
        }
        ha-card.lit { border-color: rgba(var(--ea-light-rgb), 0.55); }
        .bg {
          position: absolute; inset: 0; background-size: cover; background-position: center;
          opacity: 0.22; pointer-events: none;
        }
        .glow {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(120% 90% at 0% 0%, rgba(var(--ea-light-rgb), 0.20), transparent 60%);
        }
        .top { position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; }
        .icon {
          position: relative; flex: none; width: 42px; height: 42px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: rgba(var(--rgb-primary-text-color, 33,33,33), 0.06);
          color: var(--secondary-text-color);
        }
        .lit .icon { background: rgba(var(--ea-light-rgb), 0.2); color: var(--ea-light-color); }
        .dot {
          position: absolute; right: -1px; top: -1px; width: 12px; height: 12px; border-radius: 50%;
          background: var(--ea-presence-color); border: 2px solid var(--ha-card-background, var(--card-background-color, #fff));
          animation: pulse 2.4s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(var(--ea-presence-rgb),0.5); } 50% { box-shadow: 0 0 0 5px rgba(var(--ea-presence-rgb),0); } }
        @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
        .name { flex: 1; min-width: 0; }
        .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta { display: flex; gap: 10px; font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
        .meta span { display: inline-flex; align-items: center; gap: 2px; }
        .meta ha-icon { --mdc-icon-size: 14px; }
        .arrow { color: var(--secondary-text-color); --mdc-icon-size: 20px; opacity: 0.6; }
        .chips { position: relative; }
        .chips:empty { display: none; }
      </style>
      <ha-card class="${lit ? "lit" : ""} ${occupied ? "occupied" : ""}">
        ${picture ? `<div class="bg" style="background-image:url('${esc(area.picture)}')"></div>` : ""}
        ${lit ? `<div class="glow"></div>` : ""}
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
      const i = chips.findIndex((c) => c.cls === "power");
      const chip = { cls: "power", icon: "mdi:home-lightning-bolt", text: fmtPower((num(s.state) ?? 0) * f), action: { type: "more-info", entity: cfg.power_entity }, title: friendly(hass, cfg.power_entity) };
      if (i >= 0) chips[i] = chip;
      else chips.splice(1, 0, chip);
    }
    if (cfg.show_presence !== false && occupiedRooms.length) {
      chips.splice(1, 0, {
        cls: "presence",
        icon: "mdi:account-multiple",
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
        .chip { height: 34px; border-radius: 17px; font-size: 14px; padding: 0 14px 0 10px; }
        .chip ha-icon { --mdc-icon-size: 18px; }
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

function cardOptions(opts) {
  return { ...(opts.card || {}), power_exclude: opts.power_exclude, exclude_entities: opts.exclude_entities };
}

/** Swap every built-in area card for the enhanced wrapper (keeps its config verbatim). */
function enhanceAreaCards(view, opts) {
  const extra = cardOptions(opts);
  return mapViewCards(view, (c) => {
    if (c.type !== "area" || !c.area) return c;
    const { grid_options, visibility, ...base } = c;
    const out = { type: "custom:enhanced-area-card", ...extra, area: c.area, base: { ...base, grid_options } };
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
          cards: [{ type: "custom:enhanced-area-card", ...cardOptions(opts), area: config.area, hide_header: true, grid_options: { columns: "full" } }],
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
      return VIEW_TRANSFORMS[name](view, config, hass, opts === true ? {} : opts);
    } catch (e) {
      console.warn("[enhanced-areas] could not enhance", name, e);
      return view; // never break the upstream dashboard
    }
  };
  cls.__enhancedAreasPatched = true;
}

(function installStrategyHooks() {
  if (window.__enhancedAreasHooked) return;
  window.__enhancedAreasHooked = true;
  const registry = window.customElements;
  const origDefine = registry.define;
  registry.define = function (name, cls, options) {
    if (VIEW_TRANSFORMS[name]) patchStrategyClass(name, cls);
    return origDefine.call(this, name, cls, options);
  };
  // In case HA loaded them before us.
  for (const name of Object.keys(VIEW_TRANSFORMS)) patchStrategyClass(name, registry.get(name));
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
