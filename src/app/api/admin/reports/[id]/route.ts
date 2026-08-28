import { randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, moderationAdminRequired, unauthorized } from "@/lib/session";
import { rankingBoardSize, rankingCategories } from "@/lib/rankings";

const actions=["mark_reviewing","dismiss","resolve_no_removal","remove_creation","restore_creation"] as const;
type Action=(typeof actions)[number];

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  const account=await currentAccount();if(!account)return unauthorized();
  const denied=moderationAdminRequired(account);if(denied)return denied;
  const limited=checkRateLimit(`moderation:${account.id}`,120,60_000);if(limited)return limited;
  const {id}=await context.params;
  if(!/^[0-9a-f-]{36}$/i.test(id))return Response.json({error:"Invalid report"},{status:400});
  const body=await request.json().catch(()=>null) as {action?:unknown;reason?:unknown}|null;
  if(!body||typeof body.action!=="string"||!actions.includes(body.action as Action))return Response.json({error:"Invalid moderation action"},{status:400});
  const action=body.action as Action;const reason=typeof body.reason==="string"?body.reason.trim().slice(0,1000):"";
  const outcome=await transaction(async(client)=>{
    const found=await client.query("SELECT id,character_id,status FROM character_reports WHERE id=$1 FOR UPDATE",[id]);
    if(!found.rowCount)return null;
    const characterId=found.rows[0].character_id?String(found.rows[0].character_id):null;
    const target=characterId?"character_id=$1":"id=$1";
    const targetValue=characterId??id;
    if(action==="mark_reviewing")await client.query(`UPDATE character_reports SET status='reviewing',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE ${target} AND status='pending'`,[targetValue,account.id]);
    if(action==="dismiss")await client.query(`UPDATE character_reports SET status='dismissed',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE ${target} AND status IN ('pending','reviewing')`,[targetValue,account.id]);
    if(action==="resolve_no_removal")await client.query(`UPDATE character_reports SET status='resolved',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE ${target} AND status IN ('pending','reviewing')`,[targetValue,account.id]);
    if(action==="remove_creation"&&characterId){
      await client.query(`UPDATE characters SET pre_moderation_visibility=CASE WHEN moderation_status='active' THEN visibility ELSE pre_moderation_visibility END,
        visibility='private',moderation_status='removed',moderated_at=now(),moderated_by=$2,moderation_reason=$3,updated_at=now() WHERE id=$1`,[characterId,account.id,reason]);
      await client.query("UPDATE character_reports SET status='resolved',reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE character_id=$1 AND status IN ('pending','reviewing')",[characterId,account.id]);
      await client.query("DELETE FROM creation_rankings WHERE character_id=$1",[characterId]);
    }
    if(action==="restore_creation"&&characterId){
      await client.query("SELECT set_config('afterglow.suppress_publish_notification','on',true)").catch(()=>undefined);
      await client.query(`UPDATE characters SET visibility=COALESCE(pre_moderation_visibility,'private'),moderation_status='active',moderated_at=NULL,
        moderated_by=NULL,moderation_reason='',pre_moderation_visibility=NULL,updated_at=now() WHERE id=$1 AND moderation_status='removed'`,[characterId]);
    }
    if((action==="remove_creation"||action==="restore_creation")&&characterId){
      await client.query("UPDATE creator_stats_refresh SET refreshed_at='1970-01-01T00:00:00Z' WHERE id=true");
      await client.query("UPDATE creation_rankings_refresh SET refreshed_at='1970-01-01T00:00:00Z' WHERE id=true");
    }
    await client.query("INSERT INTO moderation_actions (id,character_id,report_id,moderator_user_id,action,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",[randomUUID(),characterId,id,account.id,action,reason,JSON.stringify({previousReportStatus:found.rows[0].status})]);
    return {characterId,action};
  });
  if(!outcome)return Response.json({error:"Report not found"},{status:404});
  if((action==="remove_creation"||action==="restore_creation")&&outcome.characterId){
    // Rare administrative writes pay the rebuild cost so public boards and
    // creator standing stop counting a removed work immediately. The stale
    // clocks above remain the fallback if a rebuild function is unavailable.
    await query("SELECT public.refresh_creator_stats()").catch(()=>undefined);
    await query("SELECT public.refresh_creation_rankings($1::text[],$2)",[rankingCategories,rankingBoardSize]).catch(()=>undefined);
  }
  return Response.json({ok:true,...outcome});
}
