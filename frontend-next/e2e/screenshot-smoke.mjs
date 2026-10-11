/* global URL, process, fetch, setTimeout, sessionStorage, localStorage, document, innerWidth, console */
// Browser-only preview fixture smoke. Mock REST/WS data are deliberately synthetic.
// Never interpret these screenshots as validation against a live SNMP backend.
import { chromium } from 'playwright';
import { fixture } from './fixture-data.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const workdir = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(workdir, 'e2e/artifacts');
mkdirSync(artifacts, { recursive: true });
const baseUrl = 'http://127.0.0.1:5174/next/';
const routes = [
  ['dashboard', ''], ['simulator', 'simulator'], ['walker', 'walker'],
  ['traps', 'traps'], ['browser', 'browser'], ['mibs', 'mibs'], ['settings', 'settings'],
];
const screenWidths = [390, 768, 1024, 1440];

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {cwd:workdir,stdio:'pipe'});
let serverOutput='';
server.stdout.on('data', data => { serverOutput+=String(data).slice(-500); });
server.stderr.on('data', data => { serverOutput+=String(data).slice(-500); });
let browser;
const report = { fixture: true, browser:'Chromium (Playwright)', collectedAt:new Date().toISOString(), routes: [], errors: [] };
try {
  let ready = false;
  for(let attempt=0;attempt<80;attempt++){
    try { const response=await fetch(baseUrl); if(response.ok){ ready=true; break; } } catch { /* Vite is still starting. */ }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready) throw Error('Vite preview failed to start: '+serverOutput);
  browser = await chromium.launch({headless:true});
  report.browserVersion = browser.version();
  for(const theme of ['light','dark']){
    for(const width of screenWidths){
      const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});
      await context.addInitScript(value=>{
        sessionStorage.setItem('snmp_token','synthetic-fixture-token');
        sessionStorage.setItem('snmp_username','Fixture operator');
        localStorage.setItem('trishul_theme',value);
      },theme);
      const page=await context.newPage();
      const browserErrors=[];
      page.on('pageerror',error=>browserErrors.push(error.message));
      page.on('console',message=>{ if(message.type()==='error') browserErrors.push('console: '+message.text()); });
      page.on('requestfailed',request=>browserErrors.push('network: '+request.url()+' '+request.failure()?.errorText));
      page.on('response',response=>{ if(response.status()>=400) browserErrors.push('http '+response.status()+' '+response.url()); });
      await page.routeWebSocket('**/api/ws*',ws=>{ws.onMessage(message=>{if(message==='ping') ws.send('pong');});});
      await page.route('**/api/**',async route=>{
        const url=new URL(route.request().url());
        const output=fixture(url.pathname);
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(output)});
      });
      for(const [name,path] of routes){
        await page.goto(baseUrl+path,{waitUntil:'domcontentloaded'});
        try {
          await page.locator('#main-content').waitFor({timeout:7000});
        } catch (cause) {
          const body = await page.locator('body').innerText().catch(() => 'Body unreadable');
          const tokenPresent = await page.evaluate(() => !!sessionStorage.getItem('snmp_token')).catch(() => false);
          console.log('Browser fixture startup diagnostic:', JSON.stringify({url:page.url(),route:path,tokenPresent,body:body.slice(0,1200),browserErrors,html:(await page.content()).slice(0,1400)}));
          await page.screenshot({path:join(artifacts,'browser-startup-failure.png'),fullPage:true});
          throw cause;
        }
        await page.waitForTimeout(250);
        if(width>=1024){
          const expand=page.getByRole('button',{name:'Expand sidebar'});
          if(await expand.count()) await expand.click();
        }
        const shots=[['expanded',false],...(width>=1024?[['collapsed',true]]:[])];
        for(const [sidebar,collapse] of shots){
          if(collapse) await page.getByRole('button',{name:'Collapse sidebar'}).click();
          const namePrefix=theme+'-'+width+'-'+name+'-'+sidebar;
          await page.screenshot({path:join(artifacts,namePrefix+'.png'),fullPage:true,animations:'disabled'});
          const overflow=await page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-innerWidth));
          report.routes.push({workspace:name,theme,width,sidebar,screenshot:namePrefix+'.png',horizontalOverflowPx:overflow,heading:await page.locator('h1').first().textContent().catch(()=>null)});
          if(collapse) await page.getByRole('button',{name:'Expand sidebar'}).click();
        }
        if(name==='mibs' && [390,1024,1440].includes(width)){
          const snapshot=async state=>{
            const file=theme+'-'+width+'-mibs-'+state+'.png';
            await page.screenshot({path:join(artifacts,file),fullPage:true,animations:'disabled'});
            report.routes.push({workspace:'mibs',theme,width,sidebar:'expanded',state,screenshot:file});
          };
          const tableDisplay=await page.locator('.manager-inventory-table table').evaluate(el=>globalThis.getComputedStyle(el).display);
          if(width===390 && tableDisplay!=='block') report.errors.push({theme,width,problem:'Manager inventory did not reflow into cards',tableDisplay});
          await page.getByRole('button',{name:'Notifications',exact:true}).click();
          await page.waitForTimeout(100);await snapshot('notification-catalog');
          await page.getByRole('button',{name:'Add / upload'}).click();
          await snapshot('add-modal');
          await page.getByRole('button',{name:'Upload files'}).click();
          await snapshot('upload-dropzone');
          await page.getByRole('button',{name:'Close add MIB sources'}).click();
          await page.getByRole('button',{name:'Reload & dependencies'}).click();
          await snapshot('maintenance-modal');
          await page.getByRole('button',{name:'Close reload and dependencies'}).click();
        }
      }
      if(browserErrors.length) report.errors.push({theme,width,messages:browserErrors});
      await context.close();
    }
  }
} catch(error) {
  report.errors.push({fatal:String(error)});
  throw error;
} finally {
  writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(report,null,2));
  if(browser) await browser.close();
  server.kill('SIGTERM');
  console.log('Browser fixture screenshots:',report.routes.length,'; errors:',report.errors.length);
  console.log('Horizontal overflow cases:',report.routes.filter(x=>x.horizontalOverflowPx>4).length);
  if(report.errors.length) console.log('Browser fixture error details:',JSON.stringify(report.errors.slice(0,8)));
}
