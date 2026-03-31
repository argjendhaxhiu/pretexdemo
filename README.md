# pretexdemo

A small Vite + TypeScript demo that uses `@chenglou/pretext` to flow text around an irregular image silhouette.

## What it shows

- Segment-based text layout with Pretext (without DOM measurement loops)
- Contour-style wrapping around a draggable PNG specimen
- A simple, interactive editorial-style page rendered on a canvas

## Tech stack

- TypeScript
- Vite
- `@chenglou/pretext`

## Getting started

```bash
npm install
npm run dev
```

The app runs on `http://localhost:5173`.

## Build and preview

```bash
npm run build
npm run preview
```

## Notes

- Vite base path is configured as `/pretexdemo/` in `vite.config.ts`.
- Main app logic lives in `src/main.ts`.
