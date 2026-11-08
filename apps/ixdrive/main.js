'use strict';
/** iXDrive: battery-electric telemetry, range and charging.
 * Forked from eDrive; independent app identity and storage. Diagnostic candidates
 * remain provisional until verified on the target vehicle (see README.md).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { t: translate, plural } = require('./kit/i18n');
const { RangeModel } = require('./range');
const startLive = require('./live');
const { Insights, journeyStats, demoInsights } = require('./insights');
const { createActivity, normalizeSoc, chargeEstimate, CapacityLearner } = require('./ev');

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES = ['main', 'energy', 'battery', 'charging', 'log', 'journeys', 'lab', 'trends', 'diag'];
const DIAG_PARTS = ['diag', 'unit', 'scan', 'signals'];
const DIAG_STEP = 492;           // each part is a full page (panel 44..512) plus a gap
/** Comfort consumers, estimated from their levels (kW): seat heating per level 0..3, steering wheel. */
const SEAT_KW = [0, 0.04, 0.07, 0.1];
const WHEEL_KW = 0.06;
/** Blower (part of the climate draw): about BLOWER_KW[0] + BLOWER_KW[1] x (level / top level)^2. */
const BLOWER_KW = [0.03, 0.32];
const PACE_TAU = 300;            // s: the pace follows the last few minutes of driving
const PACE_KEEP = 15 * 60000;    // ms without moving after which there is no "current pace"
const LOG_MAX = 200;             // charges kept in the log
const LOSS = 1.1;                // grid energy per kWh stored (charger + battery losses, estimate)
const KM_MI = 0.621371;
const VALUES = ['soc', 'capacity', 'soh', 'v12'];
const ASLEEP_MS = 10 * 60000;     // a gap this long between charge readings: the car was off meanwhile

