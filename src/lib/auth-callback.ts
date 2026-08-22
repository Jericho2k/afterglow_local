export function safeNextPath(value:string|null) {
  return value?.startsWith("/")&&!value.startsWith("//") ? value : "/";
}

export function verificationDestination(next:string|null,status:"success"|"invalid") {
  const destination=new URL(safeNextPath(next),"https://afterglow.invalid");
  destination.searchParams.set("verification",status);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
