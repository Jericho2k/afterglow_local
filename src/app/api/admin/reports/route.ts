import { query } from "@/lib/db";
import { currentAccount, moderationAdminRequired, unauthorized } from "@/lib/session";

export async function GET(request:Request){
  const account=await currentAccount();if(!account)return unauthorized();
  const denied=moderationAdminRequired(account);if(denied)return denied;
  const status=new URL(request.url).searchParams.get("status")||"active";
  const statuses=status==="all"?["pending","reviewing","resolved","dismissed"]:status==="closed"?["resolved","dismissed"]:["pending","reviewing"];
  const result=await query(
    `SELECT r.id,r.user_id reporter_user_id,r.character_id,r.reason,r.details,r.character_name,r.status,r.created_at,r.updated_at,
       e.snapshot,e.captured_at,e.creator_user_id,
       c.name current_name,c.title current_title,c.creation_type current_creation_type,c.profile_type current_profile_type,
       c.tagline current_tagline,c.description current_description,c.user_role current_user_role,c.backstory current_backstory,
       c.cast_members current_cast,c.personality current_personality,c.scenario current_scenario,c.greeting current_greeting,
       c.alternate_greetings current_alternate_greetings,c.example_dialogue current_example_dialogue,
       c.response_directive current_response_directive,c.boundaries current_boundaries,
       c.visibility,c.moderation_status,c.moderated_at,c.moderation_reason,c.published_at,
       p.username creator_username,p.display_name creator_display_name
     FROM character_reports r
     LEFT JOIN character_report_evidence e ON e.report_id=r.id
     LEFT JOIN characters c ON c.id=r.character_id
     LEFT JOIN profiles p ON p.id=COALESCE(c.user_id,e.creator_user_id)
     WHERE r.status=ANY($1::text[])
     ORDER BY (r.reason='underage') DESC,r.created_at DESC LIMIT 500`,[statuses],
  );
  const groups=new Map<string,{characterId:string|null;characterName:string;creator:{id:string;username:string;displayName:string};current:Record<string,unknown>|null;snapshot:unknown;reportCount:number;latestAt:string;priority:boolean;reports:unknown[];actions:unknown[]}>();
  for(const row of result.rows){
    const key=String(row.character_id||`deleted:${row.id}`);
    let group=groups.get(key);
    if(!group){group={characterId:row.character_id?String(row.character_id):null,characterName:String(row.current_title||row.current_name||row.character_name||"Deleted creation"),creator:{id:String(row.creator_user_id||""),username:String(row.creator_username||""),displayName:String(row.creator_display_name||"Creator")},current:row.character_id?{
      name:row.current_name,title:row.current_title,creationType:row.current_creation_type,profileType:row.current_profile_type,
      tagline:row.current_tagline,description:row.current_description,userRole:row.current_user_role,backstory:row.current_backstory,
      cast:row.current_cast,personality:row.current_personality,scenario:row.current_scenario,greeting:row.current_greeting,
      alternateGreetings:row.current_alternate_greetings,exampleDialogue:row.current_example_dialogue,
      responseDirective:row.current_response_directive,boundaries:row.current_boundaries,
      visibility:row.visibility,moderationStatus:row.moderation_status,moderatedAt:row.moderated_at,moderationReason:row.moderation_reason,publishedAt:row.published_at,
    }:null,snapshot:row.snapshot,reportCount:0,latestAt:new Date(row.created_at).toISOString(),priority:false,reports:[],actions:[]};groups.set(key,group);}
    group.reportCount+=1;group.priority ||= row.reason==="underage";
    group.reports.push({id:String(row.id),reporterUserId:String(row.reporter_user_id),reason:String(row.reason),details:String(row.details||""),status:String(row.status),createdAt:new Date(row.created_at).toISOString(),capturedAt:row.captured_at?new Date(row.captured_at).toISOString():null});
  }
  const history=await query("SELECT id,character_id,report_id,moderator_user_id,action,reason,metadata,created_at FROM moderation_actions ORDER BY created_at DESC LIMIT 500");
  for(const row of history.rows){const group=groups.get(String(row.character_id));if(group)group.actions.push({id:String(row.id),reportId:row.report_id?String(row.report_id):null,moderatorUserId:String(row.moderator_user_id),action:String(row.action),reason:String(row.reason||""),metadata:row.metadata,createdAt:new Date(row.created_at).toISOString()});}
  return Response.json({groups:[...groups.values()].sort((a,b)=>Number(b.priority)-Number(a.priority)||b.reportCount-a.reportCount||b.latestAt.localeCompare(a.latestAt))});
}
