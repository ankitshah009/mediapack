"use client";

import { usePathname, useRouter } from "next/navigation";

export const BASE = "/app";

export type Route =
  | { name: "videos" }
  | { name: "video"; videoId: string }
  | { name: "job"; jobId: string }
  | { name: "pair" }
  | { name: "notfound" };

export function parse(pathname: string): Route {
  const path = pathname === BASE || pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "videos" };
  if (parts[0] === "v" && parts[1]) return { name: "video", videoId: parts[1] };
  if (parts[0] === "jobs" && parts[1]) return { name: "job", jobId: parts[1] };
  if (parts[0] === "pair") return { name: "pair" };
  return { name: "notfound" };
}

export function useRoute(): Route {
  return parse(usePathname());
}

export function href(path: string): string {
  return `${BASE}${path === "/" ? "" : path}`;
}

export function useNavigate() {
  const router = useRouter();
  return (path: string) => router.push(href(path));
}
