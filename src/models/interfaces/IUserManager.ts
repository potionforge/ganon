export default interface IUserManager {
  getCurrentUser(): string | undefined;
  isUserLoggedIn(): boolean;
}
