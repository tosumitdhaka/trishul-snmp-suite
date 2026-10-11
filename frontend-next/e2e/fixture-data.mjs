// Same synthetic REST fixture for both legacy and React screenshot evidence. Not live SNMP parity.
export function fixture(path) {
  if (path === '/api/settings/check') return { user: 'Fixture operator' };
  if (path === '/api/meta') return { name: 'Trishul SNMP Suite', version: '2.2-fixture', description: 'Isolated browser smoke fixture', author: 'Trishul' };
  if (path === '/api/simulator/status') return { running: false, port: 1061, community: 'public', requests: 12, uptime_seconds: 0 };
  if (path === '/api/simulator/data') return { '1.3.6.1.2.1.1.1.0': 'Synthetic fixture' };
  if (path === '/api/simulator/logs') return { items: [{ timestamp:'2026-10-11T10:00:00Z', level: 'info', message: 'Fixture GET request' }], total: 1 };
  if (path === '/api/traps/status') return { running: false, port: 1162, community: 'public', resolve_mibs: true, uptime_seconds: 0 };
  if (path === '/api/traps/') return { total: 1, count: 1, data: [{ id: 42, timestamp:'2026-10-11T10:00:00Z', source:'192.0.2.10', trap_type:'linkDown',varbinds:[{oid:'1.3.6.1.2.1.2.2.1.1',name:'IF-MIB::ifIndex',value:7}]}] };
  if (path === '/api/mibs/traps') return { traps: [
    { name:'linkDown',full_name:'IF-MIB::linkDown',oid:'1.3.6.1.6.3.1.1.5.3',module:'IF-MIB',objects:[{name:'ifIndex',oid:'1.3.6.1.2.1.2.2.1.1'}] },
    { name:'vendorAlarmCleared',full_name:'LONG-VENDOR-OPERATIONS-MIB::vendorAlarmCleared',oid:'1.3.6.1.4.1.99999.4.7.2',module:'LONG-VENDOR-OPERATIONS-MIB',objects:[] },
    { name:'coldStart',full_name:'SNMPv2-MIB::coldStart',oid:'1.3.6.1.6.3.1.1.5.1',module:'SNMPv2-MIB',objects:[{name:'sysName',oid:'1.3.6.1.2.1.1.5'}] },
  ] };
  if (path === '/api/mibs/objects') return { objects: [] };
  if (path === '/api/mibs/browse/modules') return { active_bundle_id:1, modules: [{name:'IF-MIB',objects:1}] };
  if (path === '/api/mibs/browse/tree/module') return { count:1,modules:[{name:'IF-MIB',object_count:1,children:[{oid:'1.3.6.1.2.1.2.2',name:'ifTable',module:'IF-MIB',has_children:false}]}] };
  if (path === '/api/mibs/browse/tree/oid') return {root:{oid:'1.3.6.1',name:'internet'},children:[{oid:'1.3.6.1.2',name:'mgmt',has_children:false}],total_descendants:1};
  if (path === '/api/mibs/browse/search') return {count:0,results:[]};
  if (path.startsWith('/api/mibs/browse/node/')) return {node:{oid:'1.3.6.1.2.1.2.2',name:'ifTable',module:'IF-MIB'},breadcrumb:[]};
  if (path === '/api/mibs/bundle-summary') return {active_bundle_id:1,loaded:1};
  if (path === '/api/mibs/status') return { loaded:2, failed:1,
    mibs:[{name:'IF-MIB',status:'active',objects:42,traps:3,source_group:'fixture',relative_path:'uploads/IF-MIB'},
      {name:'SNMPv2-MIB',status:'active',objects:70,traps:1}],
    source_inventory:[
      {name:'IF-MIB',status:'active',source_group:'fixture',relative_path:'uploads/IF-MIB',deletable:true,imports:['SNMPv2-SMI']},
      {name:'LONG-VENDOR-OPERATIONS-MIB',status:'missing_deps',source_group:'vendors',relative_path:'vendors/deep-directory/LONG-VENDOR-OPERATIONS-MIB',deletable:true,missing_deps:['INVENTED-DEPENDENCY-MIB']},
      {name:'FAULTY-TEST-MIB',status:'failed',source_group:'vendors',relative_path:'vendors/FAULTY-TEST-MIB',deletable:true,error:'Synthetic compiler failure: module dependency unavailable'},
    ],source_groups:[{name:'fixture',file_count:1},{name:'vendors',file_count:2}],
    active_bundle_label:'fixture bundle' };
  if (path === '/api/bundles') return {bundles:[{id:1,label:'fixture bundle',status:'active',module_count:2},{id:2,label:'fixture previous',status:'stored',module_count:1},{id:3,label:'fixture candidate',status:'stored',module_count:3}],active_bundle_id:1};
  if (path === '/api/settings/app') return {auto_start_simulator:false,auto_start_trap_receiver:false,session_timeout:3600,mib_auto_fetch:false,mib_remote_sources:[],restart_required:false};
  if (path === '/api/stats/' || path === '/api/stats') return { simulator:{snmp_requests_served:12,oids_loaded:50},traps:{traps_received_total:1,traps_sent_total:2}, walker:{walks_executed:5,oids_returned:120},mibs:{reload_count:2,upload_count:1} };
  return {};
}

