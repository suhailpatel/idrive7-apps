# iXDrive

A separate battery-electric fork of eDrive for **BMW iDrive 7**, focused on the
**G08 iX3**. App ID `ixdrive`, title **iXDrive**, version **0.1.0**. eDrive is
unchanged. This is an initial implementation with synthetic tests, not yet
vehicle-validated on a G08. Newer iDrive platforms are outside this release's scope.

## Features

- Range, Energy, Battery, Charging and Charge log pages, plus optional diagnostics.
- Dashboard cards for range to reserve, charge, pack temperature/voltage, recent
  and trip efficiency, recorded distance/time, net energy, regeneration and peak
  draw. Trip efficiency uses matched power and speed samples; gaps and charging
  are excluded. Distance and time represent recorded telemetry, not an odometer.
- Electric range learning from fresh speed and SOC, without engine RPM or a
  hybrid reserve. An optional arrival reserve is independent of the BMS buffer.
- Live battery power, regeneration, cell voltages/temperatures, drive energy totals
  and a home-screen widget. Unsupported readings remain unavailable.
- Read-only charging estimates: battery-side power, energy to a chosen target and
  time at current power. The target does **not** change the car's charge limit.
- Charge sessions inferred from stationary SOC increases or increases across
  sleep/restart. Energy and cost are estimates, not charger meter readings.
- Separate settings, history and learning in the app's own data directory.
  Telemetry is published to `/tmp/mgu-ixdrive.json`, separate from eDrive.

## Automatic vehicle values

There are no vehicle-model, battery-capacity, nominal-range or power-scale settings.

**Power:** the gauge adapts to the battery's reported current limits multiplied
by pack voltage. If limits are unavailable or stale, it scales to observed power
and peaks. These are display scales and dynamic battery limits, not motor ratings.

**Capacity:** a verified usable-kWh reading can take priority through
`config.battery.capacity`. That candidate list is currently **empty**: this
repository has no verified G08 decoder for usable battery capacity. The app does
not claim to read factory capacity from the car today.

The fallback estimates current usable capacity from integrated battery power
and displayed SOC loss. It needs two consecutive windows of at least five
percentage points each, agreeing within 15%, and rejects results outside
15–200 kWh. Gaps in power, missing speed, charging and process restarts discard
incomplete windows. Accepted estimates persist for up to 30 days and are labelled
“learned”. They include current battery condition; SOH is not applied a second
time. This estimate is sensitive to SOC rounding, temperature, telemetry quality
and power-decoder accuracy; agreement is a plausibility check, not calibration.

**Range:** can learn directly from charge percentage per kilometre even before
capacity is known. It needs at least 5 km and 2 percentage points of observed use.
Once capacity and sufficient driving data are available, the inherited model
separates typical climate/comfort draw and speed effects. Climate assumptions
remain estimates requiring calibration. Until enough data exists, range and
energy-dependent figures remain blank. Charging power itself can still display.

Unknown energy in past charge sessions stays unknown; totals are marked incomplete.
Changing SOC or power decoding resets learning, retaining completed charge history.

Remaining settings are preferences: arrival reserve (0% initially), calculation
target (80%), electricity price, units and appearance. Demo defaults to off and
must be enabled explicitly. Diagnostic controls are hidden by default.

## Diagnostic validation still needed

`app.json` retains read-only battery/climate candidates inherited from eDrive.
They are **not confirmed iX3 identifiers**. In particular:

- SOC: SME address `0x07`, DID `DDBC`, two bytes at 0.1%.
- Voltage: `DDB4`, `DD68`, `DD66`, `DDEF` candidates; current: signed `DD69`.
- Cell, temperature and current-limit candidates retain their original provenance.
- 12 V voltage tries SME `F442`; no engine or transmission units are queried.
- Capacity and SOH candidates remain empty until their meaning and units are verified.

Compare raw diagnostic replies against known dashboard values at several SOC
levels. Verify pack voltage, current magnitude and sign (draw versus regen/charge),
temperatures, cell layout, limits and capacity/health semantics. A plausible number
alone does not validate a decoder. Automatic estimates depend on correct readings.

`config.battery.socWindow` expects displayed SOC (`empty: 0`, `full: 100`). If a
verified decoder returns physical SOC, configure its verified empty/full limits.
Main, Battery and widget readings share the conversion. Do not subtract a second
hidden buffer from displayed SOC.

Fresh stationary speed and negative battery power are needed to identify active
charging. Time estimates exclude charger losses and taper; the app does not read
plug state, identify AC/DC or control charging. Charging can continue while the
head unit sleeps, so a complete charging curve is not promised. Normal diagnostic
reads pause when both movement has been absent for three minutes and interaction
for ten minutes. Explicit interaction or fresh movement resumes them.

## Development

The repository discovers `apps/*/app.json`; no extra registry entry is needed.
The unique app ID permits installation alongside eDrive.

```sh
node kit/tools/test_ixdrive.js
node kit/tools/test_edrive.js
node kit/tools/test_widget_fixes.js
python3 kit/tools/build.py --preview-only ixdrive
node kit/tools/preview.js dist/ixdrive /tmp/ixdrive-preview BTN_PAGE BTN_PAGE BTN_PAGE
```

The preview tool forces demo data. An offline preview is not an installable
package. With the BMW `oap-sdk` present, `python3 kit/tools/build.py ixdrive`
produces `dist/ixdrive@0.1.0.tgz`. The launcher uses `icon.png`: a white
electric SUV with a cyan lightning bolt, rendered at 140 × 140 pixels.
The artwork was created with built-in image generation; its final prompt is
recorded in `icon-prompt.txt`. The build copies the icon directly.

Synthetic tests cover independent identity, low SOC, arrival reserve, missing
signals, range and capacity learning, power scaling, energy integration, charge
history across sleep, regen, stale readings, parked polling and page rendering.
