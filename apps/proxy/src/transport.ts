import type { OliveTransport, TransportRequest, TransportResponse } from "@olive-remote-lab/olive-client";
import { assertLocalUrl } from "./security.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Olive response exceeded the 8 MiB safety limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Olive response exceeded the 8 MiB safety limit.");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

export class LocalHttpTransport implements OliveTransport {
  public async request(request: TransportRequest): Promise<TransportResponse> {
    await assertLocalUrl(request.url);
    return this.performRequest(request);
  }

  private async performRequest(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 5_000);
    const started = performance.now();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
      const body = await boundedResponseText(response);
      return {
        url: request.url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${request.timeoutMs ?? 5_000} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
