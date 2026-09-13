"use client";

import { useCallback, useEffect, useState } from "react";

export const showSmallBalancesPreferenceKey = "home.show-small-balances.v1";
const preferenceEventName = "home:show-small-balances-change";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
type PreferenceStorageGetter<
  Method extends keyof PreferenceStorage = keyof PreferenceStorage,
> = () => Pick<PreferenceStorage, Method>;

export function readShowSmallBalancesPreference(
  getStorage: PreferenceStorageGetter<"getItem">,
): boolean {
  try {
    return getStorage().getItem(showSmallBalancesPreferenceKey) === "true";
  } catch {
    return false;
  }
}

export function writeShowSmallBalancesPreference(
  getStorage: PreferenceStorageGetter<"setItem">,
  value: boolean,
): boolean {
  try {
    getStorage().setItem(showSmallBalancesPreferenceKey, String(value));
    return true;
  } catch {
    return false;
  }
}

export function useShowSmallBalances(): readonly [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(false);

  useEffect(() => {
    const persisted = readShowSmallBalancesPreference(() => window.localStorage);
    const hydrationFrame = window.requestAnimationFrame(() => setValue(persisted));
    const onPreferenceChange = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "boolean") return;
      setValue(event.detail);
    };
    window.addEventListener(preferenceEventName, onPreferenceChange);
    return () => {
      window.cancelAnimationFrame(hydrationFrame);
      window.removeEventListener(preferenceEventName, onPreferenceChange);
    };
  }, []);

  const update = useCallback((next: boolean) => {
    setValue(next);
    writeShowSmallBalancesPreference(() => window.localStorage, next);
    window.dispatchEvent(new CustomEvent(preferenceEventName, { detail: next }));
  }, []);

  return [value, update] as const;
}
