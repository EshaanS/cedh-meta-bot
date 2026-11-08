import type { ReactNode } from "react";

export const metadata = { title: "Field Report", description: "Monthly cEDH meta reports for Discord servers" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 680, margin: "2rem auto", padding: "0 16px", lineHeight: 1.5 }}>
        {children}
      </body>
    </html>
  );
}
