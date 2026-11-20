// @ts-nocheck
"use client";

/* ============================================================
   Palamut3D v2.0 — 3D Model Kabartma ve Doku Aracı
   Tüm işlemler tarayıcıda. Sunucuya dosya gönderilmez.
   ============================================================ */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import JSZip from "jszip";

/* ------------------------------------------------------------
   ÖLÇEK SABİTLERİ — 1 sahne birimi = 10 mm
   ------------------------------------------------------------ */
const MM_PER_UNIT = 10;
const UNIT_PER_MM = 1 / MM_PER_UNIT;
const CUBE_SIZE = 5;
const CUBE_SEG = 128;
const TEX_SIZE = 512;
const MAX_LAYERS = 8;
const MAX_BOLGE = 8;
const MAX_STL_MB = 80;
const MAX_UNDO = 40;

const DEFAULT_COLOR = "#22d3ee";
const DEFAULT_METALNESS = 0.22;
const DEFAULT_ROUGHNESS = 0.58;

const QUICK_COLORS = ["#22d3ee", "#f97316", "#ef4444", "#22c55e", "#a855f7", "#ec4899", "#e5e7eb", "#4a5260"];

const BOLGE_RENKLERI = ["#22d3ee", "#fbbf24", "#e879f9", "#a3e635", "#fb923c", "#a78bfa", "#fb7185", "#34d399"];

const CATEGORIES = [
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

const BLEND_MODES = [
  { id: "ekle", label: "Eklemeli" },
  { id: "ort", label: "Ortalama" },
  { id: "maks", label: "Maksimum" },
  { id: "carp", label: "Çarpma" },
  { id: "fark", label: "Fark" },
];

const ARACLAR = [
  { id: "kalem", label: "Kalem", ikon: "brush" },
  { id: "lasso", label: "Lasso", ikon: "target" },
  { id: "silgi", label: "Silgi", ikon: "eraser" },
  { id: "sec", label: "Seç", ikon: "magnet" },
];

/* ============================================================
   DOKU ÜRETİM YARDIMCILARI — tohumlu, Math.random yok
   ============================================================ */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillBg(ctx, s, c = "#000000") {
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, s, s);
}

