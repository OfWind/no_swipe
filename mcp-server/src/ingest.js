export class IngestError extends Error {
  constructor(status, payload) {
    super(payload?.error ?? payload?.message ?? `ingest HTTP ${status}`);
    this.name = "IngestError";
    this.status = status;
    this.payload = payload;
  }
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new IngestError(502, { error: "ingest_returned_invalid_json" });
  }
}

export function createIngestClient(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async ingest(accessToken, body) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetchImpl(config.ingestUrl, {
          method: "POST",
          headers: {
            apikey: config.publishableKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await responseJson(response);
        if (!response.ok) throw new IngestError(response.status, payload);
        return payload;
      } catch (error) {
        if (error?.name === "AbortError") throw new IngestError(504, { error: "ingest_timeout" });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
