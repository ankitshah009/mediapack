// Type-only re-exports of the canonical wire contracts. `import type` keeps node:crypto/zod out of the browser bundle.
export type {
  ArtifactRef,
  ErrorBody,
  JobEvent,
  JobView,
  OperationView,
  Quote,
  SearchResult,
  VideoView,
} from "../../../src/contracts/index.js";
import type { JobView } from "../../../src/contracts/index.js";
/** `Limits` is only exported as a zod value; derive the type. */
export type Limits = JobView["remaining"];
