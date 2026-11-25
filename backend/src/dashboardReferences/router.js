import { getVariable } from "../canonicalVariableAdminService.js";
import { Router } from "express";
import { adminWriteKit } from "../sourceMetricMappingService.js";
import { resolveReferenceContext, referenceCanWrite } from "./access.js";
import { referenceUuid, validReferenceWrite, REFERENCE_LIMITS } from "./contract.js";
const { boundedRead, hashOf, rightsStillHold } = adminWriteKit;
const missing = res => res.status(404).json({ error: "notFound" });
const invalid = res => res.status(400).json({ error: "invalidRequest", message: "Check the reference values and try again." });
const refusalMessages = Object.freeze({
  staleRevision: "This table changed. Reopen it before saving.", requestIdReused: "This request cannot be repeated. Reopen the table.",
  referenceEmpty: "Add a reference value before publishing.", referenceArchived: "This table is archived. Choose another table.",
});
export function createReferenceRouter({ enabled = () => process.env.DASHBOARD_REFERENCES_ENABLED === "true" } = {}) {
  const router = Router();
  router.use(async (req,res,next) => {
    res.set("Cache-Control","no-store");
    try {
      if (!enabled()) return missing(res);
      const ctx = await resolveReferenceContext(req);
      if (!ctx || req.method !== "GET" && !referenceCanWrite(ctx)) return missing(res);
      req.referenceContext=ctx; return next();
    } catch (error) { return next(error); }
  });
  const handle = fn => async (req,res,next) => {
    try { return await fn(req,res); } catch (error) {
      if (error.code === "42501") return missing(res);
      if (Object.hasOwn(refusalMessages,error.message)) return res.status(409).json({error:error.message,message:refusalMessages[error.message]});
      if (["23514","23505","23503","22P02","22003"].includes(error.code)) return invalid(res);
      return next(error);
    }
  };
  router.get("/",handle(async(req,res)=>{
    const result=await boundedRead(client=>client.query("select id,name,revision,archived,published_version_id from training_load.dashboard_reference_tables where club_id=$1 and ($2::boolean or published_version_id is not null) order by lower(name),id limit 100",[req.referenceContext.owner.clubId,referenceCanWrite(req.referenceContext)]));
    return res.json({tables:result.rows,canCreate:referenceCanWrite(req.referenceContext)});
  }));
  router.get("/options",handle(async(req,res)=>{
    const club=req.referenceContext.owner.clubId;
    const result=await boundedRead(async client=>{
      const positions=(await client.query("select p.id,coalesce(o.name,p.name) name from public.sport_positions p left join public.club_position_overrides o on o.position_id=p.id and o.club_id=$1 where p.archived_at is null and (p.owner_scope='system' or p.owner_club_id=$1) and not coalesce(o.hidden,false) order by p.sort_order,coalesce(o.name,p.name),p.id",[club])).rows;
      const teams=(await client.query("select id,name from public.teams where club_id=$1 and coalesce(is_active,true) order by name,id",[club])).rows;
      return {clubId:club,positions,teams,canEdit:referenceCanWrite(req.referenceContext)};
    });return res.json(result);
  }));
  const detail = async(req,res) => {
    if (!referenceUuid(req.params.id) || req.params.versionId && !referenceUuid(req.params.versionId)) return missing(res);
    const result = await boundedRead(async client=>{
      const table=(await client.query("select * from training_load.dashboard_reference_tables where id=$1 and club_id=$2",[req.params.id,req.referenceContext.owner.clubId])).rows[0];
      if (!table) return null;
      const version=(await client.query(req.params.versionId
        ? "select * from training_load.dashboard_reference_versions where table_id=$1 and id=$2 and published"
        : "select * from training_load.dashboard_reference_versions where table_id=$1 and ($2::boolean or published) order by version desc limit 1",
      req.params.versionId?[table.id,req.params.versionId]:[table.id,referenceCanWrite(req.referenceContext)])).rows[0];
      if (!version) return null;
      const [columns,rows,valueKinds,cells]=await Promise.all([
        client.query("select c.definition_id,c.unit,c.aggregation,c.data_level,c.sort_order,d.label name from training_load.dashboard_reference_columns c join training_load.metric_definitions d on d.id=c.definition_id where c.version_id=$1 order by c.sort_order",[version.id]),
        client.query("select r.position_id,r.sort_order,coalesce(o.name,p.name) name from training_load.dashboard_reference_rows r join public.sport_positions p on p.id=r.position_id left join public.club_position_overrides o on o.position_id=p.id and o.club_id=$2 where r.version_id=$1 order by r.sort_order",[version.id,table.club_id]),
        client.query("select key,name,sort_order from training_load.dashboard_reference_value_kinds where version_id=$1 order by sort_order",[version.id]),
        client.query("select position_id,definition_id,value_key,value::text value from training_load.dashboard_reference_cells where version_id=$1 order by position_id,definition_id,value_key",[version.id]),
      ]);
      return {table:{id:table.id,name:table.name,revision:table.revision,archived:table.archived},version:{id:version.id,number:version.version,published:version.published},columns:columns.rows,rows:rows.rows,valueKinds:valueKinds.rows,cells:cells.rows,canEdit:referenceCanWrite(req.referenceContext)&&!table.archived};
    });
    if(result){
      const visible=new Set();
      for(const column of result.columns){const current=await getVariable({ctx:req.referenceContext,variableId:column.definition_id,query:{}});if(current?.variable?.state==='active'){visible.add(column.definition_id);column.name=current.variable.label;}}
      result.unavailableColumns=result.columns.some(column=>!visible.has(column.definition_id));
      if(result.unavailableColumns)result.canEdit=false;
      result.columns=result.columns.filter(column=>visible.has(column.definition_id));result.cells=result.cells.filter(cell=>visible.has(cell.definition_id));
    }
    return result?res.json(result):missing(res);
  };
  router.get("/:id",handle(detail));
  router.get("/:id/versions/:versionId",handle(detail));
  const write = action => handle(async(req,res)=>{
    if (req.params.id && !referenceUuid(req.params.id)) return missing(res);
    if (!validReferenceWrite(action,req.body) || Buffer.byteLength(JSON.stringify(req.body))>REFERENCE_LIMITS.bytes) return invalid(res);
    const ctx=req.referenceContext;
    const payload=action === "create"?{name:req.body.name}:action === "draft"?req.body.draft:{};
    const hash=hashOf({contract:"dashboard-reference/v1",action,club:ctx.owner.clubId,table:req.params.id??null,body:req.body});
    const receipt=await boundedRead(async client => {
      if(!await rightsStillHold(client,ctx))throw Object.assign(new Error("notFound"),{code:"42501"});
      const result=await client.query("select training_load.mutate_dashboard_reference($1,$2,$3,$4,$5,$6,$7,$8) receipt",[ctx.userId,ctx.owner.clubId,req.body.requestId,hash,req.params.id??null,req.body.expectedRevision??null,action,payload]);
      return result.rows[0].receipt;
    },{locks:true});
    return res.status(action === "create"?201:200).json(receipt);
  });
  router.post("/",write("create"));
  router.patch("/:id/draft",write("draft"));
  router.post("/:id/publish",write("publish"));
  router.post("/:id/archive",write("archive"));
  return router;
}
