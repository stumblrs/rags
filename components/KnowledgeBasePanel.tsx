"use client";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { topTerms } from "@/lib/rag";
import { useApp } from "@/lib/store";

export default function KnowledgeBasePanel({ onSelectTerm }: { onSelectTerm?: (term: string) => void }) {
  const { activeSpaceId, openModal } = useApp();
  const allDocs = useLiveQuery(() => db.documents.where("status").equals("indexed").toArray(), []) ?? [];
  const spaceDocs = useLiveQuery(() => db.space_documents.toArray(), []) ?? [];
  const [terms, setTerms] = useState<string[]>([]);

  const docs = activeSpaceId
    ? allDocs.filter((d) => spaceDocs.some((sd) => sd.space_id === activeSpaceId && sd.document_id === d.document_id))
    : allDocs;

  useEffect(() => {
    topTerms(6, activeSpaceId).then(setTerms);
  }, [docs.length, activeSpaceId]);

  const leftLabels = docs.length
    ? docs.slice(0, 6).map((d) => d.filename.replace(/\.[^.]+$/, "").slice(0, 16))
    : ["PDF_DOCS", "WORD_FILES", "SPREADSHEETS", "SLIDE_DECKS", "MARKDOWN", "NOTES_CSV"];

  const rightLabels = terms.length
    ? terms.slice(0, 6).map((t) => `#${t.slice(0, 14)}`)
    : ["#entities", "#metrics", "#findings", "#citations", "#context", "#summary"];

  const leftY = leftLabels.map((_, i) => 42 + i * (216 / Math.max(1, leftLabels.length - 1 || 1)));
  const rightY = rightLabels.map((_, i) => 42 + i * (216 / Math.max(1, rightLabels.length - 1 || 1)));
  const cx = 260, cy = 150, r = 34;

  return (
    <div style={{ width: "100%", height: 290, position: "relative" }}>
      <svg viewBox="0 0 520 300" style={{ width: "100%", height: "100%", display: "block" }}>
        <defs>
          <linearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.65" />
            <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.65" />
          </linearGradient>
        </defs>

        {/* Left document edges */}
        {leftY.map((y, i) => (
          <path
            key={"l" + i}
            d={`M 122 ${y} C 180 ${y}, 195 ${cy}, ${cx - r} ${cy}`}
            fill="none"
            stroke="url(#edgeGrad)"
            strokeWidth="1.5"
          />
        ))}

        {/* Right topic edges */}
        {rightY.map((y, i) => (
          <path
            key={"r" + i}
            d={`M ${cx + r} ${cy} C 325 ${cy}, 340 ${y}, 398 ${y}`}
            fill="none"
            stroke="url(#edgeGrad)"
            strokeWidth="1.5"
          />
        ))}

        {/* Central Hub */}
        <g style={{ cursor: "pointer" }} onClick={() => openModal("library")}>
          <circle cx={cx} cy={cy} r={r + 7} fill="none" stroke="rgba(124,92,255,0.25)" strokeWidth="1" />
          <circle cx={cx} cy={cy} r={r} fill="#171432" stroke="#9d82ff" strokeWidth="2" />
          <text x={cx} y={cy - 4} textAnchor="middle" fill="#f4f5f8" fontSize="10" fontWeight="600">
            KNOWLEDGE
          </text>
          <text x={cx} y={cy + 10} textAnchor="middle" fill="#a78bfa" fontSize="9.5" fontWeight="500">
            {docs.length} DOCS
          </text>
        </g>

        {/* Left Document Pills */}
        {leftLabels.map((label, i) => {
          const y = leftY[i];
          return (
            <g key={"ln" + i} transform={`translate(14, ${y - 13})`} style={{ cursor: "pointer" }} onClick={() => openModal("library")}>
              <rect width="108" height="26" rx="13" fill="#151722" stroke="rgba(124,92,255,0.5)" strokeWidth="1.2" />
              <text x="54" y="16.5" textAnchor="middle" fill="#e2e4ec" fontSize="10.5" fontWeight="500">
                {label}
              </text>
            </g>
          );
        })}

        {/* Right Topic Pills */}
        {rightLabels.map((label, i) => {
          const y = rightY[i];
          const rawTerm = label.replace(/^#/, "");
          return (
            <g
              key={"rn" + i}
              transform={`translate(398, ${y - 13})`}
              style={{ cursor: onSelectTerm ? "pointer" : "default" }}
              onClick={() => onSelectTerm?.(rawTerm)}
            >
              <rect width="108" height="26" rx="13" fill="#151722" stroke="rgba(56,189,248,0.45)" strokeWidth="1.2" />
              <text x="54" y="16.5" textAnchor="middle" fill="#bae6fd" fontSize="10.5" fontWeight="500">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
