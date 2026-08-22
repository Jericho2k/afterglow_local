import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { verificationDestination } from "@/lib/auth-callback";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request:Request) {
  const url=new URL(request.url);
  const code=url.searchParams.get("code");
  const tokenHash=url.searchParams.get("token_hash");
  const type=url.searchParams.get("type") as EmailOtpType|null;
  let valid=false;
  const supabase=await supabaseServer();
  if(code){
    const {error}=await supabase.auth.exchangeCodeForSession(code);
    valid=!error;
  }else if(tokenHash&&type){
    const {error}=await supabase.auth.verifyOtp({token_hash:tokenHash,type});
    valid=!error;
  }
  return NextResponse.redirect(new URL(verificationDestination(url.searchParams.get("next"),valid?"success":"invalid"),url.origin));
}
