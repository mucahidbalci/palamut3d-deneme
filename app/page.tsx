// @ts-nocheck
"use client";

/* ============================================================
   Palamut3D v2.0 — 3D Model Kabartma ve Doku Aracı
   Tüm işlemler tarayıcıda. Sunucuya dosya gönderilmez.
   ============================================================ */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import JSZip from "jszip";

/* ------------------------------------------------------------
   ÖLÇEK SABİTLERİ
   1 sahne birimi = 10 mm. Arayüz her zaman mm gösterir.
   ------------------------------------------------------------ */
const MM_PER_UNIT = 10;
const UNIT_PER_MM = 1 / MM_PER_UNIT;
const CUBE_SIZE = 5;
const CUBE_SEG = 192;
const TEX_SIZE = 512;
const MASK_SIZE = 512;
const MAX_LAYERS = 8;
const MAX_STL_MB = 80;

const DEFAULT_COLOR = "#22d3ee";
const DEFAULT_METALNESS = 0.22;
const DEFAULT_ROUGHNESS = 0.58;

const QUICK_COLORS = [
  "#22d3ee",
  "#f97316",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#ec4899",
  "#e5e7eb",
  "#4a5260",
];

const CATEGORIES: { id: string; label: string }[] = [
  { id: "tumu", label: "Tümü" },
  { id: "geometrik", label: "Geometrik" },
  { id: "endustriyel", label: "Endüstriyel" },
  { id: "dokusel", label: "Dokusal" },
  { id: "organik", label: "Organik" },
  { id: "dekoratif", label: "Dekoratif" },
  { id: "ahsap", label: "Ahşap" },
  { id: "kumas", label: "Kumaş" },
  { id: "ozel", label: "Özel" },
];

const BLEND_MODES: { id: string; label: string }[] = [
  { id: "ekle", label: "Eklemeli" },
  { id: "ort", label: "Ortalama" },
  { id: "maks", label: "Maksimum" },
  { id: "carp", label: "Çarpma" },
  { id: "fark", label: "Fark" },
];

/* ============================================================
   DOKU ÜRETİM YARDIMCILARI (tohumlu, Math.random yok)
   ============================================================ */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillBg(ctx: CanvasRenderingContext2D, s: number, c = "#000000") {
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, s, s);
}

