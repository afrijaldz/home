"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormEvent, RefObject } from "react";

export function SignInEmail({
  email,
  isSendingCode,
  baseAccountEnabled,
  inputRef,
  onEmailChange,
  onSubmit,
  onBaseAccountSignIn,
}: {
  email: string;
  isSendingCode: boolean;
  baseAccountEnabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onEmailChange: (email: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBaseAccountSignIn: () => void;
}) {
  return (
    <form className="mt-4" onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="account-email">Email address</FieldLabel>
          <Input
            ref={inputRef}
            id="account-email"
            className="h-11"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onInput={(event) => onEmailChange(event.currentTarget.value)}
            disabled={isSendingCode}
            required
            autoFocus
            data-initial-focus
          />
        </Field>
        <Button className="h-11 w-full" size="lg" type="submit" disabled={isSendingCode}>
          {isSendingCode ? "Sending code…" : "Continue with email"}
        </Button>
        {baseAccountEnabled ? (
          <>
            <FieldSeparator>or</FieldSeparator>
            <Button
              className="h-11 w-full"
              size="lg"
              variant="secondary"
              onClick={onBaseAccountSignIn}
            >
              Sign in with Base Account
            </Button>
          </>
        ) : null}
      </FieldGroup>
    </form>
  );
}
