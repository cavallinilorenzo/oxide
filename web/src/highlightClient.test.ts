import { describe, expect, it } from "vitest";
import { createHighlightClient, type HighlightRequest, type HighlightResponse, type WorkerLike } from "./highlightClient";

/** A worker that answers only when told to, recording what it was asked. */
function fakeWorker() {
  const requests: HighlightRequest[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    postMessage: (request: HighlightRequest) => void requests.push(request),
  };
  const reply = (response: HighlightResponse) =>
    worker.onmessage?.({ data: response } as MessageEvent<HighlightResponse>);
  return { worker, requests, reply };
}

describe("highlight client", () => {
  it("highlights in the worker and serves repeats from the cache", async () => {
    const { worker, requests, reply } = fakeWorker();
    const client = createHighlightClient(worker);

    const pending = client.highlight("let x = 1;", "ts");
    expect(client.cached("let x = 1;", "ts")).toBeUndefined();
    expect(requests).toEqual([{ id: requests[0].id, code: "let x = 1;", lang: "ts" }]);
    reply({ id: requests[0].id, html: "<pre>x</pre>" });

    await expect(pending).resolves.toBe("<pre>x</pre>");
    expect(client.cached("let x = 1;", "ts")).toBe("<pre>x</pre>");
    await expect(client.highlight("let x = 1;", "ts")).resolves.toBe("<pre>x</pre>");
    expect(requests.length).toBe(1);
  });

  it("asks the worker once for identical requests in flight", async () => {
    const { worker, requests, reply } = fakeWorker();
    const client = createHighlightClient(worker);

    const a = client.highlight("fn main() {}", "rust");
    const b = client.highlight("fn main() {}", "rust");
    const c = client.highlight("fn main() {}", "go");
    expect(requests.map((r) => r.lang)).toEqual(["rust", "go"]);
    reply({ id: requests[0].id, html: "R" });
    reply({ id: requests[1].id, html: "G" });

    expect(await Promise.all([a, b, c])).toEqual(["R", "R", "G"]);
  });

  it("keeps the cache within its budget of highlighted HTML", async () => {
    const { worker, requests, reply } = fakeWorker();
    const client = createHighlightClient(worker, { cacheBudget: 100 });

    for (let i = 0; i < 20; i++) {
      const pending = client.highlight(`code ${i}`, "ts");
      reply({ id: requests[i].id, html: "h".repeat(30) });
      await pending;
    }
    expect(client.cacheSize()).toBeLessThanOrEqual(100);
    expect(client.cached("code 0", "ts")).toBeUndefined();
    expect(client.cached("code 19", "ts")).toBe("h".repeat(30));
  });

  it("rejects when the worker fails, and tries again next time", async () => {
    const { worker, requests, reply } = fakeWorker();
    const client = createHighlightClient(worker);

    const failed = client.highlight("x", "ts");
    reply({ id: requests[0].id, error: "boom" });
    await expect(failed).rejects.toThrow("boom");

    void client.highlight("x", "ts");
    expect(requests.length).toBe(2);
  });
});
