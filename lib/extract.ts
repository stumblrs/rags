/**
 * Local multi-format document extraction (§4.3, §6.1, §12).
 * Supports PDF (with scanned-page OCR fallback), DOCX, XLSX/XLS, PPTX, RTF, Images (PNG/JPG/WEBP via local OCR), CSV, TXT, MD, JSON, HTML.
 */

import { useApp } from "./store";

export const SUPPORTED_EXT = [
  "pdf",
  "docx",
  "xlsx",
  "xls",
  "pptx",
  "rtf",
  "csv",
  "txt",
  "md",
  "json",
  "html",
  "htm",
  "png",
  "jpg",
  "jpeg",
  "webp",
];

export interface ExtractedSection {
  text: string;
  page?: number;
  section?: string;
}

export async function extractDocumentSections(filename: string, buf: ArrayBuffer): Promise<ExtractedSection[]> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") return extractPdf(buf);
  if (ext === "docx") return extractDocx(buf);
  if (ext === "xlsx" || ext === "xls") return extractSpreadsheet(buf);
  if (ext === "pptx") return extractPptx(buf);
  if (ext === "rtf") return extractRtf(new TextDecoder().decode(buf));
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return extractImageOcr(buf, ext);
  if (ext === "csv") return extractCsv(new TextDecoder().decode(buf));
  if (ext === "html" || ext === "htm") {
    const raw = new TextDecoder().decode(buf);
    const doc = new DOMParser().parseFromString(raw, "text/html");
    doc.querySelectorAll("script,style,noscript,iframe").forEach((n) => n.remove());
    return [{ text: doc.body.textContent ?? "" }];
  }
  if (ext === "json") {
    const raw = new TextDecoder().decode(buf);
    try {
      const parsed = JSON.parse(raw);
      return [{ text: JSON.stringify(parsed, null, 2) }];
    } catch {
      return [{ text: raw }];
    }
  }
  const raw = new TextDecoder().decode(buf);
  return extractPlainOrMarkdown(raw);
}

async function runLocalOcrOnBlob(blob: Blob, label: string): Promise<string> {
  if (!useApp.getState().ragSettings.enableOcr) return "";
  try {
    const Tesseract = await import("tesseract.js");
    const res = await Tesseract.recognize(blob, "eng");
    return (res?.data?.text ?? "").replace(/\s+/g, " ").trim();
  } catch {
    throw new Error(`OCR failed on ${label}`);
  }
}

async function extractImageOcr(buf: ArrayBuffer, ext: string): Promise<ExtractedSection[]> {
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  const blob = new Blob([buf.slice(0)], { type: mime });
  const text = await runLocalOcrOnBlob(blob, "image");
  return text ? [{ text, section: "OCR Extracted Text" }] : [];
}

async function extractPdf(buf: ArrayBuffer): Promise<ExtractedSection[]> {
  const pdfjs = await import("pdfjs-dist");
  if (typeof window !== "undefined" && pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf.slice(0)),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const sections: ExtractedSection[] = [];
  const allowOcr = useApp.getState().ragSettings.enableOcr;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean);
    let pageText = strings.join(" ").replace(/\s+/g, " ").trim();

    // If a PDF page has no extractable text layer (scanned PDF) and local OCR is enabled (cap at first 5 scanned pages)
    if (!pageText && allowOcr && p <= 5 && typeof document !== "undefined") {
      try {
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          // Release temporary canvas GPU backing store immediately after PNG encoding
          canvas.width = 0;
          canvas.height = 0;
          if (blob) {
            pageText = await runLocalOcrOnBlob(blob, `Page ${p}`);
          }
        }
      } catch {
        // Ignore OCR fallback error on individual page
      }
    }

    // Release PDF.js page resources after each page to keep memory footprint low on large PDFs
    page.cleanup();

    if (pageText) {
      sections.push({ text: pageText, page: p, section: `Page ${p}` });
    }
  }
  await loadingTask.destroy();
  return sections;
}

async function extractDocx(buf: ArrayBuffer): Promise<ExtractedSection[]> {
  const mammoth = await import("mammoth");
  const res = await mammoth.extractRawText({ arrayBuffer: buf.slice(0) });
  return extractPlainOrMarkdown(res.value || "");
}

