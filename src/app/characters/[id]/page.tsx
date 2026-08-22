import CharacterProfile from "./profile";

export default async function CharacterPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  return <CharacterProfile characterId={id}/>;
}
