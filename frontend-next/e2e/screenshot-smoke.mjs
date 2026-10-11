/* global URL, process, fetch, setTimeout, sessionStorage, localStorage, document, innerWidth, console */
// Browser-only preview fixture smoke. Mock REST/WS data are deliberately synthetic.
// Never interpret these screenshots as validation against a live SNMP backend.
import { chromium } from 'playwright';
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

function fixture(path) {
  if (path === '/api/settings/check') return { user: 'Fixture operator' };
  if (path === '/api/meta') return { name: 'Trishul SNMP Suite', version: '2.2-fixture', description: 'Isolated browser smoke fixture', author: 'Trishul' };
  if (path === '/api/simulator/status') return { running: false, port: 1061, community: 'public', requests: 12, uptime_seconds: 0 };
  if (path === '/api/simulator/data') return { '1.3.6.1.2.1.1.1.0': 'Synthetic fixture' };
  if (path === '/api/simulator/logs') return { items: [{ timestamp:'2026-10-11T10:00:00Z', level: 'info', message: 'Fixture GET request' }], total: 1 };
  if (path === '/api/traps/status') return { running: false, port: 1162, community: 'public', resolve_mibs: true, uptime_seconds: 0 };
  if (path === '/api/traps/') return { total: 1, count: 1, data: [{ id: 42, timestamp:'2026-10-11T10:00:00Z', source:'192.0.2.10', trap_type:'linkDown',varbinds:[{oid:'1.3.6.1.2.1.2.2.1.1',name:'IF-MIB::ifIndex',value:7}]}] };
  if (path === '/api/mibs/traps') return { traps: [{ name:'linkDown',full_name:'IF-MIB::linkDown',oid:'1.3.6.1.6.3.1.1.5.3',module:'IF-MIB',objects:[] }] };
  if (path === '/api/mibs/objects') return { objects: [] };
  if (path === '/api/mibs/browse/modules') return { active_bundle_id:1, modules: [{name:'IF-MIB',objects:1}] };
  if (path === '/api/mibs/browse/tree/module') return { count:1,modules:[{name:'IF-MIB',object_count:1,children:[{oid:'1.3.6.1.2.1.2.2',name:'ifTable',module:'IF-MIB',has_children:false}]}] };
  if (path === '/api/mibs/browse/tree/oid') return {root:{oid:'1.3.6.1',name:'internet'},children:[{oid:'1.3.6.1.2',name:'mgmt',has_children:false}],total_descendants:1};
  if (path === '/api/mibs/browse/search') return {count:0,results:[]};
  if (path.startsWith('/api/mibs/browse/node/')) return {node:{oid:'1.3.6.1.2.1.2.2',name:'ifTable',module:'IF-MIB'},breadcrumb:[]};
  if (path === '/api/mibs/bundle-summary') return {active_bundle_id:1,loaded:1};
  if (path === '/api/mibs/status') return { loaded:1, failed:0, mibs:[{name:'IF-MIB',status:'active',objects:1}],source_inventory:[{name:'IF-MIB',status:'active',source_group:'fixture',relative_path:'uploads/IF-MIB',deletable:true}], source_groups:[{name:'fixture',file_count:1}], active_bundle_label:'fixture bundle' };
  if (path === '/api/bundles') return {bundles:[{id:1,label:'fixture bundle',status:'active'}],active_bundle_id:1};
  if (path === '/api/settings/app') return {auto_fetch_mibs:false,trap_resolve_mibs:true,simulator_port:1061,trap_receiver_port:1162};
  if (path === '/api/stats/' || path === '/api/stats') return { simulator:{snmp_requests_served:12,oids_loaded:50},traps:{traps_received_total:1,traps_sent_total:2}, walker:{walks_executed:5,oids_returned:120},mibs:{reload_count:2,upload_count:1} };
  return {};
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {cwd:workdir,stdio:'pipe'});
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
          console.log('Browser fixture startup diagnostic:', JSON.stringify({url:page.url(),route:path,tokenPresent,body:body.slice(0,1200),browserErrors}));
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
}
