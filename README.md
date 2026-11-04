# Personal Local AI — Cognitive AI Dashboard

Next.js (static export) implementation of the Cognitive AI neon dashboard, built as the local-first RAG application described in `Product_Concept_Document.md` and `Cognitive_AI_Dashboard_Developer_Specification.docx`.

## Run
```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # static site in ./out (deploy to Cloudflare Pages / Vercel)
```
Press **Alt+R** to overlay `public/reference-dashboard.png` at 50% opacity for visual QA.

## Features (100% Client-Side, Zero Backend)
- **Step 1 — Interactive Citations, Document Library & Knowledge Spaces**:
  - Click any citation pill (`[1] file.pdf · Page 3 · 88%`) in the chat to open [`CitationModal`](components/CitationModal.tsx), highlighting the matched passage alongside full document chunks.
  - Click the **Document Processing** `⋯` menu, the status bar, or the **Knowledge Graph** hub to open [`DocumentLibraryModal`](components/DocumentLibraryModal.tsx): search documents, preview extracted chunks, rename, reprocess, delete, organize into **Knowledge Spaces** (*Business, Education, Research, Personal*, or custom spaces), or filter chat retrieval to specific documents.
  - Supports **PDF, DOCX, XLSX/XLS, PPTX, CSV, TXT, MD, JSON, HTML** ([`lib/extract.ts`](lib/extract.ts)).
- **Step 2 — Onboarding & Personalization Wizard**:
  - Click the assistant brand icon (top-left) or **Personalize** in the chat `⋯` menu to open [`OnboardingModal`](components/OnboardingModal.tsx): customize assistant name, avatar category (*Cognitive Chat, AI Robot, Neural Knot, Friendly Assistant, Minimal Geometric*), personality, response language, and response style.
  - Includes chat history switching, **Copy**, **Regenerate**, **Export Chat (.md)**, and **Clear Chat**.
- **Step 3 — Storage, Privacy, Backup & Offline PWA**:
  - Click the scanner lock icon in **Document Processing** or **Storage & Models** in the chat `⋯` menu to open [`StorageSettingsModal`](components/StorageSettingsModal.tsx): inspect IndexedDB/OPFS storage usage, request persistent storage, load local AI models (`Xenova/all-MiniLM-L6-v2` embeddings and `SmolLM2-360M-Instruct` WebLLM), **Export Knowledge Base (.json)**, **Import Backup (.json)**, or wipe all local data.
  - Installable as a Progressive Web App (`public/manifest.webmanifest`, `public/sw.js`, `public/icon.svg`) with offline caching.