function paint(
  ctx: CanvasRenderingContext2D,
  s: number,
  fn: (u: number, v: number) => number
) {
  const img = ctx.createImageData(s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    const v = y / s;
    for (let x = 0; x < s; x++) {
      let val = fn(x / s, v) * 255;
      if (val < 0) val = 0;
      else if (val > 255) val = 255;
      const i = (y * s + x) * 4;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function noise2(seed: number, cells: number) {
  const rnd = mulberry32(seed);
  const n = Math.max(2, Math.round(cells));
  const lat = new Float32Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const at = (x: number, y: number) =>
    lat[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  return (u: number, v: number) => {
    const fx = u * n;
    const fy = v * n;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const dd = at(x0 + 1, y0 + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + dd * sx) * sy;
  };
}

function fbm2(seed: number, cells: number, oct = 4) {
  const katmanlar: ((u: number, v: number) => number)[] = [];
  for (let o = 0; o < oct; o++) {
    katmanlar.push(noise2(seed + o * 37, cells * Math.pow(2, o)));
  }
  return (u: number, v: number) => {
    let t = 0;
    let amp = 0.5;
    let tot = 0;
    for (let o = 0; o < oct; o++) {
      t += katmanlar[o](u, v) * amp;
      tot += amp;
      amp *= 0.5;
    }
    return t / tot;
  };
}

function stripesV(ctx: CanvasRenderingContext2D, s: number, n: number, duty = 0.5, soft = 0) {
  const w = s / n;
  const a = 0.5 - duty / 2;
  const b = 0.5 + duty / 2;
  for (let i = 0; i < n; i++) {
    const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    if (soft > 0) {
      g.addColorStop(0, "#000000");
      g.addColorStop(Math.max(0, a - soft), "#000000");
      g.addColorStop(a, "#ffffff");
      g.addColorStop(b, "#ffffff");
      g.addColorStop(Math.min(1, b + soft), "#000000");
      g.addColorStop(1, "#000000");
    } else {
      g.addColorStop(0, "#000000");
      g.addColorStop(a, "#ffffff");
      g.addColorStop(b, "#ffffff");
      g.addColorStop(1, "#000000");
    }
    ctx.fillStyle = g;
    ctx.fillRect(i * w, 0, w + 0.6, s);
  }
}

function stripesH(ctx: CanvasRenderingContext2D, s: number, n: number, duty = 0.5, soft = 0) {
  const h = s / n;
  const a = 0.5 - duty / 2;
  const b = 0.5 + duty / 2;
  for (let i = 0; i < n; i++) {
    const g = ctx.createLinearGradient(0, i * h, 0, (i + 1) * h);
    if (soft > 0) {
      g.addColorStop(0, "#000000");
      g.addColorStop(Math.max(0, a - soft), "#000000");
      g.addColorStop(a, "#ffffff");
      g.addColorStop(b, "#ffffff");
      g.addColorStop(Math.min(1, b + soft), "#000000");
      g.addColorStop(1, "#000000");
    } else {
      g.addColorStop(0, "#000000");
      g.addColorStop(a, "#ffffff");
      g.addColorStop(b, "#ffffff");
      g.addColorStop(1, "#000000");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, i * h, s, h + 0.6);
  }
}

function stripesAng(
  ctx: CanvasRenderingContext2D,
  s: number,
  n: number,
  ang: number,
  duty = 0.45,
  soft = 0.1
) {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(ang);
  ctx.translate(-s, -s);
  const W = s * 2;
  const w = W / n;
  const a = 0.5 - duty / 2;
  const b = 0.5 + duty / 2;
  for (let i = 0; i < n; i++) {
    const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    g.addColorStop(0, "#000000");
    g.addColorStop(Math.max(0, a - soft), "#000000");
    g.addColorStop(a, "#ffffff");
    g.addColorStop(b, "#ffffff");
    g.addColorStop(Math.min(1, b + soft), "#000000");
    g.addColorStop(1, "#000000");
    ctx.fillStyle = g;
    ctx.fillRect(i * w, 0, w + 0.6, W);
  }
  ctx.restore();
}

function dotsGrid(ctx: CanvasRenderingContext2D, s: number, n: number, r: number, soft = true) {
  const c = s / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = x * c + c / 2;
      const cy = y * c + c / 2;
      if (soft) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(1, "#000000");
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = "#ffffff";
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function gridLines(ctx: CanvasRenderingContext2D, s: number, n: number, t: number) {
  const c = s / n;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < n; i++) {
    ctx.fillRect(i * c, 0, t, s);
    ctx.fillRect(0, i * c, s, t);
  }
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function radialCells(ctx: CanvasRenderingContext2D, s: number, n: number, ic: string, dis: string) {
  const c = s / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = x * c + c / 2;
      const cy = y * c + c / 2;
      const r = c * 0.72;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, ic);
      g.addColorStop(1, dis);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function blobs(
  ctx: CanvasRenderingContext2D,
  s: number,
  adet: number,
  minR: number,
  maxR: number,
  seed: number,
  parlaklik = 0.8
) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < adet; i++) {
    const cx = rnd() * s;
    const cy = rnd() * s;
    const r = minR + rnd() * (maxR - minR);
    for (const dx of [-s, 0, s]) {
      for (const dy of [-s, 0, s]) {
        const g = ctx.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
        g.addColorStop(0, `rgba(255,255,255,${parlaklik})`);
        g.addColorStop(0.7, `rgba(255,255,255,${parlaklik * 0.22})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/* ============================================================
   PRESET KÜTÜPHANESİ — 126 doku
   ============================================================ */
type Preset = {
  id: string;
  name: string;
  category: string;
  draw: (ctx: CanvasRenderingContext2D, s: number) => void;
};

const PRESETS: Preset[] = [
  { id: "kare_kume", name: "Kare Küme", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#555555"); ctx.fillStyle = g; ctx.fillRect(x * c + 1.5, y * c + 1.5, c - 3, c - 3); } } },
  { id: "izgara", name: "Izgara", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); gridLines(ctx, s, 6, 4); } },
  { id: "noktalar", name: "Noktalar", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); dotsGrid(ctx, s, 8, (s / 8) * 0.3); } },
  { id: "cizgiler_dikey", name: "Çizgiler Dikey", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); stripesV(ctx, s, 14, 0.45, 0.08); } },
  { id: "cizgiler_yatay", name: "Çizgiler Yatay", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); stripesH(ctx, s, 14, 0.45, 0.08); } },
  { id: "cizgiler_capraz", name: "Çizgiler Çapraz", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); stripesAng(ctx, s, 14, Math.PI / 4, 0.42, 0.09); } },
  { id: "elmas", name: "Elmas", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.09; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.45); ctx.lineTo(cx + c * 0.45, cy); ctx.lineTo(cx, cy + c * 0.45); ctx.lineTo(cx - c * 0.45, cy); ctx.closePath(); ctx.stroke(); } } },
  { id: "ucgen", name: "Üçgen", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; ctx.fillStyle = "#ffffff"; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const yukari = (x + y) % 2 === 0; ctx.beginPath(); if (yukari) { ctx.moveTo(x * c, y * c + c); ctx.lineTo(x * c + c / 2, y * c); ctx.lineTo(x * c + c, y * c + c); } else { ctx.moveTo(x * c, y * c); ctx.lineTo(x * c + c, y * c); ctx.lineTo(x * c + c / 2, y * c + c); } ctx.closePath(); ctx.fill(); } } },
  { id: "baklava", name: "Baklava", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; for (let y = -1; y < n + 1; y++) for (let x = -1; x < n + 1; x++) { const cx = x * c + (y % 2 ? c / 2 : 0); const cy = y * c; const g = ctx.createLinearGradient(cx, cy - c, cx, cy + c); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#444444"); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.55); ctx.lineTo(cx + c * 0.55, cy); ctx.lineTo(cx, cy + c * 0.55); ctx.lineTo(cx - c * 0.55, cy); ctx.closePath(); ctx.fill(); } } },
  { id: "altigen", name: "Altıgen", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const r = s / 4; const h = r * 1.5; for (let row = -1; row < 5; row++) for (let col = -1; col < 4; col++) { const cx = col * r * Math.sqrt(3) + (row % 2 ? (r * Math.sqrt(3)) / 2 : 0); const cy = row * h; hexPath(ctx, cx, cy, r * 0.85); ctx.fillStyle = "#ffffff"; ctx.fill(); } } },
  { id: "altigen_balpetegi", name: "Bal Petegi", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const r = s / 9; const h = r * 1.5; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = r * 0.22; for (let row = -1; row < 10; row++) for (let col = -1; col < 8; col++) { const cx = col * r * Math.sqrt(3) + (row % 2 ? (r * Math.sqrt(3)) / 2 : 0); const cy = row * h; hexPath(ctx, cx, cy, r * 0.78); ctx.stroke(); } } },
  { id: "yildiz", name: "Yıldız", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 5; const c = s / n; ctx.fillStyle = "#ffffff"; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = (Math.PI / 5) * i - Math.PI / 2; const r = i % 2 === 0 ? c * 0.42 : c * 0.17; const px = cx + r * Math.cos(a); const py = cy + r * Math.sin(a); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); } } },
  { id: "daire_icice", name: "İç İçe Daire", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.05; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, (c / 2) * (k / 4.4), 0, Math.PI * 2); ctx.stroke(); } } } },
  { id: "kare_icice", name: "İç İçe Kare", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.05; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { for (let k = 1; k <= 4; k++) { const o = (c / 2) * (k / 4.4); ctx.strokeRect(x * c + c / 2 - o, y * c + c / 2 - o, o * 2, o * 2); } } } },
  { id: "capraz_cizgi", name: "Çapraz Çizgi", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); stripesAng(ctx, s, 6, Math.PI / 4, 0.55, 0.2); } },
  { id: "ızgara_kalin", name: "Kalın Izgara", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); gridLines(ctx, s, 4, 11); } },
  { id: "ızgara_ince", name: "İnce Izgara", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); gridLines(ctx, s, 16, 1.6); } },
  { id: "nokta_izgara", name: "Nokta Izgara", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); dotsGrid(ctx, s, 16, (s / 16) * 0.28, false); } },
  { id: "cizgi_grup", name: "Çizgi Grup", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const grup = 6; const c = s / grup; for (let i = 0; i < grup; i++) for (let k = 0; k < 3; k++) { ctx.fillStyle = k === 1 ? "#ffffff" : "#999999"; ctx.fillRect(i * c + c * 0.18 + k * c * 0.2, 0, c * 0.09, s); } } },
  { id: "kare_dalga", name: "Kare Dalga", category: "geometrik", draw: (ctx, s) => { paint(ctx, s, (u) => ((u * 8) % 1 < 0.5 ? 1 : 0.08)); } },
  { id: "merdiven", name: "Merdiven", category: "geometrik", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const k = Math.floor(v * 8); return u < (k % 8) / 8 + 0.12 ? 1 : 0.1; }); } },
  { id: "piramit", name: "Piramit", category: "geometrik", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const cu = (u * 5) % 1; const cv = (v * 5) % 1; return Math.max(0, (1 - (Math.abs(cu - 0.5) + Math.abs(cv - 0.5))) * 1.8); }); } },
  { id: "kubbe", name: "Kubbe", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); radialCells(ctx, s, 5, "#ffffff", "#000000"); } },
  { id: "kuyu", name: "Kuyu", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s, "#ffffff"); radialCells(ctx, s, 5, "#000000", "#ffffff"); } },
  { id: "haiz", name: "Haç", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; ctx.fillStyle = "#ffffff"; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const t = c * 0.28; ctx.fillRect(x * c + c / 2 - t / 2, y * c + c * 0.14, t, c * 0.72); ctx.fillRect(x * c + c * 0.14, y * c + c / 2 - t / 2, c * 0.72, t); } } },
  { id: "ok", name: "Ok", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 5; const c = s / n; ctx.fillStyle = "#ffffff"; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx - c * 0.4, cy - c * 0.32); ctx.lineTo(cx + c * 0.4, cy); ctx.lineTo(cx - c * 0.4, cy + c * 0.32); ctx.lineTo(cx - c * 0.18, cy); ctx.closePath(); ctx.fill(); } } },
  { id: "zigzag", name: "Zikzak", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.16; for (let i = 0; i < n; i++) { ctx.beginPath(); for (let x = 0; x <= n; x++) { const px = x * c; const py = i * c + (x % 2 ? c : 0); if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.stroke(); } } },
  { id: "chevron", name: "Chevron", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 7; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.3; for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.moveTo(0, i * c + c * 0.7); ctx.lineTo(c * 0.5, i * c + c * 0.15); ctx.lineTo(c, i * c + c * 0.7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(c * 0.5, i * c + c * 0.7); ctx.lineTo(c, i * c + c * 0.15); ctx.lineTo(c * 1.5, i * c + c * 0.7); ctx.stroke(); } } },
  { id: "herringbone", name: "Herringbone", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const yon = (x + y) % 2 === 0; const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#666666"); ctx.fillStyle = g; ctx.save(); ctx.translate(x * c + c / 2, y * c + c / 2); ctx.rotate(yon ? Math.PI / 4 : -Math.PI / 4); ctx.fillRect(-c * 0.34, -c * 0.12, c * 0.68, c * 0.24); ctx.restore(); } } },
  { id: "argyle", name: "Argyle", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.07; for (let y = -1; y < n + 1; y++) for (let x = -1; x < n + 1; x++) { const cx = x * c + (y % 2 ? c / 2 : 0); const cy = y * c; ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.6); ctx.lineTo(cx + c * 0.6, cy); ctx.lineTo(cx, cy + c * 0.6); ctx.lineTo(cx - c * 0.6, cy); ctx.closePath(); ctx.stroke(); } } },

  { id: "knurling", name: "Knurling", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const n = 14; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.24; for (let y = -1; y < n + 1; y++) for (let x = -1; x < n + 1; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx - c * 0.5, cy - c * 0.5); ctx.lineTo(cx + c * 0.5, cy + c * 0.5); ctx.moveTo(cx + c * 0.5, cy - c * 0.5); ctx.lineTo(cx - c * 0.5, cy + c * 0.5); ctx.stroke(); } } },
  { id: "knurling_carpaz", name: "Knurling Çapraz", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const n = 26; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.4; for (let y = -1; y < n + 1; y++) for (let x = -1; x < n + 1; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx - c * 0.5, cy - c * 0.5); ctx.lineTo(cx + c * 0.5, cy + c * 0.5); ctx.stroke(); } } },
  { id: "karbon", name: "Karbon Fiber", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s, "#1a1a1a"); const n = 16; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { ctx.fillStyle = (x + y) % 4 < 2 ? "#ffffff" : "#4a4a4a"; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "cam_eliyaf", name: "Cam Elyaf", category: "endustriyel", draw: (ctx, s) => { paint(ctx, s, (u, v) => 0.45 + 0.32 * Math.sin((u + v) * Math.PI * 2 * 22) * Math.sin((u - v) * Math.PI * 2 * 22)); } },
  { id: "metal_plaka", name: "Metal Plaka", category: "endustriyel", draw: (ctx, s) => { const g = noise2(5, 128); paint(ctx, s, (u, v) => 0.5 + (g(u * 0.08, v) - 0.5) * 0.9); } },
  { id: "metal_perfore", name: "Perfore Metal", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s, "#ffffff"); const n = 10; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; const r = c * 0.32; const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, "#111111"); g.addColorStop(1, "#dddddd"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); } } },
  { id: "kabarcik", name: "Kabarcık", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); blobs(ctx, s, 70, 5, 18, 21, 0.85); } },
  { id: "puruz", name: "Pürüz", category: "endustriyel", draw: (ctx, s) => { const g = fbm2(31, 48, 3); paint(ctx, s, (u, v) => Math.pow(g(u, v), 1.6)); } },
  { id: "kum", name: "Kum", category: "endustriyel", draw: (ctx, s) => { const g = noise2(41, 200); const g2 = noise2(42, 30); paint(ctx, s, (u, v) => 0.35 + g(u, v) * 0.45 + g2(u, v) * 0.2); } },
  { id: "zigrin", name: "Zıgrin", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const n = 20; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.18; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx - c * 0.5, cy); ctx.lineTo(cx, cy - c * 0.5); ctx.lineTo(cx + c * 0.5, cy); ctx.lineTo(cx, cy + c * 0.5); ctx.closePath(); ctx.stroke(); } } },
  { id: "tirtillama", name: "Tırtıllama", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); stripesH(ctx, s, 26, 0.42, 0.16); } },
  { id: "disli", name: "Dişli", category: "endustriyel", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const dx = u - 0.5; const dy = v - 0.5; const r = Math.sqrt(dx * dx + dy * dy) * 2; const a = Math.atan2(dy, dx); return (r < 0.62 ? 1 : 0.12) * (0.35 + 0.65 * (Math.sin(a * 18) > 0 ? 1 : 0.25)); }); } },
  { id: "vida", name: "Vida Dişi", category: "endustriyel", draw: (ctx, s) => { paint(ctx, s, (u, v) => ((v * 10 + u * 2) % 1 < 0.55 ? 1 : 0.15)); } },
  { id: "kavrama", name: "Kavrama Yüzeyi", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const n = 10; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.3; for (let y = -1; y < n + 1; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx - c * 0.5, cy); ctx.lineTo(cx, cy - c * 0.5); ctx.lineTo(cx + c * 0.5, cy); ctx.lineTo(cx, cy + c * 0.5); ctx.closePath(); ctx.stroke(); } } },
  { id: "izogrid", name: "İzogrid", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.14; for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) { const px = x * c; const py = y * c; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + c, py + c); ctx.stroke(); ctx.beginPath(); ctx.moveTo(px + c, py); ctx.lineTo(px, py + c); ctx.stroke(); ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + c, py); ctx.stroke(); } } },
  { id: "ızgara_endustriyel", name: "Endüstriyel Izgara", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); gridLines(ctx, s, 5, 6); const c = s / 5; for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x * c, y * c, c * 0.1, 0, Math.PI * 2); ctx.fill(); } } },
  { id: "elmas_kesim", name: "Elmas Kesim", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); const rnd = mulberry32(63); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = Math.floor(rnd() * 170 + 60); ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.moveTo(x * c, y * c); ctx.lineTo(x * c + c, y * c + c / 2); ctx.lineTo(x * c, y * c + c); ctx.closePath(); ctx.fill(); } } },
  { id: "talaiz", name: "Talaş Yolu", category: "endustriyel", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const dx = u - 0.5; const dy = v - 0.5; return 0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 14 + Math.sqrt(dx * dx + dy * dy) * 40); }); } },
  { id: "cnc_yol", name: "CNC Yol", category: "endustriyel", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const t = (v * 18) % 1; const k = Math.floor(v * 18); const x = (u + (k % 2) * 0.5) % 1; return t < 0.5 && x < 0.9 ? 1 : 0.18; }); } },
  { id: "baski_hatti", name: "Baskı Hattı", category: "endustriyel", draw: (ctx, s) => { fillBg(ctx, s); stripesH(ctx, s, 9, 0.62, 0.1); const c = s / 9; for (let i = 0; i < 9; i++) { ctx.fillStyle = "#888888"; ctx.fillRect(0, i * c + c * 0.72, s, c * 0.1); } } },
  { id: "fume", name: "Fümé", category: "endustriyel", draw: (ctx, s) => { const g = fbm2(71, 8, 4); paint(ctx, s, (u, v) => Math.pow(g(u * 0.6, v), 1.4) * 1.3); } },
  { id: "anodize", name: "Anodize", category: "endustriyel", draw: (ctx, s) => { const g = noise2(83, 160); const g2 = noise2(84, 20); paint(ctx, s, (u, v) => 0.55 + (g(u * 0.05, v) - 0.5) * 0.5 + (g2(u, v) - 0.5) * 0.25); } },

  { id: "deri", name: "Deri", category: "dokusel", draw: (ctx, s) => { fillBg(ctx, s, "#141414"); blobs(ctx, s, 90, 10, 30, 41, 0.75); } },
  { id: "deri_2", name: "Deri 2", category: "dokusel", draw: (ctx, s) => { fillBg(ctx, s, "#101010"); blobs(ctx, s, 200, 4, 12, 47, 0.8); const g = noise2(48, 220); paint(ctx, s, (u, v) => 0.3 + g(u, v) * 0.4); } },
  { id: "deri_kalin", name: "Kalın Deri", category: "dokusel", draw: (ctx, s) => { fillBg(ctx, s, "#181818"); blobs(ctx, s, 40, 26, 60, 53, 0.7); } },
  { id: "zampara", name: "Zımpara", category: "dokusel", draw: (ctx, s) => { const g = noise2(59, 260); paint(ctx, s, (u, v) => 0.3 + g(u, v) * 0.55); } },

  { id: "kumas", name: "Kumaş", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 14; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = (x + y) % 2 === 0 ? ctx.createLinearGradient(0, y * c, 0, (y + 1) * c) : ctx.createLinearGradient(x * c, 0, (x + 1) * c, 0); g.addColorStop(0, "#111111"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#111111"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "keten", name: "Keten", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s, "#202020"); stripesV(ctx, s, 30, 0.4, 0.2); ctx.globalAlpha = 0.5; stripesH(ctx, s, 30, 0.4, 0.2); ctx.globalAlpha = 1; } },
  { id: "jute", name: "Jüt", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s, "#1c1c1c"); const rnd = mulberry32(67); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; for (let i = 0; i < 220; i++) { const x = rnd() * s; const y = rnd() * s; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 30); ctx.stroke(); } } },
  { id: "kadife", name: "Kadife", category: "kumas", draw: (ctx, s) => { const g = noise2(71, 40); paint(ctx, s, (u, v) => 0.55 + Math.sin(u * Math.PI * 2 * 40) * 0.06 + (g(u, v) - 0.5) * 0.3); } },
  { id: "hasir", name: "Hasır", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = (x + y) % 2 === 0 ? ctx.createLinearGradient(0, y * c, 0, (y + 1) * c) : ctx.createLinearGradient(x * c, 0, (x + 1) * c, 0); g.addColorStop(0, "#000000"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "kilim", name: "Kilim", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const b = 8; const h = s / b; for (let i = 0; i < b; i++) { const g = ctx.createLinearGradient(0, i * h, 0, (i + 1) * h); g.addColorStop(0, "#000000"); g.addColorStop(0.5, i % 2 ? "#888888" : "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.fillRect(0, i * h, s, h); } ctx.fillStyle = "#ffffff"; for (let i = 0; i < 8; i++) { const cx = (i + 0.5) * (s / 8); for (let j = 0; j < 4; j++) { ctx.beginPath(); ctx.moveTo(cx, j * (s / 4) + 8); ctx.lineTo(cx + 8, j * (s / 4) + 20); ctx.lineTo(cx, j * (s / 4) + 32); ctx.lineTo(cx - 8, j * (s / 4) + 20); ctx.closePath(); ctx.fill(); } } } },
  { id: "dokuma1", name: "Dokuma 1", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 12; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = (x + y) % 2 === 0 ? ctx.createLinearGradient(0, y * c, 0, (y + 1) * c) : ctx.createLinearGradient(x * c, 0, (x + 1) * c, 0); g.addColorStop(0, "#222222"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#222222"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "dokuma2", name: "Dokuma 2", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s, "#202020"); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c); g.addColorStop(0, "#000000"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 2; for (let i = 0; i <= n; i++) { ctx.beginPath(); ctx.moveTo(i * c, 0); ctx.lineTo(i * c, s); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * c); ctx.lineTo(s, i * c); ctx.stroke(); } } },
  { id: "dokuma3", name: "Dokuma 3", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s, "#111111"); const n = 20; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = (x * 3 + y * 5) % 7 < 3 ? 255 : 60; ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "dokuma4", name: "Dokuma 4", category: "kumas", draw: (ctx, s) => { paint(ctx, s, (u, v) => 0.5 + 0.35 * Math.sin(u * Math.PI * 2 * 16) * Math.sin(v * Math.PI * 2 * 16) + 0.1 * (Math.sin(u * Math.PI * 2 * 16) + Math.sin(v * Math.PI * 2 * 16))); } },
  { id: "dokuma5", name: "Dokuma 5", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 10; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { ctx.fillStyle = (x * 2 + y) % 3 === 0 ? "#ffffff" : "#3a3a3a"; ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2); } } },
  { id: "orgu", name: "Örgü", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const yon = (x + y) % 2 === 0 ? 1 : -1; const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c * yon); g.addColorStop(0, "#000000"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x * c, y * c + c / 2); ctx.quadraticCurveTo(x * c + c / 2, y * c + (yon > 0 ? 0 : c), x * c + c, y * c + c / 2); ctx.quadraticCurveTo(x * c + c / 2, y * c + (yon > 0 ? c : 0), x * c, y * c + c / 2); ctx.fill(); } } },
  { id: "tığ", name: "Tığ İşi", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.12; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.arc(cx, cy, c * 0.34, 0.4, Math.PI * 1.6); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, c * 0.18, Math.PI * 1.2, Math.PI * 2.4); ctx.stroke(); } } },
  { id: "dantel", name: "Dantel", category: "kumas", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.07; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * c * 0.26, cy + Math.sin(a) * c * 0.26, c * 0.11, 0, Math.PI * 2); ctx.stroke(); } ctx.beginPath(); ctx.arc(cx, cy, c * 0.06, 0, Math.PI * 2); ctx.stroke(); } } },
  { id: "pelus", name: "Pelüs", category: "kumas", draw: (ctx, s) => { const g = fbm2(89, 40, 3); paint(ctx, s, (u, v) => 0.45 + g(u, v) * 0.5); const rnd = mulberry32(90); ctx.globalAlpha = 0.35; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1; for (let i = 0; i < 500; i++) { const x = rnd() * s; const y = rnd() * s; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 8, y - rnd() * 10); ctx.stroke(); } ctx.globalAlpha = 1; } },
  { id: "kece", name: "Keçe", category: "kumas", draw: (ctx, s) => { const g = noise2(97, 90); paint(ctx, s, (u, v) => 0.5 + (g(u, v) - 0.5) * 0.8); const rnd = mulberry32(98); ctx.globalAlpha = 0.3; ctx.strokeStyle = "#ffffff"; for (let i = 0; i < 400; i++) { const x = rnd() * s; const y = rnd() * s; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20); ctx.stroke(); } ctx.globalAlpha = 1; } },

  { id: "voronoi", name: "Voronoi", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(23); const pts: [number, number][] = []; for (let i = 0; i < 18; i++) pts.push([rnd() * s, rnd() * s]); const img = ctx.createImageData(s, s); for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { let d1 = 1e9, d2 = 1e9; for (const p of pts) { let dx = Math.abs(x - p[0]); if (dx > s / 2) dx = s - dx; let dy = Math.abs(y - p[1]); if (dy > s / 2) dy = s - dy; const d = Math.sqrt(dx * dx + dy * dy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; } const v = Math.floor(Math.min(1, (d2 - d1) / 14) * 255); const i = (y * s + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); } },
  { id: "voronoi_kalin", name: "Kalın Voronoi", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(29); const pts: [number, number][] = []; for (let i = 0; i < 9; i++) pts.push([rnd() * s, rnd() * s]); const img = ctx.createImageData(s, s); for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { let d1 = 1e9, d2 = 1e9; for (const p of pts) { let dx = Math.abs(x - p[0]); if (dx > s / 2) dx = s - dx; let dy = Math.abs(y - p[1]); if (dy > s / 2) dy = s - dy; const d = Math.sqrt(dx * dx + dy * dy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; } const v = Math.floor(Math.min(1, (d2 - d1) / 34) * 255); const i = (y * s + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); } },
  { id: "labirent", name: "Labirent", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(31); const n = 12; const c = s / n; fillBg(ctx, s); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.16; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { ctx.beginPath(); if (rnd() > 0.5) { ctx.moveTo(x * c, y * c); ctx.lineTo(x * c, y * c + c); } else { ctx.moveTo(x * c, y * c); ctx.lineTo(x * c + c, y * c); } ctx.stroke(); } } },
  { id: "mercan", name: "Mercan", category: "organik", draw: (ctx, s) => { fillBg(ctx, s, "#0d0d0d"); const rnd = mulberry32(37); ctx.strokeStyle = "#ffffff"; ctx.lineCap = "round"; for (let i = 0; i < 160; i++) { let x = rnd() * s, y = rnd() * s, a = rnd() * Math.PI * 2; ctx.lineWidth = 1 + rnd() * 3; ctx.beginPath(); ctx.moveTo(x, y); for (let k = 0; k < 6; k++) { a += (rnd() - 0.5) * 1.4; x += Math.cos(a) * 9; y += Math.sin(a) * 9; ctx.lineTo(x, y); } ctx.stroke(); } } },
  { id: "sponge", name: "Sünger", category: "organik", draw: (ctx, s) => { fillBg(ctx, s, "#ffffff"); blobs(ctx, s, 120, 6, 22, 43, 0.55); const g = noise2(44, 60); ctx.globalAlpha = 0.4; paint(ctx, s, (u, v) => g(u, v)); ctx.globalAlpha = 1; } },
  { id: "kaya", name: "Kaya", category: "organik", draw: (ctx, s) => { const g = fbm2(51, 6, 4); paint(ctx, s, (u, v) => Math.pow(g(u, v), 0.8) * 1.2); } },
  { id: "catlak", name: "Çatlak", category: "organik", draw: (ctx, s) => { const g = noise2(57, 14); paint(ctx, s, (u, v) => (Math.abs(g(u, v) - 0.5) < 0.03 ? 1 : 0.18)); } },
  { id: "dalga", name: "Dalga", category: "organik", draw: (ctx, s) => { paint(ctx, s, (u, v) => 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 6 + Math.sin(u * Math.PI * 2) * 1.4)); } },
  { id: "dalga_cift", name: "Çift Dalga", category: "organik", draw: (ctx, s) => { paint(ctx, s, (u, v) => 0.5 + 0.35 * Math.sin(u * Math.PI * 2 * 5 + v * 3) * Math.sin(v * Math.PI * 2 * 5 + u * 3)); } },
  { id: "girdap", name: "Girdap", category: "organik", draw: (ctx, s) => { paint(ctx, s, (u, v) => { const dx = u - 0.5; const dy = v - 0.5; return 0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 4 + Math.sqrt(dx * dx + dy * dy) * 30); }); } },
  { id: "bulut", name: "Bulut", category: "organik", draw: (ctx, s) => { const g = fbm2(61, 5, 5); paint(ctx, s, (u, v) => Math.pow(g(u, v), 1.2) * 1.6); } },
  { id: "duman", name: "Duman", category: "organik", draw: (ctx, s) => { const g = fbm2(67, 6, 4); paint(ctx, s, (u, v) => Math.pow(g(u * 0.4, v), 1.3) * 1.5); } },
  { id: "gurultu", name: "Gürültü", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(99); paint(ctx, s, () => rnd()); } },
  { id: "gurultu_perlin", name: "Perlin Gürültü", category: "organik", draw: (ctx, s) => { const g = noise2(101, 16); paint(ctx, s, (u, v) => g(u, v)); } },
  { id: "gurultu_fbm", name: "FBM Gürültü", category: "organik", draw: (ctx, s) => { const g = fbm2(103, 6, 5); paint(ctx, s, (u, v) => g(u, v) * 1.4); } },
  { id: "yaprak", name: "Yaprak", category: "organik", draw: (ctx, s) => { fillBg(ctx, s); const n = 3; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.05; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.42); ctx.quadraticCurveTo(cx + c * 0.34, cy, cx, cy + c * 0.42); ctx.quadraticCurveTo(cx - c * 0.34, cy, cx, cy - c * 0.42); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.42); ctx.lineTo(cx, cy + c * 0.42); ctx.stroke(); for (let k = -3; k <= 3; k++) { const yy = cy + k * c * 0.1; const w = (1 - Math.abs(k) / 4) * c * 0.22; ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx + w, yy - c * 0.08); ctx.moveTo(cx, yy); ctx.lineTo(cx - w, yy - c * 0.08); ctx.stroke(); } } } },
  { id: "kabuk", name: "Kabuk", category: "organik", draw: (ctx, s) => { paint(ctx, s, (u, v) => 0.5 + 0.5 * Math.sin((v * 14 + Math.sin(u * 6) * 0.6) * Math.PI)); } },
  { id: "agac_kabugu", name: "Ağaç Kabuğu", category: "organik", draw: (ctx, s) => { const g = noise2(107, 26); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin(g(u * 0.35, v) * Math.PI * 6)), 0.7)); } },
  { id: "tas", name: "Taş", category: "organik", draw: (ctx, s) => { const g = fbm2(109, 9, 4); paint(ctx, s, (u, v) => 0.25 + Math.pow(g(u, v), 1.1) * 0.9); } },
  { id: "mermer", name: "Mermer", category: "organik", draw: (ctx, s) => { const g = fbm2(113, 4, 5); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin((u + g(u, v) * 1.6) * Math.PI * 8)), 0.35)); } },
  { id: "granit", name: "Granit", category: "organik", draw: (ctx, s) => { const g = noise2(127, 220); const g2 = noise2(128, 30); paint(ctx, s, (u, v) => (g(u, v) > 0.62 ? 1 : 0.28) * (0.6 + g2(u, v) * 0.6)); } },
  { id: "kum_tasi", name: "Kum Taşı", category: "organik", draw: (ctx, s) => { const g = noise2(131, 120); paint(ctx, s, (u, v) => (0.5 + 0.3 * Math.sin(v * Math.PI * 2 * 7)) * (0.7 + g(u, v) * 0.5)); } },

  { id: "damask", name: "Damasık", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#101010"); const n = 3; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.04; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.42); ctx.bezierCurveTo(cx + c * 0.4, cy - c * 0.1, cx + c * 0.1, cy + c * 0.4, cx, cy + c * 0.42); ctx.bezierCurveTo(cx - c * 0.1, cy + c * 0.4, cx - c * 0.4, cy - c * 0.1, cx, cy - c * 0.42); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, c * 0.09, 0, Math.PI * 2); ctx.stroke(); } } },
  { id: "mandala", name: "Mandala", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const cx = s / 2; const cy = s / 2; ctx.strokeStyle = "#ffffff"; for (let h = 0; h < 4; h++) { const r = (s / 2) * ((h + 1) / 4.4); ctx.lineWidth = 2 + h; ctx.beginPath(); for (let i = 0; i <= 96; i++) { const a = (Math.PI * 2 * i) / 96; const rr = r * (0.86 + 0.14 * Math.sin(a * 12 + h)); const x = cx + rr * Math.cos(a); const y = cy + rr * Math.sin(a); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.closePath(); ctx.stroke(); } } },
  { id: "kristal", name: "Kristal", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const rnd = mulberry32(11); const n = 10; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = Math.floor(rnd() * 170 + 60); ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.moveTo(x * c, y * c); ctx.lineTo(x * c + c, y * c + c / 2); ctx.lineTo(x * c, y * c + c); ctx.closePath(); ctx.fill(); } } },
  { id: "kristal_kalin", name: "Kalın Kristal", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const rnd = mulberry32(13); const n = 5; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = Math.floor(rnd() * 150 + 70); ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.moveTo(x * c, y * c + c); ctx.lineTo(x * c + c / 2, y * c); ctx.lineTo(x * c + c, y * c + c); ctx.closePath(); ctx.fill(); } } },
  { id: "tugla", name: "Tuğla", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const satir = 8; const h = s / satir; const w = s / 4; for (let r = 0; r < satir; r++) { const kay = (r % 2) * (w / 2); for (let c = -1; c < 5; c++) { const x = c * w + kay; const y = r * h; const g = ctx.createLinearGradient(x, y, x, y + h); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#777777"); ctx.fillStyle = g; ctx.fillRect(x + 2, y + 2, w - 4, h - 4); } } } },
  { id: "tugla_balik", name: "Balık Kılçığı Tuğla", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 6; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#5a5a5a"); ctx.fillStyle = g; ctx.save(); ctx.translate(x * c + c / 2, y * c + c / 2); ctx.rotate(((x + y) % 2 ? 1 : -1) * Math.PI / 4); ctx.fillRect(-c * 0.36, -c * 0.13, c * 0.72, c * 0.26); ctx.restore(); } } },
  { id: "sepet", name: "Sepet", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 8; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = (x + y) % 2 === 0 ? ctx.createLinearGradient(0, y * c, 0, (y + 1) * c) : ctx.createLinearGradient(x * c, 0, (x + 1) * c, 0); g.addColorStop(0, "#000000"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "sepet_ince", name: "İnce Sepet", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 16; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = (x + y) % 2 === 0 ? ctx.createLinearGradient(0, y * c, 0, (y + 1) * c) : ctx.createLinearGradient(x * c, 0, (x + 1) * c, 0); g.addColorStop(0, "#333333"); g.addColorStop(0.5, "#ffffff"); g.addColorStop(1, "#333333"); ctx.fillStyle = g; ctx.fillRect(x * c, y * c, c, c); } } },
  { id: "balon", name: "Balon", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); blobs(ctx, s, 40, 8, 26, 17, 0.9); } },
  { id: "inci", name: "İnci", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 7; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; const g = ctx.createRadialGradient(cx - c * 0.1, cy - c * 0.1, 0, cx, cy, c * 0.4); g.addColorStop(0, "#ffffff"); g.addColorStop(0.75, "#bbbbbb"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, c * 0.4, 0, Math.PI * 2); ctx.fill(); } } },
  { id: "boncuk", name: "Boncuk", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const satir = 9; const h = s / satir; for (let r = 0; r < satir; r++) { const kay = (r % 2) * (h / 2); for (let i = 0; i < 10; i++) { const cx = i * h + kay + h / 2; const cy = r * h + h / 2; const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.42); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#000000"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, h * 0.42, 0, Math.PI * 2); ctx.fill(); } } } },
  { id: "pul", name: "Pul", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#111111"); const n = 8; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.14; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); ctx.arc(cx, cy, c * 0.46, Math.PI, Math.PI * 2); ctx.stroke(); } } },
  { id: "karo", name: "Karo", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 5; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = ctx.createLinearGradient(x * c, y * c, x * c + c, y * c + c); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#9a9a9a"); ctx.fillStyle = g; ctx.fillRect(x * c + 3, y * c + 3, c - 6, c - 6); } } },
  { id: "mozaik", name: "Mozaik", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#0d0d0d"); const rnd = mulberry32(19); const n = 10; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = Math.floor(rnd() * 190 + 50); ctx.fillStyle = `rgb(${v},${v},${v})`; const b = 2 + rnd() * 3; ctx.fillRect(x * c + b, y * c + b, c - b * 2, c - b * 2); } } },
  { id: "fresk", name: "Fresk", category: "dekoratif", draw: (ctx, s) => { const g = fbm2(137, 7, 4); paint(ctx, s, (u, v) => 0.55 + (g(u, v) - 0.5) * 1.1); ctx.globalAlpha = 0.25; blobs(ctx, s, 40, 10, 40, 138, 0.5); ctx.globalAlpha = 1; } },
  { id: "barok", name: "Barok", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#101010"); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.05; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, c * (0.16 + k * 0.09), k * 1.2, k * 1.2 + Math.PI * 1.1); ctx.stroke(); } } } },
  { id: "artdeco", name: "Art Deco", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.06; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c; for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, c * 0.14 * k, Math.PI, Math.PI * 2); ctx.stroke(); } } } },
  { id: "cicek", name: "Çiçek", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s); const n = 4; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; for (let k = 0; k < 8; k++) { const a = (Math.PI / 4) * k; ctx.fillStyle = k % 2 ? "#bbbbbb" : "#ffffff"; ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * c * 0.22, cy + Math.sin(a) * c * 0.22, c * 0.13, c * 0.07, a, 0, Math.PI * 2); ctx.fill(); } ctx.fillStyle = "#000000"; ctx.beginPath(); ctx.arc(cx, cy, c * 0.07, 0, Math.PI * 2); ctx.fill(); } } },
  { id: "yaprak_desen", name: "Yaprak Desen", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#111111"); const n = 5; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.05; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2 + (y % 2 ? c / 2 : 0); const cy = y * c + c / 2; ctx.beginPath(); ctx.ellipse(cx, cy, c * 0.3, c * 0.12, -0.7, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx - c * 0.24, cy + c * 0.14); ctx.lineTo(cx + c * 0.24, cy - c * 0.14); ctx.stroke(); } } },
  { id: "geometrik_yildiz", name: "Geometrik Yıldız", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#101010"); const n = 4; const c = s / n; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = c * 0.04; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const cx = x * c + c / 2; const cy = y * c + c / 2; ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = (Math.PI / 4) * i; const r = i % 2 === 0 ? c * 0.42 : c * 0.16; const px = cx + r * Math.cos(a); const py = cy + r * Math.sin(a); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); ctx.stroke(); } } },

  { id: "ahsap1", name: "Ahşap 1", category: "ahsap", draw: (ctx, s) => { const rnd = mulberry32(3); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin(((v + Math.sin(u * Math.PI * 2) * 0.07) * Math.PI * 2 * 9) % (Math.PI * 2))), 0.55) + (rnd() - 0.5) * 0.06); } },
  { id: "ahsap2", name: "Ahşap 2", category: "ahsap", draw: (ctx, s) => { const rnd = mulberry32(17); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin(((u + Math.sin(v * Math.PI * 2) * 0.05 + Math.sin(u * Math.PI * 6) * 0.03) * Math.PI * 2 * 14) % (Math.PI * 2))), 1.6) + (rnd() - 0.5) * 0.1); } },
  { id: "ahsap3", name: "Ahşap 3", category: "ahsap", draw: (ctx, s) => { const rnd = mulberry32(53); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin(((u + Math.sin(v * Math.PI * 4 + Math.sin(u * 3)) * 0.09) * Math.PI * 2 * 5) % (Math.PI * 2))), 0.9) + (rnd() - 0.5) * 0.15); } },
  { id: "ahsap_damar", name: "Ahşap Damar", category: "ahsap", draw: (ctx, s) => { const g = noise2(139, 20); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin(g(u * 0.3, v) * Math.PI * 9)), 0.5)); } },
  { id: "ahsap_kesim", name: "Ahşap Kesim", category: "ahsap", draw: (ctx, s) => { const g = noise2(149, 30); paint(ctx, s, (u, v) => { const dx = u - 0.5; const dy = v - 0.5; return Math.pow(Math.abs(Math.sin(Math.sqrt(dx * dx + dy * dy) * 60 + g(u, v) * 6)), 0.6); }); } },
  { id: "ahsap_lake", name: "Lake Ahşap", category: "ahsap", draw: (ctx, s) => { const g = noise2(151, 12); paint(ctx, s, (u, v) => 0.35 + Math.pow(Math.abs(Math.sin((v + g(u, v) * 0.2) * Math.PI * 2 * 7)), 0.8) * 0.65); } },
  { id: "ahsap_kavrulmus", name: "Kavrulmuş Ahşap", category: "ahsap", draw: (ctx, s) => { const g = fbm2(157, 10, 3); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin((u + g(u, v) * 0.4) * Math.PI * 2 * 11)), 2.2) * 0.9 + 0.05); } },
  { id: "bambu", name: "Bambu", category: "ahsap", draw: (ctx, s) => { fillBg(ctx, s, "#3a3a3a"); const n = 5; const c = s / n; for (let i = 0; i < n; i++) { const g = ctx.createLinearGradient(0, i * c, 0, (i + 1) * c); g.addColorStop(0, "#ffffff"); g.addColorStop(0.85, "#8a8a8a"); g.addColorStop(1, "#222222"); ctx.fillStyle = g; ctx.fillRect(0, i * c, s, c * 0.9); } ctx.fillStyle = "#ffffff"; for (let i = 0; i < n; i++) ctx.fillRect(0, i * c + c * 0.92, s, c * 0.05); } },
  { id: "meşe", name: "Meşe", category: "ahsap", draw: (ctx, s) => { const g = noise2(163, 16); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin((v + g(u, v) * 0.5) * Math.PI * 2 * 13)), 0.7) * 0.85 + 0.1); } },
  { id: "ceviz", name: "Ceviz", category: "ahsap", draw: (ctx, s) => { const g = fbm2(167, 8, 4); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin((v * 9 + g(u, v) * 3) * Math.PI)), 1.4)); } },
  { id: "sedir", name: "Sedir", category: "ahsap", draw: (ctx, s) => { const g = noise2(173, 40); paint(ctx, s, (u, v) => 0.2 + Math.pow(Math.abs(Math.sin((u * 18 + g(u, v) * 2) * Math.PI)), 0.9) * 0.8); } },
  { id: "tik", name: "Tik", category: "ahsap", draw: (ctx, s) => { const g = noise2(179, 24); paint(ctx, s, (u, v) => Math.pow(Math.abs(Math.sin((v * 16 + g(u, v) * 1.5) * Math.PI)), 1.2) * 0.75 + 0.15); } },
];

const PRESET_MAP: Record<string, Preset> = PRESETS.reduce((acc, p) => {
  acc[p.id] = p;
  return acc;
}, {} as Record<string, Preset>);

/* Özel yüklenen haritalar */
const CUSTOM_MAPS = new Map<string, HTMLCanvasElement>();
/* Thumbnail önbelleği */
const THUMB_CACHE = new Map<string, string>();
/* Doku piksel verisi önbelleği (ImageData) */
const TEX_CACHE = new Map<string, ImageData>();

function makeTextureCanvas(presetId: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  fillBg(ctx, TEX_SIZE);

  const ozel = CUSTOM_MAPS.get(presetId);
  if (ozel) {
    ctx.drawImage(ozel, 0, 0, TEX_SIZE, TEX_SIZE);
    return canvas;
  }

  const preset = PRESET_MAP[presetId];
  if (preset) {
    try {
      preset.draw(ctx, TEX_SIZE);
    } catch {
      fillBg(ctx, TEX_SIZE, "#808080");
    }
  }
  return canvas;
}

function makeThumbCanvas(presetId: string): HTMLCanvasElement {
  const tam = makeTextureCanvas(presetId);
  const kucuk = document.createElement("canvas");
  kucuk.width = 96;
  kucuk.height = 96;
  kucuk.getContext("2d")!.drawImage(tam, 0, 0, 96, 96);
  return kucuk;
}

/* Doku ImageData'sı (önbellekli) */
function getTexData(presetId: string): ImageData {
  const varOlan = TEX_CACHE.get(presetId);
  if (varOlan) return varOlan;
  const canvas = makeTextureCanvas(presetId);
  const data = canvas
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  TEX_CACHE.set(presetId, data);
  return data;
}

/* Yüklenen görseli okunabilir bir kaynağa çevir */
async function gorselOku(
  file: File
): Promise<{ w: number; h: number; kaynak: CanvasImageSource }> {
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file);
      return { w: b.width, h: b.height, kaynak: b };
    } catch {
      /* Image yoluna düş */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("gorsel_okunamadi"));
      i.src = url;
    });
    return { w: img.naturalWidth, h: img.naturalHeight, kaynak: img };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ============================================================
   MOTOR
   ============================================================ */

/* UV üretimi — en büyük boyut referans alınır, oran korunur */
function ensureUV(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.attributes.uv) return geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const boyut = new THREE.Vector3();
  bb.getSize(boyut);
  const referans = Math.max(boyut.x, boyut.y, boyut.z, 1e-6);
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / referans;
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / referans;
  }
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/* STL normalizasyonu */
function normalizeGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeVertexNormals();
  geo.center();
  geo.computeBoundingBox();
  const boyut = new THREE.Vector3();
  geo.boundingBox!.getSize(boyut);
  const maxB = Math.max(boyut.x, boyut.y, boyut.z) || 1;
  const k = CUBE_SIZE / maxB;
  geo.scale(k, k, k);
  geo.computeBoundingBox();
  ensureUV(geo);
  return geo;
}

/* Geçiş eğrileri */
function uygulaEasing(t: number, mod: string): number {
  if (mod === "s") return t * t * (3 - 2 * t);
  if (mod === "yumusak") return Math.sin((t * Math.PI) / 2);
  return t;
}

/* Komşu ortalaması ile pozisyon yumuşatma (tek geçiş) */
function pozisyonYumusat(geo: THREE.BufferGeometry, agirlik: number) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  if (!idx || agirlik <= 0) return;
  const n = pos.count;
  const toplamX = new Float32Array(n);
  const toplamY = new Float32Array(n);
  const toplamZ = new Float32Array(n);
  const sayac = new Uint8Array(n);

  const ekle = (hedef: number, kaynak: number) => {
    toplamX[hedef] += pos.getX(kaynak);
    toplamY[hedef] += pos.getY(kaynak);
    toplamZ[hedef] += pos.getZ(kaynak);
    if (sayac[hedef] < 255) sayac[hedef] += 1;
  };

  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t);
    const b = idx.getX(t + 1);
    const c = idx.getX(t + 2);
    ekle(a, b);
    ekle(a, c);
    ekle(b, a);
    ekle(b, c);
    ekle(c, a);
    ekle(c, b);
  }

  for (let i = 0; i < n; i++) {
    const s = sayac[i];
    if (s === 0) continue;
    const ox = pos.getX(i);
    const oy = pos.getY(i);
    const oz = pos.getZ(i);
    const hx = toplamX[i] / s;
    const hy = toplamY[i] / s;
    const hz = toplamZ[i] / s;
    pos.setXYZ(
      i,
      ox + (hx - ox) * agirlik,
      oy + (hy - oy) * agirlik,
      oz + (hz - oz) * agirlik
    );
  }
  pos.needsUpdate = true;
}

/* Kutu bulanıklaştırma (doku / maske yumuşatma) */
function blurImageData(data: Uint8ClampedArray, s: number, yaricap: number) {
  if (yaricap < 1) return;
  const gecici = new Uint8ClampedArray(data.length);
  // yatay
  for (let y = 0; y < s; y++) {
    let toplam = 0;
    let adet = 0;
    for (let x = -yaricap; x < s + yaricap; x++) {
      if (x + yaricap < s + yaricap) {
        const xi = Math.min(s - 1, Math.max(0, x + yaricap));
        toplam += data[(y * s + xi) * 4];
        adet++;
      }
      if (x - yaricap - 1 >= 0) {
        const xo = Math.max(0, x - yaricap - 1);
        toplam -= data[(y * s + xo) * 4];
        adet--;
      }
      if (x >= 0 && x < s) {
        const v = toplam / Math.max(1, adet);
        gecici[(y * s + x) * 4] = v;
        gecici[(y * s + x) * 4 + 1] = v;
        gecici[(y * s + x) * 4 + 2] = v;
        gecici[(y * s + x) * 4 + 3] = 255;
      }
    }
  }
  // dikey
  for (let x = 0; x < s; x++) {
    let toplam = 0;
    let adet = 0;
    for (let y = -yaricap; y < s + yaricap; y++) {
      if (y + yaricap < s + yaricap) {
        const yi = Math.min(s - 1, Math.max(0, y + yaricap));
        toplam += gecici[(yi * s + x) * 4];
        adet++;
      }
      if (y - yaricap - 1 >= 0) {
        const yo = Math.max(0, y - yaricap - 1);
        toplam -= gecici[(yo * s + x) * 4];
        adet--;
      }
      if (y >= 0 && y < s) {
        const v = toplam / Math.max(1, adet);
        data[(y * s + x) * 4] = v;
        data[(y * s + x) * 4 + 1] = v;
        data[(y * s + x) * 4 + 2] = v;
        data[(y * s + x) * 4 + 3] = 255;
      }
    }
  }
}

/* Kanaldan parlaklık örnekleme (sarmalı) */
function ornek(data: Uint8ClampedArray, u: number, v: number): number {
  let uu = u % 1;
  if (uu < 0) uu += 1;
  let vv = v % 1;
  if (vv < 0) vv += 1;
  const px = (uu * (TEX_SIZE - 1)) | 0;
  const py = ((1 - vv) * (TEX_SIZE - 1)) | 0;
  const i = (py * TEX_SIZE + px) * 4;
  return (data[i] + data[i + 1] + data[i + 2]) / 765;
}

/* Katman verisi */
type TexLayer = {
  data: Uint8ClampedArray;
  blend: string;
  depth: number;
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
  rotation: number;
};

type DisplOpts = {
  amplitude: number; // sahne birimi
  invert: boolean;
  symmetric: boolean;
  projection: string;
  blendSmooth: number;
  maskBottom: number; // radyan
  maskTop: number; // radyan
  maskMode: string;
  easing: string;
  smoothing: number;
  maskSmooth: number;
  geoYumusatma: number;
};

/* Ana displacement */
function applyRealDisplacement(
  baseGeometry: THREE.BufferGeometry,
  katmanlar: TexLayer[],
  opts: DisplOpts,
  maskCanvas: HTMLCanvasElement | null
): THREE.BufferGeometry {
  const geo = baseGeometry.clone();
  ensureUV(geo);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  if (!pos || !nor || !uv || katmanlar.length === 0) return geo;

  /* Doku yumuşatma (katman verisi kopyaları üzerinde) */
  const yumusatmaYaricap = Math.round(opts.smoothing * 6);
  const islenecek = katmanlar.map((k) => {
    if (yumusatmaYaricap < 1) return k;
    const kopya = new Uint8ClampedArray(k.data);
    blurImageData(kopya, TEX_SIZE, yumusatmaYaricap);
    return { ...k, data: kopya };
  });

  /* Maske verisi */
  let maskeData: Uint8ClampedArray | null = null;
  if (maskCanvas) {
    const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    const md = mctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
    maskeData = new Uint8ClampedArray(md.data);
    const mYaricap = Math.round(opts.maskSmooth * 2);
    if (mYaricap >= 1) blurImageData(maskeData, MASK_SIZE, mYaricap);
  }

  const amp = opts.amplitude;
  const yon = opts.invert ? -1 : 1;
  const cosAlt = Math.cos(opts.maskBottom);
  const cosUst = Math.cos(opts.maskTop);

  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);

    /* --- Maske --- */
    let maske = 1;
    if (maskeData) {
      // Açı maskesi
      if (nz < -cosAlt) maske = 0;
      else if (nz > cosUst && opts.maskTop > 0) maske = 0;

      // Fırça maskesi
      const mu = uv.getX(i);
      const mv = uv.getY(i);
      const mi =
        ((((1 - (mv % 1 + 1) % 1) * (MASK_SIZE - 1)) | 0) * MASK_SIZE +
          (((mu % 1 + 1) % 1) * (MASK_SIZE - 1))) *
        4;
      const firca = maskeData[mi] / 255;
      if (opts.maskMode === "dahil") maske *= firca;
      else maske *= 1 - firca;

      if (maske <= 0.001) continue;
    }

    /* --- Örnekleme --- */
    let toplam = 0;
    let ilk = true;

    for (let li = 0; li < islenecek.length; li++) {
      const kat = islenecek[li];
      const aci = (kat.rotation * Math.PI) / 180;
      const ca = Math.cos(aci);
      const sa = Math.sin(aci);

      const uvDonus = (bu: number, bv: number): [number, number] => {
        const cx = bu - 0.5;
        const cy = bv - 0.5;
        return [
          (cx * ca - cy * sa + 0.5) * kat.scaleU + kat.offsetU,
          (cx * sa + cy * ca + 0.5) * kat.scaleV + kat.offsetV,
        ];
      };

      let parlak = 0;

      if (opts.projection === "uv") {
        const [bu, bv] = uvDonus(uv.getX(i), uv.getY(i));
        parlak = ornek(kat.data, bu, bv);
        if (opts.symmetric) {
          const [tu, tv] = uvDonus(1 - uv.getX(i), uv.getY(i));
          parlak = Math.max(parlak, ornek(kat.data, tu, tv));
        }
      } else if (opts.projection === "tri") {
        const ax = Math.abs(nx);
        const ay = Math.abs(ny);
        const az = Math.abs(nz);
        const yum = Math.max(0.01, opts.blendSmooth);
        const wx = Math.pow(ax, 1 / yum);
        const wy = Math.pow(ay, 1 / yum);
        const wz = Math.pow(az, 1 / yum);
        const wt = wx + wy + wz || 1;
        const sx = px * 0.2 + 0.5;
        const sy = py * 0.2 + 0.5;
        const sz = pz * 0.2 + 0.5;
        const p1 = ornek(kat.data, ...[uvDonus(sz, sy)][0]);
        const p2 = ornek(kat.data, ...[uvDonus(sx, sy)][0]);
        const p3 = ornek(kat.data, ...[uvDonus(sx, sz)][0]);
        parlak = (p1 * wx + p2 * wy + p3 * wz) / wt;
      } else if (opts.projection === "kutu") {
        if (ax >= ay && ax >= az) {
          parlak = ornek(kat.data, ...[uvDonus(pz * 0.2 + 0.5, py * 0.2 + 0.5)][0]);
        } else if (ay >= az) {
          parlak = ornek(kat.data, ...[uvDonus(px * 0.2 + 0.5, pz * 0.2 + 0.5)][0]);
        } else {
          parlak = ornek(kat.data, ...[uvDonus(px * 0.2 + 0.5, py * 0.2 + 0.5)][0]);
        }
      } else {
        const r = Math.sqrt(px * px + py * py + pz * pz) || 1;
        const su = Math.atan2(pz, px) / (Math.PI * 2) + 0.5;
        const sv = Math.acos(Math.max(-1, Math.min(1, py / r))) / Math.PI;
        parlak = ornek(kat.data, ...[uvDonus(su, sv)][0]);
      }

      parlak = uygulaEasing(Math.max(0, Math.min(1, parlak)), opts.easing);
      parlak *= kat.depth;

      if (ilk) {
        toplam = parlak;
        ilk = false;
      } else if (kat.blend === "ort") {
        toplam = (toplam + parlak) / 2;
      } else if (kat.blend === "maks") {
        toplam = Math.max(toplam, parlak);
      } else if (kat.blend === "carp") {
        toplam = toplam * parlak;
      } else if (kat.blend === "fark") {
        toplam = Math.abs(toplam - parlak);
      } else {
        toplam = toplam + parlak;
      }
    }

    if (toplam <= 0.0001) continue;
    if (toplam > 1) toplam = 1;

    const d = toplam * amp * yon * maske;
    pos.setXYZ(i, px + nx * d, py + ny * d, pz + nz * d);
  }

  pos.needsUpdate = true;

  /* Opsiyonel geometri yumuşatma — normallerden önce */
  if (opts.geoYumusatma > 0) {
    const gecis = Math.max(1, Math.round(opts.geoYumusatma * 2));
    const agirlik = Math.min(0.6, opts.geoYumusatma * 0.5);
    for (let p = 0; p < gecis; p++) pozisyonYumusat(geo, agirlik);
  }

  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------
   İKON SİSTEMİ
   ------------------------------------------------------------ */
const ICON_PATHS: Record<string, React.ReactNode> = {
  upload: (<><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" /></>),
  download: (<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" /></>),
  cube: (<><path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" /><path d="M4 7.4l8 4.6 8-4.6" /><path d="M12 12v9.2" /></>),
  layers: (<><path d="M12 2.8l9 4.7-9 4.7-9-4.7z" /><path d="M3 12.4l9 4.7 9-4.7" /><path d="M3 17.1l9 4.7 9-4.7" /></>),
  sliders: (<><path d="M4 6h8" /><path d="M16 6h4" /><path d="M4 12h4" /><path d="M12 12h8" /><path d="M4 18h12" /><path d="M20 18h0" /><circle cx="14" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>),
  palette: (<><path d="M12 3a9 9 0 100 18h1.5a2 2 0 001.6-3.2 2 2 0 011.6-3.2H19a2.8 2.8 0 002.8-2.8A8.8 8.8 0 0012 3z" /><circle cx="8" cy="9" r="1" /><circle cx="12" cy="7" r="1" /><circle cx="16" cy="9.5" r="1" /></>),
  eye: (<><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></>),
  "eye-off": (<><path d="M3 3l18 18" /><path d="M10.6 6.1A9.9 9.9 0 0112 6c6.4 0 10 6 10 6a17.6 17.6 0 01-3.1 3.8" /><path d="M6.4 7.8A17.4 17.4 0 002 12s3.6 6 10 6a9.6 9.6 0 003.3-.6" /><path d="M9.9 10a2.9 2.9 0 004.1 4.1" /></>),
  grid: (<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  file: (<><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>),
  check: <path d="M4.5 12.5l5 5 10-10" />,
  rotate: (<><path d="M21 12a9 9 0 10-3.2 6.9" /><path d="M21 4v5h-5" /></>),
  ruler: (<><path d="M15.5 2.5l6 6-13 13-6-6z" /><path d="M9 9l1.8 1.8" /><path d="M12 6l1.8 1.8" /><path d="M6 12l1.8 1.8" /></>),
  image: (<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M21 16l-5-5-6 6-3-3-4 4" /></>),
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  "chevron-up": <path d="M6 15l6-6 6 6" />,
  x: (<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>),
  folder: <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  box: (<><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5L12 12l8.5-4.5" /><path d="M12 12v9" /></>),
  zap: <path d="M13 2L4 14h6l-1 8 9-12h-6z" />,
  gauge: (<><path d="M12 20a8 8 0 110-16 8 8 0 010 16z" /><path d="M12 12l4-3.5" /><circle cx="12" cy="12" r="1.4" /></>),
  database: (<><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13" /><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></>),
  brush: (<><path d="M9.5 14.5L4 20" /><path d="M14 4.5l5.5 5.5" /><path d="M8.5 9.5l6 6" /><path d="M14.5 3.5l6 6-6 6-6-6z" /></>),
  bucket: (<><path d="M5 11l7-7 7 7-7 7z" /><path d="M5 11v5a3 3 0 003 3h8" /></>),
  eraser: (<><path d="M8 20H4a1.5 1.5 0 01-1.1-2.6L14 6.3a1.5 1.5 0 012.1 0l4.6 4.6a1.5 1.5 0 010 2.1L13 20z" /><path d="M9 11l6 6" /></>),
  undo: (<><path d="M4 8h9a5 5 0 010 10H8" /><path d="M4 8l4-4" /><path d="M4 8l4 4" /></>),
  redo: (<><path d="M20 8h-9a5 5 0 000 10h5" /><path d="M20 8l-4-4" /><path d="M20 8l-4 4" /></>),
  plus: (<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  minus: <path d="M5 12h14" />,
  lock: (<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></>),
  unlock: (<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 017.5-2" /></>),
  flip: (<><path d="M12 3v18" /><path d="M7 7l-4 5 4 5z" /><path d="M17 7l4 5-4 5z" /></>),
  stamp: (<><path d="M6 21h12" /><path d="M8 17h8v-2a2 2 0 00-1-1.7l-1-.6a2 2 0 01-1-1.7V8a3 3 0 116 0" /><path d="M5 17h14" /></>),
  mask: (<><path d="M3 6.5c3 0 4-1.5 9-1.5s6 1.5 9 1.5v5c0 4-4 8-9 8s-9-4-9-8z" /><circle cx="8.5" cy="11" r="1.2" /><circle cx="15.5" cy="11" r="1.2" /></>),
  save: (<><path d="M4 5a1 1 0 011-1h11l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1z" /><path d="M8 4v6h8V4" /><path d="M8 20v-6h8v6" /></>),
  open: (<><path d="M3 7a2 2 0 012-2h4l2 2.5h6a2 2 0 012 2V11" /><path d="M3 7v12a1 1 0 001 1h13.5a1 1 0 00.9-.6L22 12H7.5a1 1 0 00-.9.6L3 19" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" /></>),
  info: (<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h0" /></>),
  star: <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" />,
  trash: (<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>),
  copy: (<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h4" /></>),
  refresh: (<><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>),
  target: (<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>),
  magnet: (<><path d="M6 4v8a6 6 0 0012 0V4" /><path d="M6 9h4M14 9h4" /></>),
  paint: (<><path d="M5 3h9l3 3v9H8L5 12z" /><path d="M14 3v4h4" /><path d="M12 15v4a2 2 0 004 0v-2" /></>),
  droplet: <path d="M12 3s6 6.4 6 10a6 6 0 11-12 0c0-3.6 6-10 6-10z" />,
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></>),
  moon: <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />,
  cpu: (<><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="10" y="10" width="4" height="4" rx="1" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>),
  activity: <path d="M2 12h4l3-8 4 16 3-8h6" />,
  maximize: (<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>),
};

function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

/* ------------------------------------------------------------
   FPS ÖLÇER
   ------------------------------------------------------------ */
function FpsMeter() {
  const [fps, setFps] = useState(0);
  const kareRef = useRef(0);
  const baslaRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    baslaRef.current = performance.now();
    kareRef.current = 0;
    const dongu = (t: number) => {
      kareRef.current += 1;
      const gecen = t - baslaRef.current;
      if (gecen >= 500) {
        setFps(Math.round((kareRef.current * 1000) / gecen));
        kareRef.current = 0;
        baslaRef.current = t;
      }
      raf = requestAnimationFrame(dongu);
    };
    raf = requestAnimationFrame(dongu);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="mono tnum text-faint">{fps} FPS</span>;
}

/* ------------------------------------------------------------
   EKSEN GİZMOSU
   ------------------------------------------------------------ */
function AxisGizmo() {
  return (
    <svg viewBox="0 0 60 60" width={60} height={60} className="pointer-events-none absolute right-3 top-3 opacity-80" aria-hidden="true">
      <circle cx="30" cy="30" r="1.6" fill="#6e7787" />
      <path d="M30 30L30 12" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M30 30L45 38" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M30 30L15 38" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" />
      <text x="30" y="9" fill="#ef4444" fontSize="7" textAnchor="middle" fontFamily="monospace">X</text>
      <text x="49" y="42" fill="#22c55e" fontSize="7" textAnchor="middle" fontFamily="monospace">Y</text>
      <text x="11" y="42" fill="#3b82f6" fontSize="7" textAnchor="middle" fontFamily="monospace">Z</text>
    </svg>
  );
}

/* ------------------------------------------------------------
   MODEL BİLEŞENİ — displaced geometri local state'te
   ------------------------------------------------------------ */
function Model({
  baseGeometry,
  layers,
  opts,
  maskCanvas,
  maskVersion,
  color,
  wireframe,
  metalness,
  roughness,
  preview3D,
  geoRef,
  onMaskHit,
  onSize,
  maskAktif,
}: {
  baseGeometry: THREE.BufferGeometry;
  layers: any[];
  opts: any;
  maskCanvas: HTMLCanvasElement | null;
  maskVersion: number;
  color: string;
  wireframe: boolean;
  metalness: number;
  roughness: number;
  preview3D: boolean;
  geoRef: React.MutableRefObject<THREE.BufferGeometry | null>;
  onMaskHit: (u: number, v: number) => void;
  onSize: (s: { x: number; y: number; z: number }) => void;
  maskAktif: boolean;
}) {
  const [displaced, setDisplaced] = useState<THREE.BufferGeometry>(() => baseGeometry.clone());

  /* Displacement'ı geciktirerek çalıştır; önizleme kapalıysa atla */
  useEffect(() => {
    let iptal = false;
    const zaman = setTimeout(() => {
      if (iptal) return;

      let g: THREE.BufferGeometry;

      if (!preview3D) {
        g = baseGeometry.clone();
      } else {
        const gecerli = layers.filter((l) => l.visible);
        const texLayers: TexLayer[] = gecerli.map((l) => ({
          data: getTexData(l.presetId).data,
          blend: l.blend,
          depth: l.depth,
          scaleU: l.scaleU,
          scaleV: l.scaleV,
          offsetU: l.offsetU,
          offsetV: l.offsetV,
          rotation: l.rotation,
        }));
        g = applyRealDisplacement(baseGeometry, texLayers, opts, maskCanvas);
      }

      setDisplaced(g);
      geoRef.current = g;
      g.computeBoundingBox();
      const b = new THREE.Vector3();
      g.boundingBox!.getSize(b);
      onSize({ x: b.x, y: b.y, z: b.z });
    }, 60);

    return () => {
      iptal = true;
      clearTimeout(zaman);
    };
  }, [baseGeometry, layers, opts, maskCanvas, maskVersion, geoRef, onSize, preview3D]);

  /* Geometri temizliği */
  useEffect(() => () => displaced.dispose(), [displaced]);

  return (
    <mesh
      geometry={displaced}
      onPointerDown={(e) => {
        if (!maskAktif || !e.uv) return;
        onMaskHit(e.uv.x, e.uv.y);
      }}
    >
      <meshStandardMaterial
        color={color}
        wireframe={wireframe}
        metalness={metalness}
        roughness={roughness}
      />
    </mesh>
  );
}

/* ------------------------------------------------------------
   3MF PAKETLEME YARDIMCISI
   ------------------------------------------------------------ */
function ucgenXmlKur(geo: THREE.BufferGeometry): string {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const harita = new Map<string, number>();
  const koordinat: number[] = [];
  const ucgenler: string[] = [];

  const vertexAl = (i: number): number => {
    const x = pos.getX(i) * MM_PER_UNIT;
    const y = pos.getY(i) * MM_PER_UNIT;
    const z = pos.getZ(i) * MM_PER_UNIT;
    const anahtar = `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;
    const varOlan = harita.get(anahtar);
    if (varOlan !== undefined) return varOlan;
    const yeni = harita.size;
    harita.set(anahtar, yeni);
    koordinat.push(x, y, z);
    return yeni;
  };

  if (idx) {
    for (let t = 0; t < idx.count; t += 3) {
      const a = vertexAl(idx.getX(t));
      const b = vertexAl(idx.getX(t + 1));
      const c = vertexAl(idx.getX(t + 2));
      if (a === b || b === c || a === c) continue;
      ucgenler.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  } else {
    for (let t = 0; t + 2 < pos.count; t += 3) {
      const a = vertexAl(t);
      const b = vertexAl(t + 1);
      const c = vertexAl(t + 2);
      if (a === b || b === c || a === c) continue;
      ucgenler.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  }

  const vertexXml: string[] = [];
  for (let i = 0; i < koordinat.length; i += 3) {
    vertexXml.push(
      `<vertex x="${koordinat[i].toFixed(3)}" y="${koordinat[i + 1].toFixed(3)}" z="${koordinat[i + 2].toFixed(3)}"/>`
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n` +
    vertexXml.join("\n") +
    `\n</vertices>\n<triangles>\n` +
    ucgenler.join("\n") +
    `\n</triangles>\n</mesh>\n</object>\n</resources>\n<build><item objectid="1"/></build>\n</model>`
  );
}

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
  `</Types>`;

const RELS_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>`;

/* ------------------------------------------------------------
   ANA SAYFA
   ------------------------------------------------------------ */
export default function Page() {
  const [mode, setMode] = useState<"kup" | "stl">("kup");
  const [viewMode, setViewMode] = useState<"dolu" | "tel" | "kesit">("dolu");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [metalness, setMetalness] = useState(DEFAULT_METALNESS);
  const [roughness, setRoughness] = useState(DEFAULT_ROUGHNESS);

  const [fileName, setFileName] = useState<string>("");
  const [fileSizeKB, setFileSizeKB] = useState<number>(0);
  const [sizeMm, setSizeMm] = useState({ x: 50, y: 50, z: 50 });
  const [surukleAktif, setSurukleAktif] = useState(false);

  const [category, setCategory] = useState<string>("tumu");
  const [arama, setArama] = useState<string>("");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  /* Özel haritalar */
  const [ozelHaritalar, setOzelHaritalar] = useState<{ id: string; name: string }[]>([]);
  const [yuklemeDurum, setYuklemeDurum] = useState<string>("");
  const ozelInputRef = useRef<HTMLInputElement | null>(null);
  const stlInputRef = useRef<HTMLInputElement | null>(null);
  const ozelSayac = useRef(0);

  /* Katmanlar */
  const [layers, setLayers] = useState<any[]>([
    {
      id: "kat1",
      presetId: "kristal",
      blend: "ekle",
      depth: 1,
      visible: true,
      scaleU: 1,
      scaleV: 1,
      offsetU: 0,
      offsetV: 0,
      rotation: 0,
    },
  ]);
  const [activeLayer, setActiveLayer] = useState<string>("kat1");

  /* Kabartma */
  const [amplitudeMm, setAmplitudeMm] = useState(1.22);
  const [invert, setInvert] = useState(false);
  const [symmetric, setSymmetric] = useState(false);
  const [preview3D, setPreview3D] = useState(true);
  const [smoothing, setSmoothing] = useState(0);
  const [geoYumusatma, setGeoYumusatma] = useState(0);
  const [invertTexture, setInvertTexture] = useState(false);

  /* Yansıtma */
  const [projection, setProjection] = useState("uv");
  const [blendSmooth, setBlendSmooth] = useState(0.5);
  const [stampMode, setStampMode] = useState(false);

  /* Dönüştür */
  const [sizeU, setSizeU] = useState(2.01);
  const [sizeV, setSizeV] = useState(2.01);
  const [uvLock, setUvLock] = useState(true);
  const [offsetU, setOffsetU] = useState(0);
  const [offsetV, setOffsetV] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [rotateSides, setRotateSides] = useState(false);

  /* Maskeleme */
  const [maskBottom, setMaskBottom] = useState(5);
  const [maskTop, setMaskTop] = useState(0);
  const [maskMode, setMaskMode] = useState<"haric" | "dahil">("haric");
  const [maskTool, setMaskTool] = useState<"firca" | "doldur" | null>(null);
  const [brushSize, setBrushSize] = useState(12);
  const [maskSmooth, setMaskSmooth] = useState(0);
  const [easing, setEasing] = useState<"dogrusal" | "s" | "yumusak">("dogrusal");
  const [maskVersion, setMaskVersion] = useState(0);
  const [maskedCount, setMaskedCount] = useState(0);
  const [shiftBasili, setShiftBasili] = useState(false);

  /* Dışa aktarma */
  const [exportRes, setExportRes] = useState(0.35);
  const [exportStatus, setExportStatus] = useState<"idle" | "working" | "done" | "error">("idle");

  /* Geometri + maske */
  const [baseGeometry, setBaseGeometry] = useState<THREE.BufferGeometry>(
    () => new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, CUBE_SEG, CUBE_SEG, CUBE_SEG)
  );
  const geoRef = useRef<THREE.BufferGeometry | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);

  /* Maske canvas'ı istemcide oluştur */
  useEffect(() => {
    const c = document.createElement("canvas");
    c.width = MASK_SIZE;
    c.height = MASK_SIZE;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
    maskRef.current = c;
    setMaskVersion((v) => v + 1);
  }, []);

  /* Shift takibi */
  useEffect(() => {
    const indi = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftBasili(true);
    };
    const kalkti = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftBasili(false);
    };
    window.addEventListener("keydown", indi);
    window.addEventListener("keyup", kalkti);
    return () => {
      window.removeEventListener("keydown", indi);
      window.removeEventListener("keyup", kalkti);
    };
  }, []);

  const handleSize = useCallback((s: { x: number; y: number; z: number }) => {
    setSizeMm({ x: s.x * MM_PER_UNIT, y: s.y * MM_PER_UNIT, z: s.z * MM_PER_UNIT });
  }, []);

  /* Thumbnail üretimi */
  useEffect(() => {
    let durdur = false;
    const idler = Object.keys(PRESET_MAP);
    let i = 0;
    const parca = () => {
      if (durdur) return;
      const son = Math.min(i + 8, idler.length);
      const yeni: Record<string, string> = {};
      for (; i < son; i++) {
        const id = idler[i];
        if (!THUMB_CACHE.has(id)) THUMB_CACHE.set(id, makeThumbCanvas(id).toDataURL("image/png"));
        yeni[id] = THUMB_CACHE.get(id)!;
      }
      setThumbs((t) => ({ ...t, ...yeni }));
      if (i < idler.length) setTimeout(parca, 0);
    };
    parca();
    return () => {
      durdur = true;
    };
  }, []);

  /* Aktif katman */
  const aktifKatman = layers.find((l) => l.id === activeLayer) || layers[0];

  /* Preset adı çözücü (özel haritalar dahil) */
  const presetAdi = useCallback(
    (id: string) =>
      PRESET_MAP[id]?.name ||
      ozelHaritalar.find((o) => o.id === id)?.name ||
      "Katman",
    [ozelHaritalar]
  );

  /* Displacement seçenekleri (memo) */
  const opts = useMemo(
    () => ({
      amplitude: (invertTexture ? -amplitudeMm : amplitudeMm) * UNIT_PER_MM,
      invert,
      symmetric,
      projection,
      blendSmooth,
      maskBottom: (maskBottom * Math.PI) / 180,
      maskTop: (maskTop * Math.PI) / 180,
      maskMode,
      easing,
      smoothing,
      maskSmooth,
      geoYumusatma,
    }),
    [
      amplitudeMm,
      invert,
      symmetric,
      projection,
      blendSmooth,
      maskBottom,
      maskTop,
      maskMode,
      easing,
      smoothing,
      maskSmooth,
      invertTexture,
      geoYumusatma,
    ]
  );

  /* Aktif katman değişince dönüşüm değerlerini o katmandan yükle */
  const oncekiKatmanRef = useRef<string>("");
  useEffect(() => {
    if (oncekiKatmanRef.current === activeLayer) return;
    const l = layers.find((x) => x.id === activeLayer);
    if (!l) return;
    oncekiKatmanRef.current = activeLayer;
    setSizeU(50 / Math.max(0.1, l.scaleU));
    setSizeV(50 / Math.max(0.1, l.scaleV));
    setOffsetU(l.offsetU * 50);
    setOffsetV(l.offsetV * 50);
    setRotation(l.rotation);
  }, [activeLayer, layers]);

  /* Dönüşüm değerlerini yalnızca aktif katmana yaz */
  useEffect(() => {
    if (!aktifKatman) return;
    const su = 50 / Math.max(0.1, sizeU);
    const sv = 50 / Math.max(0.1, sizeV);
    setLayers((ls) =>
      ls.map((l) =>
        l.id === aktifKatman.id
          ? {
              ...l,
              scaleU: su,
              scaleV: sv,
              offsetU: offsetU / 50,
              offsetV: offsetV / 50,
              rotation,
            }
          : l
      )
    );
  }, [sizeU, sizeV, offsetU, offsetV, rotation, activeLayer]);

  const presetSec = useCallback((presetId: string) => {
    setLayers((ls) => ls.map((l) => (l.id === activeLayer ? { ...l, presetId } : l)));
  }, [activeLayer]);

  /* Katman yönetimi */
  const katmanEkle = useCallback(() => {
    setLayers((ls) => {
      if (ls.length >= MAX_LAYERS) return ls;
      let sayac = ls.length + 1;
      while (ls.some((l) => l.id === `kat${sayac}`)) sayac++;
      const id = `kat${sayac}`;
      const su = 50 / Math.max(0.1, sizeU);
      const sv = 50 / Math.max(0.1, sizeV);
      setActiveLayer(id);
      return [
        ...ls,
        {
          id,
          presetId: "gurultu",
          blend: "ort",
          depth: 0.6,
          visible: true,
          scaleU: su,
          scaleV: sv,
          offsetU: offsetU / 50,
          offsetV: offsetV / 50,
          rotation,
        },
      ];
    });
  }, [sizeU, sizeV, offsetU, offsetV, rotation]);

  const katmanSil = useCallback(
    (id: string) => {
      setLayers((ls) => {
        if (ls.length === 1) return ls;
        const kalan = ls.filter((l) => l.id !== id);
        if (id === activeLayer) setActiveLayer(kalan[0].id);
        return kalan;
      });
    },
    [activeLayer]
  );

  const katmanTasi = useCallback((id: string, yon: -1 | 1) => {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      if (i < 0) return ls;
      const j = i + yon;
      if (j < 0 || j >= ls.length) return ls;
      const kopya = [...ls];
      const gecici = kopya[i];
      kopya[i] = kopya[j];
      kopya[j] = gecici;
      return kopya;
    });
  }, []);

  const katmanKopyala = useCallback((id: string) => {
    setLayers((ls) => {
      if (ls.length >= MAX_LAYERS) return ls;
      const kaynak = ls.find((l) => l.id === id);
      if (!kaynak) return ls;
      let sayac = ls.length + 1;
      while (ls.some((l) => l.id === `kat${sayac}`)) sayac++;
      const yeniId = `kat${sayac}`;
      setActiveLayer(yeniId);
      return [...ls, { ...kaynak, id: yeniId }];
    });
  }, []);

  const katmanDerinlik = useCallback((id: string, deger: number) => {
    setLayers((ls) =>
      ls.map((l) => (l.id === id ? { ...l, depth: Math.max(0, Math.min(2, deger)) } : l))
    );
  }, []);

  const katmanGorunurluk = useCallback((id: string) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  }, []);

  const tumGorunurluk = useCallback((deger: boolean) => {
    setLayers((ls) => ls.map((l) => ({ ...l, visible: deger })));
  }, []);

  /* Özel harita yükleme */
  const ozelHaritaYukle = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setYuklemeDurum("Yalnızca PNG / JPG / WEBP yükleyin.");
        setTimeout(() => setYuklemeDurum(""), 2600);
        return;
      }
      try {
        const okunan = await gorselOku(file);
        ozelSayac.current += 1;
        const id = `ozel_${ozelSayac.current}`;

        const canvas = document.createElement("canvas");
        canvas.width = TEX_SIZE;
        canvas.height = TEX_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        fillBg(ctx, TEX_SIZE, "#000000");
        const oran = Math.max(TEX_SIZE / okunan.w, TEX_SIZE / okunan.h);
        const w = okunan.w * oran;
        const h = okunan.h * oran;
        ctx.drawImage(okunan.kaynak, (TEX_SIZE - w) / 2, (TEX_SIZE - h) / 2, w, h);

        CUSTOM_MAPS.set(id, canvas);
        TEX_CACHE.delete(id);
        THUMB_CACHE.set(id, makeThumbCanvas(id).toDataURL("image/png"));

        const ad =
          file.name.replace(/\.[^.]+$/, "").slice(0, 40).trim() || `Özel harita ${ozelSayac.current}`;

        setOzelHaritalar((m) => [...m, { id, name: ad }]);
        setThumbs((t) => ({ ...t, [id]: THUMB_CACHE.get(id)! }));
        setLayers((ls) => ls.map((l) => (l.id === activeLayer ? { ...l, presetId: id } : l)));
        setCategory("ozel");
        setArama("");
        setYuklemeDurum(`"${ad}" galeriye eklendi.`);
        setTimeout(() => setYuklemeDurum(""), 2600);
      } catch {
        setYuklemeDurum("Görsel okunamadı, tekrar deneyin.");
        setTimeout(() => setYuklemeDurum(""), 2600);
      }
    },
    [activeLayer]
  );

  const ozelHaritaSil = useCallback((id: string) => {
    CUSTOM_MAPS.delete(id);
    TEX_CACHE.delete(id);
    THUMB_CACHE.delete(id);
    setOzelHaritalar((m) => m.filter((o) => o.id !== id));
    setThumbs((t) => {
      const kopya = { ...t };
      delete kopya[id];
      return kopya;
    });
    setLayers((ls) => ls.map((l) => (l.presetId === id ? { ...l, presetId: "gurultu" } : l)));
  }, []);

  /* STL yükleme */
  const handleFile = useCallback((file: File) => {
    if (!file.name.toLocaleLowerCase("tr-TR").endsWith(".stl")) {
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2500);
      return;
    }
    if (file.size > MAX_STL_MB * 1024 * 1024) {
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2500);
      return;
    }

    setExportStatus("working");
    const okuyucu = new FileReader();

    okuyucu.onload = () => {
      try {
        const tampon = okuyucu.result as ArrayBuffer;
        const ham = new STLLoader().parse(tampon);
        const geo = normalizeGeometry(ham);
        geo.computeBoundingBox();
        setBaseGeometry(geo);
        setFileName(file.name);
        setFileSizeKB(Math.max(1, Math.round(file.size / 1024)));
        setMode("stl");
        setExportStatus("idle");
      } catch {
        setExportStatus("error");
        setTimeout(() => setExportStatus("idle"), 2500);
      }
    };

    okuyucu.onerror = () => {
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2500);
    };

    okuyucu.readAsArrayBuffer(file);
  }, []);

  const kubeDon = useCallback(() => {
    const geo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, CUBE_SEG, CUBE_SEG, CUBE_SEG);
    setBaseGeometry(geo);
    setMode("kup");
    setFileName("");
    setFileSizeKB(0);
  }, []);

  /* Fırça ile maske boyama */
  const maskeBoyan = useCallback(
    (u: number, v: number) => {
      const c = maskRef.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      const x = u * MASK_SIZE;
      const y = (1 - v) * MASK_SIZE;
      const r = brushSize / 2;
      ctx.globalCompositeOperation = shiftBasili ? "destination-out" : "source-over";
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(2, r * 2));
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.6, "#ffffff");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, r * 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      setMaskedCount((n) => n + 1);
      setMaskVersion((ver) => ver + 1);
    },
    [brushSize, shiftBasili]
  );

  const maskeyiTemizle = useCallback(() => {
    const c = maskRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
    setMaskedCount(0);
    setMaskVersion((v) => v + 1);
  }, []);

  /* Doldur: tüm yüzeyi maskele */
  const doldur = useCallback(() => {
    const c = maskRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
    setMaskedCount(1);
    setMaskVersion((v) => v + 1);
  }, []);

  /* STL dışa aktarma */
  const stlIndir = useCallback(() => {
    const geo = geoRef.current;
    if (!geo) return;
    setExportStatus("working");
    setTimeout(() => {
      try {
        const mesh = new THREE.Mesh(geo);
        const buffer = new STLExporter().parse(mesh, { binary: true });
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `palamut3d_${Date.now()}.stl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setExportStatus("done");
        setTimeout(() => setExportStatus("idle"), 2200);
      } catch {
        setExportStatus("error");
        setTimeout(() => setExportStatus("idle"), 2200);
      }
    }, 40);
  }, []);

  /* 3MF dışa aktarma */
  const handle3MFExport = useCallback(() => {
    const geo = geoRef.current;
    if (!geo) return;
    setExportStatus("working");
    setTimeout(() => {
      void (async () => {
        try {
          const modelXml = ucgenXmlKur(geo);
          const zip = new JSZip();
          zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
          zip.file("_rels/.rels", RELS_XML);
          zip.file("3D/3dmodel.model", modelXml);
          const blob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `palamut3d_${Date.now()}.3mf`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setExportStatus("done");
          setTimeout(() => setExportStatus("idle"), 2200);
        } catch {
          setExportStatus("error");
          setTimeout(() => setExportStatus("idle"), 2200);
        }
      })();
    }, 40);
  }, []);

  const vertexSayisi = baseGeometry.attributes.position.count;
  const ucgenSayisi = Math.round(vertexSayisi / 3) || 0;
  const gosterilenAd = fileName || "kup.stl";

  /* Galeri listesi (presetler + özel haritalar, arama ve kategori filtreli) */
  const galeriOgeleri = useMemo(() => {
    const q = arama.trim().toLocaleLowerCase("tr-TR");
    const hepsi: { id: string; name: string; category: string; ozel: boolean }[] = [
      ...PRESETS.map((p) => ({ id: p.id, name: p.name, category: p.category, ozel: false })),
      ...ozelHaritalar.map((o) => ({ id: o.id, name: o.name, category: "ozel", ozel: true })),
    ];
    return hepsi.filter((o) => {
      const katOk =
        category === "tumu" ? true : category === "ozel" ? o.ozel : o.category === category;
      const adOk = q === "" || o.name.toLocaleLowerCase("tr-TR").includes(q);
      return katOk && adOk;
    });
  }, [category, arama, ozelHaritalar]);

  /* Çözünürlüğe göre kaba poligon tahmini */
  const tahminiUcgen = useMemo(() => {
    const oran = 0.35 / Math.max(0.05, exportRes);
    return Math.max(12, Math.round(ucgenSayisi * oran * oran));
  }, [ucgenSayisi, exportRes]);

  const maskAktif = maskTool === "firca";
  const hepsiGorunur = layers.every((l) => l.visible);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <header className="flex h-header shrink-0 items-center justify-between border-b border-line bg-panel px-4">
        <div className="flex items-center gap-2">
          <Icon name="cube" size={18} className="text-accent" />
          <span className="text-[15px] font-bold leading-none text-ink">Palamut3D</span>
          <span className="mono text-[10px] leading-none text-faint">v2.0</span>
          <span className="sep text-[11px] leading-none">·</span>
          <span className="text-[11px] leading-none text-dim">by</span>
          <a href="https://mucahidbalci.github.io" target="_blank" rel="noopener noreferrer" className="link text-[11px] leading-none">
            Mucahid Balci
          </a>
        </div>

        <div className="flex items-center gap-2">
          <div className="seg">
            <button type="button" onClick={() => setMode("kup")} data-active={mode === "kup"}>
              <Icon name="cube" size={13} />Küp
            </button>
            <button
              type="button"
              onClick={() => setMode("stl")}
              data-active={mode === "stl"}
              disabled={!fileName}
              title={fileName ? "Yüklenen STL'ye dön" : "Önce bir STL yükleyin"}
            >
              <Icon name="file" size={13} />STL
            </button>
          </div>

          <div className="seg">
            <button type="button" onClick={() => setViewMode("dolu")} data-active={viewMode === "dolu"}>
              <Icon name="eye" size={13} />Dolu
            </button>
            <button type="button" onClick={() => setViewMode("tel")} data-active={viewMode === "tel"}>
              <Icon name="eye-off" size={13} />Tel
            </button>
            <button type="button" onClick={() => setViewMode("kesit")} data-active={viewMode === "kesit"}>
              <Icon name="layers" size={13} />Kesit
            </button>
          </div>

          <div className="seg">
            <button type="button" className="btn-icon" aria-label="Geri al" title="Geri al">
              <Icon name="undo" size={13} />
            </button>
            <button type="button" className="btn-icon" aria-label="İleri al" title="İleri al">
              <Icon name="redo" size={13} />
            </button>
            <button type="button" className="btn-icon" aria-label="Projeyi kaydet" title="Projeyi kaydet">
              <Icon name="save" size={13} />
            </button>
            <button type="button" className="btn-icon" aria-label="Proje aç" title="Proje aç">
              <Icon name="open" size={13} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <Canvas
            camera={{ position: [8, 8, 8], fov: 50 }}
            dpr={[1, 2]}
            gl={{ antialias: true }}
          >
            <color attach="background" args={["#0b0e13"]} />
            <ambientLight intensity={0.55} />
            <directionalLight position={[6, 10, 6]} intensity={1.0} />
            <directionalLight position={[-8, -4, -6]} intensity={0.45} />
            <hemisphereLight args={["#8fb4d8", "#0b0e13", 0.2]} />

            <Model
              baseGeometry={baseGeometry}
              layers={layers}
              opts={opts}
              maskCanvas={maskRef.current}
              maskVersion={maskVersion}
              color={color}
              wireframe={viewMode === "tel"}
              metalness={metalness}
              roughness={roughness}
              preview3D={preview3D}
              geoRef={geoRef}
              onMaskHit={maskeBoyan}
              onSize={handleSize}
              maskAktif={maskAktif}
            />

            <Grid
              position={[0, -2.6, 0]}
              args={[24, 24]}
              cellSize={0.5}
              cellThickness={0.6}
              cellColor="#232a35"
              sectionSize={2.5}
              sectionThickness={1}
              sectionColor="#2e3745"
              infiniteGrid
              fadeDistance={30}
              fadeStrength={1.2}
            />

            <OrbitControls enableDamping dampingFactor={0.08} minDistance={3} maxDistance={30} />
          </Canvas>

          <AxisGizmo />

          <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-faint">
            {maskAktif
              ? "Fırça aktif · Sol tık: boya · Shift + sol tık: sil"
              : "Sol tık: döndür · Tekerlek: yakınlaştır · Sağ tık: kaydır"}
          </div>

          {!preview3D ? (
            <div className="mono pointer-events-none absolute bottom-3 right-3 rounded-btn border border-line bg-panel px-2 py-1 text-[10px] text-dim">
              Önizleme kapalı · düz geometri
            </div>
          ) : null}
        </main>

        <aside className="panel">
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Model</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Varsayılan küpe dön"
                  aria-label="Varsayılan küpe dön"
                  onClick={kubeDon}
                >
                  <Icon name="cube" size={13} />
                </button>
                <Icon name="folder" size={14} className="text-faint" />
              </div>
            </div>

            <label
              className="dropzone block cursor-pointer px-3 py-4 text-center"
              data-drag={surukleAktif ? "true" : "false"}
              onDragOver={(e) => {
                e.preventDefault();
                setSurukleAktif(true);
              }}
              onDragLeave={() => setSurukleAktif(false)}
              onDrop={(e) => {
                e.preventDefault();
                setSurukleAktif(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
            >
              <input
                ref={stlInputRef}
                type="file"
                accept=".stl"
                className="sr-file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) handleFile(f);
                }}
              />
              <Icon name="upload" size={20} className="mx-auto mb-1.5 text-dim" />
              <div className="text-[11px] text-ink">STL dosyasını buraya bırakın</div>
              <div className="mt-0.5 text-[10px] text-dim">
                veya <span className="text-accent underline underline-offset-2">dosya seçin</span>
              </div>
              <div className="mono mt-1 text-[9px] text-faint">ASCII veya ikili STL · en fazla {MAX_STL_MB} MB</div>
            </label>

            <div className="mono mt-2 text-[10px] leading-relaxed text-dim">
              {fileName ? (
                <span>
                  <span className="text-ink">{fileName}</span>
                  <span className="sep"> | STL | </span>
                  <span className="tnum">{fileSizeKB} KB</span>
                  <span className="sep"> | </span>
                  <span className="tnum">{ucgenSayisi.toLocaleString("tr-TR")} üçgen</span>
                  <span className="sep"> | </span>
                  <span className="tnum">{vertexSayisi.toLocaleString("tr-TR")} vertex</span>
                </span>
              ) : (
                <span className="text-faint">Varsayılan küp üzerinde çalışılıyor</span>
              )}
            </div>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Görünüm</h2>
              <Icon name="palette" size={14} className="text-faint" />
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
              {QUICK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-5 w-5 rounded-btn border ${
                    color.toLocaleLowerCase("tr-TR") === c
                      ? "border-accent ring-1 ring-accent"
                      : "border-line-strong"
                  } flex items-center justify-center text-bg`}
                  style={{ background: c }}
                  title={c}
                  aria-label={`Renk ${c}`}
                >
                  {color.toLocaleLowerCase("tr-TR") === c ? <Icon name="check" size={9} /> : null}
                </button>
              ))}
            </div>

            <div className="mb-2 flex items-center gap-1.5">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-7 w-9 shrink-0 cursor-pointer rounded-btn border border-line bg-bg p-0.5"
                aria-label="Özel renk seç"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setColor(v);
                }}
                className="mono min-w-0 flex-1"
                aria-label="Renk kodu"
              />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Metalik</span>
                <span className="field-value">{metalness.toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={metalness} onChange={(e) => setMetalness(parseFloat(e.target.value))} />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Pürüzlülük</span>
                <span className="field-value">{roughness.toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={roughness} onChange={(e) => setRoughness(parseFloat(e.target.value))} />
            </div>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Kabartma Katmanları</h2>
              <div className="flex items-center gap-1">
                <span className="mono text-[10px] text-faint">
                  {layers.length}/{MAX_LAYERS}
                </span>
                <button
                  type="button"
                  className="btn btn-icon"
                  data-active={hepsiGorunur}
                  onClick={() => tumGorunurluk(!hepsiGorunur)}
                  title={hepsiGorunur ? "Tüm katmanları gizle" : "Tüm katmanları göster"}
                  aria-label={hepsiGorunur ? "Tüm katmanları gizle" : "Tüm katmanları göster"}
                >
                  <Icon name={hepsiGorunur ? "eye" : "eye-off"} size={12} />
                </button>
              </div>
            </div>

            <div className="relative mb-2">
              <select
                value={activeLayer}
                onChange={(e) => setActiveLayer(e.target.value)}
                className="w-full appearance-none rounded-btn border border-line bg-bg px-2 py-1 pr-6 text-[11px] text-ink"
              >
                {layers.map((l, i) => (
                  <option key={l.id} value={l.id}>
                    {i + 1} · {presetAdi(l.presetId)}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-faint" />
            </div>

            <div className="mb-2 space-y-1.5">
              {layers.map((l, i) => (
                <div
                  key={l.id}
                  onClick={() => setActiveLayer(l.id)}
                  className={`cursor-pointer rounded-btn border p-1.5 transition-colors duration-150 ${
                    l.id === activeLayer
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-bg hover:border-line-strong"
                  }`}
                >
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="mono w-3 shrink-0 text-[9px] text-faint">{i + 1}</span>
                    <div className="h-6 w-6 shrink-0 overflow-hidden rounded-swatch border border-line-strong">
                      {thumbs[l.presetId] ? (
                        <img src={thumbs[l.presetId]} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <span className={`min-w-0 flex-1 truncate text-[11px] ${l.visible ? "text-ink" : "text-faint"}`}>
                      {presetAdi(l.presetId)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Yukarı taşı"
                      aria-label="Yukarı taşı"
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        katmanTasi(l.id, -1);
                      }}
                    >
                      <Icon name="chevron-up" size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Aşağı taşı"
                      aria-label="Aşağı taşı"
                      disabled={i === layers.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        katmanTasi(l.id, 1);
                      }}
                    >
                      <Icon name="chevron-down" size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      data-active={l.visible}
                      title={l.visible ? "Katmanı gizle" : "Katmanı göster"}
                      aria-label={l.visible ? "Katmanı gizle" : "Katmanı göster"}
                      onClick={(e) => {
                        e.stopPropagation();
                        katmanGorunurluk(l.id);
                      }}
                    >
                      <Icon name={l.visible ? "eye" : "eye-off"} size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Katmanı çoğalt"
                      aria-label="Katmanı çoğalt"
                      disabled={layers.length >= MAX_LAYERS}
                      onClick={(e) => {
                        e.stopPropagation();
                        katmanKopyala(l.id);
                      }}
                    >
                      <Icon name="copy" size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Katmanı sil"
                      aria-label="Katmanı sil"
                      disabled={layers.length === 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        katmanSil(l.id);
                      }}
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <select
                        value={l.blend}
                        onChange={(e) =>
                          setLayers((ls) =>
                            ls.map((x) => (x.id === l.id ? { ...x, blend: e.target.value } : x))
                          )
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="appearance-none rounded-btn border border-line bg-card py-0.5 pl-1 pr-4 text-[10px] text-dim"
                      >
                        {BLEND_MODES.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.label}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron-down" size={9} className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-faint" />
                    </div>
                    <span className="field-label shrink-0">Derinlik</span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.01}
                      value={l.depth}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => katmanDerinlik(l.id, parseFloat(e.target.value))}
                      className="min-w-0 flex-1"
                    />
                    <span className="mono w-8 shrink-0 text-right text-[9px] tnum text-dim">
                      {l.depth.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn w-full"
              onClick={katmanEkle}
              disabled={layers.length >= MAX_LAYERS}
            >
              <Icon name="plus" size={12} />
              Katman ekle
            </button>
            <p className="field-hint mt-1.5">
              Katmanlar yukarıdan aşağıya doğru üst üste bindirilir. Blend modu ve derinlik her katman için ayrı
              çalışır.
            </p>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Doku Galerisi</h2>
              <span className="mono text-[10px] text-faint">
                {galeriOgeleri.length}/{PRESETS.length + ozelHaritalar.length}
              </span>
            </div>

            <div className="relative mb-2">
              <input
                type="search"
                value={arama}
                onChange={(e) => setArama(e.target.value)}
                placeholder="Doku ara"
                className="w-full pr-6"
              />
              <Icon name="grid" size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint" />
            </div>

            <div className="mb-2 flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`rounded-btn border px-1.5 py-0.5 text-[10px] transition-colors duration-150 ${
                    category === c.id
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-dim hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {c.label}
                  {c.id === "ozel" ? ` (${ozelHaritalar.length})` : ""}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-5 gap-1.5">
              {galeriOgeleri.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => presetSec(p.id)}
                  className="thumb-cell"
                  data-selected={aktifKatman?.presetId === p.id}
                  title={p.name}
                  aria-label={p.name}
                >
                  {thumbs[p.id] ? (
                    <img src={thumbs[p.id]} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="block h-full w-full bg-card" />
                  )}
                  {aktifKatman?.presetId === p.id ? (
                    <span className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-bg">
                      <Icon name="check" size={9} />
                    </span>
                  ) : null}
                  {p.ozel ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        ozelHaritaSil(p.id);
                      }}
                      className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bg/85 text-dim hover:text-ink"
                      title="Özel haritayı sil"
                    >
                      <Icon name="x" size={8} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {galeriOgeleri.length === 0 ? (
              <div className="mono mt-2 text-[10px] text-faint">
                {category === "ozel" && ozelHaritalar.length === 0
                  ? "Henüz özel harita yok. PNG veya JPG yükleyin."
                  : "Eşleşen doku yok."}
              </div>
            ) : null}

            <input
              ref={ozelInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void ozelHaritaYukle(f);
              }}
            />
            <button
              type="button"
              className="btn mt-2 w-full"
              onClick={() => ozelInputRef.current?.click()}
            >
              <Icon name="image" size={12} />
              Özelleştirilmiş bir harita yükle
            </button>
            <p className="field-hint mt-1.5">
              PNG / JPG / WEBP. Görsel 512 × 512&apos;ye kırpılır ve gri tonlamalı yükseklik olarak okunur.
            </p>
            {yuklemeDurum ? (
              <div className="mono mt-1 text-[10px] text-accent">{yuklemeDurum}</div>
            ) : null}
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Yansıtma</h2>
              <Icon name="target" size={14} className="text-faint" />
            </div>

            <div className="relative mb-2">
              <select
                value={projection}
                onChange={(e) => setProjection(e.target.value)}
                className="w-full appearance-none rounded-btn border border-line bg-bg px-2 py-1 pr-6 text-[11px] text-ink"
              >
                <option value="uv">UV</option>
                <option value="tri">Üç düzlemli (Triplanar)</option>
                <option value="kutu">Kutu</option>
                <option value="kuresel">Küresel</option>
              </select>
              <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-faint" />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Kesişme Yumuşatma Seviyesi</span>
                <span className="field-value">{blendSmooth.toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.05} value={blendSmooth} onChange={(e) => setBlendSmooth(parseFloat(e.target.value))} />
            </div>

            <button type="button" className="btn w-full" data-active={stampMode} onClick={() => setStampMode((v) => !v)}>
              <Icon name="stamp" size={12} />
              Damga modu
            </button>
            <p className="field-hint mt-1.5">
              Açıkken desen tekrarlamaz; modele tek noktaya basılır. Yeri sahnede tıklayarak seçin.
            </p>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Kabartma Derinliği</h2>
              <Icon name="ruler" size={14} className="text-faint" />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Kabartma uzunluğu</span>
                <span className="field-value">{amplitudeMm.toFixed(2)} mm</span>
              </div>
              <input type="range" min={0} max={5} step={0.01} value={amplitudeMm} onChange={(e) => setAmplitudeMm(parseFloat(e.target.value))} />
            </div>

            <div className="mb-2 space-y-1.5">
              <label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink">
                <button type="button" className="cbox mt-0.5" data-checked={invert} onClick={() => setInvert((v) => !v)} aria-label="Yönü değiştir">
                  <Icon name="check" size={10} />
                </button>
                <span onClick={() => setInvert((v) => !v)}>
                  Yönü değiştir
                  <span className="field-hint block">Kabartma dışarı çıkmak yerine içeri çöker.</span>
                </span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink">
                <button type="button" className="cbox" data-checked={symmetric} onClick={() => setSymmetric((v) => !v)} aria-label="Simetrik kabartma">
                  <Icon name="check" size={10} />
                </button>
                <span onClick={() => setSymmetric((v) => !v)}>Simetrik Kabartma</span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink">
                <button type="button" className="cbox" data-checked={preview3D} onClick={() => setPreview3D((v) => !v)} aria-label="3D önizleme">
                  <Icon name="check" size={10} />
                </button>
                <span onClick={() => setPreview3D((v) => !v)}>
                  3D Önizleme
                  <span className="field-hint block">Kapatıldığında displacement hesaplanmaz, düz geometri görünür.</span>
                </span>
              </label>
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Kaplama Yumuşatma</span>
                <span className="field-value">{smoothing.toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.05} value={smoothing} onChange={(e) => setSmoothing(parseFloat(e.target.value))} />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Geometri Yumuşatma</span>
                <span className="field-value">{geoYumusatma.toFixed(2)}</span>
              </div>
              <input type="range" min={0} max={1} step={0.05} value={geoYumusatma} onChange={(e) => setGeoYumusatma(parseFloat(e.target.value))} />
              <p className="field-hint mt-1">Normaller hesaplanmadan önce köşe noktalarını komşularına doğru çeker.</p>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink">
              <button type="button" className="cbox" data-checked={invertTexture} onClick={() => setInvertTexture((v) => !v)} aria-label="Dokuyu ters çevir">
                <Icon name="check" size={10} />
              </button>
              <span onClick={() => setInvertTexture((v) => !v)}>Dokuyu ters çevir</span>
            </label>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Dönüştür</h2>
              <Icon name="rotate" size={14} className="text-faint" />
            </div>

            <p className="field-hint mb-2">Daha küçük ya da büyük boyutlar için kutucuğa değer girin.</p>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">U Boyutu</span>
                <span className="field-value">{sizeU.toFixed(2)} mm</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step={0.01}
                  value={sizeU}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSizeU(v);
                    if (uvLock) setSizeV(v);
                  }}
                />
                <input
                  type="number"
                  min={0.1}
                  max={50}
                  step={0.01}
                  value={sizeU}
                  onChange={(e) => {
                    const v = Math.max(0.1, Math.min(50, parseFloat(e.target.value) || 0.1));
                    setSizeU(v);
                    if (uvLock) setSizeV(v);
                  }}
                  className="w-14"
                />
              </div>
            </div>

            <div className="mb-2 flex justify-center">
              <button type="button" onClick={() => setUvLock((v) => !v)} className="btn btn-icon" data-active={uvLock} aria-label="U ve V kilidi" title="U ve V değerlerini eşitle">
                <Icon name={uvLock ? "lock" : "unlock"} size={12} />
              </button>
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">V Boyutu</span>
                <span className="field-value">{sizeV.toFixed(2)} mm</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.1}
                  max={50}
                  step={0.01}
                  value={sizeV}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSizeV(v);
                    if (uvLock) setSizeU(v);
                  }}
                />
                <input
                  type="number"
                  min={0.1}
                  max={50}
                  step={0.01}
                  value={sizeV}
                  onChange={(e) => {
                    const v = Math.max(0.1, Math.min(50, parseFloat(e.target.value) || 0.1));
                    setSizeV(v);
                    if (uvLock) setSizeU(v);
                  }}
                  className="w-14"
                />
              </div>
            </div>

            <div className="mb-2 grid grid-cols-2 gap-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="field-label">U Offseti</span>
                  <span className="field-value">{offsetU.toFixed(1)} mm</span>
                </div>
                <input type="range" min={-50} max={50} step={0.5} value={offsetU} onChange={(e) => setOffsetU(parseFloat(e.target.value))} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="field-label">V Offseti</span>
                  <span className="field-value">{offsetV.toFixed(1)} mm</span>
                </div>
                <input type="range" min={-50} max={50} step={0.5} value={offsetV} onChange={(e) => setOffsetV(parseFloat(e.target.value))} />
              </div>
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Rotasyon Açısı</span>
                <span className="field-value">{rotation} °</span>
              </div>
              <input type="range" min={0} max={360} step={1} value={rotation} onChange={(e) => setRotation(parseFloat(e.target.value))} />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink">
              <button type="button" className="cbox" data-checked={rotateSides} onClick={() => setRotateSides((v) => !v)} aria-label="Yan yüzleri döndür">
                <Icon name="check" size={10} />
              </button>
              <span onClick={() => setRotateSides((v) => !v)}>Yan yüzleri Z etrafında döndür</span>
            </label>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Maskeleme</h2>
              <Icon name="mask" size={14} className="text-faint" />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Alt yüzeyler</span>
                <span className="field-value">{maskBottom} °</span>
              </div>
              <input type="range" min={0} max={90} step={1} value={maskBottom} onChange={(e) => setMaskBottom(parseFloat(e.target.value))} />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Üst yüzeyler</span>
                <span className="field-value">{maskTop} °</span>
              </div>
              <input type="range" min={0} max={90} step={1} value={maskTop} onChange={(e) => setMaskTop(parseFloat(e.target.value))} />
            </div>

            <div className="mb-2">
              <div className="field-hint mb-1">Yüzeye göre ayarla</div>
              <div className="seg w-full">
                <button type="button" onClick={() => setMaskMode("haric")} data-active={maskMode === "haric"} className="flex-1 justify-center">
                  Hariç Tut
                </button>
                <button type="button" onClick={() => setMaskMode("dahil")} data-active={maskMode === "dahil"} className="flex-1 justify-center">
                  Sadece Dahil Et
                </button>
              </div>
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setMaskTool(maskTool === "firca" ? null : "firca")}
                  className="btn flex-1"
                  data-active={maskTool === "firca"}
                >
                  <Icon name="brush" size={12} />
                  Fırça
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMaskTool(maskTool === "doldur" ? null : "doldur");
                    if (maskTool !== "doldur") doldur();
                  }}
                  className="btn flex-1"
                  data-active={maskTool === "doldur"}
                >
                  <Icon name="bucket" size={12} />
                  Doldur
                </button>
              </div>

              <div className="mb-1.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="field-label">Fırça boyutu</span>
                  <span className="field-value">{brushSize} px</span>
                </div>
                <input type="range" min={1} max={50} step={1} value={brushSize} onChange={(e) => setBrushSize(parseFloat(e.target.value))} />
              </div>

              <p className="field-hint mb-1.5">Silmek için Shift tuşuna basılı tutun.</p>

              <div className="mono mb-1.5 text-[10px] text-dim">{maskedCount} poligon maskelendi</div>

              <button type="button" className="btn w-full" onClick={maskeyiTemizle}>
                <Icon name="eraser" size={12} />
                Seçimin tümünü temizle
              </button>
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Maskeyi Yumuşat / Mesafe</span>
                <span className="field-value">{maskSmooth.toFixed(1)}</span>
              </div>
              <input type="range" min={0} max={10} step={0.1} value={maskSmooth} onChange={(e) => setMaskSmooth(parseFloat(e.target.value))} />
            </div>

            <div>
              <div className="field-hint mb-1">Geçiş</div>
              <div className="seg w-full">
                <button type="button" onClick={() => setEasing("dogrusal")} data-active={easing === "dogrusal"} className="flex-1 justify-center">
                  Doğrusal
                </button>
                <button type="button" onClick={() => setEasing("s")} data-active={easing === "s"} className="flex-1 justify-center">
                  S Eğrisi
                </button>
                <button type="button" onClick={() => setEasing("yumusak")} data-active={easing === "yumusak"} className="flex-1 justify-center">
                  Yumuşak
                </button>
              </div>
            </div>
          </section>

          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Dışa Aktar</h2>
              <Icon name="download" size={14} className="text-faint" />
            </div>

            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label">Çözünürlük</span>
                <span className="field-value">{exportRes.toFixed(2)} mm</span>
              </div>
              <input type="range" min={0.05} max={2} step={0.05} value={exportRes} onChange={(e) => setExportRes(parseFloat(e.target.value))} />
              <div className="mono mt-0.5 flex justify-between text-[9px] text-faint">
                <span>Kaba</span>
                <span>İnce</span>
              </div>
            </div>

            <div className="mono mb-1 flex items-center justify-between text-[10px]">
              <span className="text-dim">Çıktının poligon sayısı</span>
              <span className="tnum text-ink">
                {tahminiUcgen >= 1000000
                  ? `${(tahminiUcgen / 1000000).toFixed(2)} M`
                  : `${Math.round(tahminiUcgen / 1000)} k`}
              </span>
            </div>
            <div className="mono mb-2 flex items-center justify-between text-[10px]">
              <span className="text-dim">Sahnedeki poligon sayısı</span>
              <span className="tnum text-faint">{Math.round(ucgenSayisi / 1000)} k</span>
            </div>

            <div className="mb-2 grid grid-cols-2 gap-1.5">
              <button type="button" className="btn btn-accent" onClick={stlIndir} disabled={exportStatus === "working"}>
                <Icon name="download" size={12} />
                STL
              </button>
              <button type="button" className="btn btn-accent" onClick={handle3MFExport} disabled={exportStatus === "working"}>
                <Icon name="download" size={12} />
                3MF
              </button>
            </div>

            <div className="mono text-[10px] text-dim">
              {exportStatus === "idle" && "Hazır"}
              {exportStatus === "working" && "Hesaplanıyor..."}
              {exportStatus === "done" && "İndirildi"}
              {exportStatus === "error" && "Hata: tekrar deneyin"}
            </div>

            <p className="field-hint mt-1.5">
              İndirilen dosya, ekranda gördüğünüz kabartmanın birebir aynısıdır. 3MF milimetre birimiyle yazılır.
            </p>
          </section>

          <footer className="px-1 pb-2 pt-1 text-center text-[10px] leading-relaxed text-dim">
            Palamut3D · Açık kaynak · Tamamen ücretsiz · Tüm işlemler tarayıcınızda · Powered by{" "}
            <a href="https://mucahidbalci.github.io" target="_blank" rel="noopener noreferrer" className="link">
              Mucahid Balci
            </a>
          </footer>
        </aside>
      </div>

      <footer className="mono flex h-status shrink-0 items-center gap-2 border-t border-line bg-panel px-4 text-[10px] text-dim">
        <Icon name="file" size={12} className="text-faint" />
        <span className="text-ink">{gosterilenAd}</span>
        <span className="sep">|</span>
        <span className="tnum">{ucgenSayisi.toLocaleString("tr-TR")} üçgen</span>
        <span className="sep">|</span>
        <span className="tnum">
          {sizeMm.x.toFixed(1)} × {sizeMm.y.toFixed(1)} × {sizeMm.z.toFixed(1)} mm
        </span>
        <span className="sep">|</span>
        <span className="tnum">{vertexSayisi.toLocaleString("tr-TR")} vertex</span>
        <span className="sep">|</span>
        <span className="tnum">{layers.filter((l) => l.visible).length} etkin katman</span>
        {!preview3D ? (
          <>
            <span className="sep">|</span>
            <span className="text-faint">önizleme kapalı</span>
          </>
        ) : null}

        <span className="ml-auto flex items-center gap-1.5">
          <FpsMeter />
          <Icon name="gauge" size={12} className="text-faint" />
        </span>
      </footer>
    </div>
  );
}