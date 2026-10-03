export const metadata = { title: "Fair Drop" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16 }}>{children}</body>
    </html>
  );
}
