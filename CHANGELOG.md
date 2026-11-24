# Changelog

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