function paint(ctx, s, fn) {
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

function noise2(seed, cells) {
  const rnd = mulberry32(seed);
  const n = Math.max(2, Math.round(cells));
  const lat = new Float32Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const at = (x, y) => lat[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  return (u, v) => {
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

function fbm2(seed, cells, oct = 4) {
  const kat = [];
  for (let o = 0; o < oct; o++) kat.push(noise2(seed + o * 37, cells * Math.pow(2, o)));
  return (u, v) => {
    let t = 0;
    let amp = 0.5;
    let tot = 0;
    for (let o = 0; o < oct; o++) {
      t += kat[o](u, v) * amp;
      tot += amp;
      amp *= 0.5;
    }
    return t / tot;
  };
}

function stripesV(ctx, s, n, duty = 0.5, soft = 0) {
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

function stripesH(ctx, s, n, duty = 0.5, soft = 0) {
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

function stripesAng(ctx, s, n, ang, duty = 0.45, soft = 0.1) {
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

function dotsGrid(ctx, s, n, r, soft = true) {
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
      } else ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function gridLines(ctx, s, n, t) {
  const c = s / n;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < n; i++) {
    ctx.fillRect(i * c, 0, t, s);
    ctx.fillRect(0, i * c, s, t);
  }
}

function hexPath(ctx, cx, cy, r) {
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

function radialCells(ctx, s, n, ic, dis) {
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

function blobs(ctx, s, adet, minR, maxR, seed, parlaklik = 0.8) {
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
const PRESETS = [
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
  { id: "altigen_balpetegi", name: "Bal Petegi", category: "geometrik", draw: (ctx, s) => { fillBg(ctx, s); const r = s / 9; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = r * 0.22; for (let row = -1; row < 10; row++) for (let col = -1; col < 8; col++) { const cx = col * r * Math.sqrt(3) + (row % 2 ? (r * Math.sqrt(3)) / 2 : 0); const cy = row * r * 1.5; hexPath(ctx, cx, cy, r * 0.78); ctx.stroke(); } } },
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
  { id: "deri_2", name: "Deri 2", category: "dokusel", draw: (ctx, s) => { fillBg(ctx, s, "#101010"); blobs(ctx, s, 200, 4, 12, 47, 0.8); const g = noise2(48, 220); ctx.globalAlpha = 0.55; paint(ctx, s, (u, v) => 0.3 + g(u, v) * 0.4); ctx.globalAlpha = 1; } },
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

  { id: "voronoi", name: "Voronoi", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(23); const pts = []; for (let i = 0; i < 18; i++) pts.push([rnd() * s, rnd() * s]); const img = ctx.createImageData(s, s); for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { let d1 = 1e9, d2 = 1e9; for (const p of pts) { let dx = Math.abs(x - p[0]); if (dx > s / 2) dx = s - dx; let dy = Math.abs(y - p[1]); if (dy > s / 2) dy = s - dy; const d = Math.sqrt(dx * dx + dy * dy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; } const v = Math.floor(Math.min(1, (d2 - d1) / 14) * 255); const i = (y * s + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); } },
  { id: "voronoi_kalin", name: "Kalın Voronoi", category: "organik", draw: (ctx, s) => { const rnd = mulberry32(29); const pts = []; for (let i = 0; i < 9; i++) pts.push([rnd() * s, rnd() * s]); const img = ctx.createImageData(s, s); for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { let d1 = 1e9, d2 = 1e9; for (const p of pts) { let dx = Math.abs(x - p[0]); if (dx > s / 2) dx = s - dx; let dy = Math.abs(y - p[1]); if (dy > s / 2) dy = s - dy; const d = Math.sqrt(dx * dx + dy * dy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; } const v = Math.floor(Math.min(1, (d2 - d1) / 34) * 255); const i = (y * s + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; } ctx.putImageData(img, 0, 0); } },
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
  { id: "kristal", name: "Kristal", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#3a3a3a"); const rnd = mulberry32(11); const n = 10; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = Math.floor(rnd() * 150 + 90); ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.moveTo(x * c, y * c); ctx.lineTo(x * c + c, y * c + c / 2); ctx.lineTo(x * c, y * c + c); ctx.closePath(); ctx.fill(); const g2 = Math.floor(rnd() * 150 + 90); ctx.fillStyle = `rgb(${g2},${g2},${g2})`; ctx.beginPath(); ctx.moveTo(x * c + c, y * c); ctx.lineTo(x * c + c, y * c + c); ctx.lineTo(x * c, y * c + c); ctx.closePath(); ctx.fill(); } } },
  { id: "kristal_kalin", name: "Kalın Kristal", category: "dekoratif", draw: (ctx, s) => { fillBg(ctx, s, "#404040"); const rnd = mulberry32(13); const n = 5; const c = s / n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const g = Math.floor(rnd() * 140 + 100); ctx.fillStyle = `rgb(${g},${g},${g})`; ctx.beginPath(); ctx.moveTo(x * c, y * c + c); ctx.lineTo(x * c + c / 2, y * c); ctx.lineTo(x * c + c, y * c + c); ctx.closePath(); ctx.fill(); } } },
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

const PRESET_MAP = PRESETS.reduce((acc, p) => {
  acc[p.id] = p;
  return acc;
}, {});

const CUSTOM_MAPS = new Map();
const THUMB_CACHE = new Map();
const TEX_CACHE = new Map();

function makeTextureCanvas(presetId) {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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

function makeThumbCanvas(presetId) {
  const tam = makeTextureCanvas(presetId);
  const kucuk = document.createElement("canvas");
  kucuk.width = 96;
  kucuk.height = 96;
  kucuk.getContext("2d").drawImage(tam, 0, 0, 96, 96);
  return kucuk;
}

function getTexData(presetId) {
  const v = TEX_CACHE.get(presetId);
  if (v) return v;
  const canvas = makeTextureCanvas(presetId);
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  TEX_CACHE.set(presetId, data);
  return data;
}

async function gorselOku(file) {
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
    const img = await new Promise((res, rej) => {
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

function dataUrlYukle(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("dataurl_okunamadi"));
    i.src = url;
  });
}

/* ============================================================
   GEOMETRİ MOTORU
   ============================================================ */
function ensureUV(geo) {
  if (geo.attributes.uv) return geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const boyut = new THREE.Vector3();
  bb.getSize(boyut);
  const ref = Math.max(boyut.x, boyut.y, boyut.z, 1e-6);
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / ref;
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / ref;
  }
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

function kaynakla(geo) {
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  const welded = mergeVertices(geo, 1e-4);
  welded.computeVertexNormals();
  return welded;
}

function kupGeometrisi() {
  const geo = kaynakla(new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, CUBE_SEG, CUBE_SEG, CUBE_SEG));
  ensureUV(geo);
  geo.computeBoundingBox();
  return geo;
}

function normalizeGeometry(geo) {
  geo.center();
  geo.computeBoundingBox();
  const boyut = new THREE.Vector3();
  geo.boundingBox.getSize(boyut);
  const maxB = Math.max(boyut.x, boyut.y, boyut.z) || 1;
  geo.scale(CUBE_SIZE / maxB, CUBE_SIZE / maxB, CUBE_SIZE / maxB);
  const welded = kaynakla(geo);
  geo.dispose();
  ensureUV(welded);
  welded.computeBoundingBox();
  return welded;
}

function ortalamaKenar(geo) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  if (!idx) return 0;
  const n = Math.min(3000, Math.floor(idx.count / 3));
  let top = 0;
  let adet = 0;
  for (let t = 0; t < n; t++) {
    const a = idx.getX(t * 3);
    const b = idx.getX(t * 3 + 1);
    const c = idx.getX(t * 3 + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    top += Math.hypot(bx - ax, by - ay, bz - az);
    top += Math.hypot(cx - bx, cy - by, cz - bz);
    top += Math.hypot(ax - cx, ay - cy, az - cz);
    adet += 3;
  }
  return adet ? top / adet : 0;
}

/* Yüz komşuluk grafı — kalem ve lasso bunun üzerinde yürür */
function komsulukKur(geo) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  const ucgenSay = Math.floor(idx.count / 3);
  const merkez = new Float32Array(ucgenSay * 3);
  const normal = new Float32Array(ucgenSay * 3);
  const kenar = new Map();
  const komsu = new Array(ucgenSay);
  const vertUcgen = new Array(pos.count);
  for (let i = 0; i < ucgenSay; i++) komsu[i] = [];
  for (let i = 0; i < pos.count; i++) vertUcgen[i] = [];

  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();

  for (let t = 0; t < ucgenSay; t++) {
    const a = idx.getX(t * 3);
    const b = idx.getX(t * 3 + 1);
    const c = idx.getX(t * 3 + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    merkez[t * 3] = (ax + bx + cx) / 3;
    merkez[t * 3 + 1] = (ay + by + cy) / 3;
    merkez[t * 3 + 2] = (az + bz + cz) / 3;
    va.set(ax, ay, az); vb.set(bx, by, bz); vc.set(cx, cy, cz);
    e1.subVectors(vb, va); e2.subVectors(vc, va);
    nn.crossVectors(e1, e2);
    if (nn.lengthSq() > 0) nn.normalize();
    normal[t * 3] = nn.x; normal[t * 3 + 1] = nn.y; normal[t * 3 + 2] = nn.z;
    vertUcgen[a].push(t); vertUcgen[b].push(t); vertUcgen[c].push(t);
    const cift = [[a, b], [b, c], [c, a]];
    for (const [p, q] of cift) {
      const k = p < q ? p * 1e7 + q : q * 1e7 + p;
      const l = kenar.get(k);
      if (l) l.push(t);
      else kenar.set(k, [t]);
    }
  }
  kenar.forEach((l) => {
    if (l.length === 2) {
      komsu[l[0]].push(l[1]);
      komsu[l[1]].push(l[0]);
    }
  });
  return { merkez, normal, komsu, vertUcgen, ucgenSay };
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/* Kalem: yüzey boyunca BFS yayılım, feather'lı ağırlık */
function kalemUygula(graf, baslangic, yaricap, feather, hedef, sil) {
  const { merkez, komsu, vertUcgen, ucgenSay } = graf;
  const mesafe = new Float32Array(ucgenSay).fill(Infinity);
  const kuyruk = [baslangic];
  mesafe[baslangic] = 0;
  let head = 0;
  const dokunulan = [];
  while (head < kuyruk.length) {
    const t = kuyruk[head++];
    const d = mesafe[t];
    if (d > yaricap) continue;
    dokunulan.push(t);
    const tx = merkez[t * 3], ty = merkez[t * 3 + 1], tz = merkez[t * 3 + 2];
    for (const k of komsu[t]) {
      const nd = d + Math.hypot(merkez[k * 3] - tx, merkez[k * 3 + 1] - ty, merkez[k * 3 + 2] - tz);
      if (nd < mesafe[k] && nd <= yaricap) {
        mesafe[k] = nd;
        kuyruk.push(k);
      }
    }
  }
  const f = Math.max(1e-4, feather);
  for (const t of dokunulan) {
    const w = 1 - smoothstep(Math.max(0, yaricap - f), yaricap, mesafe[t]);
    if (w <= 0) continue;
    const idxBase = t * 3;
    const a = graf.ucgenSay ? null : null;
    const uc = [t];
    for (const tt of uc) {
      const verts = graf.vertUcgen;
      void verts;
    }
    void idxBase; void a;
  }
  return { dokunulan, mesafe, yaricap, f, sil, hedef };
}

/* Ağırlıkları vertex'e taşı (max birleşim) */
function agirlikYaz(graf, hedef, dokunulan, mesafe, yaricap, f, sil, vertIdx) {
  const out = new Float32Array(hedef);
  const w = new Float32Array(graf.ucgenSay);
  for (const t of dokunulan) {
    w[t] = 1 - smoothstep(Math.max(0, yaricap - f), yaricap, mesafe[t]);
  }
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const list = graf.vertUcgen[i];
    for (let j = 0; j < list.length; j++) if (w[list[j]] > m) m = w[list[j]];
    out[i] = sil ? Math.max(0, hedef[i] - m) : Math.max(hedef[i], m);
  }
  void vertIdx;
  return out;
}

/* Lasso: ekran uzayında poligon, arkadaki yüzeyler seçilmez */
function lassoUygula(graf, geo, camera, width, height, polygon, feather) {
  const { merkez, normal, komsu, ucgenSay } = graf;
  const secili = new Uint8Array(ucgenSay);
  const v = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) c = !c;
    }
    return c;
  };
  const bb = geo.boundingBox;
  const merkezNokta = bb ? bb.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  for (let t = 0; t < ucgenSay; t++) {
    const mx = merkez[t * 3], my = merkez[t * 3 + 1], mz = merkez[t * 3 + 2];
    const nx = normal[t * 3], ny = normal[t * 3 + 1], nz = normal[t * 3 + 2];
    if (nx * camDir.x + ny * camDir.y + nz * camDir.z > -0.05) continue;
    v.set(mx, my, mz).project(camera);
    const px = ((v.x + 1) / 2) * width;
    const py = ((1 - v.y) / 2) * height;
    if (inside(px, py)) secili[t] = 1;
  }
  void merkezNokta;
  const dist = new Float32Array(ucgenSay).fill(Infinity);
  const kuyruk = [];
  for (let t = 0; t < ucgenSay; t++) {
    if (!secili[t]) continue;
    let sinir = false;
    for (const k of komsu[t]) if (!secili[k]) { sinir = true; break; }
    if (sinir) { dist[t] = 0; kuyruk.push(t); }
  }
  let head = 0;
  while (head < kuyruk.length) {
    const t = kuyruk[head++];
    const tx = merkez[t * 3], ty = merkez[t * 3 + 1], tz = merkez[t * 3 + 2];
    for (const k of komsu[t]) {
      if (!secili[k]) continue;
      const nd = dist[t] + Math.hypot(merkez[k * 3] - tx, merkez[k * 3 + 1] - ty, merkez[k * 3 + 2] - tz);
      if (nd < dist[k]) { dist[k] = nd; kuyruk.push(k); }
    }
  }
  const f = Math.max(1e-4, feather);
  const w = new Float32Array(ucgenSay);
  for (let t = 0; t < ucgenSay; t++) {
    if (!secili[t]) continue;
    w[t] = dist[t] === Infinity ? 1 : smoothstep(0, f, dist[t]);
    if (w[t] < 0.02) w[t] = 0.02;
  }
  const out = new Float32Array(geo.attributes.position.count);
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const list = graf.vertUcgen[i];
    for (let j = 0; j < list.length; j++) if (w[list[j]] > m) m = w[list[j]];
    out[i] = m;
  }
  return out;
}

function uygulaEasing(t, mod) {
  if (mod === "s") return t * t * (3 - 2 * t);
  if (mod === "yumusak") return Math.sin((t * Math.PI) / 2);
  return t;
}

function pozisyonYumusat(geo, agirlik) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  if (!idx || agirlik <= 0) return;
  const n = pos.count;
  const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
  const say = new Uint16Array(n);
  const ekle = (h, k) => {
    tx[h] += pos.getX(k); ty[h] += pos.getY(k); tz[h] += pos.getZ(k);
    if (say[h] < 65535) say[h] += 1;
  };
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    ekle(a, b); ekle(a, c); ekle(b, a); ekle(b, c); ekle(c, a); ekle(c, b);
  }
  for (let i = 0; i < n; i++) {
    const s = say[i];
    if (!s) continue;
    const ox = pos.getX(i), oy = pos.getY(i), oz = pos.getZ(i);
    pos.setXYZ(i, ox + (tx[i] / s - ox) * agirlik, oy + (ty[i] / s - oy) * agirlik, oz + (tz[i] / s - oz) * agirlik);
  }
  pos.needsUpdate = true;
}

function blurImageData(data, s, yaricap) {
  if (yaricap < 1) return;
  const gec = new Uint8ClampedArray(data.length);
  for (let y = 0; y < s; y++) {
    let top = 0, ad = 0;
    for (let x = -yaricap; x < s + yaricap; x++) {
      if (x + yaricap < s + yaricap) { top += data[(y * s + Math.min(s - 1, Math.max(0, x + yaricap))) * 4]; ad++; }
      if (x - yaricap - 1 >= 0) { top -= data[(y * s + Math.max(0, x - yaricap - 1)) * 4]; ad--; }
      if (x >= 0 && x < s) {
        const v = top / Math.max(1, ad);
        const i = (y * s + x) * 4;
        gec[i] = v; gec[i + 1] = v; gec[i + 2] = v; gec[i + 3] = 255;
      }
    }
  }
  for (let x = 0; x < s; x++) {
    let top = 0, ad = 0;
    for (let y = -yaricap; y < s + yaricap; y++) {
      if (y + yaricap < s + yaricap) { top += gec[(Math.min(s - 1, Math.max(0, y + yaricap)) * s + x) * 4]; ad++; }
      if (y - yaricap - 1 >= 0) { top -= gec[(Math.max(0, y - yaricap - 1) * s + x) * 4]; ad--; }
      if (y >= 0 && y < s) {
        const v = top / Math.max(1, ad);
        const i = (y * s + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
  }
}

function ornek(data, u, v) {
  let uu = u % 1; if (uu < 0) uu += 1;
  let vv = v % 1; if (vv < 0) vv += 1;
  const px = (uu * (TEX_SIZE - 1)) | 0;
  const py = ((1 - vv) * (TEX_SIZE - 1)) | 0;
  const i = (py * TEX_SIZE + px) * 4;
  return (data[i] + data[i + 1] + data[i + 2]) / 765;
}

function blendUygula(acc, deger, mod, ilk) {
  if (ilk) return deger;
  if (mod === "ort") return (acc + deger) / 2;
  if (mod === "maks") return Math.max(acc, deger);
  if (mod === "carp") return acc * deger;
  if (mod === "fark") return Math.abs(acc - deger);
  return acc + deger;
}

/* Ana displacement — global katmanlar + bölgeler */
function applyRealDisplacement(baseGeometry, katmanlar, bolgeler, maskeAgirlik, opts) {
  const geo = baseGeometry.clone();
  ensureUV(geo);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  if (!pos || !nor || !uv) return geo;

  const ortKenar = ortalamaKenar(geo);
  const dSinir = ortKenar > 0 ? ortKenar * 6 : Infinity;

  const hazirla = (k) => {
    const otomatik = Math.max(opts.smoothing, Math.min(1, k.scaleU / 12));
    const yaricap = Math.round(otomatik * 6);
    if (yaricap < 1) return k;
    const kopya = new Uint8ClampedArray(k.data);
    blurImageData(kopya, TEX_SIZE, yaricap);
    return { ...k, data: kopya };
  };

  const katHazir = katmanlar.map(hazirla);
  const bolgeHazir = bolgeler
    .filter((b) => b.gorunur && b.agirlik && b.presetId)
    .map((b) => ({
      ...hazirla({
        data: getTexData(b.presetId).data,
        scaleU: b.olcekU,
        scaleV: b.olcekV,
      }),
      id: b.id,
      agirlik: b.agirlik,
      derinlik: b.derinlik,
      offsetU: b.offsetU,
      offsetV: b.offsetV,
      rotation: b.rotasyon,
      blend: b.blend,
    }));

  const amp = opts.amplitude;
  const yon = opts.invert ? -1 : 1;
  const cosAlt = Math.cos(opts.maskBottom);
  const cosUst = Math.cos(opts.maskTop);
  const stampAktif = opts.stampMode && opts.stampMerkez;
  const sm = opts.stampMerkez;
  const stampBoyut = Math.max(0.05, opts.stampBoyut * UNIT_PER_MM);
  let su1 = null, su2 = null;
  if (stampAktif) {
    const nrm = new THREE.Vector3(sm.nx, sm.ny, sm.nz).normalize();
    su1 = new THREE.Vector3(0, 1, 0);
    if (Math.abs(nrm.y) > 0.9) su1.set(1, 0, 0);
    su1.cross(nrm).normalize();
    su2 = new THREE.Vector3().crossVectors(nrm, su1).normalize();
  }

  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);

    let maske = 1;
    if (nz < -cosAlt) maske = 0;
    else if (opts.maskTop > 0 && nz > cosUst) maske = 0;
    if (maske > 0 && maskeAgirlik) {
      const w = maskeAgirlik[i] || 0;
      maske *= opts.maskMode === "dahil" ? w : 1 - w;
    }
    if (maske <= 0.001) continue;

    const ornekle = (kat, bu, bv) => {
      let aci = (kat.rotation * Math.PI) / 180;
      if (opts.rotateSides && Math.abs(nz) < 0.5) aci += Math.atan2(ny, nx);
      const ca = Math.cos(aci), sa = Math.sin(aci);
      const donus = (u, v) => {
        const cx = u - 0.5, cy = v - 0.5;
        return [(cx * ca - cy * sa + 0.5) * kat.scaleU + kat.offsetU, (cx * sa + cy * ca + 0.5) * kat.scaleV + kat.offsetV];
      };
      if (stampAktif) {
        const dx = px - sm.x, dy = py - sm.y, dz = pz - sm.z;
        const lu = (dx * su1.x + dy * su1.y + dz * su1.z) / stampBoyut;
        const lv = (dx * su2.x + dy * su2.y + dz * su2.z) / stampBoyut;
        if (Math.abs(lu) > 0.5 || Math.abs(lv) > 0.5) return 0;
        const c = donus(lu + 0.5, lv + 0.5);
        return ornek(kat.data, c[0], c[1]);
      }
      if (opts.projection === "uv") {
        const c = donus(bu, bv);
        let p = ornek(kat.data, c[0], c[1]);
        if (opts.symmetric) {
          const c2 = donus(1 - bu, bv);
          p = Math.max(p, ornek(kat.data, c2[0], c2[1]));
        }
        return p;
      }
      if (opts.projection === "tri") {
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        const yum = Math.max(0.05, opts.blendSmooth);
        const wx = Math.pow(ax, 1 / yum), wy = Math.pow(ay, 1 / yum), wz = Math.pow(az, 1 / yum);
        const wt = wx + wy + wz || 1;
        const sx = px * 0.2 + 0.5, sy = py * 0.2 + 0.5, sz = pz * 0.2 + 0.5;
        const c1 = donus(sz, sy), c2 = donus(sx, sy), c3 = donus(sx, sz);
        return (ornek(kat.data, c1[0], c1[1]) * wx + ornek(kat.data, c2[0], c2[1]) * wy + ornek(kat.data, c3[0], c3[1]) * wz) / wt;
      }
      if (opts.projection === "kutu") {
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        let c;
        if (ax >= ay && ax >= az) c = donus(pz * 0.2 + 0.5, py * 0.2 + 0.5);
        else if (ay >= az) c = donus(px * 0.2 + 0.5, pz * 0.2 + 0.5);
        else c = donus(px * 0.2 + 0.5, py * 0.2 + 0.5);
        return ornek(kat.data, c[0], c[1]);
      }
      const r = Math.hypot(px, py, pz) || 1;
      const su = Math.atan2(pz, px) / (Math.PI * 2) + 0.5;
      const sv = Math.acos(Math.max(-1, Math.min(1, py / r))) / Math.PI;
      const c = donus(su, sv);
      return ornek(kat.data, c[0], c[1]);
    };

    const bu = uv.getX(i), bv = uv.getY(i);

    let globalTop = 0;
    let ilk = true;
    for (let li = 0; li < katHazir.length; li++) {
      const kat = katHazir[li];
      let p = uygulaEasing(Math.max(0, Math.min(1, ornekle(kat, bu, bv))), opts.easing) * kat.depth;
      globalTop = blendUygula(globalTop, p, kat.blend, ilk);
      ilk = false;
    }

    let bolgeTop = 0;
    let bolgeIlk = true;
    let bolgeVar = false;
    for (let bi = 0; bi < bolgeHazir.length; bi++) {
      const b = bolgeHazir[bi];
      const w = b.agirlik[i] || 0;
      if (w <= 0.002) continue;
      bolgeVar = true;
      const p = uygulaEasing(Math.max(0, Math.min(1, ornekle(b, bu, bv))), opts.easing) * (b.derinlik / 5) * w;
      bolgeTop = blendUygula(bolgeTop, p, b.blend, bolgeIlk);
      bolgeIlk = false;
    }

    let toplam = bolgeVar ? bolgeTop : globalTop;
    if (toplam <= 0.0001) continue;
    if (toplam > 1) toplam = 1;

    let d = toplam * amp * yon * maske;
    if (d > dSinir) d = dSinir;
    else if (d < -dSinir) d = -dSinir;

    pos.setXYZ(i, px + nx * d, py + ny * d, pz + nz * d);
  }

  pos.needsUpdate = true;
  if (opts.geoYumusatma > 0) {
    const gecis = Math.max(1, Math.round(opts.geoYumusatma * 2));
    const ag = Math.min(0.6, opts.geoYumusatma * 0.5);
    for (let p = 0; p < gecis; p++) pozisyonYumusat(geo, ag);
  }
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return geo;
}

/* Export için gerçek yeniden örnekleme */
function subdivize(geo) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  const yeni = [];
  for (let i = 0; i < pos.count; i++) yeni.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  const orta = new Map();
  const ortaAl = (a, b) => {
    const k = a < b ? a * 1e7 + b : b * 1e7 + a;
    const v = orta.get(k);
    if (v !== undefined) return v;
    const i = yeni.length / 3;
    yeni.push((pos.getX(a) + pos.getX(b)) / 2, (pos.getY(a) + pos.getY(b)) / 2, (pos.getZ(a) + pos.getZ(b)) / 2);
    orta.set(k, i);
    return i;
  };
  const out = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    const ab = ortaAl(a, b), bc = ortaAl(b, c), ca = ortaAl(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(yeni, 3));
  g.setIndex(out);
  return kaynakla(g);
}

function decimate(geo, hücre) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const map = new Map();
  const temsil = [];
  const remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x / hücre)}|${Math.round(y / hücre)}|${Math.round(z / hücre)}`;
    let h = map.get(k);
    if (h === undefined) {
      h = temsil.length / 3;
      map.set(k, h);
      temsil.push(x, y, z);
    }
    remap[i] = h;
  }
  const out = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = remap[idx.getX(t)], b = remap[idx.getX(t + 1)], c = remap[idx.getX(t + 2)];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(temsil, 3));
  g.setIndex(out);
  return kaynakla(g);
}

function yenidenOrnekle(geo, hedefMm) {
  const hedef = Math.max(0.005, hedefMm * UNIT_PER_MM);
  let g = geo.clone();
  let ort = ortalamaKenar(g);
  let guard = 0;
  while (ort > hedef * 1.5 && guard < 3 && g.attributes.position.count < 700000) {
    const ng = subdivize(g);
    g.dispose();
    g = ng;
    ort = ortalamaKenar(g);
    guard++;
  }
  if (ort < hedef * 0.55) {
    const ng = decimate(g, hedef);
    g.dispose();
    g = ng;
  }
  ensureUV(g);
  g.computeBoundingBox();
  return g;
}

/* ============================================================
   İKON SİSTEMİ
   ============================================================ */
const ICON_PATHS = {
  upload: (<><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" /></>),
  download: (<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4" /></>),
  cube: (<><path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" /><path d="M4 7.4l8 4.6 8-4.6" /><path d="M12 12v9.2" /></>),
  layers: (<><path d="M12 2.8l9 4.7-9 4.7-9-4.7z" /><path d="M3 12.4l9 4.7 9-4.7" /><path d="M3 17.1l9 4.7 9-4.7" /></>),
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
  "chevron-up": <path d="M6 15l6-6 6 6" />,
  x: (<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>),
  folder: <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  gauge: (<><path d="M12 20a8 8 0 110-16 8 8 0 010 16z" /><path d="M12 12l4-3.5" /><circle cx="12" cy="12" r="1.4" /></>),
  brush: (<><path d="M9.5 14.5L4 20" /><path d="M14 4.5l5.5 5.5" /><path d="M8.5 9.5l6 6" /><path d="M14.5 3.5l6 6-6 6-6-6z" /></>),
  eraser: (<><path d="M8 20H4a1.5 1.5 0 01-1.1-2.6L14 6.3a1.5 1.5 0 012.1 0l4.6 4.6a1.5 1.5 0 010 2.1L13 20z" /><path d="M9 11l6 6" /></>),
  undo: (<><path d="M4 8h9a5 5 0 010 10H8" /><path d="M4 8l4-4" /><path d="M4 8l4 4" /></>),
  redo: (<><path d="M20 8h-9a5 5 0 000 10h5" /><path d="M20 8l-4-4" /><path d="M20 8l-4 4" /></>),
  plus: (<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  lock: (<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></>),
  unlock: (<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 017.5-2" /></>),
  stamp: (<><path d="M6 21h12" /><path d="M8 17h8v-2a2 2 0 00-1-1.7l-1-.6a2 2 0 01-1-1.7V8a3 3 0 116 0" /><path d="M5 17h14" /></>),
  mask: (<><path d="M3 6.5c3 0 4-1.5 9-1.5s6 1.5 9 1.5v5c0 4-4 8-9 8s-9-4-9-8z" /><circle cx="8.5" cy="11" r="1.2" /><circle cx="15.5" cy="11" r="1.2" /></>),
  save: (<><path d="M4 5a1 1 0 011-1h11l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1z" /><path d="M8 4v6h8V4" /><path d="M8 20v-6h8v6" /></>),
  open: (<><path d="M3 7a2 2 0 012-2h4l2 2.5h6a2 2 0 012 2V11" /><path d="M3 7v12a1 1 0 001 1h13.5a1 1 0 00.9-.6L22 12H7.5a1 1 0 00-.9.6L3 19" /></>),
  trash: (<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>),
  copy: (<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h4" /></>),
  refresh: (<><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>),
  target: (<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>),
  magnet: (<><path d="M6 4v8a6 6 0 0012 0V4" /><path d="M6 9h4M14 9h4" /></>),
  shuffle: (<><path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></>),
  scissors: (<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.12 15.88" /><path d="M14.47 14.48L20 20" /><path d="M8.12 8.12L12 12" /></>),
};

function Icon({ name, size = 16, className = "" }) {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {path}
    </svg>
  );
}

function FpsMeter() {
  const [fps, setFps] = useState(0);
  const kare = useRef(0);
  const basla = useRef(0);
  useEffect(() => {
    let raf = 0;
    basla.current = performance.now();
    kare.current = 0;
    const dongu = (t) => {
      kare.current += 1;
      const gecen = t - basla.current;
      if (gecen >= 500) {
        setFps(Math.round((kare.current * 1000) / gecen));
        kare.current = 0;
        basla.current = t;
      }
      raf = requestAnimationFrame(dongu);
    };
    raf = requestAnimationFrame(dongu);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="mono tnum text-faint">{fps} FPS</span>;
}

function AxisGizmo() {
  return (
    <svg viewBox="0 0 60 60" width={56} height={56} className="pointer-events-none absolute right-3 top-3 opacity-80" aria-hidden="true">
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
   MODEL — displaced geometri, bölge renklendirme, kesit
   ------------------------------------------------------------ */
function Model({ baseGeometry, layers, bolgeler, maskeAgirlik, opts, renkVersion, color, wireframe, metalness, roughness, preview3D, bolgeleriGoster, kesitAktif, kesitY, geoRef, graf, arac, onHit, onSize, surukleBoya }) {
  const [displaced, setDisplaced] = useState(() => baseGeometry.clone());
  const onceki = useRef(null);
  const { camera, size } = useThree();
  const boyamaRef = useRef(false);

  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), kesitY), [kesitY]);

  useEffect(() => {
    let iptal = false;
    const zaman = setTimeout(() => {
      if (iptal) return;
      let g;
      if (!preview3D) g = baseGeometry.clone();
      else {
        const gecerli = layers.filter((l) => l.visible).map((l) => ({
          data: getTexData(l.presetId).data,
          blend: l.blend, depth: l.depth, scaleU: l.scaleU, scaleV: l.scaleV,
          offsetU: l.offsetU, offsetV: l.offsetV, rotation: l.rotation,
        }));
        g = applyRealDisplacement(baseGeometry, gecerli, bolgeler, maskeAgirlik, opts);
      }
      if (bolgeleriGoster && bolgeler.length) {
        const n = g.attributes.position.count;
        const arr = new Float32Array(n * 3);
        const taban = new THREE.Color(color);
        const rc = bolgeler.map((b) => new THREE.Color(b.renk));
        for (let i = 0; i < n; i++) {
          let r = taban.r, gg = taban.g, bb = taban.b;
          for (let bi = 0; bi < bolgeler.length; bi++) {
            const w = bolgeler[bi].agirlik ? bolgeler[bi].agirlik[i] || 0 : 0;
            if (w <= 0.01) continue;
            const c = rc[bi];
            r = r * (1 - w) + c.r * w;
            gg = gg * (1 - w) + c.g * w;
            bb = bb * (1 - w) + c.b * w;
          }
          arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = bb;
        }
        g.setAttribute("color", new THREE.Float32BufferAttribute(arr, 3));
      }
      setDisplaced(g);
      geoRef.current = g;
      g.computeBoundingBox();
      const b = new THREE.Vector3();
      g.boundingBox.getSize(b);
      onSize({ x: b.x, y: b.y, z: b.z });
    }, 60);
    return () => { iptal = true; clearTimeout(zaman); };
  }, [baseGeometry, layers, bolgeler, maskeAgirlik, opts, renkVersion, preview3D, bolgeleriGoster, color, geoRef, onSize]);

  useEffect(() => {
    const p = onceki.current;
    onceki.current = displaced;
    if (p && p !== displaced) p.dispose();
  }, [displaced]);

  useEffect(() => () => { if (onceki.current) onceki.current.dispose(); onceki.current = null; }, []);

  useEffect(() => {
    const up = () => { boyamaRef.current = false; };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const hit = (e, zorla) => {
    if (!arac && !opts.stampMode) return;
    if (e.faceIndex == null) return;
    e.stopPropagation();
    onHit({
      faceIndex: e.faceIndex,
      point: e.point.clone(),
      normal: e.face ? e.face.normal.clone() : new THREE.Vector3(0, 1, 0),
      camera, width: size.width, height: size.height,
      zorla,
    });
  };

  return (
    <group>
      <mesh
        geometry={displaced}
        onPointerDown={(e) => { boyamaRef.current = true; hit(e, true); }}
        onPointerMove={(e) => { if (boyamaRef.current && surukleBoya) hit(e, false); }}
      >
        <meshStandardMaterial
          color={bolgeleriGoster && bolgeler.length ? "#ffffff" : color}
          vertexColors={bolgeleriGoster && bolgeler.length > 0}
          wireframe={wireframe}
          metalness={metalness}
          roughness={roughness}
          clippingPlanes={kesitAktif ? [plane] : []}
          clipShadows
          side={THREE.FrontSide}
        />
      </mesh>
      {kesitAktif ? (
        <mesh position={[0, kesitY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[9, 9]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ) : null}
      {opts.stampMode && opts.stampMerkez ? (
        <mesh position={[opts.stampMerkez.x, opts.stampMerkez.y, opts.stampMerkez.z]}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshBasicMaterial color="#fbbf24" />
        </mesh>
      ) : null}
      {graf ? null : null}
    </group>
  );
}

/* ------------------------------------------------------------
   3MF PAKETLEME
   ------------------------------------------------------------ */
function ucgenXmlKur(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const harita = new Map();
  const koord = [];
  const ucgenler = [];
  const al = (i) => {
    const x = pos.getX(i) * MM_PER_UNIT, y = pos.getY(i) * MM_PER_UNIT, z = pos.getZ(i) * MM_PER_UNIT;
    const k = `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;
    const v = harita.get(k);
    if (v !== undefined) return v;
    const y2 = harita.size;
    harita.set(k, y2);
    koord.push(x, y, z);
    return y2;
  };
  if (idx) {
    for (let t = 0; t < idx.count; t += 3) {
      const a = al(idx.getX(t)), b = al(idx.getX(t + 1)), c = al(idx.getX(t + 2));
      if (a === b || b === c || a === c) continue;
      ucgenler.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  } else {
    for (let t = 0; t + 2 < pos.count; t += 3) {
      const a = al(t), b = al(t + 1), c = al(t + 2);
      if (a === b || b === c || a === c) continue;
      ucgenler.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
  }
  const vx = [];
  for (let i = 0; i < koord.length; i += 3) vx.push(`<vertex x="${koord[i].toFixed(3)}" y="${koord[i + 1].toFixed(3)}" z="${koord[i + 2].toFixed(3)}"/>`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n` +
    vx.join("\n") + `\n</vertices>\n<triangles>\n` + ucgenler.join("\n") +
    `\n</triangles>\n</mesh>\n</object>\n</resources>\n<build><item objectid="1"/></build>\n</model>`
  );
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>`;
const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>`;

function u8ToB64(u8) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToU8(b) {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function agirlikPaketle(a) {
  if (!a) return null;
  const u = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) u[i] = Math.round(Math.max(0, Math.min(1, a[i])) * 255);
  return u8ToB64(u);
}
function agirlikAc(b, n) {
  if (!b) return new Float32Array(n);
  const u = b64ToU8(b);
  const a = new Float32Array(n);
  for (let i = 0; i < Math.min(n, u.length); i++) a[i] = u[i] / 255;
  return a;
}

function manifoldDenetle(geo) {
  const idx = geo.index;
  if (!idx) return { sinir: 0, nonManifold: 0, dejenere: 0 };
  const kenar = new Map();
  let dejenere = 0;
  const pos = geo.attributes.position;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    if (a === b || b === c || a === c) { dejenere++; continue; }
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    const alan = Math.hypot((bx - ax) * (cy - ay) - (by - ay) * (cx - ax), (by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (cz - az) * (bx - ax)) / 2;
    if (alan < 1e-10) { dejenere++; continue; }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = p < q ? p * 1e7 + q : q * 1e7 + p;
      kenar.set(k, (kenar.get(k) || 0) + 1);
    }
  }
  let sinir = 0, nonManifold = 0;
  kenar.forEach((v) => { if (v === 1) sinir++; else if (v > 2) nonManifold++; });
  return { sinir, nonManifold, dejenere };
}

function hacimHesapla(geo) {
  const idx = geo.index;
  const pos = geo.attributes.position;
  if (!idx) return 0;
  let v = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    const ax = pos.getX(a) * MM_PER_UNIT, ay = pos.getY(a) * MM_PER_UNIT, az = pos.getZ(a) * MM_PER_UNIT;
    const bx = pos.getX(b) * MM_PER_UNIT, by = pos.getY(b) * MM_PER_UNIT, bz = pos.getZ(b) * MM_PER_UNIT;
    const cx = pos.getX(c) * MM_PER_UNIT, cy = pos.getY(c) * MM_PER_UNIT, cz = pos.getZ(c) * MM_PER_UNIT;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

/* ============================================================
   ANA SAYFA
   ============================================================ */
export default function Page() {
  const [mode, setMode] = useState("kup");
  const [viewMode, setViewMode] = useState("dolu");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [metalness, setMetalness] = useState(DEFAULT_METALNESS);
  const [roughness, setRoughness] = useState(DEFAULT_ROUGHNESS);
  const [kesitY, setKesitY] = useState(0);

  const [fileName, setFileName] = useState("");
  const [fileSizeKB, setFileSizeKB] = useState(0);
  const [sizeMm, setSizeMm] = useState({ x: 50, y: 50, z: 50 });
  const [surukleAktif, setSurukleAktif] = useState(false);

  const [category, setCategory] = useState("tumu");
  const [arama, setArama] = useState("");
  const [thumbs, setThumbs] = useState({});
  const [ozelHaritalar, setOzelHaritalar] = useState([]);
  const [yuklemeDurum, setYuklemeDurum] = useState("");
  const ozelInputRef = useRef(null);
  const stlInputRef = useRef(null);
  const projeInputRef = useRef(null);
  const ozelSayac = useRef(0);

  const [layers, setLayers] = useState([
    { id: "kat1", presetId: "kristal", blend: "ekle", depth: 1, visible: true, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotation: 0 },
  ]);
  const [activeLayer, setActiveLayer] = useState("kat1");

  const [bolgeler, setBolgeler] = useState([]);
  const [aktifBolge, setAktifBolge] = useState(null);
  const [bolgeleriGoster, setBolgeleriGoster] = useState(true);
  const [arac, setArac] = useState(null);
  const [fircaMm, setFircaMm] = useState(8);
  const [featherMm, setFeatherMm] = useState(3);
  const [lassoNokta, setLassoNokta] = useState([]);
  const lassoRef = useRef([]);
  const [renkVersion, setRenkVersion] = useState(0);

  const [maskeAgirlik, setMaskeAgirlik] = useState(null);
  const [maskeArac, setMaskeArac] = useState(false);

  const [amplitudeMm, setAmplitudeMm] = useState(1.22);
  const [invert, setInvert] = useState(false);
  const [symmetric, setSymmetric] = useState(false);
  const [preview3D, setPreview3D] = useState(true);
  const [smoothing, setSmoothing] = useState(0);
  const [geoYumusatma, setGeoYumusatma] = useState(0);
  const [invertTexture, setInvertTexture] = useState(false);

  const [projection, setProjection] = useState("tri");
  const [blendSmooth, setBlendSmooth] = useState(0.5);
  const [stampMode, setStampMode] = useState(false);
  const [stampBoyut, setStampBoyut] = useState(14);
  const [stampMerkez, setStampMerkez] = useState(null);

  const [sizeU, setSizeU] = useState(2.01);
  const [sizeV, setSizeV] = useState(2.01);
  const [uvLock, setUvLock] = useState(true);
  const [offsetU, setOffsetU] = useState(0);
  const [offsetV, setOffsetV] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [rotateSides, setRotateSides] = useState(false);

  const [maskBottom, setMaskBottom] = useState(5);
  const [maskTop, setMaskTop] = useState(0);
  const [maskMode, setMaskMode] = useState("haric");
  const [easing, setEasing] = useState("dogrusal");
  const [maskeliVertex, setMaskeliVertex] = useState(0);

  const [exportRes, setExportRes] = useState(0.35);
  const [exportStatus, setExportStatus] = useState("idle");
  const [exportNot, setExportNot] = useState("");

  const [baseGeometry, setBaseGeometry] = useState(() => kupGeometrisi());
  const geoRef = useRef(null);
  const stlRef = useRef(null);
  const oncekiBase = useRef(null);
  const sahneRef = useRef(null);

  const gecmis = useRef([]);
  const ileri = useRef([]);
  const [undoSay, setUndoSay] = useState(0);
  const [redoSay, setRedoSay] = useState(0);
  const kilitRef = useRef(false);

  const graf = useMemo(() => (baseGeometry.index ? komsulukKur(baseGeometry) : null), [baseGeometry]);
  const vertexSayisi = baseGeometry.attributes.position.count;
  const ucgenSayisi = baseGeometry.index ? Math.round(baseGeometry.index.count / 3) : Math.round(vertexSayisi / 3);

  const opts = useMemo(() => ({
    amplitude: (invertTexture ? -amplitudeMm : amplitudeMm) * UNIT_PER_MM,
    invert, symmetric, projection, blendSmooth,
    maskBottom: (maskBottom * Math.PI) / 180,
    maskTop: (maskTop * Math.PI) / 180,
    maskMode, easing, smoothing, geoYumusatma,
    rotateSides, stampMode, stampMerkez, stampBoyut,
  }), [amplitudeMm, invert, symmetric, projection, blendSmooth, maskBottom, maskTop, maskMode, easing, smoothing, geoYumusatma, invertTexture, rotateSides, stampMode, stampMerkez, stampBoyut]);

  const aktifKatman = layers.find((l) => l.id === activeLayer) || layers[0];
  const aktifBolgeObj = bolgeler.find((b) => b.id === aktifBolge) || null;
  const hedefBolge = arac && aktifBolgeObj ? aktifBolgeObj : null;

  const presetAdi = useCallback((id) => PRESET_MAP[id]?.name || ozelHaritalar.find((o) => o.id === id)?.name || "Katman", [ozelHaritalar]);

  /* ---- Undo / Redo ---- */
  const anlikGoruntu = useCallback(() => ({
    layers: layers.map((l) => ({ ...l })),
    activeLayer,
    bolgeler: bolgeler.map((b) => ({ ...b, agirlik: b.agirlik ? new Float32Array(b.agirlik) : null })),
    aktifBolge,
    maskeAgirlik: maskeAgirlik ? new Float32Array(maskeAgirlik) : null,
    params: { amplitudeMm, invert, symmetric, smoothing, geoYumusatma, invertTexture, projection, blendSmooth, sizeU, sizeV, offsetU, offsetV, rotation, rotateSides, maskBottom, maskTop, maskMode, easing, color, metalness, roughness, stampBoyut },
  }), [layers, activeLayer, bolgeler, aktifBolge, maskeAgirlik, amplitudeMm, invert, symmetric, smoothing, geoYumusatma, invertTexture, projection, blendSmooth, sizeU, sizeV, offsetU, offsetV, rotation, rotateSides, maskBottom, maskTop, maskMode, easing, color, metalness, roughness, stampBoyut]);

  const kaydet = useCallback(() => {
    if (kilitRef.current) return;
    gecmis.current.push(anlikGoruntu());
    if (gecmis.current.length > MAX_UNDO) gecmis.current.shift();
    ileri.current = [];
    setUndoSay(gecmis.current.length);
    setRedoSay(0);
  }, [anlikGoruntu]);

  const uygula = useCallback((s) => {
    kilitRef.current = true;
    setLayers(s.layers.map((l) => ({ ...l })));
    setActiveLayer(s.activeLayer);
    setBolgeler(s.bolgeler.map((b) => ({ ...b, agirlik: b.agirlik ? new Float32Array(b.agirlik) : null })));
    setAktifBolge(s.aktifBolge);
    setMaskeAgirlik(s.maskeAgirlik ? new Float32Array(s.maskeAgirlik) : null);
    const p = s.params;
    setAmplitudeMm(p.amplitudeMm); setInvert(p.invert); setSymmetric(p.symmetric);
    setSmoothing(p.smoothing); setGeoYumusatma(p.geoYumusatma); setInvertTexture(p.invertTexture);
    setProjection(p.projection); setBlendSmooth(p.blendSmooth);
    setSizeU(p.sizeU); setSizeV(p.sizeV); setOffsetU(p.offsetU); setOffsetV(p.offsetV);
    setRotation(p.rotation); setRotateSides(p.rotateSides);
    setMaskBottom(p.maskBottom); setMaskTop(p.maskTop); setMaskMode(p.maskMode); setEasing(p.easing);
    setColor(p.color); setMetalness(p.metalness); setRoughness(p.roughness); setStampBoyut(p.stampBoyut);
    setRenkVersion((v) => v + 1);
    setTimeout(() => { kilitRef.current = false; }, 90);
  }, []);

  const geriAl = useCallback(() => {
    if (!gecmis.current.length) return;
    const s = gecmis.current.pop();
    ileri.current.push(anlikGoruntu());
    uygula(s);
    setUndoSay(gecmis.current.length);
    setRedoSay(ileri.current.length);
  }, [anlikGoruntu, uygula]);

  const ileriAl = useCallback(() => {
    if (!ileri.current.length) return;
    const s = ileri.current.pop();
    gecmis.current.push(anlikGoruntu());
    uygula(s);
    setUndoSay(gecmis.current.length);
    setRedoSay(ileri.current.length);
  }, [anlikGoruntu, uygula]);

  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) ileriAl(); else geriAl();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [geriAl, ileriAl]);

  /* ---- Geometri ömrü ---- */
  useEffect(() => {
    const p = oncekiBase.current;
    oncekiBase.current = baseGeometry;
    if (p && p !== baseGeometry && p !== stlRef.current) p.dispose();
    setBolgeler((bs) => bs.map((b) => ({ ...b, agirlik: new Float32Array(baseGeometry.attributes.position.count) })));
    setMaskeAgirlik(new Float32Array(baseGeometry.attributes.position.count));
    setMaskeliVertex(0);
  }, [baseGeometry]);

  /* ---- Thumbnail ---- */
  useEffect(() => {
    let dur = false;
    const idler = Object.keys(PRESET_MAP);
    let i = 0;
    const parca = () => {
      if (dur) return;
      const son = Math.min(i + 6, idler.length);
      const yeni = {};
      for (; i < son; i++) {
        const id = idler[i];
        if (!THUMB_CACHE.has(id)) THUMB_CACHE.set(id, makeThumbCanvas(id).toDataURL("image/png"));
        yeni[id] = THUMB_CACHE.get(id);
      }
      setThumbs((t) => ({ ...t, ...yeni }));
      if (i < idler.length) setTimeout(parca, 0);
    };
    parca();
    return () => { dur = true; };
  }, []);

  const handleSize = useCallback((s) => {
    setSizeMm({ x: s.x * MM_PER_UNIT, y: s.y * MM_PER_UNIT, z: s.z * MM_PER_UNIT });
  }, []);

  /* ---- Katman dönüşüm senkronu ---- */
  const oncekiKatman = useRef("");
  useEffect(() => {
    if (oncekiKatman.current === activeLayer) return;
    const l = layers.find((x) => x.id === activeLayer);
    if (!l) return;
    oncekiKatman.current = activeLayer;
    kilitRef.current = true;
    setSizeU(50 / Math.max(0.1, l.scaleU));
    setSizeV(50 / Math.max(0.1, l.scaleV));
    setOffsetU(l.offsetU * 50);
    setOffsetV(l.offsetV * 50);
    setRotation(l.rotation);
    setTimeout(() => { kilitRef.current = false; }, 90);
  }, [activeLayer, layers]);

  useEffect(() => {
    if (!aktifKatman || kilitRef.current) return;
    const su = 50 / Math.max(0.1, sizeU);
    const sv = 50 / Math.max(0.1, sizeV);
    setLayers((ls) => ls.map((l) => (l.id === aktifKatman.id ? { ...l, scaleU: su, scaleV: sv, offsetU: offsetU / 50, offsetV: offsetV / 50, rotation } : l)));
  }, [sizeU, sizeV, offsetU, offsetV, rotation, activeLayer]);

  const presetSec = useCallback((id) => {
    kaydet();
    if (arac && aktifBolge) {
      setBolgeler((bs) => bs.map((b) => (b.id === aktifBolge ? { ...b, presetId: id } : b)));
    } else {
      setLayers((ls) => ls.map((l) => (l.id === activeLayer ? { ...l, presetId: id } : l)));
    }
  }, [activeLayer, arac, aktifBolge, kaydet]);

  const katmanEkle = useCallback(() => {
    kaydet();
    setLayers((ls) => {
      if (ls.length >= MAX_LAYERS) return ls;
      let s = ls.length + 1;
      while (ls.some((l) => l.id === `kat${s}`)) s++;
      const id = `kat${s}`;
      setActiveLayer(id);
      return [...ls, { id, presetId: "gurultu", blend: "ort", depth: 0.6, visible: true, scaleU: 50 / Math.max(0.1, sizeU), scaleV: 50 / Math.max(0.1, sizeV), offsetU: offsetU / 50, offsetV: offsetV / 50, rotation }];
    });
  }, [sizeU, sizeV, offsetU, offsetV, rotation, kaydet]);

  const katmanSil = useCallback((id) => {
    kaydet();
    setLayers((ls) => {
      if (ls.length === 1) return ls;
      const kalan = ls.filter((l) => l.id !== id);
      if (id === activeLayer) setActiveLayer(kalan[0].id);
      return kalan;
    });
  }, [activeLayer, kaydet]);

  const katmanTasi = useCallback((id, yon) => {
    kaydet();
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + yon;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const k = [...ls];
      [k[i], k[j]] = [k[j], k[i]];
      return k;
    });
  }, [kaydet]);

  const katmanKopyala = useCallback((id) => {
    kaydet();
    setLayers((ls) => {
      if (ls.length >= MAX_LAYERS) return ls;
      const k = ls.find((l) => l.id === id);
      if (!k) return ls;
      let s = ls.length + 1;
      while (ls.some((l) => l.id === `kat${s}`)) s++;
      const yeni = `kat${s}`;
      setActiveLayer(yeni);
      return [...ls, { ...k, id: yeni }];
    });
  }, [kaydet]);

  /* ---- Bölge yönetimi ---- */
  const bolgeEkle = useCallback(() => {
    kaydet();
    setBolgeler((bs) => {
      if (bs.length >= MAX_BOLGE) return bs;
      let s = bs.length + 1;
      while (bs.some((b) => b.id === `blg${s}`)) s++;
      const id = `blg${s}`;
      setAktifBolge(id);
      setArac("kalem");
      return [...bs, {
        id, ad: `Bölge ${s}`, renk: BOLGE_RENKLERI[(s - 1) % BOLGE_RENKLERI.length],
        agirlik: new Float32Array(vertexSayisi), presetId: aktifKatman?.presetId || "kristal",
        derinlik: 2.5, olcekU: 50 / Math.max(0.1, sizeU), olcekV: 50 / Math.max(0.1, sizeV),
        offsetU: 0, offsetV: 0, rotasyon: 0, blend: "maks", gorunur: true,
      }];
    });
  }, [vertexSayisi, aktifKatman, sizeU, sizeV, kaydet]);

  const bolgeSil = useCallback((id) => {
    kaydet();
    setBolgeler((bs) => bs.filter((b) => b.id !== id));
    setAktifBolge((a) => (a === id ? null : a));
  }, [kaydet]);

  const bolgeTemizle = useCallback(() => {
    kaydet();
    setBolgeler([]);
    setAktifBolge(null);
    setArac(null);
  }, [kaydet]);

  const bolgeGuncelle = useCallback((id, alan, deger) => {
    setBolgeler((bs) => bs.map((b) => (b.id === id ? { ...b, [alan]: deger } : b)));
  }, []);

  /* ---- Sahne etkileşimi: kalem / lasso / silgi / seç / damga / maske ---- */
  const onHit = useCallback((h) => {
    if (stampMode && !arac && !maskeArac) {
      setStampMerkez({ x: h.point.x, y: h.point.y, z: h.point.z, nx: h.normal.x, ny: h.normal.y, nz: h.normal.z });
      return;
    }
    if (!graf) return;
    const yaricap = Math.max(0.02, fircaMm * UNIT_PER_MM);
    const feather = Math.max(0.01, featherMm * UNIT_PER_MM);

    if (maskeArac) {
      const r = kalemUygula(graf, h.faceIndex, yaricap, feather, maskeAgirlik || new Float32Array(vertexSayisi), false);
      const yeni = agirlikYaz(graf, maskeAgirlik || new Float32Array(vertexSayisi), r.dokunulan, r.mesafe, r.yaricap, r.f, false);
      setMaskeAgirlik(yeni);
      let c = 0;
      for (let i = 0; i < yeni.length; i++) if (yeni[i] > 0.05) c++;
      setMaskeliVertex(c);
      return;
    }

    if (!arac) return;

    if (arac === "sec") {
      let en = null, enW = 0;
      for (const b of bolgeler) {
        if (!b.agirlik) continue;
        const list = graf.vertUcgen;
        void list;
        const t = h.faceIndex;
        void t;
        let w = 0;
        const idx = baseGeometry.index;
        for (let k = 0; k < 3; k++) {
          const vi = idx.getX(h.faceIndex * 3 + k);
          w = Math.max(w, b.agirlik[vi] || 0);
        }
        if (w > enW) { enW = w; en = b.id; }
      }
      if (en && enW > 0.05) setAktifBolge(en);
      return;
    }

    if (arac === "lasso") return;

    if (!aktifBolgeObj) return;
    const hedef = aktifBolgeObj.agirlik || new Float32Array(vertexSayisi);
    const r = kalemUygula(graf, h.faceIndex, yaricap, feather, hedef, arac === "silgi");
    const yeni = agirlikYaz(graf, hedef, r.dokunulan, r.mesafe, r.yaricap, r.f, arac === "silgi");
    setBolgeler((bs) => bs.map((b) => (b.id === aktifBolgeObj.id ? { ...b, agirlik: yeni } : b)));
    setRenkVersion((v) => v + 1);
  }, [graf, fircaMm, featherMm, maskeArac, maskeAgirlik, vertexSayisi, arac, bolgeler, aktifBolgeObj, stampMode, baseGeometry]);

  /* ---- Lasso overlay ---- */
  const lassoBasla = (e) => {
    if (arac !== "lasso") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    lassoRef.current = [[e.clientX - r.left, e.clientY - r.top]];
    setLassoNokta([...lassoRef.current]);
  };
  const lassoSurdur = (e) => {
    if (arac !== "lasso" || !lassoRef.current.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    lassoRef.current.push([e.clientX - r.left, e.clientY - r.top]);
    setLassoNokta([...lassoRef.current]);
  };
  const lassoBitir = () => {
    if (arac !== "lasso") return;
    const poly = lassoRef.current;
    lassoRef.current = [];
    setLassoNokta([]);
    if (poly.length < 6 || !graf || !sahneRef.current) return;
    kaydet();
    const { camera, width, height } = sahneRef.current;
    const w = lassoUygula(graf, baseGeometry, camera, width, height, poly, Math.max(0.01, featherMm * UNIT_PER_MM));
    if (aktifBolgeObj) {
      setBolgeler((bs) => bs.map((b) => (b.id === aktifBolgeObj.id ? { ...b, agirlik: w } : b)));
    } else {
      setBolgeler((bs) => {
        if (bs.length >= MAX_BOLGE) return bs;
        let s = bs.length + 1;
        while (bs.some((b) => b.id === `blg${s}`)) s++;
        const id = `blg${s}`;
        setAktifBolge(id);
        return [...bs, {
          id, ad: `Bölge ${s}`, renk: BOLGE_RENKLERI[(s - 1) % BOLGE_RENKLERI.length],
          agirlik: w, presetId: aktifKatman?.presetId || "kristal", derinlik: 2.5,
          olcekU: 50 / Math.max(0.1, sizeU), olcekV: 50 / Math.max(0.1, sizeV),
          offsetU: 0, offsetV: 0, rotasyon: 0, blend: "maks", gorunur: true,
        }];
      });
    }
    setRenkVersion((v) => v + 1);
  };

  function SahneKopru() {
    const { camera, size } = useThree();
    useEffect(() => { sahneRef.current = { camera, width: size.width, height: size.height }; }, [camera, size]);
    return null;
  }

  /* ---- Dosya yükleme ---- */
  const handleFile = useCallback((file) => {
    if (!file.name.toLocaleLowerCase("tr-TR").endsWith(".stl")) {
      setExportStatus("error"); setExportNot("Yalnızca .stl dosyası");
      setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 2600);
      return;
    }
    if (file.size > MAX_STL_MB * 1024 * 1024) {
      setExportStatus("error"); setExportNot(`En fazla ${MAX_STL_MB} MB`);
      setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 2600);
      return;
    }
    setExportStatus("working");
    const ok = new FileReader();
    ok.onload = () => {
      try {
        const geo = normalizeGeometry(new STLLoader().parse(ok.result));
        if (stlRef.current && stlRef.current !== geo) stlRef.current.dispose();
        stlRef.current = geo;
        kaydet();
        setBaseGeometry(geo);
        setFileName(file.name);
        setFileSizeKB(Math.max(1, Math.round(file.size / 1024)));
        setMode("stl");
        setExportStatus("idle");
      } catch {
        setExportStatus("error"); setExportNot("Dosya okunamadı");
        setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 2600);
      }
    };
    ok.onerror = () => { setExportStatus("error"); setTimeout(() => setExportStatus("idle"), 2600); };
    ok.readAsArrayBuffer(file);
  }, [kaydet]);

  const kubeDon = useCallback(() => {
    kaydet();
    setBaseGeometry(kupGeometrisi());
    setMode("kup"); setFileName(""); setFileSizeKB(0);
  }, [kaydet]);

  const stlDon = useCallback(() => {
    if (!stlRef.current) return;
    kaydet();
    setBaseGeometry(stlRef.current);
    setMode("stl");
  }, [kaydet]);

  /* ---- Özel harita ---- */
  const ozelHaritaYukle = useCallback(async (file) => {
    if (!file.type.startsWith("image/")) {
      setYuklemeDurum("Yalnızca PNG / JPG / WEBP yükleyin.");
      setTimeout(() => setYuklemeDurum(""), 2600);
      return;
    }
    try {
      const o = await gorselOku(file);
      ozelSayac.current += 1;
      const id = `ozel_${ozelSayac.current}`;
      const canvas = document.createElement("canvas");
      canvas.width = TEX_SIZE; canvas.height = TEX_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      fillBg(ctx, TEX_SIZE, "#000000");
      const oran = Math.max(TEX_SIZE / o.w, TEX_SIZE / o.h);
      const w = o.w * oran, h = o.h * oran;
      ctx.drawImage(o.kaynak, (TEX_SIZE - w) / 2, (TEX_SIZE - h) / 2, w, h);
      CUSTOM_MAPS.set(id, canvas);
      TEX_CACHE.delete(id);
      THUMB_CACHE.set(id, makeThumbCanvas(id).toDataURL("image/png"));
      const ad = file.name.replace(/\.[^.]+$/, "").slice(0, 40).trim() || `Özel harita ${ozelSayac.current}`;
      setOzelHaritalar((m) => [...m, { id, name: ad }]);
      setThumbs((t) => ({ ...t, [id]: THUMB_CACHE.get(id) }));
      kaydet();
      if (arac && aktifBolge) setBolgeler((bs) => bs.map((b) => (b.id === aktifBolge ? { ...b, presetId: id } : b)));
      else setLayers((ls) => ls.map((l) => (l.id === activeLayer ? { ...l, presetId: id } : l)));
      setCategory("ozel"); setArama("");
      setYuklemeDurum(`"${ad}" galeriye eklendi.`);
      setTimeout(() => setYuklemeDurum(""), 2600);
    } catch {
      setYuklemeDurum("Görsel okunamadı, tekrar deneyin.");
      setTimeout(() => setYuklemeDurum(""), 2600);
    }
  }, [activeLayer, arac, aktifBolge, kaydet]);

  const ozelHaritaSil = useCallback((id) => {
    CUSTOM_MAPS.delete(id); TEX_CACHE.delete(id); THUMB_CACHE.delete(id);
    setOzelHaritalar((m) => m.filter((o) => o.id !== id));
    setThumbs((t) => { const k = { ...t }; delete k[id]; return k; });
    setLayers((ls) => ls.map((l) => (l.presetId === id ? { ...l, presetId: "gurultu" } : l)));
    setBolgeler((bs) => bs.map((b) => (b.presetId === id ? { ...b, presetId: "gurultu" } : b)));
  }, []);

  /* ---- Maske ---- */
  const maskeTemizle = useCallback(() => {
    kaydet();
    setMaskeAgirlik(new Float32Array(vertexSayisi));
    setMaskeliVertex(0);
  }, [vertexSayisi, kaydet]);

  const maskeDoldur = useCallback(() => {
    kaydet();
    const a = new Float32Array(vertexSayisi).fill(1);
    setMaskeAgirlik(a);
    setMaskeliVertex(vertexSayisi);
  }, [vertexSayisi, kaydet]);

  /* ---- Sıfırla / Rastgele ---- */
  const sifirla = useCallback(() => {
    kaydet();
    setAmplitudeMm(1.22); setInvert(false); setSymmetric(false); setSmoothing(0); setGeoYumusatma(0);
    setInvertTexture(false); setProjection("tri"); setBlendSmooth(0.5);
    setSizeU(2.01); setSizeV(2.01); setOffsetU(0); setOffsetV(0); setRotation(0); setRotateSides(false);
    setMaskBottom(5); setMaskTop(0); setMaskMode("haric"); setEasing("dogrusal");
    setColor(DEFAULT_COLOR); setMetalness(DEFAULT_METALNESS); setRoughness(DEFAULT_ROUGHNESS);
    setStampMode(false); setStampMerkez(null); setStampBoyut(14);
    setKesitY(0); setExportRes(0.35);
    setMaskeAgirlik(new Float32Array(vertexSayisi)); setMaskeliVertex(0);
    setLayers([{ id: "kat1", presetId: "kristal", blend: "ekle", depth: 1, visible: true, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotation: 0 }]);
    setActiveLayer("kat1");
    setBolgeler([]); setAktifBolge(null); setArac(null); setMaskeArac(false);
  }, [vertexSayisi, kaydet]);

  const rastgele = useCallback(() => {
    kaydet();
    const rnd = mulberry32((Date.now() & 0xffff) + 17);
    const p = PRESETS[Math.floor(rnd() * PRESETS.length)];
    setLayers((ls) => ls.map((l) => (l.id === activeLayer ? { ...l, presetId: p.id, depth: 0.6 + rnd() * 1.2 } : l)));
    setAmplitudeMm(0.6 + rnd() * 2.4);
    setSizeU(1 + rnd() * 8); setSizeV(1 + rnd() * 8);
    setRotation(Math.floor(rnd() * 360));
    setSmoothing(rnd() * 0.3);
    setProjection(["uv", "tri", "kutu", "kuresel"][Math.floor(rnd() * 4)]);
    setColor(QUICK_COLORS[Math.floor(rnd() * QUICK_COLORS.length)]);
  }, [activeLayer, kaydet]);

  /* ---- Proje kaydet / aç ---- */
  const projeKaydet = useCallback(() => {
    try {
      const veri = {
        surum: 2,
        layers, activeLayer,
        bolgeler: bolgeler.map((b) => ({ ...b, agirlik: agirlikPaketle(b.agirlik) })),
        aktifBolge,
        maske: agirlikPaketle(maskeAgirlik),
        vertexSayisi,
        ozelHaritalar: ozelHaritalar.map((o) => ({ id: o.id, name: o.name, data: CUSTOM_MAPS.get(o.id)?.toDataURL("image/png") || null })),
        params: { amplitudeMm, invert, symmetric, smoothing, geoYumusatma, invertTexture, projection, blendSmooth, sizeU, sizeV, offsetU, offsetV, rotation, rotateSides, maskBottom, maskTop, maskMode, easing, color, metalness, roughness, stampBoyut, exportRes, kesitY },
        dosya: fileName || null,
      };
      const blob = new Blob([JSON.stringify(veri)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const t = new Date();
      const damga = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}_${String(t.getHours()).padStart(2, "0")}${String(t.getMinutes()).padStart(2, "0")}`;
      a.href = url; a.download = `palamut_proje_${damga}.palamut`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportNot("Proje kaydedildi");
      setTimeout(() => setExportNot(""), 2400);
    } catch {
      setExportNot("Proje kaydedilemedi");
      setTimeout(() => setExportNot(""), 2400);
    }
  }, [layers, activeLayer, bolgeler, aktifBolge, maskeAgirlik, vertexSayisi, ozelHaritalar, amplitudeMm, invert, symmetric, smoothing, geoYumusatma, invertTexture, projection, blendSmooth, sizeU, sizeV, offsetU, offsetV, rotation, rotateSides, maskBottom, maskTop, maskMode, easing, color, metalness, roughness, stampBoyut, exportRes, kesitY, fileName]);

  const projeAc = useCallback(async (file) => {
    try {
      const metin = await file.text();
      const v = JSON.parse(metin);
      if (!v || v.surum !== 2 || !Array.isArray(v.layers)) throw new Error("gecersiz");
      kaydet();
      for (const o of v.ozelHaritalar || []) {
        if (!o.data) continue;
        const img = await dataUrlYukle(o.data);
        const c = document.createElement("canvas");
        c.width = TEX_SIZE; c.height = TEX_SIZE;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
        CUSTOM_MAPS.set(o.id, c);
        TEX_CACHE.delete(o.id);
        THUMB_CACHE.set(o.id, makeThumbCanvas(o.id).toDataURL("image/png"));
        setThumbs((t) => ({ ...t, [o.id]: THUMB_CACHE.get(o.id) }));
      }
      setOzelHaritalar((v.ozelHaritalar || []).map((o) => ({ id: o.id, name: o.name })));
      const n = vertexSayisi;
      setLayers(v.layers);
      setActiveLayer(v.activeLayer);
      setBolgeler((v.bolgeler || []).map((b) => ({ ...b, agirlik: agirlikAc(b.agirlik, n) })));
      setAktifBolge(v.aktifBolge || null);
      setMaskeAgirlik(agirlikAc(v.maske, n));
      const p = v.params || {};
      setAmplitudeMm(p.amplitudeMm ?? 1.22); setInvert(!!p.invert); setSymmetric(!!p.symmetric);
      setSmoothing(p.smoothing ?? 0); setGeoYumusatma(p.geoYumusatma ?? 0); setInvertTexture(!!p.invertTexture);
      setProjection(p.projection ?? "tri"); setBlendSmooth(p.blendSmooth ?? 0.5);
      setSizeU(p.sizeU ?? 2.01); setSizeV(p.sizeV ?? 2.01); setOffsetU(p.offsetU ?? 0); setOffsetV(p.offsetV ?? 0);
      setRotation(p.rotation ?? 0); setRotateSides(!!p.rotateSides);
      setMaskBottom(p.maskBottom ?? 5); setMaskTop(p.maskTop ?? 0); setMaskMode(p.maskMode ?? "haric"); setEasing(p.easing ?? "dogrusal");
      setColor(p.color ?? DEFAULT_COLOR); setMetalness(p.metalness ?? DEFAULT_METALNESS); setRoughness(p.roughness ?? DEFAULT_ROUGHNESS);
      setStampBoyut(p.stampBoyut ?? 14); setExportRes(p.exportRes ?? 0.35); setKesitY(p.kesitY ?? 0);
      setRenkVersion((x) => x + 1);
      setExportNot(v.dosya ? `Proje açıldı · kaynak dosya: ${v.dosya}` : "Proje açıldı");
      setTimeout(() => setExportNot(""), 3600);
    } catch {
      setExportNot("Geçersiz proje dosyası");
      setTimeout(() => setExportNot(""), 2600);
    }
  }, [vertexSayisi, kaydet]);

  /* ---- Export ---- */
  const exportHazirla = useCallback(() => {
    const temel = yenidenOrnekle(baseGeometry, exportRes);
    const gecerli = layers.filter((l) => l.visible).map((l) => ({
      data: getTexData(l.presetId).data, blend: l.blend, depth: l.depth,
      scaleU: l.scaleU, scaleV: l.scaleV, offsetU: l.offsetU, offsetV: l.offsetV, rotation: l.rotation,
    }));
    const n = temel.attributes.position.count;
    const olcekle = (a) => {
      if (!a) return null;
      if (a.length === n) return a;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = a[Math.min(a.length - 1, Math.floor((i / n) * a.length))] || 0;
      return out;
    };
    const bg = bolgeler.map((b) => ({ ...b, agirlik: olcekle(b.agirlik) }));
    const mk = olcekle(maskeAgirlik);
    const g = preview3D ? applyRealDisplacement(temel, gecerli, bg, mk, opts) : temel;
    if (g !== temel) temel.dispose();
    return g;
  }, [baseGeometry, exportRes, layers, bolgeler, maskeAgirlik, opts, preview3D]);

  const stlIndir = useCallback(() => {
    setExportStatus("working");
    setTimeout(() => {
      try {
        const g = exportHazirla();
        const kontrol = manifoldDenetle(g);
        const buffer = new STLExporter().parse(new THREE.Mesh(g), { binary: true });
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `palamut3d_${Date.now()}.stl`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        const t = g.index ? Math.round(g.index.count / 3) : Math.round(g.attributes.position.count / 3);
        setExportNot(`${t.toLocaleString("tr-TR")} üçgen · ${kontrol.sinir === 0 && kontrol.nonManifold === 0 ? "kapalı katı" : `${kontrol.sinir} sınır kenar`}`);
        g.dispose();
        setExportStatus("done");
        setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 4200);
      } catch {
        setExportStatus("error"); setExportNot("Dışa aktarma başarısız");
        setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 2600);
      }
    }, 40);
  }, [exportHazirla]);

  const mfIndir = useCallback(() => {
    setExportStatus("working");
    setTimeout(() => {
      void (async () => {
        try {
          const g = exportHazirla();
          const xml = ucgenXmlKur(g);
          const zip = new JSZip();
          zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
          zip.file("_rels/.rels", RELS_XML);
          zip.file("3D/3dmodel.model", xml);
          const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `palamut3d_${Date.now()}.3mf`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(url);
          const t = g.index ? Math.round(g.index.count / 3) : Math.round(g.attributes.position.count / 3);
          setExportNot(`3MF · ${t.toLocaleString("tr-TR")} üçgen · mm`);
          g.dispose();
          setExportStatus("done");
          setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 4200);
        } catch {
          setExportStatus("error"); setExportNot("3MF oluşturulamadı");
          setTimeout(() => { setExportStatus("idle"); setExportNot(""); }, 2600);
        }
      })();
    }, 40);
  }, [exportHazirla]);

  /* ---- Türetilmiş değerler ---- */
  const galeriOgeleri = useMemo(() => {
    const q = arama.trim().toLocaleLowerCase("tr-TR");
    const hepsi = [
      ...PRESETS.map((p) => ({ id: p.id, name: p.name, category: p.category, ozel: false })),
      ...ozelHaritalar.map((o) => ({ id: o.id, name: o.name, category: "ozel", ozel: true })),
    ];
    return hepsi.filter((o) => {
      const katOk = category === "tumu" ? true : category === "ozel" ? o.ozel : o.category === category;
      return katOk && (q === "" || o.name.toLocaleLowerCase("tr-TR").includes(q));
    });
  }, [category, arama, ozelHaritalar]);

  const ortKenarMm = useMemo(() => ortalamaKenar(baseGeometry) * MM_PER_UNIT, [baseGeometry]);
  const tahminiUcgen = useMemo(() => {
    const oran = ortKenarMm / Math.max(0.05, exportRes);
    return Math.max(12, Math.round(ucgenSayisi * oran * oran));
  }, [ucgenSayisi, ortKenarMm, exportRes]);

  const sahneKontrol = useMemo(() => manifoldDenetle(baseGeometry), [baseGeometry]);
  const hacimCm3 = useMemo(() => (geoRef.current ? hacimHesapla(geoRef.current) / 1000 : 0), [sizeMm, renkVersion, ucgenSayisi]);

  const hepsiGorunur = layers.every((l) => l.visible);
  const cizimAktif = !!arac || maskeArac;
  const hedefEtiket = hedefBolge ? `Bölge: ${hedefBolge.ad}` : `Katman: ${presetAdi(aktifKatman?.presetId)}`;

  const Slider = ({ etiket, deger, set, min, max, step, birim, hassas = 2 }) => (
    <div className="mb-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="field-label">{etiket}</span>
        <span className="field-value">{Number(deger).toFixed(hassas)}{birim ? ` ${birim}` : ""}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={deger}
        onPointerDown={kaydet}
        onChange={(e) => set(parseFloat(e.target.value))} />
    </div>
  );

  const Cbox = ({ secili, tikla, etiket, alt }) => (
    <label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink">
      <button type="button" className="cbox mt-0.5" data-checked={secili} onClick={() => { kaydet(); tikla(); }} aria-label={etiket}>
        <Icon name="check" size={10} />
      </button>
      <span onClick={() => { kaydet(); tikla(); }}>
        {etiket}
        {alt ? <span className="field-hint block">{alt}</span> : null}
      </span>
    </label>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <header className="flex min-h-header shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-line bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <Icon name="cube" size={18} className="text-accent" />
          <span className="text-[15px] font-bold leading-none text-ink">Palamut3D</span>
          <span className="mono text-[10px] leading-none text-faint">v2.0</span>
          <span className="sep text-[11px] leading-none">·</span>
          <span className="text-[11px] leading-none text-dim">by</span>
          <a href="https://mucahidbalci.github.io" target="_blank" rel="noopener noreferrer" className="link text-[11px] leading-none">Mucahid Balci</a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="seg">
            <button type="button" onClick={kubeDon} data-active={mode === "kup"}><Icon name="cube" size={13} />Küp</button>
            <button type="button" onClick={stlDon} data-active={mode === "stl"} disabled={!stlRef.current} title={stlRef.current ? "Yüklenen STL'ye dön" : "Önce bir STL yükleyin"}><Icon name="file" size={13} />STL</button>
          </div>
          <div className="seg">
            <button type="button" onClick={() => setViewMode("dolu")} data-active={viewMode === "dolu"}><Icon name="eye" size={13} />Dolu</button>
            <button type="button" onClick={() => setViewMode("tel")} data-active={viewMode === "tel"}><Icon name="eye-off" size={13} />Tel</button>
            <button type="button" onClick={() => setViewMode("kesit")} data-active={viewMode === "kesit"}><Icon name="scissors" size={13} />Kesit</button>
          </div>
          <div className="seg">
            <button type="button" className="btn-icon" onClick={geriAl} disabled={undoSay === 0} aria-label="Geri al" title={`Geri al (${undoSay})`}><Icon name="undo" size={13} /></button>
            <button type="button" className="btn-icon" onClick={ileriAl} disabled={redoSay === 0} aria-label="İleri al" title={`İleri al (${redoSay})`}><Icon name="redo" size={13} /></button>
            <button type="button" className="btn-icon" onClick={projeKaydet} aria-label="Projeyi kaydet" title="Projeyi kaydet (.palamut)"><Icon name="save" size={13} /></button>
            <button type="button" className="btn-icon" onClick={() => projeInputRef.current?.click()} aria-label="Proje aç" title="Proje aç (.palamut)"><Icon name="open" size={13} /></button>
          </div>
          <input ref={projeInputRef} type="file" accept=".palamut,.json" className="sr-file-input"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void projeAc(f); }} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 max-lg:flex-col">
        <main className="relative min-w-0 flex-1 max-lg:min-h-[46vh]">
          <Canvas camera={{ position: [8, 8, 8], fov: 50 }} dpr={[1, 2]} gl={{ antialias: true, localClippingEnabled: true }}>
            <color attach="background" args={["#0b0e13"]} />
            <fog attach="fog" args={["#0b0e13", 22, 52]} />
            <ambientLight intensity={0.55} />
            <directionalLight position={[6, 10, 6]} intensity={1.05} color="#ffffff" />
            <directionalLight position={[-8, -4, -6]} intensity={0.45} color="#7dd3fc" />
            <hemisphereLight args={["#8fb4d8", "#0b0e13", 0.25]} />
            <SahneKopru />
            <Model
              baseGeometry={baseGeometry} layers={layers} bolgeler={bolgeler} maskeAgirlik={maskeAgirlik}
              opts={opts} renkVersion={renkVersion} color={color} wireframe={viewMode === "tel"}
              metalness={metalness} roughness={roughness} preview3D={preview3D}
              bolgeleriGoster={bolgeleriGoster} kesitAktif={viewMode === "kesit"} kesitY={kesitY}
              geoRef={geoRef} graf={graf} arac={maskeArac ? "kalem" : arac} onHit={onHit} onSize={handleSize}
              surukleBoya={arac === "kalem" || arac === "silgi" || maskeArac}
            />
            <Grid position={[0, -2.9, 0]} args={[24, 24]} cellSize={0.5} cellThickness={0.6} cellColor="#232a35" sectionSize={2.5} sectionThickness={1} sectionColor="#2e3745" infiniteGrid fadeDistance={32} fadeStrength={1.2} />
            <OrbitControls enableDamping dampingFactor={0.08} minDistance={3} maxDistance={30} enabled={!cizimAktif || arac === "sec"} />
          </Canvas>

          {arac === "lasso" ? (
            <svg className="absolute inset-0 h-full w-full cursor-crosshair" onPointerDown={lassoBasla} onPointerMove={lassoSurdur} onPointerUp={lassoBitir} onPointerLeave={lassoBitir}>
              {lassoNokta.length > 1 ? (
                <polygon points={lassoNokta.map((p) => p.join(",")).join(" ")} fill="rgba(34,211,238,0.14)" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 3" />
              ) : null}
            </svg>
          ) : null}

          <AxisGizmo />

          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] text-[10px] leading-relaxed text-faint">
            {maskeArac
              ? "Maske fırçası · Sol tık + sürükle: boya"
              : arac === "kalem"
              ? "Kalem · Sol tık + sürükle: bölgeye doku alanı boya"
              : arac === "silgi"
              ? "Silgi · Sol tık + sürükle: bölgeden çıkar"
              : arac === "lasso"
              ? "Lasso · Basılı tut, kapalı alan çiz, bırak"
              : arac === "sec"
              ? "Seç · Modele tıkla, en baskın bölge seçilir"
              : stampMode
              ? "Damga · Modele tıkla, desen merkezi oraya taşınır"
              : "Sol tık: döndür · Tekerlek: yakınlaştır · Sağ tık: kaydır"}
          </div>

          <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
            {!preview3D ? (
              <span className="mono rounded-btn border border-line bg-panel/90 px-2 py-1 text-[10px] text-dim">Önizleme kapalı · düz geometri</span>
            ) : null}
            {cizimAktif ? (
              <span className="mono rounded-btn border px-2 py-1 text-[10px]" style={{ borderColor: "#22d3ee", color: "#22d3ee", background: "rgba(34,211,238,0.12)" }}>
                {maskeArac ? "Maske boyama" : `${ARACLAR.find((a) => a.id === arac)?.label} · ${aktifBolgeObj ? aktifBolgeObj.ad : "bölge yok"}`}
              </span>
            ) : null}
          </div>
        </main>

        <aside className="panel max-lg:w-full max-lg:flex-1 max-lg:border-l-0 max-lg:border-t">
          {/* MODEL */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Model</h2>
              <div className="flex items-center gap-1">
                <button type="button" className="btn btn-icon" title="Varsayılan küpe dön" aria-label="Varsayılan küpe dön" onClick={kubeDon}><Icon name="cube" size={13} /></button>
                <Icon name="folder" size={14} className="text-faint" />
              </div>
            </div>
            <label className="dropzone block cursor-pointer px-3 py-4 text-center" data-drag={surukleAktif ? "true" : "false"}
              onDragOver={(e) => { e.preventDefault(); setSurukleAktif(true); }}
              onDragLeave={() => setSurukleAktif(false)}
              onDrop={(e) => { e.preventDefault(); setSurukleAktif(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}>
              <input ref={stlInputRef} type="file" accept=".stl" className="sr-file-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleFile(f); }} />
              <Icon name="upload" size={20} className="mx-auto mb-1.5 text-dim" />
              <div className="text-[11px] text-ink">STL dosyasını buraya bırakın</div>
              <div className="mt-0.5 text-[10px] text-dim">veya <span className="text-accent underline underline-offset-2">dosya seçin</span></div>
              <div className="mono mt-1 text-[9px] text-faint">ASCII veya ikili STL · en fazla {MAX_STL_MB} MB</div>
            </label>
            <div className="mono mt-2 text-[10px] leading-relaxed text-dim">
              {fileName ? (
                <span>
                  <span className="text-ink">{fileName}</span><span className="sep"> | STL | </span>
                  <span className="tnum">{fileSizeKB} KB</span><span className="sep"> | </span>
                  <span className="tnum">{ucgenSayisi.toLocaleString("tr-TR")} üçgen</span>
                </span>
              ) : <span className="text-faint">Varsayılan küp üzerinde çalışılıyor</span>}
            </div>
            <div className="mono mt-1 flex items-center gap-1.5 text-[10px]">
              <span style={{ color: sahneKontrol.sinir === 0 && sahneKontrol.nonManifold === 0 ? "#34d399" : "#fbbf24" }}>
                {sahneKontrol.sinir === 0 && sahneKontrol.nonManifold === 0 ? "Kapalı katı" : `${sahneKontrol.sinir} sınır · ${sahneKontrol.nonManifold} non-manifold`}
              </span>
              <span className="sep">|</span>
              <span className="text-dim tnum">{ortKenarMm.toFixed(2)} mm kenar</span>
            </div>
          </section>

          {/* ARAÇLAR */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Yüzey Araçları</h2>
              <Icon name="brush" size={14} className="text-faint" />
            </div>
            <div className="mb-2 grid grid-cols-4 gap-1">
              {ARACLAR.map((a) => (
                <button key={a.id} type="button" className="btn flex-col !gap-1 !py-1.5"
                  data-active={arac === a.id && !maskeArac}
                  onClick={() => { setMaskeArac(false); setArac(arac === a.id ? null : a.id); }}>
                  <Icon name={a.ikon} size={13} />
                  <span className="text-[9px]">{a.label}</span>
                </button>
              ))}
            </div>
            <Slider etiket="Fırça çapı" deger={fircaMm} set={setFircaMm} min={1} max={40} step={0.5} birim="mm" hassas={1} />
            <Slider etiket="Kenar yumuşaklığı" deger={featherMm} set={setFeatherMm} min={0.2} max={20} step={0.2} birim="mm" hassas={1} />
            <div className="mono mb-1.5 rounded-btn border border-line bg-bg px-2 py-1 text-[10px] text-dim">
              Hedef: <span style={{ color: "#22d3ee" }}>{hedefEtiket}</span>
            </div>
            <p className="field-hint">
              Kalem ve silgi yüzey komşuluğu boyunca yürür; modelin arka yüzü etkilenmez. Lasso ile kapalı alan çizip tek seferde bölge oluşturabilirsiniz.
            </p>
          </section>

          {/* BÖLGELER */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Bölgeler</h2>
              <div className="flex items-center gap-1">
                <span className="mono text-[10px] text-faint">{bolgeler.length}/{MAX_BOLGE}</span>
                <button type="button" className="btn btn-icon" data-active={bolgeleriGoster} onClick={() => setBolgeleriGoster((v) => !v)} title="Bölge renklerini göster" aria-label="Bölge renklerini göster">
                  <Icon name={bolgeleriGoster ? "eye" : "eye-off"} size={12} />
                </button>
              </div>
            </div>

            {bolgeler.length === 0 ? (
              <p className="field-hint mb-2">Henüz bölge yok. Kalemle modelin üzerine çizin ya da Lasso ile alan seçin; her bölge kendi dokusunu taşır.</p>
            ) : (
              <div className="mb-2 space-y-1.5">
                {bolgeler.map((b) => (
                  <div key={b.id} onClick={() => setAktifBolge(b.id)}
                    className={`cursor-pointer rounded-btn border p-1.5 transition-colors duration-150 ${b.id === aktifBolge ? "bg-accent-soft" : "bg-bg hover:border-line-strong"}`}
                    style={{ borderColor: b.id === aktifBolge ? b.renk : undefined }}>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: b.renk }} />
                      <input type="text" value={b.ad} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => bolgeGuncelle(b.id, "ad", e.target.value.slice(0, 24))}
                        className="min-w-0 flex-1 !border-transparent !bg-transparent !px-0 !text-[11px]" style={{ fontFamily: "inherit" }} />
                      <div className="h-5 w-5 shrink-0 overflow-hidden rounded-swatch border border-line-strong">
                        {thumbs[b.presetId] ? <img src={thumbs[b.presetId]} alt="" className="h-full w-full object-cover" /> : null}
                      </div>
                      <button type="button" className="btn btn-icon" data-active={b.gorunur} title="Bölgeyi aç/kapat" aria-label="Bölgeyi aç/kapat"
                        onClick={(e) => { e.stopPropagation(); kaydet(); bolgeGuncelle(b.id, "gorunur", !b.gorunur); }}>
                        <Icon name={b.gorunur ? "eye" : "eye-off"} size={11} />
                      </button>
                      <button type="button" className="btn btn-icon" title="Bölgeyi sil" aria-label="Bölgeyi sil"
                        onClick={(e) => { e.stopPropagation(); bolgeSil(b.id); }}>
                        <Icon name="trash" size={11} />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <select value={b.blend} onChange={(e) => { kaydet(); bolgeGuncelle(b.id, "blend", e.target.value); }}
                        className="appearance-none rounded-btn border border-line bg-card py-0.5 pl-1 pr-1 text-[10px] text-dim">
                        {BLEND_MODES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                      <input type="range" min={0} max={5} step={0.05} value={b.derinlik}
                        onPointerDown={kaydet} onChange={(e) => bolgeGuncelle(b.id, "derinlik", parseFloat(e.target.value))} className="min-w-0 flex-1" />
                      <span className="mono w-10 shrink-0 text-right text-[9px] tnum text-dim">{b.derinlik.toFixed(2)}</span>
                    </div>
                    {b.id === aktifBolge ? (
                      <div className="mt-1.5 grid grid-cols-2 gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <div>
                          <div className="mb-1 flex justify-between text-[9px] text-dim"><span>Ölçek U</span><span className="mono tnum" style={{ color: b.renk }}>{b.olcekU.toFixed(1)}</span></div>
                          <input type="range" min={0.2} max={60} step={0.2} value={b.olcekU} onPointerDown={kaydet} onChange={(e) => bolgeGuncelle(b.id, "olcekU", parseFloat(e.target.value))} />
                        </div>
                        <div>
                          <div className="mb-1 flex justify-between text-[9px] text-dim"><span>Rotasyon</span><span className="mono tnum" style={{ color: b.renk }}>{b.rotasyon}°</span></div>
                          <input type="range" min={0} max={360} step={1} value={b.rotasyon} onPointerDown={kaydet} onChange={(e) => bolgeGuncelle(b.id, "rotasyon", parseFloat(e.target.value))} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" className="btn" onClick={bolgeEkle} disabled={bolgeler.length >= MAX_BOLGE}><Icon name="plus" size={12} />Bölge ekle</button>
              <button type="button" className="btn" onClick={bolgeTemizle} disabled={bolgeler.length === 0}><Icon name="eraser" size={12} />Tümünü sil</button>
            </div>
          </section>

          {/* GÖRÜNÜM */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Görünüm</h2>
              <Icon name="palette" size={14} className="text-faint" />
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {QUICK_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => { kaydet(); setColor(c); }}
                  className={`flex h-5 w-5 items-center justify-center rounded-btn border text-bg ${color.toLowerCase() === c ? "border-accent ring-1 ring-accent" : "border-line-strong"}`}
                  style={{ background: c }} title={c} aria-label={`Renk ${c}`}>
                  {color.toLowerCase() === c ? <Icon name="check" size={9} /> : null}
                </button>
              ))}
            </div>
            <div className="mb-2 flex items-center gap-1.5">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 shrink-0 cursor-pointer rounded-btn border border-line bg-bg p-0.5" aria-label="Özel renk seç" />
              <input type="text" value={color} onChange={(e) => { const v = e.target.value.trim(); if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setColor(v); }} className="mono min-w-0 flex-1" aria-label="Renk kodu" />
            </div>
            <Slider etiket="Metalik" deger={metalness} set={setMetalness} min={0} max={1} step={0.01} />
            <Slider etiket="Pürüzlülük" deger={roughness} set={setRoughness} min={0} max={1} step={0.01} />
            {viewMode === "kesit" ? <Slider etiket="Kesit yüksekliği" deger={kesitY} set={setKesitY} min={-3} max={3} step={0.02} birim="mm" /> : null}
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" className="btn" onClick={sifirla}><Icon name="refresh" size={12} />Sıfırla</button>
              <button type="button" className="btn" onClick={rastgele}><Icon name="shuffle" size={12} />Rastgele</button>
            </div>
          </section>

          {/* KATMANLAR */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Global Katmanlar</h2>
              <div className="flex items-center gap-1">
                <span className="mono text-[10px] text-faint">{layers.length}/{MAX_LAYERS}</span>
                <button type="button" className="btn btn-icon" data-active={hepsiGorunur}
                  onClick={() => { kaydet(); setLayers((ls) => ls.map((l) => ({ ...l, visible: !hepsiGorunur }))); }}
                  title="Tüm katmanları aç/kapat" aria-label="Tüm katmanları aç/kapat">
                  <Icon name={hepsiGorunur ? "eye" : "eye-off"} size={12} />
                </button>
              </div>
            </div>
            <div className="mb-2 space-y-1.5">
              {layers.map((l, i) => (
                <div key={l.id} onClick={() => setActiveLayer(l.id)}
                  className={`cursor-pointer rounded-btn border p-1.5 transition-colors duration-150 ${l.id === activeLayer ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-line-strong"}`}>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="mono w-3 shrink-0 text-[9px] text-faint">{i + 1}</span>
                    <div className="h-6 w-6 shrink-0 overflow-hidden rounded-swatch border border-line-strong">
                      {thumbs[l.presetId] ? <img src={thumbs[l.presetId]} alt="" className="h-full w-full object-cover" /> : null}
                    </div>
                    <span className={`min-w-0 flex-1 truncate text-[11px] ${l.visible ? "text-ink" : "text-faint"}`}>{presetAdi(l.presetId)}</span>
                    <button type="button" className="btn btn-icon" title="Yukarı taşı" aria-label="Yukarı taşı" disabled={i === 0} onClick={(e) => { e.stopPropagation(); katmanTasi(l.id, -1); }}><Icon name="chevron-up" size={11} /></button>
                    <button type="button" className="btn btn-icon" title="Aşağı taşı" aria-label="Aşağı taşı" disabled={i === layers.length - 1} onClick={(e) => { e.stopPropagation(); katmanTasi(l.id, 1); }}><Icon name="chevron-down" size={11} /></button>
                    <button type="button" className="btn btn-icon" data-active={l.visible} title="Katmanı aç/kapat" aria-label="Katmanı aç/kapat" onClick={(e) => { e.stopPropagation(); kaydet(); setLayers((ls) => ls.map((x) => (x.id === l.id ? { ...x, visible: !x.visible } : x))); }}><Icon name={l.visible ? "eye" : "eye-off"} size={11} /></button>
                    <button type="button" className="btn btn-icon" title="Katmanı çoğalt" aria-label="Katmanı çoğalt" disabled={layers.length >= MAX_LAYERS} onClick={(e) => { e.stopPropagation(); katmanKopyala(l.id); }}><Icon name="copy" size={11} /></button>
                    <button type="button" className="btn btn-icon" title="Katmanı sil" aria-label="Katmanı sil" disabled={layers.length === 1} onClick={(e) => { e.stopPropagation(); katmanSil(l.id); }}><Icon name="trash" size={11} /></button>
                  </div>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <select value={l.blend} onChange={(e) => { kaydet(); setLayers((ls) => ls.map((x) => (x.id === l.id ? { ...x, blend: e.target.value } : x))); }}
                      className="appearance-none rounded-btn border border-line bg-card py-0.5 pl-1 pr-1 text-[10px] text-dim">
                      {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                    </select>
                    <span className="field-label shrink-0">Derinlik</span>
                    <input type="range" min={0} max={2} step={0.01} value={l.depth} onPointerDown={kaydet}
                      onChange={(e) => setLayers((ls) => ls.map((x) => (x.id === l.id ? { ...x, depth: parseFloat(e.target.value) } : x)))} className="min-w-0 flex-1" />
                    <span className="mono w-8 shrink-0 text-right text-[9px] tnum text-dim">{l.depth.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="btn w-full" onClick={katmanEkle} disabled={layers.length >= MAX_LAYERS}><Icon name="plus" size={12} />Katman ekle</button>
          </section>

          {/* GALERİ */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Doku Galerisi</h2>
              <span className="mono text-[10px] text-faint">{galeriOgeleri.length}/{PRESETS.length + ozelHaritalar.length}</span>
            </div>
            <div className="relative mb-2">
              <input type="search" value={arama} onChange={(e) => setArama(e.target.value)} placeholder="Doku ara" className="w-full pr-6" />
              <Icon name="grid" size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint" />
            </div>
            <div className="mb-2 flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button key={c.id} type="button" onClick={() => setCategory(c.id)}
                  className={`rounded-btn border px-1.5 py-0.5 text-[10px] transition-colors duration-150 ${category === c.id ? "border-accent bg-accent-soft text-accent" : "border-line text-dim hover:border-line-strong hover:text-ink"}`}>
                  {c.label}{c.id === "ozel" ? ` (${ozelHaritalar.length})` : ""}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {galeriOgeleri.map((p) => {
                const secili = (hedefBolge ? hedefBolge.presetId : aktifKatman?.presetId) === p.id;
                return (
                  <button key={p.id} type="button" onClick={() => presetSec(p.id)} className="thumb-cell" data-selected={secili} title={p.name} aria-label={p.name}>
                    {thumbs[p.id] ? <img src={thumbs[p.id]} alt={p.name} className="h-full w-full object-cover" /> : <span className="block h-full w-full bg-card" />}
                    {secili ? <span className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-bg"><Icon name="check" size={9} /></span> : null}
                    {p.ozel ? (
                      <span role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); ozelHaritaSil(p.id); }}
                        className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bg/85 text-dim hover:text-ink" title="Özel haritayı sil">
                        <Icon name="x" size={8} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {galeriOgeleri.length === 0 ? <div className="mono mt-2 text-[10px] text-faint">{category === "ozel" && ozelHaritalar.length === 0 ? "Henüz özel harita yok. PNG veya JPG yükleyin." : "Eşleşen doku yok."}</div> : null}
            <input ref={ozelInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-file-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void ozelHaritaYukle(f); }} />
            <button type="button" className="btn mt-2 w-full" onClick={() => ozelInputRef.current?.click()}><Icon name="image" size={12} />Özelleştirilmiş harita yükle</button>
            {yuklemeDurum ? <div className="mono mt-1 text-[10px] text-accent">{yuklemeDurum}</div> : null}
          </section>

          {/* YANSITMA */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Yansıtma</h2>
              <Icon name="target" size={14} className="text-faint" />
            </div>
            <div className="relative mb-2">
              <select value={projection} onChange={(e) => { kaydet(); setProjection(e.target.value); }} className="w-full appearance-none rounded-btn border border-line bg-bg px-2 py-1 pr-6 text-[11px] text-ink">
                <option value="tri">Üç düzlemli (Triplanar)</option>
                <option value="uv">UV</option>
                <option value="kutu">Kutu</option>
                <option value="kuresel">Küresel</option>
              </select>
              <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-faint" />
            </div>
            <Slider etiket="Kesişme yumuşatma" deger={blendSmooth} set={setBlendSmooth} min={0.05} max={1} step={0.05} />
            <button type="button" className="btn w-full" data-active={stampMode} onClick={() => { setStampMode((v) => !v); if (!stampMode) { setArac(null); setMaskeArac(false); } }}>
              <Icon name="stamp" size={12} />Damga modu
            </button>
            {stampMode ? (
              <div className="mt-2">
                <Slider etiket="Damga boyutu" deger={stampBoyut} set={setStampBoyut} min={2} max={50} step={0.5} birim="mm" hassas={1} />
                <button type="button" className="btn w-full" onClick={() => setStampMerkez(null)} disabled={!stampMerkez}><Icon name="x" size={12} />Damga merkezini kaldır</button>
              </div>
            ) : null}
            <p className="field-hint mt-1.5">Damga açıkken desen tekrarlamaz; sahneye tıklayarak merkezi seçin.</p>
          </section>

          {/* DERİNLİK */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Kabartma Derinliği</h2>
              <Icon name="ruler" size={14} className="text-faint" />
            </div>
            <Slider etiket="Kabartma uzunluğu" deger={amplitudeMm} set={setAmplitudeMm} min={0} max={5} step={0.01} birim="mm" />
            <div className="mb-2 space-y-1.5">
              <Cbox secili={invert} tikla={() => setInvert((v) => !v)} etiket="Yönü değiştir" alt="Kabartma dışarı çıkmak yerine içeri çöker." />
              <Cbox secili={symmetric} tikla={() => setSymmetric((v) => !v)} etiket="Simetrik kabartma" />
              <Cbox secili={preview3D} tikla={() => setPreview3D((v) => !v)} etiket="3D önizleme" alt="Kapatıldığında displacement hesaplanmaz." />
            </div>
            <Slider etiket="Kaplama yumuşatma" deger={smoothing} set={setSmoothing} min={0} max={1} step={0.05} />
            <Slider etiket="Geometri yumuşatma" deger={geoYumusatma} set={setGeoYumusatma} min={0} max={1} step={0.05} />
            <Cbox secili={invertTexture} tikla={() => setInvertTexture((v) => !v)} etiket="Dokuyu ters çevir" />
          </section>

          {/* DÖNÜŞTÜR */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Dönüştür</h2>
              <Icon name="rotate" size={14} className="text-faint" />
            </div>
            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between"><span className="field-label">U Boyutu</span><span className="field-value">{sizeU.toFixed(2)} mm</span></div>
              <div className="flex items-center gap-1.5">
                <input type="range" min={0.1} max={50} step={0.01} value={sizeU} onPointerDown={kaydet} onChange={(e) => { const v = parseFloat(e.target.value); setSizeU(v); if (uvLock) setSizeV(v); }} />
                <input type="number" min={0.1} max={50} step={0.01} value={sizeU} onChange={(e) => { const v = Math.max(0.1, Math.min(50, parseFloat(e.target.value) || 0.1)); setSizeU(v); if (uvLock) setSizeV(v); }} className="w-14" />
              </div>
            </div>
            <div className="mb-2 flex justify-center">
              <button type="button" onClick={() => setUvLock((v) => !v)} className="btn btn-icon" data-active={uvLock} title="U ve V değerlerini eşitle" aria-label="U ve V kilidi"><Icon name={uvLock ? "lock" : "unlock"} size={12} /></button>
            </div>
            <div className="mb-2">
              <div className="mb-1.5 flex items-center justify-between"><span className="field-label">V Boyutu</span><span className="field-value">{sizeV.toFixed(2)} mm</span></div>
              <div className="flex items-center gap-1.5">
                <input type="range" min={0.1} max={50} step={0.01} value={sizeV} onPointerDown={kaydet} onChange={(e) => { const v = parseFloat(e.target.value); setSizeV(v); if (uvLock) setSizeU(v); }} />
                <input type="number" min={0.1} max={50} step={0.01} value={sizeV} onChange={(e) => { const v = Math.max(0.1, Math.min(50, parseFloat(e.target.value) || 0.1)); setSizeV(v); if (uvLock) setSizeU(v); }} className="w-14" />
              </div>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between"><span className="field-label">U Offseti</span><span className="field-value">{offsetU.toFixed(1)}</span></div>
                <input type="range" min={-50} max={50} step={0.5} value={offsetU} onPointerDown={kaydet} onChange={(e) => setOffsetU(parseFloat(e.target.value))} />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between"><span className="field-label">V Offseti</span><span className="field-value">{offsetV.toFixed(1)}</span></div>
                <input type="range" min={-50} max={50} step={0.5} value={offsetV} onPointerDown={kaydet} onChange={(e) => setOffsetV(parseFloat(e.target.value))} />
              </div>
            </div>
            <Slider etiket="Rotasyon açısı" deger={rotation} set={setRotation} min={0} max={360} step={1} birim="°" hassas={0} />
            <Cbox secili={rotateSides} tikla={() => setRotateSides((v) => !v)} etiket="Yan yüzleri Z etrafında döndür" />
          </section>

          {/* MASKELEME */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Maskeleme</h2>
              <Icon name="mask" size={14} className="text-faint" />
            </div>
            <Slider etiket="Alt yüzeyler" deger={maskBottom} set={setMaskBottom} min={0} max={90} step={1} birim="°" hassas={0} />
            <Slider etiket="Üst yüzeyler" deger={maskTop} set={setMaskTop} min={0} max={90} step={1} birim="°" hassas={0} />
            <div className="mb-2">
              <div className="field-hint mb-1">Yüzeye göre ayarla</div>
              <div className="seg w-full">
                <button type="button" onClick={() => { kaydet(); setMaskMode("haric"); }} data-active={maskMode === "haric"} className="flex-1 justify-center">Hariç Tut</button>
                <button type="button" onClick={() => { kaydet(); setMaskMode("dahil"); }} data-active={maskMode === "dahil"} className="flex-1 justify-center">Sadece Dahil Et</button>
              </div>
            </div>
            <div className="mb-1.5 flex gap-1.5">
              <button type="button" className="btn flex-1" data-active={maskeArac} onClick={() => { setMaskeArac((v) => !v); setArac(null); }}><Icon name="brush" size={12} />Maske fırçası</button>
              <button type="button" className="btn flex-1" onClick={maskeDoldur}><Icon name="plus" size={12} />Tümünü boya</button>
            </div>
            <div className="mono mb-1.5 text-[10px] text-dim tnum">{maskeliVertex.toLocaleString("tr-TR")} vertex maskeli</div>
            <button type="button" className="btn mb-2 w-full" onClick={maskeTemizle}><Icon name="eraser" size={12} />Maskeyi temizle</button>
            <div>
              <div className="field-hint mb-1">Geçiş eğrisi</div>
              <div className="seg w-full">
                <button type="button" onClick={() => { kaydet(); setEasing("dogrusal"); }} data-active={easing === "dogrusal"} className="flex-1 justify-center">Doğrusal</button>
                <button type="button" onClick={() => { kaydet(); setEasing("s"); }} data-active={easing === "s"} className="flex-1 justify-center">S Eğrisi</button>
                <button type="button" onClick={() => { kaydet(); setEasing("yumusak"); }} data-active={easing === "yumusak"} className="flex-1 justify-center">Yumuşak</button>
              </div>
            </div>
          </section>

          {/* DIŞA AKTAR */}
          <section className="card mb-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="card-title">Dışa Aktar</h2>
              <Icon name="download" size={14} className="text-faint" />
            </div>
            <Slider etiket="Çözünürlük" deger={exportRes} set={setExportRes} min={0.05} max={2} step={0.05} birim="mm" />
            <div className="mono mb-1 flex items-center justify-between text-[10px]">
              <span className="text-dim">Tahmini poligon</span>
              <span className="tnum text-ink">{tahminiUcgen >= 1e6 ? `${(tahminiUcgen / 1e6).toFixed(2)} M` : `${Math.round(tahminiUcgen / 1000)} k`}</span>
            </div>
            <div className="mono mb-1 flex items-center justify-between text-[10px]">
              <span className="text-dim">Sahnedeki poligon</span>
              <span className="tnum text-faint">{Math.round(ucgenSayisi / 1000)} k</span>
            </div>
            <div className="mono mb-2 flex items-center justify-between text-[10px]">
              <span className="text-dim">Katı hacmi</span>
              <span className="tnum text-faint">{hacimCm3.toFixed(2)} cm³</span>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-1.5">
              <button type="button" className="btn btn-accent" onClick={stlIndir} disabled={exportStatus === "working"}><Icon name="download" size={12} />STL</button>
              <button type="button" className="btn btn-accent" onClick={mfIndir} disabled={exportStatus === "working"}><Icon name="download" size={12} />3MF</button>
            </div>
            <div className="mono text-[10px]" style={{ color: exportStatus === "error" ? "#f87171" : exportStatus === "done" ? "#34d399" : "#6e7787" }}>
              {exportStatus === "idle" && (exportNot || "Hazır")}
              {exportStatus === "working" && "Hesaplanıyor..."}
              {exportStatus === "done" && (exportNot || "İndirildi")}
              {exportStatus === "error" && (exportNot || "Hata: tekrar deneyin")}
            </div>
            <p className="field-hint mt-1.5">Çözünürlük, dışa aktarımda gerçek yeniden örnekleme yapar. İndirilen dosya ekrandaki kabartmanın birebir aynısıdır.</p>
          </section>

          <footer className="px-1 pb-2 pt-1 text-center text-[10px] leading-relaxed text-dim">
            Palamut3D · Açık kaynak · Tamamen ücretsiz · Tüm işlemler tarayıcınızda · Powered by{" "}
            <a href="https://mucahidbalci.github.io" target="_blank" rel="noopener noreferrer" className="link">Mucahid Balci</a>
          </footer>
        </aside>
      </div>

      <footer className="mono flex h-status shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-panel px-4 text-[10px] text-dim">
        <Icon name="file" size={12} className="text-faint" />
        <span className="whitespace-nowrap text-ink">{fileName || "kup.stl"}</span>
        <span className="sep">|</span>
        <span className="tnum whitespace-nowrap">{ucgenSayisi.toLocaleString("tr-TR")} üçgen</span>
        <span className="sep">|</span>
        <span className="tnum whitespace-nowrap">{sizeMm.x.toFixed(1)} × {sizeMm.y.toFixed(1)} × {sizeMm.z.toFixed(1)} mm</span>
        <span className="sep">|</span>
        <span className="tnum whitespace-nowrap">{vertexSayisi.toLocaleString("tr-TR")} vertex</span>
        <span className="sep">|</span>
        <span className="tnum whitespace-nowrap">{layers.filter((l) => l.visible).length} katman</span>
        <span className="sep">|</span>
        <span className="tnum whitespace-nowrap">{bolgeler.filter((b) => b.gorunur).length} bölge</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3"><FpsMeter /><Icon name="gauge" size={12} className="text-faint" /></span>
      </footer>
    </div>
  );
}