/** Demo: charge drains, outside temperature swings across the cold threshold. */
class Demo {
    constructor() { this.t0 = Date.now(); }
    sample() {
        const s = (Date.now() - this.t0) / 1000;
        return {
            soc: 64 - (s * 0.08) % 50, soh: 91.5, ambient: 6 + 14 * Math.sin(s / 12), v12: 12.45 + 0.05 * Math.sin(s / 5),
            climate: s % 30 < 10 ? 'ac' : s % 30 < 20, ac: s % 30 < 10,
            pace: 55 + 25 * Math.sin(s / 20), seats: { DR: 2, PS: s % 30 < 15 ? 1 : 0 }, wheel: true, blower: 4,
            batt: { avg: 18, min: 17, max: 20 },
            charge: { from: 28, to: 97, toT: this.t0 - 3 * 3600000, kwh: 46.6 },
        };
    }
    log() {
        if (!this._log) {
            // ~3 weeks of plausible charges, newest last
            this._log = [];
            let t = this.t0 - 21 * 86400000;
            for (let i = 0; i < 16; i++) {
                t += (0.8 + ((i * 37) % 10) / 10) * 86400000;
                const from = 12 + (i * 23) % 40, to = Math.min(100, from + 35 + (i * 17) % 50);
                this._log.push({ from, to, fromT: t - 4 * 3600000, toT: t, kwh: (to - from) / 100 * 74 * 0.915 });
            }
        }
        return this._log;
    }
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 7, soc: [], soh: [], v12: [], chargeMinPct: 3 },
            (ctx.spec.config && ctx.spec.config.battery) || {});
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            const v = raw * c.factor + (c.offset || 0);
            return c.max != null && v > c.max ? null : v;
        };

        /* ---------- persisted state: SOH, the last charge reading and the last charge session ---------- */
        const STATE = path.join(ctx.dataDir, 'battery.json');
        let st = {};
        try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { /* first run */ }
        const basis = () => JSON.stringify([cfg.ecu, cfg.soc, cfg.socWindow, cfg.capacity, cfg.soh, cfg.fast, cfg.powerSign]);
        const resetLearning = () => {
            ['learn', 'drive', 'driveOff', 'aux', 'acAux', 'base', 'evSpeed', 'lastSoc', 'lastSocT', 'session', 'soh', 'sohT', 'capacityLearning', 'totalUse']
                .forEach((k) => delete st[k]);
            st.basis = basis();
        };
        // Preserve completed charge history, but never combine different SOC/capacity calibrations.
        if (st.basis !== basis()) resetLearning();
        const insights = new Insights(st.insights || (st.insights = {}), basis());
        const model = new RangeModel(st, () => kwhPerPct());
        const capacityLearner = new CapacityLearner(st.capacityLearning || (st.capacityLearning = {}));
        const activity = createActivity();
        const active = () => activity.active();
        let savedAt = 0, saved = JSON.stringify(st);
        const save = () => {
            savedAt = Date.now(); saved = JSON.stringify(st);
            try { fs.writeFileSync(STATE, saved); } catch (e) { log.warn('save: ' + e); }
        };
        // MainApp's shutdown: what changed since the last save (the last charge reading, learning) goes with it
        process.on('exit', () => { if (JSON.stringify(st) !== saved) save(); });
        const live = { soc: null, socT: 0, soh: G.isNum(st.soh) ? st.soh : null, sohT: st.sohT || 0, v12: null, v12T: 0, capacity: null, capacityT: 0, ambient: null, speed: null, speedT: 0,
            climate: null, ac: null, seats: {}, wheel: null, blower: null, blowerTop: 8, pd: null, batt: null, hvV: null,
            pace: null, lastMove: 0, raw: {}, standSince: 0, acRaw: null, acKw: null, lscV: null, lscVT: 0,
        };

        // Distance is learned only across fresh speed samples; missing signals never mean zero speed.
        const seg = { km: 0, valid: true, climate: null, climateMixed: false, comfort: 0 };
        let lastSpeedT = 0;
        const STOP_MS = 5 * 60000;
        const onSpeed = (kmh) => {
            const now = Date.now();
            activity.observe(kmh);
            if (!G.isNum(kmh)) seg.valid = false;
            if (lastSpeedT && G.isNum(kmh)) {
                const gap = now - lastSpeedT;
                if (gap > 2000) seg.valid = false;
                const dt = G.clamp(gap, 0, 2000);
                seg.km += kmh * dt / 3600000;
                if (kmh > 3) live.lastMove = now;
                if (now - live.lastMove < STOP_MS) {
                    live.pace = live.pace === null ? kmh : live.pace + (kmh - live.pace) * (dt / 1000) / (dt / 1000 + PACE_TAU);
                }
            }
            lastSpeedT = now;
        };
        const paceNow = () => (live.pace !== null && live.lastMove && Date.now() - live.lastMove < PACE_KEEP ? live.pace : null);
        // Arrival reserve is a driver preference, independent of the BMS's hidden buffer.
        const reserve = () => G.clamp(Number(settings.get('reserve')) || 0, 0, 20);
        /* ---------- climate control on / off (per zone: on when any zone is on) ----------
         * Off, only the on-board electrics draw (model.auxRate). A reading stretch during which it was
         * switched on or off teaches nothing ('mixed'), so neither draw learns the other's. */
        const zones = { climate: {}, ac: {} };
        const rawClimate = {};                           // last values as received (Diagnostics page)
        const onZone = (what, on, zone) => {
            if (typeof on !== 'boolean') return;
            const z = zones[what];
            if (zone === 'ALL_ZONES') zone = 0;                          // enums may come as names
            if (!zone) Object.keys(z).forEach((k) => delete z[k]);      // ALL_ZONES (0) sets every zone
            z[zone || 0] = on;
        };
        /** every entry holding `key`, however the list arrives (plain, wrapped in the field's name, single) */
        const entries = (v, key, out) => {
            out = out || [];
            if (v && typeof v === 'object') {
                if (key in v) out.push(v);
                else Object.keys(v).forEach((k) => entries(v[k], key, out));
            }
            return out;
        };
        const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };
        /* Climate: false (off: on-board draw only), true (on: fan, heating), 'ac' (on with the A/C
         * compressor as well) - each costs its own draw. null: not known. */
        const climateNow = () => {
            const sys = Object.keys(zones.climate).length ? Object.keys(zones.climate).some((k) => zones.climate[k]) : null;
            const ac = Object.keys(zones.ac).length ? Object.keys(zones.ac).some((k) => zones.ac[k]) : null;
            live.ac = ac;
            if (ac) return 'ac';
            return sys;
        };
        const seen = (what, v) => {
            const raw = JSON.stringify(v);
            if (raw !== rawClimate[what]) { rawClimate[what] = raw; log.info('climate ' + what + ': ' + raw); }
        };
        const climateChanged = () => {
            const now = climateNow();
            if (now === null) return;
            if (live.climate !== null && now !== live.climate) { seg.climateMixed = true; log.info('climate control ' + (now === 'ac' ? 'on (A/C)' : now ? 'on' : 'off')); }
            live.climate = now;
        };
        // ClimateMaster: lists, one entry per zone (not offered on every car)
        const onClimate = (what, key, v) => {
            seen(what, v);
            entries(v, key).forEach((e) => onZone(what, e[key], e.operationZone));
            climateChanged();
        };
        // Climate2 - from the vehicle gateway, what the HMI itself reads: A/C on / off, blower, compressor
        const ON = { 1: true, KLIMAANLAGE_EIN: true, 0: false, KLIMAANLAGE_AUS: false };
        const onAircon = (v) => {
            seen('A/C', v);
            const on = ON[one(v, 'statusAircon')];
            if (typeof on === 'boolean') { zones.ac = { 0: on }; climateChanged(); }
        };
        const onBlower = (v) => {
            seen('blower', v);
            const b = one(v, 'statusBlowerSettingDR');
            if (typeof b === 'number' && b < 255) {
                live.blower = b; live.blowerTop = Math.max(live.blowerTop, b);
                zones.climate = { 0: b > 0 }; climateChanged();
            }
        };
        const onCompressor = (v) => {
            seen('compressor', v);
            const r = one(v, 'actualValuePowerACCompressor');
            live.acPower = r; live.acRaw = r; live.acKw = typeof r === 'number' ? sc('acPower', r) : null;
        };
        /** Climate during the stretch since the last charge reading: true / false / null / 'mixed'. */
        const stretchClimate = () => (seg.climateMixed ? 'mixed' : seg.climate);

        /* ---------- comfort consumers and the car's own power figures ---------- */
        const rawSeen = (what, v) => { live.raw[what] = JSON.stringify(v); };
        const level = (v) => (typeof v === 'number' && v >= 0 && v < 15 ? Math.min(3, v) : null);
        const onSeat = (pos, key) => (v) => { rawSeen('seat ' + pos, v); live.seats[pos] = level(one(v, key)); };
        /** Seat + steering-wheel heating now (kW, estimated from their levels). */
        const comfortKw = (d) => {
            const x = d || live;
            const seats = Object.keys(x.seats || {}).reduce((a, k) => a + (x.seats[k] ? SEAT_KW[x.seats[k]] : 0), 0);
            return seats + (x.wheel ? WHEEL_KW : 0);
        };
        /** Blower now (kW, estimated; part of the climate draw). */
        const blowerKw = (d) => {
            const x = d || live;
            if (!G.isNum(x.blower) || x.blower <= 0) return 0;
            const f = G.clamp(x.blower / Math.max(8, x.blowerTop || 8), 0, 1);
            return BLOWER_KW[0] + BLOWER_KW[1] * f * f;
        };
        const battTemp = (raw) => {
            const v = sc('batteryTemp', raw);
            return v !== null && v > -30 && v < 70 ? v : null;
        };

        /** kWh in 1 % of charge today (size when new x health). */
        const capacityNow = () => settings.get('demo') === 'on' ? { kwh: 67.71, source: 'demo' }
            : live.capacityT && Date.now() - live.capacityT < 3600000 ? { kwh: live.capacity, source: 'reported' }
                : { kwh: capacityLearner.value(Date.now()), source: 'learned' };
        const kwhPerPct = () => { const c = capacityNow(); return G.isNum(c.kwh) ? c.kwh / 100 : null; };

        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
            ExteriorTemperature: (v) => { const a = sc('ambient', v.temperatureExterior); if (a !== null) live.ambient = a; },
        }, log).then((s) => log.info('ambient ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const k = v.speedVehicleCentreOfGravity;
                live.speed = k === 65535 || k == null ? null : k * 0.015625;
                // standing since (live.js: the measured climate draw)
                if (G.isNum(live.speed) && live.speed > 1) live.standSince = 0;
                else if (G.isNum(live.speed) && !live.standSince) live.standSince = Date.now();
                onSpeed(live.speed);
                live.speedT = Date.now();
            },
            highVoltageStorageInfoToExternal: (v) => rawSeen('HV energy', v),
        }, log).then((s) => log.info('speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.climatemaster.ClimateMaster', '1', {
            // both are lists, one entry per zone
            statusClimateSystemOn: (v) => onClimate('climate', 'airConditioningOn', v),
            statusAirCondAC: (v) => onClimate('ac', 'acButton', v),
        }, log, { pollMs: 10000 }).then((s) => log.info('climate ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.climate.Climate2', '1', {
            statusACFront: onAircon,
            statusAirConditionDRStatus: onBlower,
            statusActualValuePowerACCompressor: onCompressor,
        }, log, { pollMs: 10000 }).then((s) => log.info('climate2 ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        ctx.signals.watch('de.bmw.infotainment.climate.Climate', '1', {
            statusSeatHeatingDR: onSeat('DR', 'statusSeatHeaterDR'),
            statusSeatHeatingPS: onSeat('PS', 'statusSeatHeaterPS'),
            statusSeatHeatingDRR: onSeat('DRR', 'statusSeatHeaterDRR'),
            statusSeatHeatingPSR: onSeat('PSR', 'statusSeatHeaterPSR'),
        }, log, { pollMs: 15000 }).then((s) => log.info('seat heating ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', '1', {
            heatingState: (v) => { rawSeen('wheel', v); const h = one(v, 'heating'); if (typeof h === 'boolean') live.wheel = h; },
        }, log, { pollMs: 15000 }).then((s) => log.info('steering wheel ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            // the car's own "power distribution" display: drive / climate share, seat heating bars, range they cost
            statusDisplayElectricalPowerDistribution: (v) => { rawSeen('distribution', v); live.pd = entries(v, 'displayRepartitionDriveElectricPower')[0] || null; },
        }, log, { pollMs: 15000 }).then((s) => log.info('power distribution ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', '1', {
            statusBatteryTemperature: (v) => {
                rawSeen('battery temp', v);
                const e = entries(v, 'actualValueTemperatureHighVoltageStorage')[0];
                if (e) live.batt = { avg: battTemp(e.actualValueTemperatureHighVoltageStorage), min: battTemp(e.actualValueTemperatureHighVoltageStorageMinimum), max: battTemp(e.actualValueTemperatureHighVoltageStorageMaximum) };
            },
        }, log, { pollMs: 30000 }).then((s) => log.info('battery temperature ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ctx.signals.watch('de.bmw.infotainment.lsc.LSCDataSink', '1', {
            statusHighVoltageStorage: (v) => {
                rawSeen('HV voltage', v);
                const x = one(v, 'actualValueVoltageHighVoltageStorage');
                if (!G.isNum(x)) return;
                live.hvV = x;
                const volts = x > 1500 ? x / 10 : x;            // 0.1 V on the X5 45e
                if (volts > 150 && volts < 500) { live.lscV = volts; live.lscVT = Date.now(); }
            },
        }, log).then((s) => log.info('HV voltage ' + (s.error ? 'error: ' + s.error : 'subscribed')));

        // connect in the background: the screen must not wait for the diagnostic link
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;                     // polled every few seconds: keep the log file small
        diag.init();
        const demo = new Demo();
        const usingDemo = () => settings.get('demo') === 'on';

        /* ---------- UDS reads (candidates per value, see kit/dids.js) ---------- */
        const reader = new DidReader(diag, { ecu: cfg.ecu });
        const raws = reader.raws, pick = reader.pick;      // for the Diagnostics page
        // one request at a time on the diagnostic link: a queue rather than a plain chain, so a live
        // power read (urgent) goes ahead of the reads that wait
        const queue = [];
        let pumping = false;
        async function pump() {
            if (pumping) return;
            pumping = true;
            while (queue.length) {
                const j = queue.shift(), t0 = Date.now();
                try { j.res(await j.fn()); } catch (e) { j.rej(e); }
                // one turn that holds the link this long delays every read behind it (the live power too): say which
                const ms = Date.now() - t0;
                if (ms > 1500) { exclusive.stalls = (exclusive.stalls || 0) + 1; log.warn('link held ' + ms + ' ms by ' + j.label + (queue.length ? ' (' + queue.length + ' waiting)' : '')); }
            }
            pumping = false;
        }
        const exclusive = (fn, urgent, label) => new Promise((res, rej) => {
            const j = { fn, res, rej, label: label || (urgent ? 'urgent' : 'read') };
            if (urgent) queue.unshift(j); else queue.push(j);
            pump();
        });
        const readValue = (key) => exclusive(() => reader.value(key, cfg[key]));
        /* ---------- last charge ----------
         * A charge is inferred from the charge level rising by >= chargeMinPct while the car stands still
         * (regen while driving doesn't count), from the level before it to the last level read before the
         * car drives off or the level really drops. The last reading is saved, so a charge done
         * while the head unit slept shows up as a jump at the next start: that jump counts even when
         * the car is already moving by the first reading (the diagnostic link takes a while to come up),
         * as readings come every few seconds while the car is on and regen never adds that much between them. */
        const chargeKwh = (from, to) => { const k = kwhPerPct(); return k === null ? null : (to - from) * k; };
        function closeSession() {
            const s = st.session;
            st.session = null;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                st.lastCharge = { from: s.from, to: s.to, fromT: s.fromT, toT: s.toT, kwh: chargeKwh(s.from, s.to) };
                st.log = (st.log || []).concat([st.lastCharge]).slice(-LOG_MAX);
                log.info('charge ' + s.from.toFixed(1) + ' -> ' + s.to.toFixed(1) + ' %');
            }
        }
        let lv = null;
        function onSoc(soc, now) {
            if (lv) capacityLearner.observe(soc, lv.energySample(), now);
            const prev = st.lastSoc, open = st.session, logged = st.lastCharge, moving = live.speedT && now - live.speedT < 5000 && G.isNum(live.speed) && live.speed > 3;
            const h = (now - (st.lastSocT || 0)) / 3600000;
            if (G.isNum(prev) && h > 0 && h < 120000 / 3600000 && seg.valid
                && live.speedT && now - live.speedT < 5000 && !st.session) {
                model.learn(prev - soc, h, seg.km, live.ambient, kwhPerPct(), stretchClimate(), (seg.comfort + comfortKw()) / 2);
            }
            seg.km = 0; seg.valid = true;
            seg.climate = live.climate; seg.climateMixed = false; seg.comfort = comfortKw();
            if (G.isNum(prev)) {
                if (soc > prev + 0.3 && now - (st.lastSocT || now) > ASLEEP_MS
                    && soc >= (st.session ? st.session.from : prev) + cfg.chargeMinPct) {
                    // charged while the car was off (also one that began while the head unit was still awake):
                    // the charge runs up to this reading. The car wakes now and then during a long charge, so the
                    // session stays open until the car drives off: one charge from the first level to the last
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT };
                    st.session.to = soc; st.session.toT = now;
                    if (moving) closeSession();
                } else if (soc > prev + 0.3 && live.speedT && now - live.speedT < 5000 && G.isNum(live.speed) && live.speed <= 1) {
                    if (!st.session) st.session = { from: prev, fromT: st.lastSocT || now };
                    st.session.to = soc; st.session.toT = now;
                } else if (st.session && (soc < st.session.to - 2 || moving)) {
                    // ends when driving off or on a real drop; small dips while parked (cabin
                    // pre-conditioning, display wobble) keep the session open
                    closeSession();
                }
            }
            st.lastSoc = soc; st.lastSocT = now;
            // a charge logged, a session opened, grown or closed: saved with this reading, so battery.json never holds
            // a logged charge with the reading before it (the next start would log the same charge again)
            if (st.lastCharge !== logged || st.session !== open || (open && open.toT === now) || now - savedAt > 120000) save();
        }
        /** The charge to show: the open session (big enough to count), else the last finished one.
         *  open: the level rose within ASLEEP_MS (charging now); the session itself stays open until the car drives off. */
        function lastCharge() {
            const s = st.session;
            if (s && s.to - s.from >= cfg.chargeMinPct) {
                return Object.assign({}, s, { kwh: chargeKwh(s.from, s.to), open: Date.now() - s.toT < ASLEEP_MS });
            }
            return st.lastCharge || null;
        }

        const pages = () => PAGES.filter((p) => p !== 'diag' || settings.get('diagPage'));
        const diagHint = (s) => (settings.get('diagPage') ? s + ' - see Diagnostics page' : s);
        let busy = false, pollTimer = null, sohFailT = 0;
        async function poll(forceSoh) {
            if (forceSoh) activity.touch();
            if (!usingDemo()) {
                insights.tick(Date.now());
                if (Date.now() - savedAt > 120000 && JSON.stringify(st) !== saved) save();
            }
            if (busy || !diag.available || !active() || usingDemo()) return;
            busy = true;
            try {
                if (!live.capacityT || Date.now() - live.capacityT > 60000) {
                    const capacity = await readValue('capacity');
                    if (G.isNum(capacity) && capacity >= 15 && capacity <= 200) { live.capacity = capacity; live.capacityT = Date.now(); }
                }
                // Read HV first; a missing optional 12 V value must not delay SOC.
                const rawSoc = await readValue('soc');
                const soc = normalizeSoc(rawSoc, cfg.socWindow);
                if (soc !== null) { live.soc = soc; live.socT = Date.now(); onSoc(soc, live.socT); }
                const sohDue = live.soh === null || Date.now() - live.sohT > settings.get('sohDays') * 86400000;
                if (forceSoh || (sohDue && Date.now() - sohFailT > 3600000)) {
                    const soh = await readValue('soh');
                    if (soh !== null) { live.soh = soh; live.sohT = Date.now(); st.soh = soh; st.sohT = live.sohT; save(); }
                    else sohFailT = Date.now();
                }
                if (lv) {
                    const b = lv.dashboard(), c = capacityNow();
                    insights.battery({ t: Date.now(), temp: b.batteryTemp, spread: b.cellSpreadMv,
                        soc: live.socT && Date.now() - live.socT < 60000 ? live.soc : null,
                        capacity: c.kwh, source: c.source,
                        capacityT: c.source === 'reported' ? live.capacityT : capacityLearner.state.t });
                }
                const v = await readValue('v12');
                if (v !== null) { live.v12 = v; live.v12T = Date.now(); }
            } catch (e) { log.warn('poll: ' + e); }
            finally { busy = false; }
        }
        function schedule() {
            clearTimeout(pollTimer);
            pollTimer = setTimeout(() => poll(false).then(schedule), settings.get('poll') * 1000);
        }
        diag.on('available', (a) => { if (a) poll(false); });
        poll(false).then(schedule);

        /* ---------- derived values ---------- */
        function data() {
            if (usingDemo()) return Object.assign(demo.sample(), { demo: true, socAge: 0 });
            const maxAge = Math.max(60, settings.get('poll') * 4) * 1000, now = Date.now();
            return {
                soc: live.soc, soh: live.soh, sohAge: live.sohT ? now - live.sohT : null, ambient: live.ambient, demo: false,
                socAge: live.socT ? now - live.socT : null, stale: !(live.socT && now - live.socT < maxAge),
                v12: live.v12T && now - live.v12T < maxAge ? live.v12 : null, charge: lastCharge(),
                climate: live.climate, ac: live.ac, pace: paceNow(), seats: live.seats, wheel: live.wheel,
                speed: live.speedT && now - live.speedT < 5000 ? live.speed : null,
                blower: live.blower, blowerTop: live.blowerTop, batt: live.batt,
            };
        }
        // Before capacity is known, the range model can still learn total % per km.
        // Until enough driving has been observed, range stays unavailable instead of
        // assigning the car an iX3-sized battery or a fixed nominal range.
        function estimate(soc, tC, climate, pace, comfort) {
            const res = reserve(), span = 100 - res, use = G.isNum(soc) ? Math.max(0, soc - res) : null;
            const k = kwhPerPct(), m = usingDemo()
                ? new RangeModel({ learn: { km: 60, pct: 15 } }, () => k).range(use, tC, k, climate, pace, comfort)
                : model.range(use, tC, k, climate, pace, comfort);
            const base = { res, auxKw: null, auxLearned: false, climate, comfortKw: comfort || 0,
                mid: use === 0 ? 0 : null, lo: null, hi: null, kpp: null, learned: false,
                full: null, auxKm: null, pace, climateKm: null, comfortKm: null };
            if (!m) return base;
            return Object.assign(base, { mid: m.mid, lo: m.mid === null ? null : m.mid * 0.9,
                hi: m.mid === null ? null : m.mid * 1.1, kpp: m.kpp, full: m.kpp * span,
                learned: true, auxKw: m.aux && k ? m.aux.rate * k : null,
                auxLearned: !!(m.aux && m.aux.learned), climateKm: m.climateKm, comfortKm: m.comfortKm,
                pace: m.pace, perKm: m.perKm });
        }
        /** km a charge of +pct % adds (charge log). */
        const kmOf = (pct) => { const k = estimate(null, live.ambient, null, paceNow(), comfortKw()).kpp; return k === null ? null : pct * k; };

        /* ---------- units ---------- */
        const MI = () => settings.get('distUnit') === 'mi';
        const D = (km) => (G.isNum(km) ? (MI() ? km * KM_MI : km) : null);
        const dU = () => (MI() ? 'mi' : 'km');
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const ago = (ms) => (ms == null ? 'not read yet' : ms < 60000 ? Math.max(0, Math.round(ms / 1000)) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago'
            : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' days ago');

        /* ---------- drawing ---------- */
        let page = 0, journeyOffset = 0, chargeOffset = 0;
        const browseHistory = (kind, step) => {
            const h = insightData(data());
            const count = kind === 'journeys' ? h.journeys.length + (h.journey ? 1 : 0) : h.charges.length + (h.charge ? 1 : 0);
            if (kind === 'journeys') journeyOffset = G.clamp(journeyOffset + step, 0, Math.max(0, count - 1));
            else chargeOffset = G.clamp(chargeOffset + step, 0, Math.max(0, count - 1));
            return render();
        };
        // the climate's typical draw for this drive's totals while nothing better is known (the Energy page's estimate)
        const climateKw = () => {
            if (live.climate === false || live.climate == null || kwhPerPct() === null) return 0;
            const k = kwhPerPct();
            return Math.max(0, (model.auxRate(live.ambient, k, live.climate).rate - model.auxRate(live.ambient, k, false).rate) * k);
        };
        // (the scan runs while the Diagnostic page, which shows it, is up)
        // the home-screen widget's range, as the Range page's figure; for this EV
        const rangeText = (soc) => {
            const km = G.isNum(soc) ? estimate(soc, live.ambient, null, paceNow(), comfortKw()).mid : null;
            return (G.isNum(km) ? Math.round(D(km)) : '--') + ' ' + dU();
        };
        lv = startLive(ctx, { diag, reader, exclusive, live, climateKw, rangeText, active, onSample: (sample) => {
            if (usingDemo()) return;
            const j = st.insights.journey, c = st.insights.charge;
            insights.observe(sample);
            if (j !== st.insights.journey || c !== st.insights.charge || Date.now() - savedAt > 120000) save();
        }, demoSoc: () => demo.sample().soc, touch: () => activity.touch(), kwhPerPct, page: () => (pages()[page] === 'diag' ? 'scan' : pages()[page]) });
        const isLive = (p) => lv.PAGES.indexOf(p) >= 0;

        /* ---------- for other apps (Cluster functions' HUD): the power now and the range, four times a second ----------
         * SHARED, a file anyone may read (an app cannot read another's data folder): { t, kw (+ the battery gives power,
         * - it takes it; null while not read), soc, rangeKm (the range at this charge, as the Range page has it) }.
         * Nothing while the demo runs. */
        const SHARED = '/tmp/mgu-ixdrive.json';
        setInterval(() => {
            try {
                const d = data();
                if (d.demo) return;
                const p = lv.powerNow({});
                const e = G.isNum(d.soc) && !d.stale ? estimate(d.soc, d.ambient, d.climate, d.pace, comfortKw(d)) : null;
                const out = { t: Date.now(), kw: p && G.isNum(p.kw) ? +p.kw.toFixed(1) : null, soc: G.isNum(d.soc) && !d.stale ? d.soc : null,
                    rangeKm: e && G.isNum(e.mid) ? Math.round(e.mid) : null };
                fs.writeFileSync(SHARED + '.tmp', JSON.stringify(out), { mode: 0o644 });
                fs.chmodSync(SHARED + '.tmp', 0o644);
                fs.renameSync(SHARED + '.tmp', SHARED);
            } catch (e) { /* the next write tries again */ }
        }, 250);
        // the first bar button: "Read now", on the live pages their own action (this drive's totals, the scan)
        let actionText = 'Read now';
        const actionLabel = () => {
            const p = pages()[page], txt = p === 'journeys' ? 'Older trips' : p === 'lab' ? 'Older session' : (isLive(p) && lv.actionLabel(p)) || 'Read now';
            if (txt !== actionText) { actionText = txt; ui.text('BTN_READ', txt); }
        };
        const turn = (n) => { page = n; activity.touch(); poll(false); actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % pages().length));
        ui.onClick('BTN_PREV', () => { const n = pages().length; return turn((page + n - 1) % n); });
        ctx.onTab((i) => turn(i));
        ui.onClick('BTN_READ', () => {
            const p = pages()[page];
            if (p === 'journeys' || p === 'lab') return browseHistory(p, p === 'journeys' ? 7 : 1);
            if (isLive(p) && lv.actionLabel(p)) { lv.action(p); return render(); }
            return poll(true).then(render);
        });
        // where the kit runs the screen the values are read on their own (poll) and the resets are on the page
        ctx.hideButton('BTN_READ');
        const diagScroll = { y: 0, max: 0 };
        ctx.onScroll((dy) => {
            const p = pages()[page];
            if (p === 'journeys' || p === 'lab') { browseHistory(p, Math.sign(dy)); return true; }
            if (p !== 'diag') return false;
            const y = G.clamp(diagScroll.y + dy, 0, diagScroll.max), moved = y !== diagScroll.y;
            diagScroll.y = y;
            return moved;
        });

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t, d) {
            const names = Object.assign({ main: 'Range', energy: 'Energy', charging: 'Charging', log: 'Charge log', journeys: 'Journeys', lab: 'Charge lab', trends: 'Trends', diag: 'Diagnostic', signals: 'Signals' }, lv.NAMES);
            G.frame(cv, t, pages().map((p) => names[p]), page, [d.demo && { text: 'DEMO' }]);
        }

        function battery(cv, t, x, y, w, h, soc) {
            const f = G.isNum(soc) ? G.clamp(soc / 100, 0, 1) : 0;
            const col = !G.isNum(soc) ? t.tick : soc < 10 ? t.crit : soc < 25 ? t.warn : GO;
            cv.strokeRoundRect(x, y, w, h, 14, 5, t.tick);
            cv.roundRect(x + w + 2, y + h * 0.3, 16, h * 0.4, 4, t.tick);
            const iw = w - 24, ih = h - 24, seg = iw / 10;
            for (let i = 0; i < 10; i++) cv.roundRect(x + 12 + i * seg, y + 12, seg - 6, ih, 5, f * 10 > i + 0.05 ? col : t.track);
            const i = Math.floor(f * 10), part = f * 10 - i;
            if (i < 10 && part > 0.05) cv.roundRect(x + 12 + i * seg, y + 12, (seg - 6) * part, ih, 5, withAlpha(col, 0.55));
        }

        /** Label left, value right, on one line of a panel. */
        function row(cv, t, x, w, y, label, value, col) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(value, x + w, y, 26, col || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
        }
        const num = (v, dec, unit) => (G.isNum(v) ? G.fmt(v, dec) + (unit ? ' ' + unit : '') : '--');
        const signed = (v, dec, unit) => (G.isNum(v) ? (v > 0 ? '+' : '') + G.fmt(v, dec) + (unit ? ' ' + unit : '') : '--');

        function renderMain(cv, t, d) {
            const e = estimate(d.soc, d.ambient, d.climate, d.pace, comfortKw(d));
            const trip = lv.dashboard(), use = lv.consumption(), pw = lv.powerNow(t);
            const capacity = capacityNow(), has = G.isNum(d.soc);
            const label = (text, x, y, right) => cv.text(text, x, y, 19, t.dim,
                { font: 'bold', spacing: 1, align: right ? 'right' : 'left' });
            const metric = (value, unit, x, y, size, color) => {
                const width = cv.text(value, x, y, size, color || t.text, { font: 'num' });
                cv.text(unit, x + width + 10, y, 22, t.dim, { font: 'bold' });
            };
            const efficiency = v => G.isNum(v) ? v * 100 / D(1) : null;
            const effUnit = 'kWh/100 ' + dU();

            // Dominant range, with the planning reserve kept beside it.
            G.panel(cv, t, 24, 44, 560, 268, 'Estimated range');
            const rw = cv.text(has && G.isNum(e.mid) ? String(Math.round(D(e.mid))) : '--', 48, 196, 116, t.text, { font: 'num' });
            cv.text(dU(), 60 + rw, 196, 32, t.dim, { font: 'bold' });
            label('RESERVE', 560, 145, true);
            cv.text(G.fmt(e.res, 0) + ' %', 560, 196, 38, t.text, { font: 'num', align: 'right' });
            const state = !has ? 'NO CHARGE READING' : d.stale ? 'STALE · ' + ago(d.socAge)
                : !active() && !d.demo ? 'PAUSED' : !e.learned ? 'LEARNING' : d.demo ? 'DEMO' : 'LEARNED';
            label(state, 48, 247);
            cv.text('Full ~' + (G.isNum(e.full) ? Math.round(D(e.full)) : '--') + ' ' + dU(), 560, 247, 22, t.dim, { align: 'right' });
            const rangeStatus = has && d.soc <= e.res && e.res > 0 ? 'RESERVE REACHED'
                : has && d.soc <= 10 ? 'LOW BATTERY' : e.res ? 'Range to arrival reserve' : 'To 0% displayed charge';
            cv.text(rangeStatus, 48, 286, 20, has && d.soc <= Math.max(10, e.res) ? t.warn : t.dim);

            // Charge and battery telemetry share a compact card.
            G.panel(cv, t, 608, 44, 448, 268, 'Battery');
            metric(G.fmt(d.soc, 0), '%', 632, 175, 78);
            battery(cv, t, 834, 113, 164, 62, d.soc);
            const energy = has && !d.stale && G.isNum(capacity.kwh) ? d.soc * capacity.kwh / 100 : null;
            label('ENERGY', 632, 220);
            cv.text(G.isNum(energy) ? '~' + G.fmt(energy, 1) + ' kWh' : '--', 1032, 220, 26, t.text, { font: 'bold', align: 'right' });
            cv.fillRect(632, 238, 400, 1, t.panelEdge);
            label('PACK TEMP', 632, 268);
            cv.text(num(T(trip.batteryTemp), 0, tU()), 632, 295, 24, t.text, { font: 'bold' });
            label('PACK VOLTAGE', 1032, 268, true);
            cv.text(num(trip.volts, 0, 'V'), 1032, 295, 24, t.text, { font: 'bold', align: 'right' });

            // Power remains glanceable; the scale follows battery limits.
            const powerExtra = G.panel(cv, t, 24, 336, 560, 176, 'Live power').h - 176;
            cv.text(!G.isNum(pw.kw) ? (!active() ? 'PAUSED' : 'NO DATA') : pw.old ? 'STALE' : pw.what, 560, 372, 18, pw.old ? t.dim : pw.kw < -0.3 ? GO : t.dim, { align: 'right' });
            lv.drawPowerBar(cv, t, 48, 396 + powerExtra, 512, '');

            // Matched energy/distance samples, with explicit distance units.
            const effExtra = G.panel(cv, t, 608, 336, 448, 176, 'Efficiency').h - 176;
            const recent = efficiency(use.perKm), average = efficiency(trip.perKm);
            const trend = G.isNum(recent) && G.isNum(average) && average > 0 ? (recent / average - 1) * 100 : null;
            if (G.isNum(trend)) cv.text((trend > 0 ? '+' : '') + G.fmt(trend, 0) + '% vs trip', 1032, 372, 18,
                trend < -2 ? GO : t.dim, { align: 'right' });
            label('LAST ' + G.fmt(D(use.km), 1) + ' ' + dU().toUpperCase(), 632, 410 + effExtra / 2);
            label('TRIP AVG', 848, 410 + effExtra / 2);
            cv.text(G.fmt(recent, 1), 632, 458 + effExtra / 2, 42, t.text, { font: 'num' });
            cv.text(G.fmt(average, 1), 848, 458 + effExtra / 2, 42, t.text, { font: 'num' });
            cv.text(effUnit, 632, 490 + effExtra, 19, t.dim);
            cv.text(effUnit, 848, 490 + effExtra, 19, t.dim);

            const extra = G.panel(cv, t, 1080, 44, 496, 468, 'This drive').h - 468;
            G.button(cv, t, 1440, 54, 112, 38, 'Reset', () => { lv.action('battery'); return render(); }, { key: 'trip', confirm: true });
            label('DISTANCE', 1104, 126);
            metric(G.fmt(D(trip.km), 1), dU(), 1104, 184, 58);
            cv.text(G.isNum(trip.minutes) ? Math.round(trip.minutes) + ' min recorded' : '-- min', 1552, 184, 20, t.dim, { align: 'right' });
            cv.fillRect(1104, 207, 448, 1, t.panelEdge);
            label('NET ENERGY', 1104, 247 + extra / 3);
            label('RECOVERED', 1340, 247 + extra / 3);
            metric(G.fmt(trip.net, 2), 'kWh', 1104, 298 + extra / 3, 40);
            metric(G.fmt(trip.regen, 2), 'kWh', 1340, 298 + extra / 3, 40, GO);
            row(cv, t, 1104, 448, 364 + extra * 2 / 3, 'PEAK DRAW', num(trip.peakOut, 0, 'kW'));
            row(cv, t, 1104, 448, 418 + extra * 2 / 3, '12 V BATTERY', num(d.v12, 2, 'V'));
            const c = d.charge;
            label(c && c.open ? 'CHARGE SESSION' : 'LAST CHARGE', 1104, 486 + extra);
            cv.text(c ? '+' + G.fmt(c.to - c.from, 0) + ' %' : '--', 1552, 486 + extra, 26, c ? GO : t.dim, { font: 'bold', align: 'right' });
        }

        /**
         * The Diagnostic page: the battery diagnostics, the battery unit, the scan and the car's signals, one
         * under the other, scrolled by a finger or the controller (ctx.onScroll). In software (no renderer to
         * move the parts) only the first part.
         */
        function renderDiagAll(cv, t, d) {
            const parts = DIAG_PARTS.map((p) => ({
                diag: () => renderDiag(cv, t, d), signals: () => renderSignals(cv, t, d),
                unit: () => lv.draw('unit', cv, t),
                scan: () => { lv.draw('scan', cv, t); G.button(cv, t, 1576 - 20 - 120, 56, 120, 40, 'Reset', () => { lv.action('scan'); return render(); }, { key: 'scan', confirm: true }); },
            })[p]);
            const pl = cv.place;
            if (!pl) { parts[0](); return; }
            cv.scroll = true;
            diagScroll.max = Math.max(0, parts.length * DIAG_STEP - (H + (cv.extra || 0) - 44));
            diagScroll.y = G.clamp(diagScroll.y, 0, diagScroll.max);
            const sy = G.smooth('diagScroll', diagScroll.y, 22);
            const extra = cv.extra;
            cv.extra = 0;                // (each part is a page of its own height)
            cv.clip(0, 38, W, H + extra - 38);
            parts.forEach((draw, i) => {
                const oy = i * DIAG_STEP - sy;
                if (oy > H || oy + DIAG_STEP < 0) return;
                const n0 = cv.targets.length;
                cv.xf(pl.scale, pl.ox, pl.oy + oy * pl.scale);
                draw();
                cv.xf();
                for (let k = n0; k < cv.targets.length; k++) cv.targets[k].y += oy;
            });
            cv.noclip();
            cv.extra = extra;
            const vis = H + extra - 44, bh = Math.max(40, vis * vis / (vis + diagScroll.max));
            cv.roundRect(W - 9, 44 + (vis - bh) * (diagScroll.max ? sy / diagScroll.max : 0), 6, bh, 3, withAlpha('#ffffff', 0.3));
        }

        function renderCharging(cv, t, d) {
            const target = settings.get('chargeTarget'), pw = lv.powerNow(t);
            const c = chargeEstimate(d.stale ? null : d.soc, target, kwhPerPct(),
                d.demo ? -45 : pw.old ? null : pw.kw, d.demo ? 0 : d.speed);
            G.panel(cv, t, 24, 44, 744, 468, 'Charging estimate');
            G.panel(cv, t, 792, 44, 784, 468, 'Battery energy');
            const kw = d.demo ? -45 : pw.old ? null : pw.kw, speed = d.demo ? 0 : d.speed;
            const charging = G.isNum(kw) && kw < -0.3 && G.isNum(speed) && speed <= 1;
            const status = charging ? 'CHARGING' : !G.isNum(d.soc) || d.stale ? 'WAITING FOR CHARGE LEVEL'
                : !c ? 'LEARNING CAPACITY' : c.reached ? 'TARGET REACHED' : 'NO ACTIVE CHARGE DETECTED';
            cv.text(status, 48, 128, 26, charging ? GO : t.dim, { font: 'bold' });
            const value = cv.text(charging ? G.fmt(-kw, 1) : '--', 48, 248, 96, t.text, { font: 'num' });
            cv.text('kW', 60 + value, 248, 32, t.dim, { font: 'bold' });
            row(cv, t, 48, 696, 328, 'ESTIMATE TARGET', G.fmt(target, 0) + ' %');
            row(cv, t, 48, 696, 396, 'AT CURRENT POWER', c && c.minutes !== null ? '~' + Math.ceil(c.minutes) + ' min' : '--');
            cv.text('Charging slows near full; time is an estimate.', 48, 464, 22, t.dim);
            row(cv, t, 816, 736, 144, 'CHARGE LEVEL', num(d.stale ? null : d.soc, 1, '%'));
            row(cv, t, 816, 736, 222, 'ENERGY TO TARGET', c ? '~' + num(c.remaining, 1, 'kWh') : '--');
            row(cv, t, 816, 736, 300, 'USABLE CAPACITY', num(capacityNow().kwh, 1, 'kWh'));
            cv.text('Battery-side power; charger losses are excluded.', 816, 378, 21, t.dim);
            cv.text('The target here does not change the car setting.', 816, 420, 21, t.dim);
            cv.text(G.isNum(capacityNow().kwh) ? 'Capacity source: ' + capacityNow().source : 'Learning usable capacity while you drive.', 816, 464, 20, t.dim);
        }

        function renderHealth(cv, t, d, x, y, w, h) {
            const capacity = capacityNow(), kwh = capacity.kwh;
            G.panel(cv, t, x, y, w, h, 'Usable battery energy');
            cv.text(G.isNum(kwh) ? G.fmt(kwh, 1) : '--', x + 24, y + 150, 80, t.text, { font: 'num' });
            cv.text('kWh', x + w - 24, y + 150, 30, t.dim, { align: 'right' });
            cv.text(G.isNum(kwh) ? 'Capacity: ' + capacity.source : 'Learning capacity while driving', x + 24, y + 195, 22, t.dim);
            row(cv, t, x + 24, w - 48, y + 285, 'ENERGY NOW', G.isNum(kwh) && G.isNum(d.soc) ? '~' + num(kwh * d.soc / 100, 1, 'kWh') : '--');
            row(cv, t, x + 24, w - 48, y + 355, 'HEALTH', num(d.soh, 0, '%'));
            cv.text('Usable capacity reflects current battery condition.', x + 24, y + 425, 19, t.dim);
        }

        const pad = n => (n < 10 ? '0' : '') + n;
        const dateOf = ms => { const x = new Date(ms); return pad(x.getDate()) + '.' + pad(x.getMonth() + 1) + '  ' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
        const price = () => settings.get('price') || 0;
        const money = (kwh) => (G.isNum(kwh) && price() > 0 ? (kwh * LOSS * price()).toFixed(2) + ' €' : null);

        function renderLog(cv, t, d) {
            const all = d.demo ? demo.log() : (st.log || []);
            const kwhOf = (c) => (G.isNum(c.kwh) ? c.kwh : 0);

            // ---- list, newest first
            const ex = G.panel(cv, t, 24, 44, 1040, 468, 'Charges' + (all.length ? '  (' + all.length + ')' : '')).h - 468;
            // room below the page: another row where a whole one fits, the rest spread over the rows
            const nRows = 8 + Math.floor(ex / 43), rowP = 43 + (ex - (nRows - 8) * 43) / nRows;
            const cols = [48, 230, 380, 590, 760, 920];
            ['DATE', 'ADDED', 'FROM - TO', 'ENERGY', 'RANGE', price() > 0 ? 'COST' : ''].forEach((h, i) => cv.text(h, cols[i], 121, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 133, 992, 1, t.panelEdge);
            if (!all.length) {
                const ny = Math.round(ex / 2);
                cv.text('No charges logged yet.', 544, 284 + ny, 32, t.dim, { align: 'center', font: 'bold' });
                cv.text('Every charge of ' + cfg.chargeMinPct + ' % or more shows up here,', 544, 330 + ny, 26, t.dim, { align: 'center' });
                cv.text('also overnight charges.', 544, 366 + ny, 26, t.dim, { align: 'center' });
            }
            all.slice(-nRows).reverse().forEach((c, i) => {
                const y = Math.round(174 + i * rowP);
                if (i % 2 === 0) cv.roundRect(40, y - 28, 1008, 38, 8, withAlpha(t.track, 0.55));
                const add = c.to - c.from;
                cv.text(dateOf(c.toT), cols[0], y, 24, t.text, { font: 'label' });
                cv.text('+' + add.toFixed(0) + ' %', cols[1], y, 26, GO, { font: 'bold' });
                cv.text(Math.round(c.from) + ' - ' + Math.round(c.to) + ' %', cols[2], y, 24, t.dim, { font: 'label' });
                cv.text(G.isNum(c.kwh) ? c.kwh.toFixed(1) + ' kWh' : '-', cols[3], y, 24, t.text, { font: 'label' });
                cv.text(G.isNum(kmOf(add)) ? '+' + Math.round(D(kmOf(add))) + ' ' + dU() : '--', cols[4], y, 24, t.text, { font: 'label' });
                const m = money(c.kwh);
                if (m) cv.text(m, cols[5], y, 24, t.text, { font: 'label' });
            });

            // ---- totals + 14-day chart
            G.panel(cv, t, 1088, 44, 488, 468, 'Totals');
            const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const month = all.filter((c) => c.toT >= monthStart);
            const sum = (list) => list.reduce((a, c) => a + kwhOf(c), 0);
            const block = (y, label, list) => {
                cv.text(label, 1112, y, 22, t.dim, { font: 'bold', spacing: 1 });
                const complete = list.every(c => G.isNum(c.kwh));
                const kw = cv.text(complete ? sum(list).toFixed(1) : '--', 1112, y + 52, 48, t.text, { font: 'num' });
                cv.text('kWh', 1120 + kw, y + 52, 24, t.dim);
                const m = complete ? money(sum(list)) : null;
                if (m) cv.text(m, 1552, y + 52, 30, t.text, { align: 'right', font: 'bold' });
                cv.text(list.length + ' ' + plural(list.length, 'charge', 'charges') + (complete ? '' : ' · energy incomplete'), 1552, y, 22, t.dim, { align: 'right' });
            };
            block(116, 'THIS MONTH', month);
            block(208, 'ALL TIME', all);
            // kWh per day, last 14 days
            const day = 86400000, today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const days = [];
            for (let i = 13; i >= 0; i--) days.push(sum(all.filter((c) => c.toT >= today0 - i * day && c.toT < today0 - (i - 1) * day)));
            const top = Math.max(4, Math.max.apply(null, days));
            // (taller into the room below the page; its label then ends G.MARGIN over the panel's bottom, as the list's rows)
            const dg = G.toMargin(ex, 9), gx = 1112, gy = 470 + dg, gh = 132 + dg, bw = 440 / 14;
            cv.text('KNOWN KWH PER DAY, 14 DAYS', gx, 318, 22, t.dim, { font: 'bold', spacing: 1 });
            days.forEach((v, i) => {
                const h = v > 0 ? Math.max(6, v / top * gh) : 0;
                cv.roundRect(gx + i * bw + 3, gy - gh, bw - 6, gh, 4, withAlpha(t.track, 0.6));
                if (h) cv.rampRect(gx + i * bw + 3, gy - h, bw - 6, h, 4, t.ramp || [t.accent]);
            });
            cv.text('today', gx + 440, gy + 28, 22, t.dim, { align: 'right' });
        }

        function renderDiag(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Battery diagnostics');
            const link = diag.p ? (diag.available ? 'link up' : 'link down') : 'no link (' + (diag.error || 'not started') + ')';
            cv.text('UDS 22 ReadDataByIdentifier / OBD 01  ·  ' + link + '  ·  ' + translate('ambient') + ' ' + (G.isNum(live.ambient) ? G.fmt(live.ambient, 1) + ' °C' : translate('n/a'))
                + '  ·  ' + translate('speed') + ' ' + (G.isNum(live.speed) ? G.fmt(G.hold('speed', live.speed), 0) + ' km/h' : translate('n/a'))
                + '  ·  ' + translate('climate') + ' ' + (live.climate === null ? translate('n/a') : translate(live.climate ? 'on' : 'off')) + (live.ac ? ' (A/C)' : ''), 48, 121, 24, t.text, { font: 'label' });
            const cols = [48, 160, 260, 380, 820, 1000, 1290];
            ['VALUE', 'ECU', 'DID', 'REPLY', 'DECODED', 'STATUS', 'READ'].forEach((h, i) => cv.text(h, cols[i], 167, 22, t.dim, { font: 'bold', spacing: 1 }));
            cv.fillRect(48, 178, 1504, 1, t.tick);
            // every candidate gets a row: the rows shrink to fit between the header and the note at the bottom
            const keys = VALUES;
            const n = keys.reduce((a, key) => a + (cfg[key] || []).length, 0);
            const rowH = Math.min(38, Math.floor(232 / Math.max(1, n))), fs = rowH >= 34 ? 24 : Math.max(15, rowH - 3), fsS = Math.max(14, fs - 2);
            let y = 178 + Math.max(24, rowH);
            keys.forEach((key) => (cfg[key] || []).forEach((c, i) => {
                const ecu = c.ecu == null ? cfg.ecu : c.ecu, r = raws[reader.key(c)];
                const used = pick[key] === i && r && r.ok;
                cv.text(key.toUpperCase() + (used ? ' *' : ''), cols[0], y, fs, used ? GO : t.text, { font: 'bold' });
                cv.text('0x' + hex(ecu), cols[1], y, fs, t.text, { font: 'label' });
                cv.text(DidReader.label(c), cols[2], y, fs, t.text, { font: 'label' });
                const bytes = r ? r.bytes || '-' : '-';
                cv.text(bytes.length > 36 ? bytes.slice(0, 35) + '…' : bytes, cols[3], y, fsS, t.dim, { font: 'label' });
                cv.text(r && G.isNum(r.value) ? G.fmt(r.value, key === 'v12' ? 2 : 1) : '-', cols[4], y, fs, t.text, { font: 'label' });
                const why = r ? (r.ok ? 'OK' : r.why) : 'not read';
                cv.text(why.length > 24 ? why.slice(0, 23) + '…' : why, cols[5], y, fsS, r && r.ok ? GO : r ? t.warn : t.dim, { font: 'label' });
                cv.text(r ? ago(Date.now() - r.t) : '-', cols[6], y, fsS, t.dim, { font: 'label' });
                y += rowH;
            }));
            cv.text('A value n/a or wrong? Adjust config.battery in apps/ixdrive/app.json and rebuild.', 48, 488, 20, t.dim);
            if (d.demo) cv.text('Main page: demo data until the link answers', 1552, 488, 20, t.warn, { align: 'right' });
        }

        /** The car's signals as received (climate, comfort, power figures), one per line - for checking scalings. */
        function renderSignals(cv, t, d) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Car signals');
            const seatTxt = Object.keys(live.seats).map((k) => k + ' ' + (live.seats[k] === null ? '?' : live.seats[k])).join(' ') || translate('n/a');
            const bt = live.batt;
            cv.text('climate ' + (live.climate === null ? translate('n/a') : live.climate === 'ac' ? translate('on') + ' (A/C)' : translate(live.climate ? 'on' : 'off'))
                + '  ·  blower ' + (G.isNum(live.blower) ? live.blower + ' / ' + live.blowerTop : translate('n/a')) + '  ·  seats ' + seatTxt
                + '  ·  wheel ' + (live.wheel === null ? translate('n/a') : translate(live.wheel ? 'on' : 'off')) + '  ·  pace ' + (G.isNum(paceNow()) ? Math.round(paceNow()) + ' km/h' : translate('n/a'))
                + '  ·  battery ' + (bt && G.isNum(bt.avg) ? bt.avg + ' °C (' + bt.min + '..' + bt.max + ')' : translate('n/a'))
                + '  ·  HV ' + (G.isNum(live.hvV) ? live.hvV : translate('n/a')), 48, 112, 21, t.text, { font: 'label' });
            cv.fillRect(48, 128, 1504, 1, t.tick);
            const rows = [['A/C', rawClimate['A/C']], ['blower', rawClimate.blower], ['compressor', rawClimate.compressor],
                ['climate', rawClimate.climate], ['ac', rawClimate.ac]].concat(Object.keys(live.raw).sort().map((k) => [k, live.raw[k]]));
            // up to 14 rows between the summary and the note: the spacing shrinks to fit them all
            const step = Math.min(26, Math.floor(310 / Math.max(1, rows.length))), fz = step >= 24 ? 18 : 16;
            let y = 154;
            rows.forEach(([k, v]) => {
                if (y > 470) return;
                cv.text(k, 48, y, fz + 1, t.dim, { font: 'bold' });
                const txt = v || '-';
                cv.text(txt.length > 160 ? txt.slice(0, 159) + '…' : txt, 230, y, fz, v ? t.text : t.dim, { font: 'label' });
                y += step;
            });
            cv.text('Raw values as the car sends them - for checking the scalings (config.scaling in app.json).', 48, 498, 18, t.dim);
        }

        /** Energy: use per speed band, where the power goes now, the car's own figures, battery temperature. */
        function renderEnergy(cv, t, d) {
            const k = kwhPerPct(), comfort = comfortKw(d);
            const e = estimate(d.soc, d.ambient, d.climate, d.pace, comfort), has = G.isNum(d.soc);

            // ---- the battery's power now: kW, bar, the last two minutes (live.js)
            lv.drawPower(cv, t, 24, 44, 740, 468);
            // the range at the rate the battery itself measured: energy above the arrival reserve / kWh per km lately
            const use = lv.consumption(), usable = has && k !== null ? k * Math.max(0, d.soc - e.res) : null;
            const measured = G.isNum(usable) && G.isNum(use.perKm) && use.perKm > 0;
            const rr = measured ? usable / use.perKm : e.mid;          // not measured yet: the learned range

            // ---- where the power goes now
            const x0 = 788, w0 = 788;
            const ex = G.panel(cv, t, x0, 44, w0, 468, 'Where the power goes now').h - 468;   // (room below the page: rows spread, range at the bottom)
            const base = k === null ? null : model.auxRate(d.ambient, k, false).rate * k;
            // the climate: measured from the battery or the climate unit's figures (live.js) when there are, else the estimate
            // (the measurement holds the seat and wheel heating too: they have rows of their own)
            const lc = d.demo ? null : lv.climate();
            const climKw = d.climate === false && !lc ? 0 : lc ? Math.max(0, lc.kw - comfort) : G.isNum(e.auxKw) && G.isNum(base) ? Math.max(0, e.auxKw - base) : null;
            const blow = d.climate === false ? 0 : Math.min(climKw, blowerKw(d));
            const seatKw = comfort - (d.wheel ? WHEEL_KW : 0), wheelKw = d.wheel ? WHEEL_KW : 0;
            const share = (kw) => (G.isNum(e.comfortKm) && comfort > 0 ? e.comfortKm * kw / comfort : null);
            // driving: learned % per km at the pace; before that the typical range (all use per km) less
            // what the climate, on-board electrics and seat heating draw
            // moving: live - the battery's power now less what the rest draws; else the learned figure
            const pwNow = d.demo ? null : lv.powerNow(t).kw;
            const liveDrive = G.isNum(climKw) && G.isNum(base) && G.isNum(pwNow) && G.isNum(d.speed) && d.speed > 2
                ? Math.max(0, pwNow - climKw - (comfort || 0) - base) : null;
            const driveKw = G.isNum(liveDrive) ? liveDrive : !G.isNum(k) || !G.isNum(e.pace) ? null : G.isNum(e.perKm) ? e.perKm * k * e.pace
                : G.isNum(e.kpp) && e.kpp > 0 ? Math.max(0, (1 / e.kpp) * k * e.pace - e.auxKw - (comfort || 0)) : null;
            const seatTxt = Object.keys(d.seats || {}).filter((s2) => d.seats[s2]).map((s2) => ({ DR: 'driver', PS: 'pass.', DRR: 'rear L', PSR: 'rear R' }[s2] + ' ' + d.seats[s2])).join(', ');
            const rows = [
                ['Driving', driveKw, null,
                    G.isNum(liveDrive) ? 'live, at ' + Math.round(D(d.speed)) + ' ' + (MI() ? 'mph' : 'km/h')
                        : G.isNum(e.pace) ? translate('at') + ' ' + Math.round(D(e.pace)) + ' ' + (MI() ? 'mph' : 'km/h') + (e.learned ? '' : ' (typical)') : 'learns as you drive'],
                ['Climate (heating / A/C)', climKw, has && d.climate !== false ? e.climateKm : null,
                    lc ? (lc.how === 'measured' ? 'from the battery' : lc.how === 'climate unit' ? 'climate unit' : 'measured before')
                        + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')
                        : d.climate === false ? 'off' : (e.auxLearned ? 'learned' : 'typical') + (blow > 0 ? ', blower ~' + G.fmt(blow, 2) + ' kW' : '')],
                ['Seat heating', seatKw, has ? share(seatKw) : null, seatTxt ? seatTxt + ' (est.)' : 'off'],
                ['Steering wheel', wheelKw, has ? share(wheelKw) : null, d.wheel === null || d.wheel === undefined ? translate('n/a') : d.wheel ? 'on (est.)' : 'off'],
                ['On-board electrics', base, null, 'screens, units, pumps'],
            ];
            ['', 'KW', 'RANGE', ''].forEach((h, i) => cv.text(h, [x0 + 24, x0 + 400, x0 + 500, 0][i], 116, 20, t.dim, { font: 'bold', spacing: 1, align: 'right' }));
            rows.forEach(([name, kw, km, note], i) => {
                const y = Math.round(160 + i * (52 + ex / 5));
                cv.text(name, x0 + 24, y, 24, t.text, { font: 'bold' });
                cv.text(G.isNum(kw) ? G.fmt(kw, kw < 1 ? 2 : 1) : '-', x0 + 400, y, 24, G.isNum(kw) && kw >= 1.5 ? t.warn : t.text, { font: 'bold', align: 'right' });
                cv.text(G.isNum(km) && km >= 0.5 ? '-' + Math.round(D(km)) + ' ' + dU() : '', x0 + 500, y, 22, t.text, { align: 'right' });
                cv.text(note.length > 30 ? note.slice(0, 29) + '…' : note, x0 + 520, y, 19, t.dim);
            });
            // the car's own "power distribution" display (scaling not known yet: shown as sent)
            // (255 = the car doesn't send that value: left out; nothing at all: the line is left out)
            const pd = live.pd || {};
            const sent = [['drive', pd.displayRepartitionDriveElectricPower], ['climate', pd.displayRepartitionAirConditioningElectricPower],
                ['seat bars', pd.displayRepartitionElectricSeatHeater], ['climate boost', pd.displayRepartitionElectricRangeAirConditioningBoost]]
                .filter(([, v]) => G.isNum(v) && v !== 255);
            void sent;
            // learned range vs. the range at the rate measured lately
            const kmTxt = (km) => (G.isNum(km) && has ? Math.round(D(km)) + ' ' + dU() : '--');
            cv.text('RANGE AT THIS RATE', x0 + 24, 486 + ex, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(kmTxt(rr), x0 + w0 - 24, 490 + ex, 40, measured ? t.text : t.dim, { font: 'bold', align: 'right' });
        }

        const insightData = d => d.demo ? demoInsights(Date.now()) : insights.view();
        const efficiencyText = v => G.isNum(v) ? G.fmt(v * 100 / D(1), 1) : '--';
        const shortDate = ms => { const d = new Date(ms); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1); };

        function renderJourneys(cv, t, d) {
            const history = insightData(d), all = history.journeys.concat(history.journey ? [history.journey] : []);
            const ex = G.panel(cv, t, 24, 44, 1040, 468, 'Journey journal').h - 468;
            journeyOffset = G.clamp(journeyOffset,0,Math.max(0,all.length-1));
            const rows = all.slice().reverse().slice(journeyOffset,journeyOffset+7);
            cv.scroll = all.length > 7;
            G.button(cv,t,776,54,120,38,'Newer',()=>browseHistory('journeys',-7),{key:'journey-newer',busy:!journeyOffset});
            G.button(cv,t,916,54,120,38,'Older',()=>browseHistory('journeys',7),{key:'journey-older',busy:journeyOffset+7>=all.length});
            const xs = [48, 255, 390, 540, 700, 850];
            ['START', 'DISTANCE', 'ENERGY', 'PER 100 ' + dU().toUpperCase(), 'OUTSIDE', 'RECORD'].forEach((v,i) => cv.text(v,xs[i],125,18,t.dim,{font:'bold'}));
            if (!rows.length) cv.text('Journeys appear as you drive.',544,285,28,t.dim,{align:'center'});
            rows.forEach((j,i) => {
                const y = 177 + i * (43 + ex / 7), ambient = j.ambientN ? j.ambientSum / j.ambientN : null;
                if (i%2===0) cv.roundRect(40,y-27,1008,39,6,withAlpha(t.track,.5));
                const values = [dateOf(j.start), num(D(j.km),1,dU()), num(j.kwh,2,'kWh'),
                    efficiencyText(j.km>=1 ? j.kwh/j.km : null), num(T(ambient),0,tU()),
                    j === history.journey ? 'LIVE' : j.partial ? 'PARTIAL' : Math.round(j.seconds/60)+' min'];
                values.forEach((v,k) => cv.text(v,xs[k],y,23,k===5 && j===history.journey ? GO : t.text,{font:'label'}));
            });
            cv.text('Recorded intervals · cost at current tariff',48,490+ex,18,t.dim);
            cv.text(all.length ? (journeyOffset+1)+' - '+Math.min(all.length,journeyOffset+7)+' / '+all.length : '',1040,490+ex,18,t.dim,{align:'right'});
            G.panel(cv,t,1088,44,488,468,'Last 7 days');
            const now = Date.now(), week = 7*86400000;
            const same = all.filter(j=>j.era===(history.era || 0));
            const current = same.filter(j=>j.start>=now-week), previous = same.filter(j=>j.start>=now-2*week && j.start<now-week);
            const a = journeyStats(current), b = journeyStats(previous);
            cv.text(G.fmt(D(a.km),1),1112,183,68,t.text,{font:'num'});
            cv.text(dU()+' recorded',1552,183,24,t.dim,{align:'right'});
            row(cv,t,1112,440,255,'TRIPS',String(a.count));
            row(cv,t,1112,440,311,'NET ENERGY',num(a.kwh,1,'kWh'));
            row(cv,t,1112,440,367,'AVG / 100 '+dU().toUpperCase(),efficiencyText(a.perKm)+' kWh');
            const delta = a.perKm>0 && b.perKm>0 ? (a.perKm/b.perKm-1)*100 : null;
            row(cv,t,1112,440,423,'VS PRIOR WEEK',G.isNum(delta)?signed(delta,0,'%'):'--',delta<0?GO:t.text);
            row(cv,t,1112,440,482+ex,'EST. COST',a.count ? money(Math.max(0,a.kwh)) || '--' : '--');
        }

        function renderChargeLab(cv,t,d) {
            const history = insightData(d), all = history.charges.concat(history.charge ? [history.charge] : []);
            chargeOffset=G.clamp(chargeOffset,0,Math.max(0,all.length-1));
            const current = all[all.length-1-chargeOffset], older = all[all.length-2-chargeOffset];
            const previous = older && current && older.era === current.era ? older : null;
            cv.scroll=all.length>1;
            const ex = G.panel(cv,t,24,44,960,468,'Charging power by charge level').h-468;
            G.button(cv,t,704,54,120,38,'Newer',()=>browseHistory('lab',-1),{key:'charge-newer',busy:!chargeOffset});
            G.button(cv,t,840,54,120,38,'Older',()=>browseHistory('lab',1),{key:'charge-older',busy:chargeOffset+1>=all.length});
            const series=[];
            [previous,current].forEach((c,index) => {
                if (!c) return;
                let pts=[], segment=null;
                const flush=()=>{ if(pts.length) series.push({pts,color:index?GO:t.dim,width:index?4:2}); pts=[]; };
                c.points.forEach(p=>{
                    if (!G.isNum(p.soc) || p.segment!==segment) flush();
                    segment=p.segment;
                    if(G.isNum(p.soc)) pts.push([p.soc,p.kw]);
                }); flush();
            });
            const top=Math.max(25,Math.ceil(Math.max(...[previous,current].filter(Boolean).map(c=>c.peak),0)/25)*25);
            cv.text(current ? (current===history.charge ? 'LIVE SESSION' : shortDate(current.start)) : 'NO SESSION YET',48,125,22,GO,{font:'bold'});
            cv.text(previous ? 'GREY · '+shortDate(previous.start) : '',960,125,20,t.dim,{align:'right'});
            const chart=G.chart(cv,t,48,155,912,280+ex,{xMin:0,xMax:100,yMin:0,yMax:top,xStep:20,xUnit:'%',yUnit:'kW',series,
                empty:series.length ? '' : 'Waiting for charging power and charge level'});
            series.forEach(s=>s.pts.forEach(p=>cv.circle(chart.X(p[0]),chart.Y(p[1]),3,s.color)));
            cv.text('Battery-side power · gaps stay separate',48,488+ex,20,t.dim);
            G.panel(cv,t,1008,44,568,468,'Observed session');
            row(cv,t,1032,520,139,'CHARGE',current ? num(current.from,0,'%')+' - '+num(current.to,0,'%'):'--');
            row(cv,t,1032,520,205,'ENERGY ADDED',current ? num(current.kwh,2,'kWh'):'--');
            row(cv,t,1032,520,271,'PEAK POWER',current ? num(current.peak,0,'kW'):'--');
            row(cv,t,1032,520,337,'RECORDED TIME',current ? num(current.seconds/60,1,'min'):'--');
            const temps=current ? current.points.map(p=>p.temp).filter(G.isNum) : [];
            row(cv,t,1032,520,403,'PACK TEMPERATURE',temps.length ? num(T(Math.min(...temps)),0,'')+' - '+num(T(Math.max(...temps)),0,tU()):'--');
            cv.text(!current ? 'Records automatically while charging.' : current.partial ? 'PARTIAL · telemetry interrupted' : 'Observed while the app is awake',1032,484+ex,22,t.dim);
        }

        function renderTrends(cv,t,d) {
            const history=insightData(d), era=history.era || 0;
            const caps=history.capacities.filter(p=>p.era===era), days=history.days.filter(p=>p.era===era);
            const last=caps[caps.length-1], latestDay=days[days.length-1], now=Date.now(), day=86400000;
            const ex=G.panel(cv,t,24,44,960,468,'Usable capacity history').h-468;
            const minT=caps.length ? caps[0].t : now-30*day, span=Math.max(1,Math.ceil((now-minT)/day));
            const vals=caps.map(p=>p.kwh), low=vals.length ? Math.max(0,Math.floor(Math.min(...vals)-2)) : 0;
            const high=vals.length ? Math.ceil(Math.max(...vals)+2) : 100;
            const groups=['learned','reported'].map(source=>({color:source==='learned'?GO:'#2a8cff',width:3,
                pts:caps.filter(p=>p.source===source).map(p=>[(p.t-minT)/day,p.kwh])}));
            cv.text('GREEN · learned',48,125,21,GO); cv.text('BLUE · reported',960,125,21,'#2a8cff',{align:'right'});
            const chart=G.chart(cv,t,48,155,912,280+ex,{xMin:0,xMax:span,yMin:low,yMax:high,yUnit:'kWh',
                xFmt:v=>shortDate(minT+v*day),series:groups,empty:caps.length?'':'Waiting for capacity readings'});
            caps.forEach(p=>cv.circle(chart.X((p.t-minT)/day),chart.Y(p.kwh),4,p.source==='learned'?GO:'#2a8cff'));
            cv.text('Capacity estimates vary with conditions; this is not a health score.',48,488+ex,20,t.dim);
            G.panel(cv,t,1008,44,568,468,'Battery observations');
            row(cv,t,1032,520,138,'LATEST CAPACITY',last ? num(last.kwh,1,'kWh'):'--');
            row(cv,t,1032,520,193,'RECORDED',last ? shortDate(last.t)+' · '+last.source:'--');
            row(cv,t,1032,520,248,'PACK TEMP RANGE',latestDay && G.isNum(latestDay.minTemp) ? num(T(latestDay.minTemp),0,'')+' - '+num(T(latestDay.maxTemp),0,tU()):'--');
            row(cv,t,1032,520,303,'MAX CELL SPREAD',latestDay ? num(latestDay.spread,0,'mV'):'--');
            const recent=days.slice(-14), minDay=recent.length ? recent[0].day : Math.floor(now/day)-13;
            const top=Math.max(20,Math.ceil(Math.max(...recent.map(p=>p.spread || 0),0)/10)*10);
            cv.text('DAILY MAX CELL SPREAD',1032,352,18,t.dim,{font:'bold'});
            const cellPoints=recent.filter(p=>G.isNum(p.spread)).map(p=>[p.day-minDay,p.spread]);
            const cellChart=G.chart(cv,t,1032,365,520,106+ex,{xMin:0,xMax:Math.max(1,recent.length ? recent[recent.length-1].day-minDay:13),
                yMin:0,yMax:top,yUnit:'mV',xFmt:v=>shortDate((minDay+v)*day),
                series:[{pts:cellPoints,color:t.text}],empty:cellPoints.length ? '' : 'No cell readings yet'});
            cellPoints.forEach(p=>cv.circle(cellChart.X(p[0]),cellChart.Y(p[1]),3,t.text));
            cv.text(latestDay ? shortDate(latestDay.t)+' · spread at '+num(latestDay.soc,0,'%') : 'Temperature and charge level affect cell spread.',1032,494+ex,18,t.dim);
        }

        function render() {
            const t = ctx.theme();
            let d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const pg = pages();
            if (page >= pg.length) { page = 0; actionLabel(); }
            if (isLive(pg[page])) {
                const own = d;
                d = lv.draw(pg[page], cv, t);
                if (pg[page] === 'battery') renderHealth(cv, t, own, 24, 44, 560, 468);
            }
            else if (pg[page] === 'diag') renderDiagAll(cv, t, d);
            else if (pg[page] === 'energy') renderEnergy(cv, t, d);
            else if (pg[page] === 'log') renderLog(cv, t, d);
            else if (pg[page] === 'charging') renderCharging(cv, t, d);
            else if (pg[page] === 'journeys') renderJourneys(cv, t, d);
            else if (pg[page] === 'lab') renderChargeLab(cv, t, d);
            else if (pg[page] === 'trends') renderTrends(cv, t, d);
            else renderMain(cv, t, d);
            header(cv, t, d);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 2 fps in software (PNG frames)
        ctx.loop('MAIN', 2, render);
        settings.onChange((k) => {
            if (k === 'demo') {
                capacityLearner.anchor = null; capacityLearner.candidate = null;
                seg.valid = false; insights.breakContinuity();
            }
            if (k === 'poll') schedule();
            if (k === 'diagPage') actionLabel();

        });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
