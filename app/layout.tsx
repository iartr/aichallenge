import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OfferFactory.ai Interview Feedback",
  description: "SaaS prototype for IT interview transcription, LLM feedback and explicit memory layers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
