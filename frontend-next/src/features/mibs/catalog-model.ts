/** One catalog view: loaded modules plus stored source files, deduplicated by managed source path. */
export interface CatalogSource {
  name:string; file?:string; relative_path?:string; status?:string; source_kind?:string;
  source_group?:string; objects?:number; traps?:number; imports?:string[]; missing_deps?:string[];
  builtin?:boolean; deletable?:boolean; error?:string; active_relative_path?:string;
}
export interface CatalogEntry extends CatalogSource {
  key:string;
  moduleName?:string;
  sourcePath?:string;
  active:boolean;
}
export type CatalogSortKey='name'|'source_group'|'status'|'objects'|'traps';
export type CatalogSort = { field:CatalogSortKey; descending:boolean };
export function buildCatalogEntries(modules:CatalogSource[], sources:CatalogSource[]):CatalogEntry[] {
  const rows:CatalogEntry[]=[];
  const linkedPaths=new Set<string>();
  for(const module of modules){
    const modulePath=module.relative_path||'';
    const source=sources.find(item=>item.relative_path && item.relative_path===modulePath)
      || sources.find(item=>item.name===module.name && item.status==='active');
    const path=source?.relative_path||modulePath||undefined;
    if(source?.relative_path)linkedPaths.add(source.relative_path);
    rows.push({...module,...(source?{source_group:source.source_group,source_kind:source.source_kind,
      deletable:source.deletable,relative_path:source.relative_path,file:source.file}:{}),
      key:'module:'+module.name,moduleName:module.name,sourcePath:path,active:true});
  }
  for(const source of sources){
    const path=source.relative_path||source.file||'';
    if(!path || linkedPaths.has(path))continue;
    rows.push({...source,key:'source:'+path,sourcePath:path,active:false});
  }
  return rows;
}
export function filterSortCatalog(entries:CatalogEntry[],query:string,group:string,status:string,sort:CatalogSort){
  const needle=query.trim().toLowerCase();
  return entries.filter(item=>(!group||item.source_group===group) &&
    (!status||(item.status||'active').toLowerCase()===status.toLowerCase()) &&
    (!needle||[item.name,item.file,item.relative_path,item.source_group,item.status,item.error]
      .some(value=>value?.toLowerCase().includes(needle)))).sort((a,b)=>{
    const left=a[sort.field],right=b[sort.field];
    const order=typeof left==='number'&&typeof right==='number' ? left-right :
      String(left??'').localeCompare(String(right??''),undefined,{numeric:true,sensitivity:'base'});
    return sort.descending?-order:order;
  });
}
export function scopedSelection(entries:CatalogEntry[],selectedKeys:string[]){
  const selected=new Set(selectedKeys);
  const chosen=entries.filter(entry=>selected.has(entry.key));
  return {
    modules:[...new Set(chosen.filter(x=>x.active&&x.moduleName).map(x=>x.moduleName!))],
    paths:[...new Set(chosen.filter(x=>x.sourcePath&&x.deletable).map(x=>x.sourcePath!))],
  };
}
export function nextCatalogSort(previous:CatalogSort,key:CatalogSortKey):CatalogSort{
  return {field:key,descending:previous.field===key?!previous.descending:false};
}
