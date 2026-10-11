/* global fetch, setTimeout, sessionStorage, localStorage, location, URL, console */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture } from './fixture-data.mjs';

// Legacy visual baseline. Uses the same synthetic fixture as modern screenshots.
// Not a live-backend, UDP protocol, or complete interaction-parity test.
const root=fileURLToPath(new URL('../../frontend/',import.meta.url));
const artifacts=fileURLToPath(new URL('./artifacts/',import.meta.url));
const server=spawn('python3',['-m','http.server','5175','--bind','127.0.0.1','--directory',root],{stdio:'ignore'});
const report={synthetic:true,legacy:true,images:[],warnings:[],errors:[]};
let browser;
try{
 let ready=false;
 for(let i=0;i<80;i++){
   try {const r=await fetch('http://127.0.0.1:5175/');if(r.ok){ready=true;break;}}catch{ /* static fixture server is starting */ }
   await new Promise(ok=>setTimeout(ok,250));
 }
 if(!ready)throw Error('Legacy static fixture server did not start');
 browser=await chromium.launch({headless:true});
 for(const theme of ['light','dark']){
  for(const width of [390,768,1024,1440]){
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
   await context.addInitScript(value=>{
    sessionStorage.setItem('snmp_token','synthetic-fixture-token');
    sessionStorage.setItem('snmp_username','Fixture operator');
    localStorage.setItem('trishul_theme',value);
   },theme);
   const page=await context.newPage();
   page.on('pageerror',error=>report.errors.push({theme,width,message:error.message}));
   await page.routeWebSocket('**/api/ws*',ws=>ws.onMessage(message=>{if(message==='ping')ws.send('pong');}));
   await page.route('**/api/**',async route=>{
    const u=new URL(route.request().url());
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixture(u.pathname))});
   });
   await page.goto('http://127.0.0.1:5175/#dashboard',{waitUntil:'domcontentloaded'});
   await page.locator('#wrapper').waitFor({state:'visible',timeout:12000});
   for(const workspace of ['dashboard','simulator','walker','traps','browser','mibs','settings']){
     await page.evaluate(value=>{location.hash='#'+value;},workspace);
     await page.waitForTimeout(600);
     const name='legacy-'+theme+'-'+width+'-'+workspace+'.png';
     await page.screenshot({path:join(artifacts,name),fullPage:true,animations:'disabled'});
     report.images.push({theme,width,workspace,name,heading:await page.locator('#page-title').textContent()});
   }
   await context.close();
  }
 }
}finally{
 writeFileSync(join(artifacts,'legacy-manifest.json'),JSON.stringify(report,null,2));
 if(browser)await browser.close();
 server.kill('SIGTERM');
 console.log('Legacy captures:',report.images.length,'JS exceptions:',report.errors.length);
}
