'use strict';

// iXDrive's saved state against stubbed kit modules (mgu, the diagnostic link) and a clock moved by hand: the charge
// log across restarts (main.js) and what live.js learns and keeps. No SDK, vehicle or capture needed:
//   node kit/tools/test_ixdrive.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'ixdrive', 'main.js'), LIVE = path.join(ROOT, 'apps', 'ixdrive', 'live.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'ixdrive', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

// the clock, and timers that only run when a test fires them
let now = Date.UTC(2026, 9, 1, 18);
Date.now = () => now;
let timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
global.clearTimeout = (t) => { timers = timers.filter((x) => x !== t); };
global.setInterval = () => 0;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const fire = async (pred) => {
    const t = timers.filter((x) => pred(x.ms)).pop();
    assert(t, 'timer scheduled');
    timers = timers.filter((x) => x !== t);
    t.fn(); await flush();
};

// the kit modules: './kit/x' from kit/runtime, the SDK-bound ones stubbed
let app = null, diag = null, reader = null, values = {};
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; diag = this; } init() {} }
// the battery unit's values by name; other units (the 48 V battery, the converter, the engine unit's 12 V
// sensor) answer `replies` by '<ecu>:<DID>' (the data after the DID, hex), through the real reader
let replies = {}, asked = [];
const RealReader = require(path.join(KIT, 'dids')).DidReader;
class FakeReader extends RealReader {
    constructor() {
        super({ physical: async (ecu, sid, req) => {
            asked.push({ ecu, sid, req: req.slice() });
            // OBD service 01 ('<ecu>:OBD <PID>'); 'NRC xx': the unit refuses
            if (sid === 0x01) {
                const o = replies[ecu + ':OBD ' + req[0].toString(16).toUpperCase().padStart(2, '0')];
                return !o ? null : /^NRC/.test(o) ? [0x7F, sid, parseInt(o.slice(4), 16)] : [0x41, req[0]].concat(o.split(' ').map((x) => parseInt(x, 16)));
            }
            const did = ((req[0] << 8) | req[1]).toString(16).toUpperCase().padStart(4, '0'), r = replies[ecu + ':' + did];
            if (r && /^NRC/.test(r)) return [0x7F, sid, parseInt(r.slice(4), 16)];
            if (r) return [0x62, req[0], req[1]].concat(r.split(' ').map((x) => parseInt(x, 16)));
            // the 12 V voltage (vals.v12): the engine unit's control module voltage (F442, 1 mV)
            if (ecu === 18 && did === 'F442' && typeof values.v12 === 'number') return [0x62, 0xF4, 0x42, Math.round(values.v12 * 1000) >> 8, Math.round(values.v12 * 1000) & 0xFF];
            // the battery unit (0x07) is there while the test gives it a charge value (null: no reading now)
            if (ecu === 7 && values.soc !== undefined) {
                return did === 'DDBC' && typeof values.soc === 'number' ? [0x62, req[0], req[1], (values.soc * 10) >> 8, (values.soc * 10) & 0xFF] : [0x7F, sid, 0x31];
            }
            return null;
        } }, { ecu: 7 });
        reader = this;
    }
    async value(key, list) {
        if (!(list || []).length) return null;
        if (values[key] === undefined && (list || []).some((c) => c.ecu != null && c.ecu !== 7)) return super.value(key, list);
        if (values[key] === undefined) (list || []).forEach((c) => { this.raws[this.key(c)] = { why: 'no reply', bytes: '' }; });
        return values[key] === undefined ? null : values[key];
    }
}
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex },
    './kit/dids': { DidReader: FakeReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

const dirs = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ixdrive-' + name + '-')); dirs.push(d); return d; };
const quiet = { info() {}, warn() {}, error() {} };
function context(dir, set) {
    const defaults = {};
    SPEC.settings.forEach((s) => { defaults[s.key] = s.default; });
    const changes = [];
    const S = Object.assign(defaults, { demo: 'off' }, set || {});
    const clicks = {}, texts = [], watchers = {};
    return {
        clicks, texts, watchers, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange(fn) { changes.push(fn); }, set(k, v) { S[k] = v; changes.forEach(fn => fn(k)); } },
        log: quiet, spec: SPEC, dataDir: dir,
        signals: { watch: (iface, ver, handlers) => { Object.assign(watchers, handlers); return Promise.resolve({}); } },
        onTab() {}, hideButton() {}, onScroll() {}, loop(name, fps, fn) { this.frame = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            cv.text = (str, x, y, size, color, opts) => {
                const width = text(str, x, y, size, color, opts);
                texts.push({ str: String(str), x, y, width });
                return width;
            };
            return cv;
        },
    };
}

