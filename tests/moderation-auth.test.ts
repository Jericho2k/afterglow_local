import { afterEach, describe, expect, it } from "vitest";
import { isModerationAdminAccount } from "@/lib/session";

const originalAdmin=process.env.AFTERGLOW_ADMIN_USER_IDS;
const originalMemory=process.env.MEMORY_RETRIEVAL_V2_USER_IDS;
afterEach(()=>{
  if(originalAdmin===undefined)delete process.env.AFTERGLOW_ADMIN_USER_IDS;else process.env.AFTERGLOW_ADMIN_USER_IDS=originalAdmin;
  if(originalMemory===undefined)delete process.env.MEMORY_RETRIEVAL_V2_USER_IDS;else process.env.MEMORY_RETRIEVAL_V2_USER_IDS=originalMemory;
});

describe("moderation authorization",()=>{
  it("uses only the explicit Afterglow administrator allowlist",()=>{
    const account={id:"11111111-1111-4111-8111-111111111111",email:null};
    delete process.env.AFTERGLOW_ADMIN_USER_IDS;
    process.env.MEMORY_RETRIEVAL_V2_USER_IDS=account.id;
    expect(isModerationAdminAccount(account)).toBe(false);
    process.env.AFTERGLOW_ADMIN_USER_IDS=account.id;
    expect(isModerationAdminAccount(account)).toBe(true);
  });
});
