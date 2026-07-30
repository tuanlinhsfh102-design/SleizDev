import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Donghua Translate - Dịch & Lồng Tiếng Phim Hoạt Hình",
  description: "Hệ thống dịch và lồng tiếng phim hoạt hình Trung Quốc sang tiếng Việt với AI. Tự động trích xuất phụ đề, dịch bằng Gemini, lồng tiếng bằng TTS.",
  keywords: ["donghua", "vietsub", "dịch phim", "lồng tiếng", "Gemini AI", "TTS", "hoạt hình Trung Quốc"],
  authors: [{ name: "Donghua Translate" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Donghua Translate",
    description: "Dịch và lồng tiếng phim hoạt hình Trung Quốc với AI",
    siteName: "Donghua Translate",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Donghua Translate",
    description: "Dịch và lồng tiếng phim hoạt hình Trung Quốc với AI",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
