import { Composition } from "remotion";
import { Architecture } from "./Architecture";
import { Demo, FPS, totalFrames } from "./Demo";
import { JobFlow } from "./JobFlow";

export const Root = () => (
  <>
    <Composition id="MediaPackDemo" component={Demo} durationInFrames={totalFrames()} fps={FPS} width={1920} height={1080} />
    {/* README images: npx remotion still src/index.ts <id> ../docs/images/<file>.png */}
    <Composition id="ArchitectureImage" component={Architecture} defaultProps={{ theme: "light" as const }} durationInFrames={1} fps={FPS} width={1920} height={1080} />
    <Composition id="JobFlowImage" component={JobFlow} defaultProps={{ theme: "light" as const }} durationInFrames={1} fps={FPS} width={1920} height={1080} />
  </>
);