/**
 * One start of iXDrive (a fresh process): the battery unit answers `vals`; read() is one poll, readNow() the
 * "Read now" button (the health read too), exit() the process exiting (its exit handlers only: kept off this process's)
 */
async function boot(dir, vals, set) {
    [MAIN, LIVE, path.join(ROOT, 'apps', 'ixdrive', 'range.js')].forEach((f) => { delete require.cache[f]; });
    require(MAIN);
    values = vals; timers = [];
    const ctx = context(dir, set), before = process.listeners('exit');
    await app.start(ctx);
    const onExit = process.listeners('exit').filter((f) => before.indexOf(f) < 0);
    onExit.forEach((f) => process.removeListener('exit', f));
    await flush();
    return {
        texts: ctx.texts, reader, set: (k,v) => ctx.settings.set(k,v),
        page: async () => { await ctx.clicks.BTN_PAGE(); await flush(); },
        read: async () => { diag.available = true; diag.emit('available', true); await flush(); },
        readNow: async () => { diag.available = true; ctx.clicks.BTN_READ(); await flush(); },
        draw: async () => { ctx.texts.length = 0; await ctx.frame(); return ctx.texts.map((x) => x.str); },
        drive: (kmh) => ctx.watchers.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh / 0.015625 }),
        signal: (name, v) => ctx.watchers[name](v),
        exit: () => onExit.forEach((f) => f(0)),
    };
}
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'battery.json'), 'utf8'));

/** iXDrive Live (live.js) on its own, with iXDrive's live values L; the battery unit answers `vals` by DID. */
function startLive(dir, L, vals, config) {
    delete require.cache[LIVE];
    timers = [];
    const raws = {};
    const reader = {
        raws, key: (p) => p.did,
        async read(p) {
            const v = vals[p.did];
            if (v === undefined) return null;
            raws[p.did] = { bytes: '62 ' + p.did.slice(0, 2) + ' ' + p.did.slice(2) + ' 00 00' };
            return v;
        },
    };
    const ctx = context(dir);
    ctx.spec = { config: Object.assign({ battery: { fast: { hvV: [{ did: 'DD68', fields: { v: {} } }], hvI: [{ did: 'DD69', fields: { a: {} } }] }, slow: {} } }, config || {}) };
    const exclusive = (fn) => fn();
    return require(LIVE)(ctx, { diag: { available: true, on() {}, physical: async () => null }, reader, exclusive, live: L, page: () => 'main', climateKw: () => 0 });
}
const power = () => fire((ms) => ms === 60 || ms === 2000);
const liveState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')); } catch (e) { return {}; } };
const L0 = () => ({ speed: 0, speedT: now, climate: false, seats: {}, wheel: false, standSince: now - 60000, blower: 0, blowerTop: 8, ambient: 10 });

