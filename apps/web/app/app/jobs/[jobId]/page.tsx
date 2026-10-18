import { JobPage } from "@/components/viewer/pages/JobPage";

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <JobPage key={jobId} jobId={jobId} />;
}
