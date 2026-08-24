---
name: web-design
description: Design-system-first page and UI construction. Use when building pages, landing sites, dashboards, or components for any project - covers design tokens, responsive layout, accessibility, performance budgets, and RTL readiness.
---

# Web Design — Design-System First

Starter tokens: [`assets/design-system-starter.css`](assets/design-system-starter.css)

## Workflow: tokens → layout → components
1. DEFINE tokens first as CSS custom properties — colors, spacing scale, type scale, radii, shadows. Start from the starter asset; never begin from ad-hoc values.
2. LAY OUT with tokens only — grid/flex containers, breakpoints, container widths. No magic numbers.
3. BUILD components from tokens — buttons, cards, forms, nav — each consuming variables, never raw hex/px values.
4. EXTEND the system before overriding it: a new need becomes a new token or a new component, not a one-off hack.

## Responsive breakpoints
- Go mobile-first: base styles for small screens, then `min-width` media queries.
- Standard steps: 640px (sm) · 768px (md) · 1024px (lg) · 1280px (xl). Use fewer if the design allows.
- Verify at 375px, 768px, and 1440px minimum. Prefer fluid sizing via `clamp()` for type and spacing.

## Accessibility basics
- Write semantic HTML first: `header/nav/main/section/footer`, real `<button>` and `<a>` elements.
- One `h1` per page; logical heading order; label every input; alt text on meaningful images.
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI. Keep visible focus states — never remove outlines without replacement.
- Make everything keyboard-operable; honor `prefers-reduced-motion`.

## Performance budgets
- Target Lighthouse > 90 across Performance, Accessibility, Best Practices, and SEO.
- Budgets: JS ≤ 170KB gzipped · CSS ≤ 60KB · images compressed + lazy-loaded · fonts subset with `font-display: swap`.
- Ship no render-blocking third-party scripts; inline critical CSS or load it asynchronously.

## RTL readiness
- Use logical properties (`margin-inline-start`, `padding-inline-end`, `inset-inline`) instead of left/right.
- Ensure the design mirrors cleanly under `[dir="rtl"]` — the starter asset ships RTL-ready defaults.
