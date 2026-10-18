// Private Supabase Storage (service role, server only). Everything the app needs sits behind StorageAdapter
// so tests can substitute an in-memory edge.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../services/errors.js";
import { type Config } from "../config.js";

export interface UploadInstructions {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_in_seconds: number;
}
export interface StoredObject { size: number; contentType?: string }

export interface StorageAdapter {
  readonly bucket: string;
  /** Signed single-use upload; client does fetch(url,{method:'PUT',headers,body}). Overwrites are disabled. */
  createUpload(objectKey: string, contentType: string): Promise<UploadInstructions>;
  createDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  createDownloadUrls(objectKeys: string[], expiresInSeconds: number): Promise<Record<string, string>>;
  stat(objectKey: string): Promise<StoredObject | null>;
  download(objectKey: string, maxBytes: number): Promise<Buffer>;
  remove(objectKeys: string[]): Promise<void>;
}

const SIGNED_UPLOAD_TTL = 7200; // Supabase signed upload URLs are valid for 2 hours.

export function createSupabaseStorage(cfg: Config): StorageAdapter {
  let client: SupabaseClient | undefined;
  const sb = () => {
    if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
      throw new AppError("INTERNAL", "Storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", { status: 503 });
    }
    return (client ??= createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }));
  };
  const bucket = () => sb().storage.from(cfg.bucket);
  const fail = (what: string, err: unknown): never => {
    console.error(`[storage] ${what}:`, err instanceof Error ? err.message : err);
    throw new AppError("INTERNAL", `Storage ${what} failed.`, { status: 502, retryable: true });
  };

  return {
    bucket: cfg.bucket,
    async createUpload(objectKey, contentType) {
      // upsert stays false (default): the signed token cannot overwrite an existing object.
      const { data, error } = await bucket().createSignedUploadUrl(objectKey);
      if (error || !data) return fail("signed upload", error);
      return {
        method: "PUT",
        url: data.signedUrl,
        headers: { "content-type": contentType, "x-upsert": "false" },
        expires_in_seconds: SIGNED_UPLOAD_TTL,
      };
    },
    async createDownloadUrl(objectKey, expiresIn) {
      const { data, error } = await bucket().createSignedUrl(objectKey, expiresIn);
      if (error || !data) return fail("signed download", error);
      return data.signedUrl;
    },
    async createDownloadUrls(objectKeys, expiresIn) {
      if (!objectKeys.length) return {};
      const { data, error } = await bucket().createSignedUrls(objectKeys, expiresIn);
      if (error || !data) return fail("signed downloads", error);
      const out: Record<string, string> = {};
      for (const d of data) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
      return out;
    },
    async stat(objectKey) {
      const { data, error } = await bucket().info(objectKey);
      if (error || !data) {
        const msg = String((error as { message?: string } | null)?.message ?? "");
        if (/not.?found|does not exist|404/i.test(msg) || !error) return null;
        return fail("stat", error);
      }
      return { size: Number(data.size ?? 0), contentType: data.contentType ?? undefined };
    },
    async download(objectKey, maxBytes) {
      const { data, error } = await bucket().download(objectKey);
      if (error || !data) return fail("download", error);
      if (data.size > maxBytes) throw new AppError("WORKER_FAILED", "Stored object exceeds the expected size.");
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(objectKeys) {
      if (!objectKeys.length) return;
      const { error } = await bucket().remove(objectKeys);
      if (error) fail("remove", error);
    },
  };
}
