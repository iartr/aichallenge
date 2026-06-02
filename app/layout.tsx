import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Provider Raw Console",
  description: "Minimal raw JSON console for OpenAI and Anthropic APIs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
