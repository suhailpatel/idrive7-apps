'use strict';
const assert = require('assert');
const { Insights, journeyStats } = require('../../apps/ixdrive/insights');
const DAY=86400000, T=Date.UTC(2026,10,8);
const checks=[];
const test=(name,run)=>checks.push([name,run]);
const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-8,actual+' != '+expected);
const point=(t,kw=18,speed=60,soc=60)=>({t,kw,speed,soc,temp:24,ambient:10});
function drive(h,start=T,seconds=60,kw=18) {
    for(let s=0;s<=seconds;s+=2) h.observe(point(start+s*1000,kw));
}
test('journeys integrate observed speed, energy, regen and temperature',()=>{
    const st={},h=new Insights(st,'a'); drive(h);
    near(st.journey.km,1);near(st.journey.kwh,.3);near(st.journey.seconds,60);
    near(journeyStats([st.journey]).ambient,10);
    h.observe(point(T+62000,-18)); h.observe(point(T+64000,-18));
    assert(st.journey.regen>0);assert(!st.charge);
    h.tick(T+400000);
    assert.strictEqual(st.journeys.length,1);assert(!st.journey);
    assert(st.journeys[0].partial,'missing end of trip marked partial');
});
test('parking closes once and restart cannot double-count or bridge gaps',()=>{
    const st={},h=new Insights(st,'a');drive(h);
    const restored=JSON.parse(JSON.stringify(st)),r=new Insights(restored,'a');
    r.observe(point(T+70000));
    near(restored.journey.km,1);assert(restored.journey.partial);
    for(let s=72;s<=372;s+=2) r.observe(point(T+s*1000,1,0));
    assert.strictEqual(restored.journeys.length,1);assert(!restored.journey);
    r.tick(T+800000);assert.strictEqual(restored.journeys.length,1);
    r.observe(point(T+900000));r.observe(point(T+902000));
    near(restored.journey.km,60*2/3600);
});
test('charging excludes regen and compares continuous segments only',()=>{
    const st={},h=new Insights(st,'a');
    for(let s=0;s<=60;s+=2) h.observe(point(T+s*1000,-60,0,20+s/60));
    near(st.charge.kwh,1);near(st.charge.seconds,60);
    assert.strictEqual(st.charge.peak,60);assert(!st.journey);
    h.observe(point(T+90000,-60,0,22));
    near(st.charge.kwh,1);assert(st.charge.partial);
    const p=st.charge.points;
    assert(p[p.length-1].segment!==p[p.length-2].segment);
    h.observe(point(T+92000,10,30));
    assert.strictEqual(st.charges.length,1);assert(!st.charge);
    near(st.charges[0].kwh,1);
});
test('short pauses split curves without inventing energy; missing SOC stays null',()=>{
    const st={},h=new Insights(st,'a');
    for(let s=0;s<=40;s+=2) h.observe(point(T+s*1000,-30,0,null));
    const energy=st.charge.kwh,segment=st.charge.points[st.charge.points.length-1].segment;
    h.observe(point(T+42000,0,0,null));h.observe(point(T+44000,-30,0,null));
    near(st.charge.kwh,energy);
    assert.strictEqual(st.charge.from,null);
    assert(st.charge.points[st.charge.points.length-1].segment>segment);
    for(let s=46;s<=166;s+=2)h.observe(point(T+s*1000,0,0,null));
    assert.strictEqual(st.charges.length,1);
});
test('capacity readings retain source, freshness and daily aggregation',()=>{
    const st={},h=new Insights(st,'a');
    h.battery({t:T,temp:20,spread:15,soc:60,capacity:74,capacityT:T,source:'learned'});
    h.battery({t:T+1000,temp:25,spread:12,soc:50,capacity:74,capacityT:T,source:'learned'});
    assert.strictEqual(st.capacities.length,1);
    h.battery({t:T+2000,temp:18,spread:22,soc:40,capacity:73.5,capacityT:T+2000,source:'reported'});
    assert.strictEqual(st.capacities.length,2);
    assert.deepStrictEqual(st.capacities.map(p=>p.source),['learned','reported']);
    assert.strictEqual(st.days.length,1);assert.strictEqual(st.days[0].minTemp,18);
    assert.strictEqual(st.days[0].maxTemp,25);assert.strictEqual(st.days[0].spread,22);
    assert.strictEqual(st.days[0].soc,40);
    h.battery({t:T+DAY,capacity:73.5,capacityT:T,source:'reported'});
    assert.strictEqual(st.capacities.length,2,'cached estimates do not create new history');
    h.battery({t:T+DAY,capacity:null,temp:null,spread:null});
    assert.strictEqual(st.days.length,1,'missing data does not create zero readings');
});
test('decoder changes retain records but separate incompatible histories',()=>{
    const st={},h=new Insights(st,'a');drive(h);
    h.battery({t:T,capacity:74,capacityT:T,source:'learned'});
    const r=new Insights(st,'b');
    assert.strictEqual(st.journeys.length,1);assert(st.journeys[0].partial);
    assert.strictEqual(st.era,1);assert.strictEqual(st.capacities[0].era,0);
    r.battery({t:T+DAY,capacity:70,capacityT:T+DAY,source:'learned'});
    assert.strictEqual(st.capacities[1].era,1);
});
test('saved history stays bounded',()=>{
    const st={},h=new Insights(st,'a');
    for(let i=0;i<400;i++) {
        drive(h,T+i*DAY,8);h.closeJourney();
        h.battery({t:T+i*DAY,capacity:74,capacityT:T+i*DAY,source:'learned',temp:20,spread:20});
    }
    assert.strictEqual(st.journeys.length,200);assert.strictEqual(st.days.length,365);
    assert.strictEqual(st.capacities.length,365);
    for(let i=0;i<25;i++) {
        const t=T+(500+i)*DAY;
        for(let s=0;s<=40;s+=2)h.observe(point(t+s*1000,-20,0,30));
        h.closeCharge();
    }
    assert.strictEqual(st.charges.length,20);
    for(let i=0;i<600;i++)h.observe(point(T+600*DAY+i*30000,-20,0,30));
    assert(st.charge.points.length<=240);
});
test('weekly averages use distance weighting',()=>{
    const s=journeyStats([{km:10,kwh:1,ambientSum:0,ambientN:0},{km:90,kwh:27,ambientSum:0,ambientN:0}]);
    near(s.perKm,.28);assert.strictEqual(s.ambient,null);
    assert.strictEqual(journeyStats([]).perKm,null);
});
let failures=0;
for(const [name,run] of checks)try{run();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.stack);}
process.exitCode=failures?1:0;
