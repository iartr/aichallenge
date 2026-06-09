import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Persistent Chat Agent",
  description: "An OpenAI-backed chat agent with authenticated persistent conversation history.",
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
