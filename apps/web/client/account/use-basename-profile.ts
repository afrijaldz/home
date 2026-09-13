"use client";

import { fetchBasenameProfile } from "@/client/account/basename-profile";
import { publicQueryKey, useHomeQuery } from "@/client/query/query-client";

export function useBasenameProfile({
  ownerKey,
  address,
  enabled = true,
}: {
  ownerKey?: string | null;
  address?: string | null;
  enabled?: boolean;
}) {
  return useHomeQuery({
    queryKey: address
      ? publicQueryKey(
          "basename",
          ownerKey ?? "owner-unavailable",
          address.toLowerCase(),
        )
      : publicQueryKey("basename", "disabled"),
    enabled: enabled && Boolean(address),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => fetchBasenameProfile(address, fetch, signal),
  });
}
