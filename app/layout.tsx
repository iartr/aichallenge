import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Simple Chat Agent",
  description: "A simple OpenAI-backed chat agent with conversation history.",
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
