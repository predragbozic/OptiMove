import { previewError } from '../dashboardSimple/previewTransaction.js';

export async function copyDashboardPages(query,source,destination) {
  if(source.pages_revision===undefined)return null;
  const pages=(await query('select * from training_load.dashboard_pages where dashboard_id=$1 order by position,id limit 33',[source.id])).rows;
  if(!pages.length || pages.length>32)throw previewError('pagesUnavailable');
  const initial=(await query('select id from training_load.dashboard_pages where dashboard_id=$1 order by position,id',[destination.id])).rows;
  if(initial.length!==1)throw previewError('pagesUnavailable');
  const pageMap=new Map();
  for(const [index,page]of pages.entries()){
    let id;
    const filter=page.default_filter==null?null:JSON.stringify(page.default_filter),period=page.period_config==null?null:JSON.stringify(page.period_config);
    if(index===0){id=initial[0].id;await query('update training_load.dashboard_pages set name=$2,position=$3,default_filter=$4::jsonb,period_config=$5::jsonb,period_origin=$6 where id=$1',[id,page.name,page.position,filter,period,page.period_origin]);}
    else id=(await query('insert into training_load.dashboard_pages(dashboard_id,name,position,default_filter,period_config,period_origin) values($1,$2,$3,$4::jsonb,$5::jsonb,$6) returning id',[destination.id,page.name,page.position,filter,period,page.period_origin])).rows[0].id;
    pageMap.set(page.id,id);
  }
  return pageMap;
}

export async function enterClonePage(query,dashboardId,pageId) {
  if(pageId)await query("select set_config('training_load.page_mutation',$1,true)",[JSON.stringify({dashboardId,pageId,operation:'duplicate'})]);
}
