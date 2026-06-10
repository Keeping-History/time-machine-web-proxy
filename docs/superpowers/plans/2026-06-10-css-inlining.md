# CSS Inlining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline `<link rel="stylesheet">` tags as `<style>` blocks in every HTML response so archived pages render correctly in div-based frames and WebSocket clients that cannot make secondary requests.

**Architecture:** A new async `inlineCssLinks` function in `src/lib/url-rewriter.ts` receives the already-rewritten HTML string, re-parses it with parse5, fetches each qualifying stylesheet via a caller-supplied `fetchCss(cssUrl, ts)` callback, rewrites `url()` references inside the fetched CSS, replaces each `<link>` node with a `<style>` node, and serializes. `ProxyService.fetchCore` calls it immediately after `rewriteHtmlUrls`, passing a `buildCssFetcher()` closure that resolves CSS from cache or live via `directClient`.

**Tech Stack:** TypeScript, parse5 (already a dependency), Jest + ts-jest (existing test harness), Node.js `fs.promises`.

---

## File Map

| File | Change |
|---|---|
| `src/lib/url-rewriter.ts` | Add `inlineCssLinks` export (new function at bottom of file) |
| `src/services/proxy.ts` | Add `buildCssFetcher` private method; call `inlineCssLinks` after `rewriteHtmlUrls` in `fetchCore` |
| `tests/lib/url-rewriter.inline-css.test.ts` | New file — unit tests for `inlineCssLinks` |
| `tests/services/proxy.test.ts` | Add integration test block for CSS inlining |

---

## Task 1: Unit tests for `inlineCssLinks` (failing)

**Files:**
- Create: `tests/lib/url-rewriter.inline-css.test.ts`

The test file must import `inlineCssLinks` from `../../src/lib/url-rewriter` — which does not exist yet, so these tests will fail to compile/run until Task 2.

- [ ] **Step 1.1: Create the test file**

