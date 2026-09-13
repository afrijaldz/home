"use client";

import { CDPHooksProvider } from "@coinbase/cdp-hooks";
import { useMemo, type ReactNode } from "react";
import { AccountWalletSessionOwner } from "./cdp-session-lifecycle";
import {
  CdpHooksErrorBoundary,
  cdpHooksConfig,
  useCdpSdkBoundary,
} from "./cdp-sdk-provider";
import { composeSdkBoundaries } from "./composite-sdk-boundary";
import NativeBaseAccountBridge, { useNativeBaseIdentity } from "./native-base-bridge";

function CompositeAccountBridge({ children }: { children: ReactNode }) {
  const cdp = useCdpSdkBoundary();
  const native = useNativeBaseIdentity();
  const sdk = useMemo(() => composeSdkBoundaries({
    cdp,
    native,
    clearNative: native.boundary.signOut,
    cdpSignOut: cdp.signOut,
  }), [cdp, native]);

  return (
    <AccountWalletSessionOwner sdk={sdk} baseAccountEnabled projectConfigured>
      {children}
    </AccountWalletSessionOwner>
  );
}

export default function CompositeAccountProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const config = useMemo(() => cdpHooksConfig(projectId), [projectId]);

  return (
    <CdpHooksErrorBoundary fallback={<NativeBaseAccountBridge>{children}</NativeBaseAccountBridge>}>
      <CDPHooksProvider config={config}>
        <CompositeAccountBridge>{children}</CompositeAccountBridge>
      </CDPHooksProvider>
    </CdpHooksErrorBoundary>
  );
}
