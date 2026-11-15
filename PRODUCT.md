# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

People who want a nice app on their phone for reading the Stanford Encyclopedia of Philosophy (SEP). The primary use is simply a pleasant reader; serious study is the pleasant surprise, not the pitch. Users should think "this is surprisingly good for studying" after a while, not "this is a dedicated study tool" on first launch. Those who go deep (long sessions, following threads between articles, highlights and notes) find the tools waiting, without the app announcing itself as a study environment.

## Product Purpose

Nous is an unofficial, native reader for the SEP, built to work well with it and with InPhO. It exists so that reading the encyclopedia is fast, offline-capable, and cumulative: what you read, how you got there, and what you marked all stay with you. Success is an app people enjoy opening and reading in, whose study depth reveals itself through use: the trail of what you read, how you got there, and what you marked quietly accumulates.

## Positioning

Compared with reading plato.stanford.edu in a browser, Nous offers:
- a native renderer (not a WebView) with real text selection and offline, searchable library;
- annotations (color-coded, searchable, exportable) and reading history shown as branching trees of how the reader moved between articles;
- a semantic graph (related articles, influence timelines, zoomable graph) powered by InPhO data fetched per-client at runtime.

## Operating Context

Long-form reading of dense academic prose with footnotes, tables of contents, and inline math (MathJax SVG cached in SQLite). Articles are fetched on-device at runtime; the library can be bulk-downloaded at first launch or fetched on demand. Library scope can target SEP only, OWL only, or both.

## Capabilities and Constraints

- Targets: Android, macOS, and iOS (React Native 0.81 / Expo 54; react-native-macos for macOS). Platform is recorded as `adaptive` because the product ships on several OSes; macOS is a desktop target outside the `ios`/`android` references and its design language is an open decision.
- Features: full-text search (FTS5), offline library, annotations, reading history, bookmarks/reading list, TOC sheet, footnote sheet, graph view, settings, onboarding.
- Licensing: app code is GPL-3.0. SEP article text (© Metaphysics Research Lab) and InPhO data (CC BY-NC-SA) are never bundled or redistributed; fetch at runtime only. Allowed to ship: app code, title/link index, empty SQLite schema. See `NOTICE.md`, `AGENTS.md`.
- The app is unofficial and not affiliated with Stanford; the name must not incorporate the Stanford mark.

## Brand Commitments

Name: Nous. Unofficial and non-affiliated status must stay visible in legal copy. No other brand assets confirmed.

## Evidence on Hand

Real SEP content is only ever fetched at runtime; there is no bundled article content to use as sample material. No testimonials, usage data, or press exist and none should be invented.

## Product Principles

1. The text is the product: reading comes before chrome, features, and decoration.
2. Local and cumulative: offline-first, with the reader's notes, history, and bookmarks as lasting assets.
3. Respect the source: SEP and InPhO are credited and fetched, never repackaged or implied to endorse the app.
4. Native on every platform it ships to, not a web page in a shell.
5. Study depth is discovered, not advertised: the app leads as a pleasant reader; annotations, history and the graph are present and findable but never framed as a study dashboard.

## Accessibility & Inclusion

No product-specific standard established. Long-form reading implies adjustable text and strong legibility; confirm requirements before design work.
