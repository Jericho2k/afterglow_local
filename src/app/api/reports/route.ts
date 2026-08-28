import { randomUUID } from "node:crypto";
import { transaction } from "@/lib/db";
import { characterReportSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const limited=checkRateLimit(`creation-report:${account.id}`,8,60_000); if(limited)return limited;
  const parsed = characterReportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid report" }, { status: 400 });
  const value = parsed.data;
  try {
    const reportId=await transaction(async(client)=>{
      const creation=await client.query(
        `SELECT id,user_id,name,title,creation_type,profile_type,tagline,description,user_role,avatar_path,backstory,cast_members,
           personality,scenario,greeting,alternate_greetings,example_dialogue,response_directive,boundaries
         FROM characters WHERE id=$1 AND user_id<>$2 AND moderation_status='active' AND visibility IN ('public','unlisted')`,
        [value.characterId,account.id],
      );
      if(!creation.rowCount)return null;
      const row=creation.rows[0];
      const worlds=await client.query("SELECT world_id FROM character_worlds WHERE character_id=$1 ORDER BY world_id",[value.characterId]);
      const gallery=await client.query("SELECT id,storage_path FROM character_gallery WHERE character_id=$1 ORDER BY position,id",[value.characterId]);
      const id=randomUUID();
      await client.query(
        `INSERT INTO character_reports (id,user_id,character_id,reason,details,character_name)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id,account.id,value.characterId,value.reason,value.details,row.name],
      );
      const snapshot={
        name:row.name,title:row.title,creationType:row.creation_type,profileType:row.profile_type,tagline:row.tagline,
        description:row.description,userRole:row.user_role,backstory:row.backstory,cast:row.cast_members,
        personality:row.personality,scenario:row.scenario,greeting:row.greeting,alternateGreetings:row.alternate_greetings,
        exampleDialogue:row.example_dialogue,responseDirective:row.response_directive,boundaries:row.boundaries,
        linkedWorldIds:worlds.rows.map((item)=>String(item.world_id)),
        avatarStoragePath:String(row.avatar_path||""),
        galleryStorageIds:gallery.rows.map((item)=>({id:String(item.id),storagePath:String(item.storage_path||"")})),
      };
      await client.query("INSERT INTO character_report_evidence (report_id,character_id,creator_user_id,snapshot) VALUES ($1,$2,$3,$4::jsonb)",[id,value.characterId,row.user_id,JSON.stringify(snapshot)]);
      return id;
    });
    if(!reportId)return Response.json({error:"Creation not found"},{status:404});
    return Response.json({ok:true,reportId},{status:201});
  }catch(error){
    if((error as {code?:string}).code==="23505"||error instanceof Error&&error.message.includes("character_reports_one_active_idx"))return Response.json({error:"You already have an active report for this creation."},{status:409});
    throw error;
  }
}
