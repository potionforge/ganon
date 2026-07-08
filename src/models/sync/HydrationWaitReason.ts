/** Why a whenHydrated() waiter settled — lets consumers distinguish hydration outcomes. */
export type HydrationWaitReason = 'hydrated' | 'logged-out' | 'login-failed' | 'stopped';
