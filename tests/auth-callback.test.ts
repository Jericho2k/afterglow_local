import {describe,expect,it} from "vitest";
import {externalRequestOrigin,safeNextPath,verificationDestination} from "@/lib/auth-callback";

describe("email verification redirects",()=>{
  it("keeps local destinations and labels success",()=>expect(verificationDestination("/characters/abc","success")).toBe("/characters/abc?verification=success"));
  it("refuses protocol-relative and external destinations",()=>{
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
  });
  it("uses the public proxy origin instead of the container address",()=>{
    const request=new Request("http://0.0.0.0:8080/auth/callback",{headers:{"x-forwarded-host":"afterglow.example","x-forwarded-proto":"https"}});
    expect(externalRequestOrigin(request)).toBe("https://afterglow.example");
  });
});
