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
