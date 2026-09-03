const assert=require('assert'); const h=require('../src/httpHandler'); const router=require('../src/router');
(async()=>{
  const token=Buffer.from(JSON.stringify({sub:'n'})).toString('base64');
  // 1. a TypeError inside route -> catch-all -> recorded with stack
  const orig=router.route; router.route=async()=>{ let u; return u.x; };
  await h.handleCaptain({method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({text:'what 22-11'}),env:{CAPTAIN_DEV_SESSION:'1'}});
  router.route=orig;
  // 2. a DB connect failure -> recorded, secrets scrubbed
  await h.handleCaptain({method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({text:'fueleu penalty for STI ROTHERHITHE this year'}),env:{CAPTAIN_DEV_SESSION:'1',CAPTAIN_ENABLE_LLM:'0',CAPTAIN_READ_URL:'postgresql://postgres.abc:Secret%40123@nowhere.invalid:5432/postgres',CAPTAIN_PG_CONNECT_TIMEOUT_MS:'2000'}});
  const health=JSON.parse((await h.handleCaptain({method:'GET',headers:{},env:{CAPTAIN_DEV_SESSION:'1'}})).body);
  assert.ok(Array.isArray(health.recentErrors)&&health.recentErrors.length>=2);
  const s=JSON.stringify(health.recentErrors);
  assert.ok(/TypeError/.test(s)&&/Cannot read properties of undefined/.test(s));
  assert.ok(!/Secret%40123/.test(s)&&!/Secret@123/.test(s),'password must never appear: '+s);
  assert.ok(/database connect/.test(s));
  // 3. NOT exposed outside prototype mode
  const prod=JSON.parse((await h.handleCaptain({method:'GET',headers:{},env:{}})).body);
  assert.strictEqual(prod.recentErrors,undefined);
  console.log('recentErrors buffer: OK'); console.log(JSON.stringify(health.recentErrors[0]).slice(0,200)); process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1);});