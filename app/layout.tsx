import type { Metadata } from "next";
import "./globals.css";

// Palamut3D — kök layout. Dil Türkçe, gövde koyu zemin, tam ekran yerleşim.
export const metadata: Metadata = {
  title: "Palamut3D",
  description:
    "Palamut3D — 3D Model Kabartma ve Doku Aracı. STL modelinize 100+ prosedürel doku ile gerçek kabartma uygulayın, STL veya 3MF olarak indirin. Tamamen ücretsiz, tüm işlemler tarayıcınızda.",
  applicationName: "Palamut3D",
  authors: [{ name: "Mucahid Balci", url: "https://mucahidbalci.github.io" }],
  keywords: [
    "STL",
    "3MF",
    "kabartma",
    "doku",
    "heightmap",
    "3D baskı",
    "CNC",
    "triplanar",
    "Palamut3D",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body className="h-full overflow-hidden bg-bg text-ink antialiased">
        {children}
      </body>
    </html>
  );
}