---
name: seo
description: Metadata, crawlability, and rendering fidelity for search-visible pages.
version: 1.0.0
---

# SEO Testing Guidance

E2E catches the SEO regressions that static linting won't: post-hydration DOM shape, canonical mismatches, client-only content.

## Things worth asserting

- [ ] `<title>` is non-empty and page-specific (not "React App" or the framework default).
- [ ] Exactly one `<link rel="canonical">` points to the URL the page should be indexed at.
- [ ] `<meta name="description">` exists and is 50–160 characters.
- [ ] Open Graph + Twitter Card tags present on public pages: `og:title`, `og:image`, `og:url`, `twitter:card`.
- [ ] Structured data validates — presence of at least the expected `@type` for the page category (Product / Article / Organization).

## Flow patterns

Assert metadata after navigation:

```yaml
- navigate: /products/abc
- evalScript: |
    const canonical = document.querySelector('link[rel=canonical]')?.href;
    const title = document.title;
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    return { canonical, title, ogTitle };
- assertWithAI:
    assertion: "The page metadata (title, canonical, og:title) refers to a specific product — not a generic catch-all."
```

For SSR vs hydrated rendering parity, flag any element that exists at initial HTML but gets replaced on hydration — a pre-hydrate snapshot via `runScript` + comparison to post-hydrate DOM catches this.

## Red flags — file a bug

- Client-rendered content inside tags that bots read (title / meta / structured data) — JS-dependent SEO is fragile.
- Multiple H1s on a page, or H1 that depends on carousel state.
- Canonical pointing to itself when it should point to a cleaner URL (losing rank signals).
- `robots` meta set to `noindex` on pages that should be indexed (staging config leaking to prod).
- Duplicate content between `/path` and `/path/` without a canonical.
