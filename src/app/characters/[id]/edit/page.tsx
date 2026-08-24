import CreationEditor from "./editor";

export default async function CharacterEditRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CreationEditor creationId={id} />;
}
