import type { Metadata } from "next";
import { Onest, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
});

// Figures face: open-source (OFL) with tabular digits, close to Satoshi's numerals.
const figures = Plus_Jakarta_Sans({
  variable: "--font-figures",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AutoCFO",
  description: "Autonomous CFO with a policy-guarded treasury on Arc",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${onest.variable} ${figures.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
