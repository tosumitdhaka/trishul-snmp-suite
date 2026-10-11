import { describe,expect,it } from 'vitest';
import {buildCatalogEntries,filterSortCatalog,nextCatalogSort,scopedSelection,sortCatalogNotifications} from '../src/features/mibs/catalog-model';

const active=[
 {name:'IF-MIB',status:'active',relative_path:'uploads/IF-MIB',objects:20,source_group:'uploaded',deletable:true},
 {name:'SNMPv2-MIB',status:'active',objects:10,source_group:'',deletable:false},
];
const inventory=[
 {name:'IF-MIB',status:'active',relative_path:'uploads/IF-MIB',source_group:'uploaded',deletable:true},
 {name:'CERAGON-MIB',status:'missing_deps',relative_path:'vendors/CERAGON-MIB',source_group:'vendors',deletable:true},
];
describe('combined MIB catalog',()=>{
 it('merges loaded modules and uploaded sources without duplicating the active file',()=>{
  const rows=buildCatalogEntries(active,inventory);
  expect(rows).toHaveLength(3);
  expect(rows.map(row=>row.key)).toEqual(['module:IF-MIB','module:SNMPv2-MIB','source:vendors/CERAGON-MIB']);
  expect(rows.find(row=>row.key==='module:IF-MIB')?.sourcePath).toBe('uploads/IF-MIB');
  expect(rows.find(row=>row.key==='source:vendors/CERAGON-MIB')?.active).toBe(false);
 });
 it('selects only real managed sources for download/delete, while builtin modules export by name',()=>{
  const rows=buildCatalogEntries(active,inventory);
  expect(scopedSelection(rows,['module:SNMPv2-MIB'])).toEqual({modules:['SNMPv2-MIB'],paths:[]});
  expect(scopedSelection(rows,['module:IF-MIB','source:vendors/CERAGON-MIB']))
   .toEqual({modules:['IF-MIB'],paths:['uploads/IF-MIB','vendors/CERAGON-MIB']});
 });
 it('filters vendor uploads using the source group without a separate Sources tab',()=>{
  const rows=buildCatalogEntries(active,inventory);
  const chosen=filterSortCatalog(rows,'','vendors','',{field:'name',descending:false});
  expect(chosen.map(x=>x.name)).toEqual(['CERAGON-MIB']);
  expect(filterSortCatalog(rows,'CERAGON','','',{field:'name',descending:false})).toHaveLength(1);
 });
 it('restores legacy module, imports and path search scopes',()=>{
  const rows=buildCatalogEntries([{name:'VENDOR-MIB',imports:['SNMPv2-SMI'],relative_path:'vendors/VENDOR-MIB',status:'active'}],[]);
  const by=(scope:'all'|'module'|'imports'|'path',needle:string)=>
   filterSortCatalog(rows,needle,'','',{field:'name',descending:false},scope);
  expect(by('module','VENDOR')).toHaveLength(1);
  expect(by('module','SNMPv2-SMI')).toHaveLength(0);
  expect(by('imports','SNMPv2-SMI')).toHaveLength(1);
  expect(by('path','vendors/')).toHaveLength(1);
  expect(by('path','SNMPv2-SMI')).toHaveLength(0);
  expect(by('all','SNMPv2-SMI')).toHaveLength(1);
 });
 it('sorts notification catalog by OID, module and object count',()=>{
  const entries=[
   {name:'a',full_name:'M2::a',oid:'1.3.6.5',module:'M2',objects:[]},
   {name:'b',full_name:'M1::b',oid:'1.3.6.2',module:'M1',objects:[{},{}]},
  ];
  expect(sortCatalogNotifications(entries,'oid',false).map(x=>x.oid)).toEqual(['1.3.6.2','1.3.6.5']);
  expect(sortCatalogNotifications(entries,'module',false)[0].module).toBe('M1');
  expect(sortCatalogNotifications(entries,'objects',true)[0].objects).toHaveLength(2);
  expect(entries[0].oid).toBe('1.3.6.5');
 });
 it('sorts numeric columns and toggles direction on repeated header clicks',()=>{
  const rows=buildCatalogEntries(active,inventory);
  const sorted=filterSortCatalog(rows,'','','',{field:'objects',descending:false});
  expect(sorted[sorted.length-1]?.objects).toBe(20);
  const initial={field:'name' as const,descending:false};
  expect(nextCatalogSort(initial,'status')).toEqual({field:'status',descending:false});
  expect(nextCatalogSort({field:'status',descending:false},'status')).toEqual({field:'status',descending:true});
 });
});