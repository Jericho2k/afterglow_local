import { byokEnabled, byokMetadata, deleteProviderKey, setByokEnabled, storeProviderKey, validateOpenRouterKey } from "@/lib/byok";
import { checkRateLimit } from "@/lib/rate-limit";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET() {
  const account=await currentAccount(); if(!account)return unauthorized();
  return Response.json({ ...(await byokMetadata(account.id)), available:byokEnabled() });
}

export async function POST(request:Request) {
  const account=await currentAccount(); if(!account)return unauthorized();
  const limited=checkRateLimit(`byok:${account.id}`,10,60_000); if(limited)return limited;
  if(!byokEnabled())return Response.json({error:"Personal API keys are temporarily unavailable."},{status:503});
  const body=await request.json().catch(()=>null) as {apiKey?:unknown;enabled?:unknown}|null;
  if(!body||(!body.apiKey&&typeof body.enabled!=="boolean"))return Response.json({error:"Enter an OpenRouter API key."},{status:400});
  if(typeof body.apiKey==="string"){
    const apiKey=body.apiKey.trim();
    if(apiKey.length<12||apiKey.length>512)return Response.json({error:"Enter a valid OpenRouter API key."},{status:400});
    const validation=await validateOpenRouterKey(apiKey,request.signal);
    if(!validation.ok)return Response.json({error:validation.kind==="invalid"?"OpenRouter rejected that API key.":"OpenRouter could not validate the key right now. Try again shortly.",reason:validation.kind},{status:validation.kind==="invalid"?400:503});
    await storeProviderKey(account.id,apiKey,body.enabled!==false);
  } else if(!await setByokEnabled(account.id,Boolean(body.enabled))) {
    return Response.json({error:"Connect an OpenRouter key first."},{status:404});
  }
  return Response.json({ ...(await byokMetadata(account.id)), available:true });
}

export async function DELETE() {
  const account=await currentAccount(); if(!account)return unauthorized();
  await deleteProviderKey(account.id);
  return Response.json({connected:false,enabled:false,provider:"openrouter",suffix:"",validatedAt:null,available:byokEnabled()});
}
