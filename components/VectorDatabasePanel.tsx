"use client";
import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";

type P = { x: number; y: number; z: number; b: number; real?: boolean };

function baseCloud(): P[] {
  const pts: P[] = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let gx = -9; gx <= 9; gx++) {
    for (let gy = -9; gy <= 9; gy++) {
      for (let gz = -4; gz <= 4; gz++) {
        const x = gx / 9, y = gy / 9, z = gz / 4;
        const e = x * x + y * y + z * z * 0.7;
        if (e > 1 || rnd() > 0.72 - e * 0.3) continue;
        pts.push({ x: x * 110, y: y * 95, z: z * 80, b: 0.35 + (1 - e) * 0.65 });
      }
    }
  }
  return pts;
}

export default function VectorDatabasePanel() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const embs = useLiveQuery(() => db.embeddings.limit(350).toArray(), []) ?? [];
  const totalCount = useLiveQuery(() => db.embeddings.count(), []) ?? 0;
  const realRef = useRef<P[]>([]);

  useEffect(() => {
    realRef.current = embs.slice(0, 600).map((e) => {
      const v = e.vector;
      const third = Math.max(1, Math.floor(v.length / 3));
      const a = v.slice(0, third).reduce((s, x) => s + x, 0);
      const b = v.slice(third, third * 2).reduce((s, x) => s + x, 0);
      const c = v.slice(third * 2).reduce((s, x) => s + x, 0);
      return { x: Math.tanh(a * 2) * 105, y: Math.tanh(b * 2) * 90, z: Math.tanh(c * 2) * 75, b: 1, real: true };
    });
  }, [embs]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const c = canvasRef.current;
    if (!wrap || !c) return;

    const base = baseCloud();
    let t = 0.4;
    let raf = 0;
    let isVisible = true;
    let lastFrameTime = 0;
    const isMobile = window.innerWidth <= 960;
    const targetInterval = isMobile ? 42 : 28; // ~24fps on mobile, ~35fps on desktop to save battery
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const draw = (now = 0) => {
      if (!isVisible || document.hidden) {
        raf = 0;
        return;
      }
      if (!reduce && now - lastFrameTime < targetInterval) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = now;

      const W = wrap.clientWidth || 360;
      const H = wrap.clientHeight || 290;
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap DPR at 2x to save GPU fill-rate on 3x mobile OLEDs
      if (c.width !== W * dpr || c.height !== H * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const CX = W / 2;
      const CY = H / 2;

      const g = ctx.createRadialGradient(CX, CY, 8, CX, CY, Math.min(W, H) * 0.48);
      g.addColorStop(0, "rgba(124, 92, 255, 0.24)");
      g.addColorStop(1, "rgba(124, 92, 255, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const cos = Math.cos(t), sin = Math.sin(t);
      const all = base.concat(realRef.current);
      const proj = all
        .map((p) => {
          const x = p.x * cos - p.z * sin;
          const z = p.x * sin + p.z * cos;
          const s = 380 / (380 + z);
          return { sx: CX + x * s, sy: CY + p.y * s, s, p, z };
        })
        .sort((a, b) => b.z - a.z);

      for (const q of proj) {
        const a = Math.min(1, q.p.b * (0.5 + q.s * 0.5));
        const r = (q.p.real ? 2.2 : 1.25) * q.s;
        ctx.fillStyle = q.p.real
          ? `rgba(56, 189, 248, ${a})`
          : `rgba(${180 + q.p.b * 65}, ${160 + q.p.b * 75}, 255, ${a})`;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = "rgba(167, 139, 250, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(CX, 20);
      ctx.lineTo(CX, H - 20);
      ctx.stroke();

      if (!reduce) {
        t += 0.0045;
        raf = requestAnimationFrame(draw);
      }
    };

    const resumeIfNeeded = () => {
      if (isVisible && !document.hidden && !raf) {
        raf = requestAnimationFrame(draw);
      }
    };

    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              isVisible = entries[0]?.isIntersecting ?? true;
              if (isVisible) resumeIfNeeded();
              else if (raf) {
                cancelAnimationFrame(raf);
                raf = 0;
              }
            },
            { threshold: 0.05 }
          )
        : null;
    observer?.observe(wrap);

    const onVisChange = () => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else {
        resumeIfNeeded();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);

    draw(0);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: 290, position: "relative" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div
        style={{
          position: "absolute",
          right: 12,
          bottom: 8,
          fontSize: 11.5,
          color: "var(--text-2)",
          fontFamily: "var(--font-mono), monospace",
        }}
      >
        {totalCount} indexed vectors (384-D)
      </div>
    </div>
  );
}
