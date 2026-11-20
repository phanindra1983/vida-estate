import type { Metadata, Viewport } from "next";
import { Jost, Cormorant_Garamond } from "next/font/google";
import "./globals.css";

const jost = Jost({ subsets: ["latin"], weight: ["300", "400", "500"], variable: "--font-jost" });
const cormorant = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--font-cormorant" });

export const metadata: Metadata = {
  title: "Vida OS",
  description: "The central operating system for Vida Estates",
  icons: { icon: "/monogram.svg" },
};
export const viewport: Viewport = { themeColor: "#121413" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${jost.variable} ${cormorant.variable}`}>
      <body>{children}</body>
    </html>
  );
}
