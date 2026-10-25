import SessionToken from '../../sync/SessionToken';

export const TEST_USER_ID = 'test-user';
export const testSession = SessionToken.forTests(TEST_USER_ID);

export function operationRepoSessionDeps() {
  return {
    getCurrentUserId: () => TEST_USER_ID,
    getRunSession: () => testSession,
  };
}
