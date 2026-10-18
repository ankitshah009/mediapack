import { VideoPage } from "@/components/viewer/pages/VideoPage";

export default async function Page({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <VideoPage key={videoId} videoId={videoId} />;
}
