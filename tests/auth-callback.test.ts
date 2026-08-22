import {describe,expect,it} from "vitest";
import {safeNextPath,verificationDestination} from "@/lib/auth-callback";

describe("email verification redirects",()=>{
  it("keeps local destinations and labels success",()=>expect(verificationDestination("/characters/abc","success")).toBe("/characters/abc?verification=success"));
  it("refuses protocol-relative and external destinations",()=>{
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
  });
});
