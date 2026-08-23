import WorldProfile from "./profile";

export default async function WorldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorldProfile worldId={id} />;
}
