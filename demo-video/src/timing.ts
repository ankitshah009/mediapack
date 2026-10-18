import beats from "./beats.json";

export const FPS = 30;
export const VO_DELAY = 4; // frames of air before each voice line

type Id = keyof typeof beats;
/** Frame (scene-relative) where sentence `i` of voice line `id` starts, plus `plus` seconds. */
export const at = (id: Id, i: number, plus = 0) => VO_DELAY + Math.round((beats[id][i].start + plus) * FPS);
export const sec = (s: number) => Math.round(s * FPS);
