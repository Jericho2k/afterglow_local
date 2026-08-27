import CreatorProfile from "./profile";

export default async function CreatorPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <CreatorProfile username={decodeURIComponent(username)} />;
}