async function extractSpreadsheet(buf: ArrayBuffer): Promise<ExtractedSection[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf.slice(0), { type: "array" });
  const sections: ExtractedSection[] = [];
  const ROWS_PER_GROUP = 25;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, { header: 1, blankrows: false });
    if (!rows.length) continue;
    const header = rows[0]?.map((c) => String(c ?? "").trim()).filter(Boolean).join(" | ") || "";

    for (let i = 0; i < rows.length; i += ROWS_PER_GROUP) {
      const slice = rows.slice(i, i + ROWS_PER_GROUP);
      const lines = slice
        .map((r, idx) => {
          const cells = (r ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
          return cells.length ? `Row ${i + idx + 1}: ${cells.join(", ")}` : "";
        })
        .filter(Boolean);
      if (lines.length) {
        const startRow = i + 1;
        const endRow = Math.min(i + ROWS_PER_GROUP, rows.length);
        const text = (header && i > 0 ? `Columns: ${header}\n` : "") + lines.join("\n");
        sections.push({
          text,
          section: `${sheetName} · Rows ${startRow}–${endRow}`,
        });
      }
    }
  }
  return sections;
}

async function extractPptx(buf: ArrayBuffer): Promise<ExtractedSection[]> {
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  const slides: { num: number; text: string }[] = [];

  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
      offset++;
      continue;
    }
    const method = bytes[offset + 8] | (bytes[offset + 9] << 8);
    const compSize =
      (bytes[offset + 18] | (bytes[offset + 19] << 8) | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24)) >>> 0;
    const nameLen = bytes[offset + 26] | (bytes[offset + 27] << 8);
    const extraLen = bytes[offset + 28] | (bytes[offset + 29] << 8);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;

    const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name);
    if (m && dataEnd <= bytes.length) {
      const slideNum = parseInt(m[1], 10);
      const slice = bytes.subarray(dataStart, dataEnd);
      let xml = "";
      if (method === 0) {
        xml = decoder.decode(slice);
      } else if (method === 8 && typeof DecompressionStream !== "undefined") {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(slice);
          writer.close();
          const outBuf = await new Response(ds.readable).arrayBuffer();
          xml = decoder.decode(outBuf);
        } catch {
          // ignore corrupt slide stream
        }
      }
      if (xml) {
        const matches = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((x) =>
          x[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
        );
        const text = matches.filter(Boolean).join(" ");
        if (text) slides.push({ num: slideNum, text });
      }
    }
    offset = compSize > 0 ? dataEnd : offset + 30 + nameLen + extraLen + 1;
  }

  slides.sort((a, b) => a.num - b.num);
  return slides.map((s) => ({
    text: s.text,
    page: s.num,
    section: `Slide ${s.num}`,
  }));
}

/**
 * Cleanly extracts readable text from Rich Text Format (.rtf) files locally (§4.3).
 */
function extractRtf(raw: string): ExtractedSection[] {
  const text = raw
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\line/g, "\n")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, code) => {
      const c = parseInt(code, 10);
      return String.fromCharCode(c < 0 ? c + 65536 : c);
    })
    .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer)[\s\S]*?\}/g, "")
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text ? [{ text, section: "RTF Document" }] : [];
}

function extractCsv(raw: string): ExtractedSection[] {
  const lines = raw.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0];
  const ROWS_PER_GROUP = 25;
  const sections: ExtractedSection[] = [];
  for (let i = 0; i < lines.length; i += ROWS_PER_GROUP) {
    const slice = lines.slice(i, i + ROWS_PER_GROUP);
    const startRow = i + 1;
    const endRow = Math.min(i + ROWS_PER_GROUP, lines.length);
    const body = (i > 0 ? `Header: ${header}\n` : "") + slice.join("\n");
    sections.push({
      text: body,
      section: `Rows ${startRow}–${endRow}`,
    });
  }
  return sections;
}

function extractPlainOrMarkdown(raw: string): ExtractedSection[] {
  const clean = raw.replace(/\r/g, "").trim();
  if (!clean) return [];
  const lines = clean.split("\n");
  const sections: ExtractedSection[] = [];
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (joined) sections.push({ text: joined, section: currentHeading });
    buffer = [];
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (m) {
      flush();
      currentHeading = m[2].trim().slice(0, 60);
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ text: clean }];
}
