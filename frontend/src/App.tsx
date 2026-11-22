import React from 'react';
import { Loader2 } from 'lucide-react';
import { useWorkbench } from './context/WorkbenchContext';
import { AuthGate } from './components/AuthGate';
import { WorkbenchShell } from './components/WorkbenchShell';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmModal, ToastStack, TrishulMark } from './components/UiPrimitives';
import { OverviewWorkspace } from './workspaces/OverviewWorkspace';
import { SimulatorWorkspace } from './workspaces/SimulatorWorkspace';
import { WalkerWorkspace } from './workspaces/WalkerWorkspace';
import { TrapsWorkspace } from './workspaces/TrapsWorkspace';
import { BrowserWorkspace } from './workspaces/BrowserWorkspace';
import { MibsWorkspace } from './workspaces/MibsWorkspace';
import { SettingsWorkspace } from './workspaces/SettingsWorkspace';

export const App: React.FC = () => {
  const { authChecking, authenticated, activeWorkspace } = useWorkbench();

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[var(--tui-bg-canvas)] flex flex-col items-center justify-center gap-3">
        <TrishulMark className="w-8 h-8" />
        <div className="flex items-center gap-2 text-xs font-mono text-[var(--tui-ink-muted)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--tui-brand)]" />
          Verifying operator session...
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <>
        <AuthGate />
        <ToastStack />
      </>
    );
  }

  const renderWorkspace = () => {
    switch (activeWorkspace) {
      case 'simulator':
        return <SimulatorWorkspace />;
      case 'walker':
        return <WalkerWorkspace />;
      case 'traps':
        return <TrapsWorkspace />;
      case 'browser':
        return <BrowserWorkspace />;
      case 'mibs':
        return <MibsWorkspace />;
      case 'settings':
        return <SettingsWorkspace />;
      case 'overview':
      default:
        return <OverviewWorkspace />;
    }
  };

  return (
    <>
      <WorkbenchShell>{renderWorkspace()}</WorkbenchShell>
      <CommandPalette />
      <ToastStack />
      <ConfirmModal />
    </>
  );
};

export default App;
