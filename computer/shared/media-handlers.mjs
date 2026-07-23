/**
 * Shared media handlers for upload and voice transcription.
 * Used by the ai-chat server.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/user";
const UPLOADS_DIR = join(HOME, "uploads");

// Base URL of the in-box control plane that brokers the AI APIs (/internal/ai/*).
// In the OSS native edition the cockpit runs on the host, so the control plane is
// the loopback FastAPI on API_PORT — NOT the `host.docker.internal` Docker gateway
// (which doesn't resolve outside a container, the cause of "Transcription failed
// (502)"). Override with INTERNAL_API_BASE if the plane lives elsewhere.
export const INTERNAL_API_BASE =
  process.env.INTERNAL_API_BASE || `http://127.0.0.1:${process.env.API_PORT || "8000"}`;

/**
 * Auth headers for /internal/ai/* calls: the in-box SHELLTEAM_AI_TOKEN (HMAC
 * secret shared with the control plane) + the user id it was minted for.
 * Returns null when the token isn't configured — callers must handle that
 * loudly (it means the box wasn't installed via install.sh).
 */
export function internalAiAuthHeaders() {
  const token = process.env.SHELLTEAM_AI_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "X-Shellteam-User-Id": process.env.SHELLTEAM_USER_ID || "",
  };
}

// --- Utilities ---

export function readBody(req, maxSize = 200 * 1024 * 1024) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        rej(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

export function jsonResponse(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function extractMultipartFile(body, boundary) {
  const str = body.toString("binary");
  const delim = "--" + boundary;
  const parts = str.split(delim);
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (!headers.includes("filename=")) continue;
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
    const dataStr = part.slice(headerEnd + 4);
    const trimmed = dataStr.endsWith("\r\n") ? dataStr.slice(0, -2) : dataStr;
    return {
      filename: filenameMatch ? filenameMatch[1] : "audio.webm",
      contentType: ctMatch ? ctMatch[1].trim() : "audio/webm",
      data: Buffer.from(trimmed, "binary"),
    };
  }
  return null;
}

// --- File Upload Handler ---

export async function handleUpload(req, res) {
  const filename = req.headers["x-file-name"];
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    jsonResponse(res, 400, { error: "Invalid filename" });
    return;
  }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const body = await readBody(req);
  writeFileSync(join(UPLOADS_DIR, filename), body);
  jsonResponse(res, 200, { ok: true, path: `${UPLOADS_DIR}/${filename}` });
}

// --- Voice Transcription Proxy ---

export async function handleTranscribe(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) {
      jsonResponse(res, 413, { error: "Audio too large" });
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    jsonResponse(res, 400, { error: "Missing multipart boundary" });
    return;
  }
  const boundary = boundaryMatch[1];
  const fileData = extractMultipartFile(body, boundary);
  if (!fileData) {
    jsonResponse(res, 400, { error: "No file in request" });
    return;
  }

  const authHeaders = internalAiAuthHeaders();
  if (!authHeaders) {
    jsonResponse(res, 500, { error: "SHELLTEAM_AI_TOKEN not set" });
    return;
  }

  const formBoundary = "----TranscribeBoundary" + Date.now();
  const header = Buffer.from(
    `--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileData.filename}"\r\nContent-Type: ${fileData.contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${formBoundary}--\r\n`);
  const formBody = Buffer.concat([header, fileData.data, footer]);

  try {
    const resp = await fetch(`${INTERNAL_API_BASE}/internal/ai/stt`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": `multipart/form-data; boundary=${formBoundary}`,
      },
      body: formBody,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error("[media] STT failed:", resp.status, text.slice(0, 200));
      // Forward the control plane's real reason (e.g. "ELEVENLABS_API_KEY not
      // configured") instead of a generic message, so the user can act on it.
      let detail = "Transcription failed";
      try { const j = JSON.parse(text); detail = j.detail || j.error || detail; } catch { /* keep default */ }
      jsonResponse(res, 502, { error: detail });
      return;
    }
    const data = await resp.json();
    jsonResponse(res, 200, { text: data.text || "" });
  } catch (err) {
    console.error("[media] STT error:", err.message);
    jsonResponse(res, 502, { error: "Transcription service unavailable" });
  }
}
