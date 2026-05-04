import { describe, expect, it, vi } from "vitest";
import type { Page, Request, Response } from "playwright";
import { NetworkCollector } from "../../../src/observability/collectors/network-collector.js";
import type { ExecutionContext } from "../../../src/executor/context.js";

const mockCtx = {} as ExecutionContext;

interface FakeFrame {
  url(): string;
}

type RequestEvent = "request" | "response" | "requestfailed" | "requestfinished";
type EventHandler<T> = (arg: T) => void;

interface FakePage {
  on(event: RequestEvent, handler: EventHandler<Request | Response>): void;
  off(event: RequestEvent, handler: EventHandler<Request | Response>): void;
  emit(event: RequestEvent, arg: Request | Response): void;
  handlers: Map<RequestEvent, Set<EventHandler<Request | Response>>>;
}

const createFakePage = (): FakePage => {
  const handlers = new Map<RequestEvent, Set<EventHandler<Request | Response>>>();
  return {
    handlers,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, arg) {
      for (const h of handlers.get(event) ?? []) h(arg);
    },
  };
};

interface RequestStub {
  url: string;
  method: string;
  resourceType: string;
  frameUrl: string;
  failureText?: string;
  timing?: { startTime: number; responseEnd: number };
}

const makeRequest = (stub: RequestStub): Request => {
  const frame: FakeFrame = { url: () => stub.frameUrl };
  return {
    url: () => stub.url,
    method: () => stub.method,
    resourceType: () => stub.resourceType,
    frame: () => frame,
    failure: () => (stub.failureText ? { errorText: stub.failureText } : null),
    timing: () =>
      stub.timing ?? { startTime: 0, responseEnd: 0 },
  } as unknown as Request;
};

const makeResponse = (req: Request, status: number): Response => ({
  request: () => req,
  url: () => req.url(),
  status: () => status,
}) as unknown as Response;

