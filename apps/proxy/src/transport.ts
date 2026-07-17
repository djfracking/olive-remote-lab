import type { OliveTransport, TransportRequest, TransportResponse } from "@olive-remote-lab/olive-client";
import { assertLocalUrl } from "./security.js";

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
      const body = await response.text();
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
