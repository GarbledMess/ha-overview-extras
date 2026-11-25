# Changelog

## 0.5.1

- **Far fewer state changes and database writes.** The room average and total-power sensors now update at most every 30 seconds, combining everything in between. A power plug reporting every second used to mean a write every second; now it's at most 2 a minute. Values are rounded (temperature to 0.1, humidity and power to whole numbers), so steady readings don't write at all. Occupancy and lights still update instantly.
- New setting: Configure → General settings → **How often room averages and power totals update** (5–600 s, default 30).

**After updating:** restart Home Assistant.

## 0.5.0

- **Room sources in HA's own room settings.** Open a room → ⋮/pencil → Edit area. Under the temperature and humidity sensor pickers there are now lists for temperature, humidity, power and presence sources, plus lights, and they save with the dialog's Save button. Everything is included by default and new entities join automatically. Configure → Room sources still works too.

**After updating:** restart Home Assistant, then refresh the browser or app.

## 0.4.0

### Per-room sources with averages

- **Configure → Room sources**: pick a room and choose which entities feed its temperature, humidity, power, presence and lights. Everything is ticked by default, and new entities added to the room are included automatically. Untick anything you don't want.
- **New per-room entities**: average temperature, average humidity, total power, lights on, and occupancy. The averages become the room's own temperature and humidity sensors, so HA's room card shows them. Rooms where you already picked a sensor keep your choice.
- Room cards, badges and the room page strip all use the chosen sources.
- The global "power sensors to exclude" setting is replaced by per-room power sources.

**After updating:** restart Home Assistant, then refresh the browser or app.

## 0.3.2

- Fixed room cards overlapping on the built-in Overview (especially on mobile).

## 0.3.1

- Restyled to match Home Assistant: HA badge and tile styles, HA state colours and icons.

## 0.3.0

- First release as a HACS integration that adds extras to the built-in Overview, with settings in the UI.