describe("NetworkCollector", () => {
  const DEFAULT_OPTS = { captureLimit: 500, duplicateWindowMs: 500 };

  it("registers handlers for all four Playwright request events", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);
    expect(page.handlers.get("request")?.size).toBe(1);
    expect(page.handlers.get("response")?.size).toBe(1);
    expect(page.handlers.get("requestfailed")?.size).toBe(1);
    expect(page.handlers.get("requestfinished")?.size).toBe(1);
  });

  it("records a request entry with url/method/frameUrl/timestamp", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = makeRequest({
      url: "https://example.com/api",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", req);

    const snap = await collector.snapshot();
    expect(snap.requests).toHaveLength(1);
    expect(snap.requests[0]).toMatchObject({
      url: "https://example.com/api",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    expect(snap.requests[0]?.status).toBeUndefined();
  });

  it("response event fills status on the matching request (identity-keyed)", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = makeRequest({
      url: "https://example.com/api",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", req);
    page.emit("response", makeResponse(req, 200));

    const snap = await collector.snapshot();
    expect(snap.requests[0]?.status).toBe(200);
  });

  it("does NOT cross-wire status between concurrent requests to same URL+method", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const reqA = makeRequest({
      url: "https://example.com/api",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    const reqB = makeRequest({
      url: "https://example.com/api",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", reqA);
    page.emit("request", reqB);
    // Response for A arrives before B's response
    page.emit("response", makeResponse(reqA, 200));
    page.emit("response", makeResponse(reqB, 500));

    const snap = await collector.snapshot();
    expect(snap.requests[0]?.status).toBe(200);
    expect(snap.requests[1]?.status).toBe(500);
  });

  it("4xx status lands in failedRequests", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);
    const req = makeRequest({
      url: "https://example.com/missing",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", req);
    page.emit("response", makeResponse(req, 404));

    const snap = await collector.snapshot();
    expect(snap.issues.failedRequests).toEqual([
      { url: "https://example.com/missing", method: "GET", status: 404 },
    ]);
  });

  it("DNS failure (ERR_NAME_NOT_RESOLVED) lands in networkFailures, NOT failedRequests", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);
    const req = makeRequest({
      url: "http://nonexistent.invalid/",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
      failureText: "net::ERR_NAME_NOT_RESOLVED",
    });
    page.emit("request", req);
    page.emit("requestfailed", req);

    const snap = await collector.snapshot();
    expect(snap.issues.failedRequests).toHaveLength(0);
    expect(snap.issues.networkFailures).toEqual([
      {
        url: "http://nonexistent.invalid/",
        method: "GET",
        reason: "net::ERR_NAME_NOT_RESOLVED",
      },
    ]);
    expect(snap.issues.corsErrors).toHaveLength(0);
  });

  it("CORS failure routes to corsErrors, not networkFailures", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);
    const req = makeRequest({
      url: "https://other-origin.invalid/",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
      failureText: "net::ERR_FAILED because blocked by CORS policy",
    });
    page.emit("request", req);
    page.emit("requestfailed", req);

    const snap = await collector.snapshot();
    expect(snap.issues.corsErrors).toHaveLength(1);
    expect(snap.issues.networkFailures).toHaveLength(0);
  });

  it("two identical GETs within duplicateWindow → duplicate group reported", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const req1 = makeRequest({
      url: "https://example.com/dup",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", req1);
    nowSpy.mockReturnValue(now + 200);
    const req2 = makeRequest({
      url: "https://example.com/dup",
      method: "GET",
      resourceType: "xhr",
      frameUrl: "https://example.com/",
    });
    page.emit("request", req2);
    nowSpy.mockRestore();

    const snap = await collector.snapshot();
    expect(snap.issues.duplicates).toHaveLength(1);
    expect(snap.issues.duplicates[0]?.count).toBe(2);
    expect(snap.summary).toMatchObject({
      requestCount: 2,
      duplicateGroupCount: 1,
      issueCount: 1,
      captureLimit: 500,
      truncated: false,
      resourceTypes: { xhr: 2 },
      methods: { GET: 2 },
      statusCodes: {},
    });
  });

  it("two identical GETs 1s apart → NOT a duplicate (outside 500ms window)", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    page.emit(
      "request",
      makeRequest({
        url: "https://example.com/x",
        method: "GET",
        resourceType: "xhr",
        frameUrl: "https://example.com/",
      }),
    );
    nowSpy.mockReturnValue(now + 1000);
    page.emit(
      "request",
      makeRequest({
        url: "https://example.com/x",
        method: "GET",
        resourceType: "xhr",
        frameUrl: "https://example.com/",
      }),
    );
    nowSpy.mockRestore();

    const snap = await collector.snapshot();
    expect(snap.issues.duplicates).toHaveLength(0);
  });

  it("mixed content: https frame + http resource → flagged", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = makeRequest({
      url: "http://cdn.example/x.png",
      method: "GET",
      resourceType: "image",
      frameUrl: "https://secure.example/",
    });
    page.emit("request", req);

    const snap = await collector.snapshot();
    expect(snap.issues.mixedContent).toEqual(["http://cdn.example/x.png"]);
  });

  it("mixed content: http frame + http resource → NOT flagged", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = makeRequest({
      url: "http://cdn.example/x.png",
      method: "GET",
      resourceType: "image",
      frameUrl: "http://archive.example/",
    });
    page.emit("request", req);

    const snap = await collector.snapshot();
    expect(snap.issues.mixedContent).toHaveLength(0);
  });

  it("data: URLs never flagged as mixed content", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = makeRequest({
      url: "data:image/png;base64,abc",
      method: "GET",
      resourceType: "image",
      frameUrl: "https://secure.example/",
    });
    page.emit("request", req);

    const snap = await collector.snapshot();
    expect(snap.issues.mixedContent).toHaveLength(0);
  });

  it("captureLimit caps requests; later events on uncaptured requests are silent no-ops", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector({ captureLimit: 3, duplicateWindowMs: 500 });
    await collector.attach(page as unknown as Page, mockCtx);

    const reqs: Request[] = [];
    for (let i = 0; i < 5; i++) {
      const r = makeRequest({
        url: `https://example.com/${i}`,
        method: "GET",
        resourceType: "xhr",
        frameUrl: "https://example.com/",
      });
      reqs.push(r);
      page.emit("request", r);
    }
    page.emit("response", makeResponse(reqs[4]!, 200));

    const snap = await collector.snapshot();
    expect(snap.requests).toHaveLength(3);
    // Requests 0..2 stored; 3 and 4 dropped. Response on 4 must not throw or affect anything.
  });

  it("detach calls page.off for each listener and clears map", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);
    expect(page.handlers.get("request")?.size).toBe(1);
    await collector.detach();
    expect(page.handlers.get("request")?.size).toBe(0);
    expect(page.handlers.get("response")?.size).toBe(0);
    expect(page.handlers.get("requestfailed")?.size).toBe(0);
    expect(page.handlers.get("requestfinished")?.size).toBe(0);
  });

  it("detached frame: frame().url() throws → frameUrl remains undefined, mixed-content skips safely", async () => {
    const page = createFakePage();
    const collector = new NetworkCollector(DEFAULT_OPTS);
    await collector.attach(page as unknown as Page, mockCtx);

    const req = {
      url: () => "http://cdn.example/x.png",
      method: () => "GET",
      resourceType: () => "image",
      frame: () => {
        throw new Error("frame detached");
      },
      failure: () => null,
      timing: () => ({ startTime: 0, responseEnd: 0 }),
    } as unknown as Request;
    page.emit("request", req);

    const snap = await collector.snapshot();
    expect(snap.requests[0]?.frameUrl).toBeUndefined();
    expect(snap.issues.mixedContent).toHaveLength(0);
  });
});
