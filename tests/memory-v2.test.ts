import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUser, ensureSchema, query, setPoolForTesting } from "@/lib/db";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "@/lib/memory-jobs";
import { applyCanonPlan, focusedRetrievalQuery, hybridRankMemories, memoryRetrievalV2Enabled, packCoreCanon, retrieveContinuityV2 } from "@/lib/memory-v2";
import type { CoreCanonEntry, Memory, Message } from "@/lib/types";

const ownerId="11111111-1111-4111-8111-111111111111";
const otherId="22222222-2222-4222-8222-222222222222";
const baseMemory={characterId:"c",conversationId:"x",kind:"event" as const,importance:3,pinned:false,status:"active" as const,resolution:"",resolvedAt:null,lastRecalledAt:null,recallCount:0,sourceMessageCount:0,createdAt:new Date().toISOString()};
const memory=(id:string,content:string,extra:Partial<Memory>={}):Memory=>({...baseMemory,id,content,keywords:[],...extra});
const canon=(id:string,content:string,extra:Partial<CoreCanonEntry>={}):CoreCanonEntry=>({id,conversationId:"x",characterId:"c",content,category:"event",importance:4,status:"active",sourceMemoryIds:[],sourceArcIds:[],sourceMessageCount:0,tokenCount:0,curationVersion:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...extra});

beforeEach(async()=>{
  const database=newDb({autoCreateForeignKeyIndices:true}); const adapter=database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool); await ensureSchema();
});
afterEach(()=>vi.unstubAllEnvs());

