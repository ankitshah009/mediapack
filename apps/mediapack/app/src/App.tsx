import { useRoute } from "./lib/router";
import { JobPage } from "./pages/JobPage";
import { PairPage } from "./pages/PairPage";
import { VideoPage } from "./pages/VideoPage";
import { VideosPage } from "./pages/VideosPage";
import { Link, Shell } from "./components/Shell";

export function App() {
  const r = useRoute();
  switch (r.name) {
    case "videos":
      return <VideosPage />;
    case "video":
      return <VideoPage key={r.videoId} videoId={r.videoId} />;
    case "job":
      return <JobPage key={r.jobId} jobId={r.jobId} />;
    case "pair":
      return <PairPage />;
    default:
      return (
        <Shell>
          <h1 className="font-display text-2xl font-semibold">Page not found</h1>
          <Link to="/" className="text-sm underline">Back to videos</Link>
        </Shell>
      );
  }
}
