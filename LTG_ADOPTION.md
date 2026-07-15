# LetThemGo — Ganon Adoption Notes (beta-6.1)

Notes for adopting `@potionforge/ganon` `1.0.0-beta.6` / `beta-6.1` in the LetThemGo app.
(The fuller beta-7 adoption plan lives on the `beta-7` branch.)

---

## Breaking: `login()` returns `LoginResult`, not a string

`ganon.login(userId)` no longer returns `"noop" | "restore" | "backup"`. It returns:

```ts
{
  action: 'noop' | 'restore' | 'backup';
  probe: 'present' | 'absent' | 'indeterminate' | 'skipped';
  restoredKeys: number;
  restoreFailedKeys: number;
  probeReason?: string; // only when probe === 'indeterminate'
}
```

### What to do after bumping

1. Run `tsc --noEmit` in the LTG app — do **not** rely on IDE red squiggles alone.
   Only typechecked files surface the no-overlap errors from comparing a string to an object.
2. Grep for `ganon.login` call sites (and any stored return value). Every
   `result === "backup"` / `=== "restore"` / `=== "noop"` comparison becomes
   `result.action === "backup"` (etc.).

### Probe / restore facts (app owns policy)

| Field | Meaning |
|---|---|
| `probe: 'skipped'` | Same-user reopen; **no probe ran**. Do not treat as `present`. |
| `probe: 'indeterminate'` + `restoredKeys: 0` | Stranded-guest signal — restore reached empty/unreadable remote. |
| `restoreFailedKeys > 0` | Partial restore; session may be degraded even when `probe: 'present'`. |
