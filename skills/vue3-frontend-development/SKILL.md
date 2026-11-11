---
name: vue3-frontend-development
description: Build, modify, and review front-end features in Vue 3, JavaScript, and Vite projects. Use for components, pages, composables, UI behavior, and related refactors in this stack.
---

# Vue 3 Front-end Development

Use this skill for work in Vue 3 + JavaScript + Vite repositories. First inspect the existing project structure, package scripts, and nearby code; follow its established conventions and installed libraries. Do not introduce TypeScript, another framework, or a new dependency unless the user requests it or the task requires it.

## Size limits

Treat these as hard limits for every source file you create or materially edit:

- A file must contain no more than **250 physical lines**, including blank lines and comments.
- A function must contain no more than **50 physical lines**, counting from its declaration through its closing brace, including blank lines and comments.

Before finishing, check the line count of each changed or added file and the length of each function in it. Do not solve a limit violation by minifying code, removing useful comments, or moving code into an unrelated oversized file.

## Splitting code

When a file would exceed 250 lines, split it along cohesive responsibilities. In Vue work, prefer extracting reusable UI into focused components and stateful/reusable logic into composables (`use…` functions). Move framework-independent helpers into small utility modules when that makes ownership clearer. Keep a component's template, state, and presentation together when they form one coherent unit; avoid splitting solely to satisfy a number when a clear component or composable boundary is available.

When a function would exceed 50 lines, extract named helpers or smaller composables/components as appropriate. Give each extracted unit a clear responsibility and preserve behavior, event contracts, reactive dependencies, and lifecycle cleanup. Avoid deeply nested callbacks and one-line helper proliferation.

## Working approach

1. Inspect related components, composables, routes, styles, and package scripts to learn local patterns.
2. Make the smallest cohesive change that meets the request, reusing existing components and dependencies.
3. Keep Vue reactivity correct: use `ref`/`computed` where appropriate, avoid destructuring reactive state in ways that lose reactivity, and clean up watchers, timers, and listeners when needed.
4. Keep component props, emitted events, slots, and user-visible loading, empty, and error states aligned with the surrounding application.
5. Review all changed files against both size limits. If an existing file is already over a limit, avoid making it larger; when the requested change touches that area, split a cohesive part as part of the change where practical.
6. Run the relevant existing check or build only when the user asks for verification or it is necessary to establish the requested result. Report what was changed and any validation performed.
