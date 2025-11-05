export const metadata = {
  title: 'Robotic Arm Sorter',
  description: 'Simulation of a robotic arm sorting boxes by color',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>
        {children}
      </body>
    </html>
  );
}
