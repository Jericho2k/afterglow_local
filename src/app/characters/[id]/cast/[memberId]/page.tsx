import CastMemberProfile from "./profile";

export default async function CastMemberPage({ params }: { params: Promise<{ id: string; memberId: string }> }) {
  const { id, memberId } = await params;
  return <CastMemberProfile creationId={id} memberId={memberId} />;
}