const { normalizeSoc, createActivity, chargeEstimate, CapacityLearner, powerScale } = require('../../apps/ixdrive/ev');
const { RangeModel } = require('../../apps/ixdrive/range');
const checks = [
    ['independent BEV identity and defaults', async () => {
        assert.strictEqual(SPEC.id, 'ixdrive');
        assert.strictEqual(SPEC.title, 'iXDrive');
        assert.strictEqual(SPEC.startWidget.name, 'iXDrive');
        const settings = Object.fromEntries(SPEC.settings.map(s => [s.key, s.default]));
        for (const k of ['designKwh','gaugeKw','range20','model']) assert(!(k in settings), k + ' must be automatic');
        assert.strictEqual(settings.reserve, '0');
        assert.strictEqual(settings.demo, 'off');
        assert(!('hybrid' in settings));
        assert(!SPEC.signals['de.bmw.infotainment.vehicle.CDS']);
        assert.deepStrictEqual(SPEC.config.battery.soh, [], 'no unverified SOH decoder');
        assert(SPEC.config.battery.v12.every(c => c.ecu === 7), 'no engine or transmission queries');
    }],
    ['driving learns without RPM, including below 11 percent', async () => {
        for (const initial of [80, 10]) {
            const dir = tmp('learn'), b = await boot(dir, { soc: initial });
            await b.read();
            for (let i = 0; i < 30; i++) { now += 1000; b.drive(60); }
            values.soc = initial - 0.2;
            await b.read(); b.exit();
            assert(state(dir).totalUse.km > 0.45, 'fresh speed and SOC teach range without an engine');
            const text = await b.draw();
            assert(!text.some(s => /HYBRID|engine|held at/i.test(s)), text.join(' | '));
            assert(text.includes(initial <= 10 ? 'LOW BATTERY' : 'To 0% displayed charge'));
        }
    }],
    ['low SOC range and configurable arrival reserve', async () => {
        for (const reserve of ['0', '10']) {
            const dir = tmp('reserve');
            const first = await boot(dir, {soc:10}, {reserve}); await first.read(); first.exit();
            const st = state(dir); st.totalUse = {km:60,pct:15};
            fs.writeFileSync(path.join(dir,'battery.json'),JSON.stringify(st));
            const b = await boot(dir, { soc: 10 }, { reserve });
            b.signal('ExteriorTemperature', {temperatureExterior: 120}); // 20 C
            await b.read(); await b.draw();
            const range = b.texts.find(t => t.x === 48 && t.y === 196);
            assert.strictEqual(range.str, reserve === '0' ? '40' : '0');
            assert(!b.texts.some(t => /HYBRID|engine|held at/i.test(t.str)));
        }
    }],
    ['missing speed does not teach range; missing battery stays EV', async () => {
        const dir = tmp('missing'), b = await boot(dir, { soc: 80 });
        await b.read(); now += 30000; values.soc = 79;
        await b.read(); b.exit();
        assert(!state(dir).learn && !state(dir).totalUse);
        const noBattery = await boot(tmp('absent'), {});
        for (let i = 0; i < 8; i++) { now += 20000; await noBattery.read(); }
        const text = await noBattery.draw();
        assert(text.includes('RANGE') && text.includes('CHARGING'));
        assert(!text.some(s => /ALTERNATOR|HYBRID|DEMO/.test(s)));
    }],
    ['efficient EV consumption is valid across battery sizes', async () => {
        for (const capacity of [33,74,110]) {
            const rate = 0.14 / (capacity / 100);
            const model = new RangeModel({learn:{km:60,pct:60*rate}}, () => capacity / 100);
            assert(Math.abs(model.drivePctPerKm(60) - rate) < 1e-9);
            assert(model.range(10, 20, capacity/100, false, 60, 0).mid > 0);
        }
        assert.strictEqual(new RangeModel({learn:{km:60,pct:0.1}}).drivePctPerKm(60), null);
    }],
    ['charge logged once across sleep; unknown energy stays unavailable', async () => {
        const dir = tmp('charge');
        let b = await boot(dir, {soc:20}); await b.read(); b.exit();
        now += 8*3600000;
        b = await boot(dir, {soc:80}); await b.read(); b.exit();
        now += 30000;
        b = await boot(dir, {soc:80}); b.drive(30); await b.read(); b.exit();
        const log = state(dir).log;
        assert.strictEqual(log.length,1);
        assert.strictEqual(log[0].kwh, null);
        await b.page(); await b.page(); await b.page(); await b.page();
        assert((await b.draw()).includes('--'));
        now += 30000;
        b = await boot(dir, {soc:79.8}); b.drive(30); await b.read();
        assert.strictEqual(state(dir).log.length,1);
    }],
    ['regen while moving is not a charging session', async () => {
        const dir = tmp('regen'), b = await boot(dir, {soc:50});
        b.drive(40); await b.read(); now += 1000;
        b.drive(40); values.soc = 52; await b.read(); b.exit();
        assert(!state(dir).session && !state(dir).log);
    }],
    ['SOC mapping and charging estimates reject unavailable values', async () => {
        assert.strictEqual(normalizeSoc(50, {empty:10,full:90}), 50);
        assert.strictEqual(normalizeSoc(10, {empty:10,full:90}), 0);
        assert.strictEqual(normalizeSoc(90, {empty:10,full:90}), 100);
        for (const v of [null, undefined, NaN, -1, 101]) assert.strictEqual(normalizeSoc(v), null);
        assert.strictEqual(normalizeSoc(50, {empty:90,full:10}), null);
        const c = chargeEstimate(20,80,.74,-74,0);
        assert(Math.abs(c.remaining - 44.4)<1e-9 && Math.abs(c.minutes-36)<1e-9);
        assert.strictEqual(chargeEstimate(20,80,.74,-74,40).minutes,null, 'regen is not plugged-in charging');
        assert.strictEqual(chargeEstimate(20,80,.74,-74,null).minutes,null);
        assert.strictEqual(chargeEstimate(20,80,.74,null,0).minutes,null);
        assert.strictEqual(chargeEstimate(null,80,.74,-74,0),null);
        assert.strictEqual(chargeEstimate(85,80,.74,-74,0).remaining,0);
    }],
    ['all diagnostics pause parked and resume on interaction', async () => {
        const dir = tmp('sleep'), b = await boot(dir, {soc:50});
        await b.read(); const stamp = state(dir).lastSocT;
        now += 11*60000; values.soc = 60; asked = [];
        await b.read();
        assert.strictEqual(state(dir).lastSocT, stamp);
        assert.strictEqual(asked.length,0);
        await b.readNow();
        assert.strictEqual(state(dir).lastSoc,60);
        let at=0; const a=createActivity(() => at);
        at=11*60000; assert(!a.active());
        a.observe(50); assert(a.active());
        at+=3*60000; assert(!a.active(),'stale speed must not hold car awake');
        a.touch(); assert(a.active());
    }],
    ['live energy counts regen separately from charging without RPM', async () => {
        const dir=tmp('live'), L=Object.assign(L0(),{speed:50});
        const vals={DD68:400,DD69:-50};
        const lv=startLive(dir,L,vals);
        for(let i=0;i<4;i++){now+=2000;L.speedT=now;await power();}
        assert(lv.consumption().km>0);
        const before=lv.consumption().km;
        L.speed=0; vals.DD69=100;
        for(let i=0;i<4;i++){now+=2000;L.speedT=now;await power();}
        assert.strictEqual(lv.consumption().km,before, 'plugged-in energy does not train driving');
        now+=16000;
        assert.strictEqual(lv.powerNow(themes.theme('ice')).kw,null,'stale power expires');
    }],
    ['capacity learns from two consistent windows and expires', async () => {
        for (const capacity of [64.7, 74, 105.2]) {
            const st = {}, learner = new CapacityLearner(st);
            const sample = (soc, kwh, epoch = 1) => learner.observe(soc, {kwh, epoch, t:now}, now);
            sample(80,0); sample(75,capacity*.05);
            assert.strictEqual(learner.value(now), null);
            sample(70,capacity*.10);
            assert(Math.abs(learner.value(now)-capacity)<1e-9);
            assert.strictEqual(new CapacityLearner(st).value(now), learner.value(now));
            assert.strictEqual(learner.value(now+31*86400000), null);
        }
    }],
    ['capacity rejects gaps, disagreement, charging and restart fragments', async () => {
        for (const event of ['gap','charge','restart','stale','disagree']) {
            const st = {}; let l = new CapacityLearner(st);
            const obs = (soc,kwh,epoch=1,t=now) => l.observe(soc,{kwh,epoch,t},now);
            obs(80,0); obs(75,3.7);
            if(event==='gap') {obs(73,4,2);obs(68,7.7,2);}
            if(event==='charge') {obs(85,3);obs(80,6.7);}
            if(event==='restart') {l=new CapacityLearner(st);obs(70,7.4);}
            if(event==='stale') {obs(72,5,1,now-6000);obs(70,7.4);}
            if(event==='disagree') obs(70,9);
            assert.strictEqual(l.value(now),null,event);
        }
        const l=new CapacityLearner({});
        for(const soc of [null,NaN,-1,101]) l.observe(soc,{kwh:0,t:now,epoch:1},now);
        assert.strictEqual(l.anchor,null);
    }],
    ['power scale follows limits and never clips observed power', async () => {
        assert.deepStrictEqual(powerScale({out:210,in:150},200,0,0), {out:225,in:150,outLimit:210,inLimit:150});
        for(const kw of [210,230,385,455,500]) assert(powerScale(null,kw,0,0).out>=kw);
        assert(powerScale(null,-160,0,0).in>=160);
        assert.strictEqual(powerScale(null,null,210,70).out,225);
        assert.strictEqual(powerScale(null,null,0,0).outLimit,null);
    }],
    ['range learns without capacity; insufficient driving stays unknown', async () => {
        const st={}, m=new RangeModel(st);
        assert.strictEqual(m.range(10,20,null,false,60,0),null);
        m.learn(2.5,10/60,10,20,null,false,0);
        assert.strictEqual(m.range(10,20,null,false,60,0).mid,40);
        assert.strictEqual(m.range(0,20,null,false,60,0).mid,0);
        assert.strictEqual(m.auxRate(20,null,false).rate,null);
        m.learn(.5,1/60,0,20,null,false,0);
        assert(Math.abs(m.range(10,20,null,false,60,0).mid-100/3)<1e-9, 'traffic energy included');
        m.learn(1,10/60,0,20,null,false,0);
        assert.strictEqual(st.totalUse.pct,3, 'parked draw excluded');
    }],
    ['energy meter integrates power and breaks on charging or missing data', async () => {
        const L=Object.assign(L0(),{speed:50}), vals={DD68:400,DD69:-50};
        const lv=startLive(tmp('meter'),L,vals);
        now+=2000; L.speedT=now; await power();
        const initial=lv.energySample();
        now+=2000; L.speedT=now; await power();
        const next=lv.energySample();
        assert.strictEqual(next.epoch,initial.epoch);
        assert(Math.abs(next.kwh-initial.kwh-20*2/3600)<1e-9);
        now+=8000; L.speedT=now; await power();
        const gap=lv.energySample(); assert(gap.epoch>next.epoch); assert.strictEqual(gap.kwh,0);
        L.speed=0; vals.DD69=100; now+=2000;L.speedT=now;await power();
        assert(lv.energySample().epoch>gap.epoch);
        assert.strictEqual(lv.energySample().kwh,0);
    }],
    ['reported capacity hook is optional and does not assume battery health', async () => {
        const cfg=SPEC.config.battery;
        cfg.capacity=[{did:'TEST',bytes:2,factor:.1}];
        try {
            const b=await boot(tmp('reported'),{soc:20,capacity:74});
            await b.read(); await b.page(); await b.page(); await b.page();
            const texts=await b.draw();
            assert(texts.includes('74.0 kWh'));
            assert(texts.includes('Capacity source: reported'));
            assert(texts.includes('~44.4 kWh'));
        } finally {cfg.capacity=[];}
    }],
    ['dashboard trip uses matched samples, excludes charging and resets', async () => {
        const L=Object.assign(L0(),{speed:60}), vals={DD68:400,DD69:-50};
        const lv=startLive(tmp('trip-summary'),L,vals);
        assert.strictEqual(lv.dashboard().net,null);
        assert.strictEqual(lv.dashboard().km,null);
        for(let i=0;i<40;i++){now+=2000;L.speedT=now;await power();}
        const trip=lv.dashboard();
        assert(Math.abs(trip.km-60*78/3600)<1e-9);
        assert(Math.abs(trip.perKm-20/60)<1e-9);
        assert(Math.abs(trip.minutes-78/60)<1e-9);
        now+=10000;L.speedT=now;await power();
        assert.strictEqual(lv.dashboard().km,trip.km,'missing intervals excluded');
        L.speed=0;vals.DD69=100;
        now+=2000;L.speedT=now;await power();
        assert.strictEqual(lv.dashboard().perKm,trip.perKm,'charging excluded');
        assert.strictEqual(lv.dashboard().net,trip.net,'charging is not regen');
        lv.action('battery');
        assert.strictEqual(lv.dashboard().km,null);
        assert.strictEqual(lv.dashboard().net,null);
        assert.strictEqual(lv.dashboard().perKm,null);
    }],
    ['dashboard keeps regenerated energy and unit conversions accurate', async () => {
        const L=Object.assign(L0(),{speed:60}),vals={DD68:400,DD69:50};
        const lv=startLive(tmp('downhill'),L,vals);
        for(let i=0;i<40;i++){now+=2000;L.speedT=now;await power();}
        assert(lv.dashboard().regen>0);
        assert(lv.dashboard().net<0);
        assert(lv.consumption().perKm<0,'net downhill consumption is not clamped positive');
        const b=await boot(tmp('imperial'),{},{demo:'on',distUnit:'mi',tempUnit:'f'});
        const text=await b.draw();
        assert(text.includes('kWh/100 mi'));
        assert(text.includes('27.0'),'16.8 kWh/100km converts to 27.0 kWh/100mi');
        assert(text.includes('7.7'),'12.4 km converts to 7.7 mi');
        assert(text.includes('77 °F'));
    }],
    ['live samples persist journey and charging histories for the new pages', async () => {
        const dir=tmp('insights-wire');
        replies={'7:DDB4':'9C 40','7:DD69':'FF FF EC 78'};
        try {
            const b=await boot(dir,{soc:60});await b.read();
            for(let i=0;i<40;i++){now+=2000;b.drive(60);await power();}
            b.exit();assert(state(dir).insights.journey.km>1);
            for(let i=0;i<5;i++)await b.page();
            const journeyText=await b.draw();assert(journeyText.includes('LIVE'));
            replies['7:DD69']='00 00 17 70';
            for(let i=0;i<20;i++){now+=2000;b.drive(0);if(i===0)await b.read();await power();}
            b.exit();
            const h=state(dir).insights;
            assert.strictEqual(h.journeys.length,1);
            assert(h.charge.kwh>0 && h.charge.points.length>0);
            await b.page();const lab=await b.draw();
            assert(lab.includes('LIVE SESSION'));assert(lab.includes('24 kW'));
        } finally {replies={};}
    }],
    ['history pages browse older records through the HMI action', async () => {
        const b=await boot(tmp('history-browse'),{},{demo:'on'});
        for(let i=0;i<5;i++)await b.page();
        assert((await b.draw()).includes('1 - 7 / 12'));
        await b.readNow();assert((await b.draw()).includes('8 - 12 / 12'));
        await b.page();assert((await b.draw()).includes('130 kW'));
        await b.readNow();assert((await b.draw()).includes('145 kW'));
    }],
    ['demo insights never write synthetic history', async () => {
        const dir=tmp('demo-insights'),b=await boot(dir,{soc:60},{demo:'on'});
        for(let i=0;i<9;i++){await b.draw();await b.page();}
        b.exit();
        const file=path.join(dir,'battery.json');
        if(fs.existsSync(file)) {
            const h=state(dir).insights;
            assert(!h.journeys.length && !h.charges.length && !h.capacities.length && !h.days.length);
        }
    }],
    ['every page renders with missing telemetry and demo data', async () => {
        for(const demo of ['off','on']) {
            const b=await boot(tmp('pages'),{},{demo,diagPage:true});
            for(let i=0;i<9;i++){
                const texts=await b.draw();
                assert(texts.length>0);
                assert(!texts.some(s=>/NaN|Infinity|ENGINE|HYBRID|ALTERNATOR/.test(s)),texts.join(' | '));
                await b.page();
            }
        }
    }],
];
(async () => {
    let failures=0;
    for(const [name,fn] of checks) {
        try { await fn(); console.log('PASS '+name); }
        catch(e) { failures++; console.error('FAIL '+name+': '+e.stack); }
    }
    dirs.forEach(d=>fs.rmSync(d,{recursive:true,force:true}));
    process.exit(failures ? 1 : 0);
})();