describe("Memory Retrieval V2",()=>{
  it("recalls an essential semantically related memory with no lexical overlap",()=>{
    const memories=[
      memory("essential","At the winter gala Mara permanently chose Alex as her partner.",{importance:5,kind:"relationship"}),
      memory("recent","They bought oranges yesterday.",{importance:4}),
    ];
    const result=hybridRankMemories(memories,"Are we truly committed to each other?",new Map([["essential",.91],["recent",.04]]),2,1200);
    expect(result.selected.map((item)=>item.id)).toContain("essential");
    const score=result.details.find((item)=>item.id==="essential");
    expect(score?.semantic).toBe(.91);
    expect(score?.lexical).toBe(0);
    expect(score?.reason).toContain("semantic");
  });

  it("deduplicates paraphrases so they do not consume the episodic budget",()=>{
    const result=hybridRankMemories([
      memory("a","Mara promised to return the silver key at sunrise.",{kind:"promise"}),
      memory("b","At sunrise Mara promised to return the silver key.",{importance:5}),
      memory("c","Alex discovered the hidden observatory.",{importance:5}),
    ],"What commitments and discoveries matter?",new Map([["a",.8],["b",.79],["c",.75]]),8,2000);
    expect(result.selected.map((item)=>item.id)).toContain("c");
    expect(result.selected.filter((item)=>item.id==="a"||item.id==="b")).toHaveLength(1);
  });

  it("keeps Core Canon under its strict 1,200-token ceiling",()=>{
    const packed=packCoreCanon(Array.from({length:20},(_,index)=>canon(String(index),`${index} ${"foundational relationship fact ".repeat(80)}`)),5000);
    expect(packed.reduce((sum,item)=>sum+item.tokenCount,0)).toBeLessThanOrEqual(1200);
  });

  it("builds recall primarily from latest intent with compact scene cues",()=>{
    const messages:Message[]=[
      {id:"1",conversationId:"x",role:"user",content:"A very old restaurant discussion",variants:[],selectedVariant:0,memoryIds:[],arcIds:[],createdAt:new Date().toISOString()},
      {id:"2",conversationId:"x",role:"assistant",content:"Mara hides the compass beneath her coat.",variants:[""],selectedVariant:0,memoryIds:[],arcIds:[],createdAt:new Date().toISOString()},
      {id:"3",conversationId:"x",role:"user",content:"Why are you protecting me from the council?",variants:[],selectedVariant:0,memoryIds:[],arcIds:[],createdAt:new Date().toISOString()},
    ];
    const result=focusedRetrievalQuery(messages);
    expect(result).toContain("Why are you protecting me");
    expect(result).toContain("compass");
  });

  it("falls back without semantic retrieval and never crosses conversation boundaries",async()=>{
    vi.stubEnv("MEMORY_RETRIEVAL_V2_ENABLED","true"); vi.stubEnv("MEMORY_RETRIEVAL_V2_USER_IDS",ownerId); vi.stubEnv("MEMORY_SEMANTIC_ENABLED","false");
    const characterId=crypto.randomUUID(); const chatA=crypto.randomUUID(); const chatB=crypto.randomUUID();
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Mara')",[characterId,ownerId]);
    await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$3,$2,'A'),($4,$3,$2,'B')",[chatA,characterId,ownerId,chatB]);
    await query("INSERT INTO memories (id,user_id,character_id,conversation_id,content,keywords) VALUES ($1,$2,$3,$4,'The obsidian ring belongs to chat A',$5),($6,$2,$3,$7,'The amber crown belongs to chat B',$8)",[crypto.randomUUID(),ownerId,characterId,chatA,["obsidian ring"],crypto.randomUUID(),chatB,["amber crown"]]);
    await query("INSERT INTO core_canon_entries (id,user_id,conversation_id,character_id,content,token_count) VALUES ($1,$2,$3,$4,'Mara and Alex are permanent partners',12)",[crypto.randomUUID(),ownerId,chatA,characterId]);
    const result=await retrieveContinuityV2({userId:ownerId,characterId,conversationId:chatA,query:"Where is the obsidian ring?",tokenBudget:3000});
    expect(result.diagnostics.semanticAvailable).toBe(false);
    expect(result.diagnostics.fallbackReason).toContain("disabled");
    expect(result.memories.map((item)=>item.content)).toContain("The obsidian ring belongs to chat A");
    expect(result.memories.map((item)=>item.content)).not.toContain("The amber crown belongs to chat B");
    expect(result.coreCanon.map((item)=>item.content)).toEqual(["Mara and Alex are permanent partners"]);
  });

  it("uses a database lease to stop concurrent memory jobs",async()=>{
    const characterId=crypto.randomUUID(); const conversationId=crypto.randomUUID();
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Mara')",[characterId,ownerId]);
    await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Lease')",[conversationId,ownerId,characterId]);
    const first=await acquireMemoryJobLease(ownerId,conversationId,"consolidation",300);
    expect(first).toBeTruthy();
    await expect(acquireMemoryJobLease(ownerId,conversationId,"curation",300)).resolves.toBeNull();
    await releaseMemoryJobLease(ownerId,conversationId,String(first));
    await expect(acquireMemoryJobLease(ownerId,conversationId,"curation",300)).resolves.toBeTruthy();
  });

  it("canon curation writes only the derived layer and preserves the archive",async()=>{
    const characterId=crypto.randomUUID(); const conversationId=crypto.randomUUID(); const memoryId=crypto.randomUUID(); const oldCanonId=crypto.randomUUID();
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Mara')",[characterId,ownerId]);
    await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Canon',100)",[conversationId,ownerId,characterId]);
    await query("INSERT INTO memories (id,user_id,character_id,conversation_id,content) VALUES ($1,$2,$3,$4,'Foundational gala event')",[memoryId,ownerId,characterId,conversationId]);
    await query("INSERT INTO core_canon_entries (id,user_id,conversation_id,character_id,content) VALUES ($1,$2,$3,$4,'Old duplicate')",[oldCanonId,ownerId,conversationId,characterId]);
    await asUser(ownerId,(client)=>applyCanonPlan(client,{userId:ownerId,conversationId,characterId,messageCount:100,currentVersion:0,supersede:[oldCanonId],demote:[],additions:[{id:crypto.randomUUID(),content:"The gala defined their partnership.",category:"relationship",importance:5,sourceMemoryIds:[memoryId],sourceArcIds:[],sourceMessageCount:80,tokens:18}]}));
    expect(Number((await query("SELECT COUNT(*) count FROM memories WHERE id=$1",[memoryId])).rows[0].count)).toBe(1);
    expect((await query("SELECT status FROM core_canon_entries WHERE id=$1",[oldCanonId])).rows[0].status).toBe("superseded");
  });

  it("does not consider another account's allowlist entry enabled",()=>{
    vi.stubEnv("MEMORY_RETRIEVAL_V2_ENABLED","true"); vi.stubEnv("MEMORY_RETRIEVAL_V2_USER_IDS",ownerId);
    expect(memoryRetrievalV2Enabled(ownerId)).toBe(true);
    expect(memoryRetrievalV2Enabled(otherId)).toBe(false);
  });
});
