import { authHeaders } from "@/lib/auth";

export interface UploadedFile {
  key: string;
  size: number;
  mimeType: string;
  fileName: string;
  contentHash: string;
}

/**
 * Upload a file as multipart to the server, which sniffs its real type
 * and stores it. The returned key is then passed to inbox.create or
 * attachments.add. Throws with the server's message on refusal.
 */
export async function uploadFile(file: File, scope: "inbox" | "attachments"): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("scope", scope);
  const res = await fetch("/api/upload", {
    method: "POST",
    body: form,
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  return (await res.json()) as UploadedFile;
}
