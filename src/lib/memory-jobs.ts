import { randomUUID } from "node:crypto";
import { asUser } from "./db";

export type MemoryJobType = "consolidation" | "curation" | "embedding_backfill" | "scene_state";

/** Cross-worker lease. One active memory-maintenance job is allowed per chat. */
export async function acquireMemoryJobLease(userId:string,conversationId:string,jobType:MemoryJobType,seconds=300) {
  const token=randomUUID(); const lockedUntil=new Date(Date.now()+seconds*1000).toISOString();
  return asUser(userId,async(client)=>{
    const current=await client.query("SELECT lease_token,locked_until FROM memory_job_leases WHERE conversation_id=$1 FOR UPDATE",[conversationId]);
    if (current.rows[0] && new Date(String(current.rows[0].locked_until)).getTime()>Date.now()) return null;
    if (current.rows[0]) {
      const replaced=await client.query(
        `UPDATE memory_job_leases SET user_id=$2,job_type=$3,lease_token=$4,locked_until=$5,updated_at=now()
         WHERE conversation_id=$1 RETURNING lease_token`,[conversationId,userId,jobType,token,lockedUntil]);
      return replaced.rowCount?token:null;
    }
    const inserted=await client.query(
      `INSERT INTO memory_job_leases (conversation_id,user_id,job_type,lease_token,locked_until)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (conversation_id) DO NOTHING RETURNING lease_token`,[conversationId,userId,jobType,token,lockedUntil]);
    return inserted.rowCount?token:null;
  });
}

export async function releaseMemoryJobLease(userId:string,conversationId:string,token:string) {
  await asUser(userId,(client)=>client.query("DELETE FROM memory_job_leases WHERE conversation_id=$1 AND user_id=$2 AND lease_token=$3",[conversationId,userId,token]));
}