```typescript
import { inlineCssLinks } from "../../src/lib/url-rewriter";

const TIME = "20010912000000";
const PROXY_BASE = "https://proxy.example.com";

// Helper: build a proxy-path href as rewriteHtmlUrls would emit it
const proxyPath = (cssUrl: string, ts = TIME) => `/web/${ts}/${cssUrl}`;
const proxyAbsolute = (cssUrl: string, ts = TIME) => `${PROXY_BASE}/web/${ts}/${cssUrl}`;

const CSS_URL = "http://www.novell.com/inc/main.css";
const CSS_CONTENT = "body { color: red; }";

const noFetch = jest.fn().mockResolvedValue(null);
const fetchReturns = (content: string) => jest.fn().mockResolvedValue(content);

describe("inlineCssLinks", () => {
  beforeEach(() => jest.clearAllMocks());

  it("replaces a single <link rel='stylesheet'> with a <style> block", async () => {
    const html = `<html><head><link rel="stylesheet" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(CSS_CONTENT), TIME, false, "");
    expect(result).toContain(`<style>${CSS_CONTENT}</style>`);
    expect(result).not.toContain("<link");
  });

  it("rewrites url() references inside inlined CSS", async () => {
    const imgUrl = "http://www.novell.com/images/bg.png";
    const rawCss = `body { background: url(/web/${TIME}/${imgUrl}); }`;
    const html = `<html><head><link rel="stylesheet" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(rawCss), TIME, false, "");
    // rewriteCssUrls should rewrite the url() to a proxy path
    expect(result).toContain(`/web/${TIME}/${imgUrl}`);
  });

  it("preserves the media attribute as <style media='...'>", async () => {
    const html = `<html><head><link rel="stylesheet" media="print" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(CSS_CONTENT), TIME, false, "");
    expect(result).toContain(`<style media="print">`);
  });

  it("leaves <link> intact when fetchCss returns null", async () => {
    const html = `<html><head><link rel="stylesheet" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, noFetch, TIME, false, "");
    expect(result).toContain("<link");
    expect(result).not.toContain("<style");
  });

  it("handles multiple stylesheets independently", async () => {
    const CSS_URL_2 = "http://www.novell.com/inc/extra.css";
    const CSS_CONTENT_2 = "h1 { font-size: 2em; }";
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(CSS_CONTENT)
      .mockResolvedValueOnce(CSS_CONTENT_2);
    const html = `<html><head>
      <link rel="stylesheet" href="${proxyPath(CSS_URL)}">
      <link rel="stylesheet" href="${proxyPath(CSS_URL_2)}">
    </head><body></body></html>`;
    const result = await inlineCssLinks(html, fetch, TIME, false, "");
    expect(result).toContain(CSS_CONTENT);
    expect(result).toContain(CSS_CONTENT_2);
    expect(result).not.toContain("<link");
  });

  it("does NOT replace rel='alternate stylesheet'", async () => {
    const html = `<html><head><link rel="alternate stylesheet" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const fetch = jest.fn().mockResolvedValue(CSS_CONTENT);
    const result = await inlineCssLinks(html, fetch, TIME, false, "");
    expect(result).toContain("<link");
    // fetchCss must NOT have been called — multi-token rel is excluded
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT replace rel='stylesheet preload'", async () => {
    const html = `<html><head><link rel="stylesheet preload" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const fetch = jest.fn().mockResolvedValue(CSS_CONTENT);
    const result = await inlineCssLinks(html, fetch, TIME, false, "");
    expect(result).toContain("<link");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT touch non-stylesheet <link> tags", async () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon.ico">
      <link rel="canonical" href="http://example.com/">
    </head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(CSS_CONTENT), TIME, false, "");
    expect(result).toContain('rel="icon"');
    expect(result).toContain('rel="canonical"');
    expect(result).not.toContain("<style");
  });

  it("strips proxyBase origin from absolute proxy href before resolving", async () => {
    const html = `<html><head><link rel="stylesheet" href="${proxyAbsolute(CSS_URL)}"></head><body></body></html>`;
    const fetch = fetchReturns(CSS_CONTENT);
    const result = await inlineCssLinks(html, fetch, TIME, false, PROXY_BASE);
    expect(result).toContain(`<style>${CSS_CONTENT}</style>`);
    expect(fetch).toHaveBeenCalledWith(CSS_URL, TIME);
  });

  it("leaves <link> intact when href is not a proxy-format URL", async () => {
    const html = `<html><head><link rel="stylesheet" href="http://external.example.com/style.css"></head><body></body></html>`;
    const fetch = fetchReturns(CSS_CONTENT);
    const result = await inlineCssLinks(html, fetch, TIME, false, "");
    expect(result).toContain("<link");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles rel='STYLESHEET' (uppercase)", async () => {
    const html = `<html><head><link rel="STYLESHEET" href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(CSS_CONTENT), TIME, false, "");
    expect(result).toContain(`<style>${CSS_CONTENT}</style>`);
  });

  it("handles rel='  stylesheet  ' (surrounding whitespace)", async () => {
    const html = `<html><head><link rel="  stylesheet  " href="${proxyPath(CSS_URL)}"></head><body></body></html>`;
    const result = await inlineCssLinks(html, fetchReturns(CSS_CONTENT), TIME, false, "");
    expect(result).toContain(`<style>${CSS_CONTENT}</style>`);
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail (function not yet exported)**

```bash
npx jest tests/lib/url-rewriter.inline-css.test.ts --no-coverage 2>&1 | head -30
```

Expected: compile error — `inlineCssLinks` is not exported from `url-rewriter`.

---

## Task 2: Implement `inlineCssLinks` in `url-rewriter.ts`

**Files:**
- Modify: `src/lib/url-rewriter.ts` (append after `stripWaybackToolbar`)

`RE_WAYBACK_PATH` is already defined at line 37 of `url-rewriter.ts`. The new function uses it directly — no import needed.

- [ ] **Step 2.1: Append `inlineCssLinks` to `src/lib/url-rewriter.ts`**

Add the following after the existing `stripWaybackToolbar` export at the bottom of the file:

```typescript
const isStylesheetLink = (node: Node): node is Element => {
	if (!isElement(node) || node.tagName.toLowerCase() !== "link") return false;
	const rel = node.attrs.find((a) => a.name === "rel")?.value ?? "";
	const tokens = rel.trim().toLowerCase().split(/\s+/);
	return tokens.length === 1 && tokens[0] === "stylesheet";
};

export const inlineCssLinks = async (
	html: string,
	fetchCss: (cssUrl: string, ts: string) => Promise<string | null>,
	time: string,
	lockTime: boolean,
	proxyBase: string,
): Promise<string> => {
	const doc = parse(html);
	const linkNodes: Element[] = [];

	const collectLinks = (node: Node): void => {
		if (isStylesheetLink(node)) {
			linkNodes.push(node as Element);
		}
		if (hasChildNodes(node)) {
			for (const child of node.childNodes) collectLinks(child);
		}
	};
	collectLinks(doc);

	for (const link of linkNodes) {
		const hrefAttr = link.attrs.find((a) => a.name === "href");
		if (!hrefAttr?.value) continue;

		const rawHref = hrefAttr.value;
		const path =
			proxyBase && rawHref.startsWith(proxyBase) ? rawHref.slice(proxyBase.length) : rawHref;
		const match = path.match(RE_WAYBACK_PATH);
		if (!match) continue;

		const [, ts, cssUrl] = match;
		const resolvedTs = ts ?? time;

		const cssContent = await fetchCss(cssUrl, resolvedTs);
		if (!cssContent) continue;

		const rewritten = rewriteCssUrls(cssContent, cssUrl, resolvedTs, lockTime, undefined, undefined, proxyBase);

		const styleNode = defaultTreeAdapter.createElement(
			"style",
			"http://www.w3.org/1999/xhtml" as unknown as Parameters<
				typeof defaultTreeAdapter.createElement
			>[1],
			[],
		);

		const mediaAttr = link.attrs.find((a) => a.name === "media");
		if (mediaAttr) {
			styleNode.attrs.push({ name: "media", value: mediaAttr.value });
		}

		const textNode = defaultTreeAdapter.createTextNode(rewritten);
		defaultTreeAdapter.appendChild(styleNode, textNode);

		const parent = link.parentNode as ParentNode;
		const idx = parent.childNodes.indexOf(link);
		parent.childNodes.splice(idx, 1, styleNode);
		styleNode.parentNode = parent;
	}

	return serialize(doc);
};
```

- [ ] **Step 2.2: Run the unit tests — all should pass**

```bash
npx jest tests/lib/url-rewriter.inline-css.test.ts --no-coverage
```

Expected: all tests in the file pass.

- [ ] **Step 2.3: Run the full url-rewriter test suite to check for regressions**

```bash
npx jest tests/lib/url-rewriter.test.ts --no-coverage
```

Expected: all existing tests pass unchanged.

- [ ] **Step 2.4: Commit**

```bash
git add src/lib/url-rewriter.ts tests/lib/url-rewriter.inline-css.test.ts
git commit -F - <<'EOF'
feat(url-rewriter): add inlineCssLinks — inline stylesheet <link> as <style> blocks
EOF
```

---

## Task 3: Wire `inlineCssLinks` into `ProxyService`

**Files:**
- Modify: `src/services/proxy.ts`

- [ ] **Step 3.1: Add `inlineCssLinks` to the import in `proxy.ts`**

In `src/services/proxy.ts`, find the line:

```typescript
import { rewriteCssUrls, rewriteHtmlUrls, stripWaybackToolbar } from "../lib/url-rewriter";
```

Change it to:

```typescript
import { inlineCssLinks, rewriteCssUrls, rewriteHtmlUrls, stripWaybackToolbar } from "../lib/url-rewriter";
```

- [ ] **Step 3.2: Add `buildCssFetcher` private method to `ProxyService`**

Add this method to the `ProxyService` class, after `fetchCore` and before `maybeEnqueueDomainCrawl`:

```typescript
private buildCssFetcher(): (cssUrl: string, ts: string) => Promise<string | null> {
    return async (cssUrl: string, ts: string): Promise<string | null> => {
        try {
            const hit = await this.cache.lookup(cssUrl, ts);
            if (hit) {
                const raw = await fs.readFile(hit.absPath);
                return raw.toString("utf-8");
            }
            if (!this.directClient) return null;
            const result = await this.directClient.fetchAtRequestedTime(cssUrl, ts);
            if (result.outcome !== "ok" || !result.body) return null;
            await this.cache.writeFile(cssUrl, ts, result.body);
            await this.cache.writeContentTypeSidecar(cssUrl, ts, "text/css");
            if (result.resolvedTime) {
                await this.cache.writeResolvedTimeSidecar(ts, cssUrl, result.resolvedTime);
            }
            return result.body.toString("utf-8");
        } catch {
            return null;
        }
    };
}
```

- [ ] **Step 3.3: Call `inlineCssLinks` in `fetchCore` after `rewriteHtmlUrls`**

In `fetchCore`, find this block (around line 157–164):

```typescript
		if (isHtml) {
			const stripped = stripWaybackToolbar(raw.toString("utf-8"));
			const { html, discoveredAssets } = rewriteHtmlUrls(
				stripped,
				targetUrl,
				time,
				this.config.lockTime,
				this.config.proxyBase,
			);
			body = html;
```

Change `body = html;` to:

```typescript
			body = await inlineCssLinks(
				html,
				this.buildCssFetcher(),
				time,
				this.config.lockTime,
				this.config.proxyBase,
			);
```

The `fetchCore` method signature must become `async` if it isn't already — check; it already is (`private async fetchCore`).

- [ ] **Step 3.4: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3.5: Commit**

```bash
git add src/services/proxy.ts
git commit -F - <<'EOF'
feat(proxy): wire inlineCssLinks into fetchCore HTML pipeline
EOF
```

---

## Task 4: Integration test for CSS inlining in `ProxyService`

**Files:**
- Modify: `tests/services/proxy.test.ts`

The test file already has full mock infrastructure (`makeCache`, `makeDirectClient`, `mockedReadFile`). Add a new `describe` block at the end of the file.

- [ ] **Step 4.1: Write the failing integration test**

Append this block to `tests/services/proxy.test.ts`:

```typescript
// --- CSS inlining -----------------------------------------------------------

describe("ProxyService.fetch — CSS inlining", () => {
  const CSS_URL = "http://www.example.com/style.css";
  const CSS_TS = TIME;
  const CSS_CONTENT = "body { color: red; }";

  // baseConfig doesn't include lockTime/cdxCacheEnabled; supply them explicitly
  // so buildCssFetcher receives a well-typed config and rewriteCssUrls gets
  // lockTime=false rather than undefined.
  const inlineConfig = { ...baseConfig, lockTime: false, cdxCacheEnabled: false } as unknown as typeof baseConfig;

  const htmlWithLink = (href: string) =>
    `<html><head><link rel="stylesheet" href="${href}"></head><body>hello</body></html>`;

  it("inlines a cached stylesheet as a <style> block", async () => {
    const proxyHref = `http://localhost:8080/web/${CSS_TS}/${CSS_URL}`;
    const html = htmlWithLink(proxyHref);

    // HTML page: cache HIT
    const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
    // CSS: cache HIT
    const cssHitLocal: CacheHit = { absPath: "/cache/style.css", contentType: "text/css" };

    const cacheLookup = jest
      .fn()
      .mockImplementation((url: string, _ts: string) => {
        if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
        if (url === CSS_URL) return Promise.resolve(cssHitLocal);
        return Promise.resolve(null);
      });

    const cache = makeCache(cacheLookup);
    const client = makeClient();

    // readFile: first call returns HTML, second returns CSS
    mockedReadFile
      .mockResolvedValueOnce(Buffer.from(html))
      .mockResolvedValueOnce(Buffer.from(CSS_CONTENT));

    const svc = new ProxyService(cache, client, logger, inlineConfig);
    const result = await svc.fetch(TARGET_HTML_URL, TIME);

    expect(String(result.body)).toContain(`<style>${CSS_CONTENT}</style>`);
    expect(String(result.body)).not.toContain('<link rel="stylesheet"');
  });

  it("inlines a stylesheet fetched live (cache miss, directClient available)", async () => {
    const proxyHref = `http://localhost:8080/web/${CSS_TS}/${CSS_URL}`;
    const html = htmlWithLink(proxyHref);

    // HTML page: cache HIT; CSS: cache MISS
    const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
    const cacheLookup = jest
      .fn()
      .mockImplementation((url: string, _ts: string) => {
        if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
        return Promise.resolve(null); // CSS miss
      });

    const cache = makeCache(cacheLookup);
    const client = makeClient();
    const directClient = makeDirectClient();
    directClient.fetchAtRequestedTime.mockResolvedValueOnce({
      outcome: "ok",
      body: Buffer.from(CSS_CONTENT),
      contentType: "text/css",
    });

    mockedReadFile.mockResolvedValueOnce(Buffer.from(html));

    const svc = new ProxyService(cache, client, logger, inlineConfig, null, directClient);
    const result = await svc.fetch(TARGET_HTML_URL, TIME);

    expect(String(result.body)).toContain(`<style>${CSS_CONTENT}</style>`);
    expect(String(result.body)).not.toContain('<link rel="stylesheet"');
    expect(cache.writeFile).toHaveBeenCalledWith(CSS_URL, CSS_TS, expect.any(Buffer));
    expect(cache.writeContentTypeSidecar).toHaveBeenCalledWith(CSS_URL, CSS_TS, "text/css");
    expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
  });

  it("leaves <link> intact when CSS fetch fails", async () => {
    const proxyHref = `http://localhost:8080/web/${CSS_TS}/${CSS_URL}`;
    const html = htmlWithLink(proxyHref);

    const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
    const cacheLookup = jest
      .fn()
      .mockImplementation((url: string, _ts: string) => {
        if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
        return Promise.resolve(null);
      });

    const cache = makeCache(cacheLookup);
    const client = makeClient();
    const directClient = makeDirectClient();
    directClient.fetchAtRequestedTime.mockResolvedValueOnce({ outcome: "not_found" });

    mockedReadFile.mockResolvedValueOnce(Buffer.from(html));

    const svc = new ProxyService(cache, client, logger, inlineConfig, null, directClient);
    const result = await svc.fetch(TARGET_HTML_URL, TIME);

    expect(String(result.body)).toContain('<link rel="stylesheet"');
    expect(String(result.body)).not.toContain("<style>");
  });
});
```

- [ ] **Step 4.2: Run the new test block to verify it fails (before implementation is wired)**

If you're working sequentially after Task 3, these should now pass. If running before Task 3, expect failures. Either way, confirm:

```bash
npx jest tests/services/proxy.test.ts --no-coverage -t "CSS inlining"
```

- [ ] **Step 4.3: Run the full proxy test suite**

```bash
npx jest tests/services/proxy.test.ts --no-coverage
```

Expected: all tests pass (new + existing).

- [ ] **Step 4.4: Run the full test suite**

```bash
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 4.5: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4.6: Commit**

```bash
git add tests/services/proxy.test.ts
git commit -F - <<'EOF'
test(proxy): add integration tests for CSS inlining
EOF
```

---

## Done

All tasks complete when:
- `npx jest --no-coverage` passes with zero failures
- `npm run typecheck` exits clean
- Every HTML response now has `<link rel="stylesheet">` tags replaced by inline `<style>` blocks (or left as-is on fetch failure)
