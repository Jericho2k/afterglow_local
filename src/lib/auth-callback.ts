export function safeNextPath(value:string|null) {
  return value?.startsWith("/")&&!value.startsWith("//") ? value : "/";
}

export function verificationDestination(next:string|null,status:"success"|"invalid") {
  const destination=new URL(safeNextPath(next),"https://afterglow.invalid");
  destination.searchParams.set("verification",status);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function externalRequestOrigin(request:Request) {
  const url=new URL(request.url);
  const forwardedHost=request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol=request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host=forwardedHost||request.headers.get("host")||url.host;
  const protocol=forwardedProtocol||url.protocol.replace(":","");
  return `${protocol}://${host}`;
}
