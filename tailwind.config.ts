import type { Config } from "tailwindcss";

// Palamut3D — Tailwind yapılandırması.
// Renkler globals.css içindeki CSS değişkenlerine bağlıdır; tek yerden değiştirilir.
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Zemin katmanları
        bg: "var(--c-bg)",
        panel: "var(--c-panel)",
        card: "var(--c-card)",
        "card-hover": "var(--c-card-hover)",
        // Kenarlıklar
        line: "var(--c-line)",
        "line-strong": "var(--c-line-strong)",
        // Metin katmanları
        ink: "var(--c-text)",
        dim: "var(--c-text-dim)",
        faint: "var(--c-text-faint)",
        // Anlam renkleri
        accent: "var(--c-accent)",
        "accent-soft": "var(--c-accent-soft)",
        success: "var(--c-success)",
        danger: "var(--c-danger)",
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Inter",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "JetBrains Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        // Tasarım dili: kart 6px, buton 4px, swatch 3px
        card: "6px",
        btn: "4px",
        swatch: "3px",
      },
      spacing: {
        // Sabit yerleşim ölçüleri
        header: "48px",
        status: "28px",
        panel: "320px",
      },
      transitionDuration: {
        150: "150ms",
      },
    },
  },
  plugins: [],
};

export default config;