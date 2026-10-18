import { useSyncExternalStore } from "react";

export const BASE = "/app";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener("mp:navigate", cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("mp:navigate", cb);
  };
}
const snap = () => window.location.pathname + window.location.search;

export type Route =
  | { name: "videos" }
  | { name: "video"; videoId: string }
  | { name: "job"; jobId: string }
  | { name: "pair" }
  | { name: "notfound" };

export function parse(pathname: string): Route {
  const p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = p.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "videos" };
  if (parts[0] === "v" && parts[1]) return { name: "video", videoId: parts[1] };
  if (parts[0] === "jobs" && parts[1]) return { name: "job", jobId: parts[1] };
  if (parts[0] === "pair") return { name: "pair" };
  return { name: "notfound" };
}

export function useRoute(): Route {
  useSyncExternalStore(subscribe, snap);
  return parse(window.location.pathname);
}

/** `?fixtures=1` is sticky within the tab so internal links keep the labeled fixture mode. */
export function href(path: string): string {
  const fx = new URLSearchParams(window.location.search).get("fixtures") === "1";
  return `${BASE}${path === "/" ? "/" : path}${fx ? "?fixtures=1" : ""}`;
}
export function navigate(path: string) {
  window.history.pushState({}, "", href(path));
  window.dispatchEvent(new Event("mp:navigate"));
  window.scrollTo(0, 0);
}
