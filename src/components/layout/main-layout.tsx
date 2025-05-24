import type { ReactNode } from 'react';

interface MainLayoutProps {
  children: ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="flex flex-col min-h-screen items-center justify-center p-4 sm:p-6 md:p-8">
      <main className="w-full max-w-2xl flex flex-col items-center gap-8">
        {children}
      </main>
    </div>
  );
}
