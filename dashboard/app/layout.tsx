import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Baileys Bot Dashboard",
  description: "Ping and test the Baileys WhatsApp bot API",
  icons: {
    icon: "/brand/favicon.ico",
    shortcut: "/brand/favicon.ico"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
