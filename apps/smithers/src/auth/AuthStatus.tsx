import { useAuthStore } from "./authStore";

// The auth check is kicked once at app boot from main.tsx (alongside
// startApprovalWatcher), not from a mount effect — the app forbids
// useEffect in components (state-and-routing.md). This is a pure render of store
// state.
export function AuthStatus() {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const openSignIn = useAuthStore((state) => state.openSignIn);

  if (status === "signed-in" && user) {
    return (
      <div className="auth-status" data-testid="auth-status">
        <span className="auth-avatar" aria-hidden="true">
          {user.avatarUrl ? <img alt="" src={user.avatarUrl} /> : user.username.slice(0, 1).toUpperCase()}
        </span>
        <span className="auth-name">{user.displayName}</span>
        <button className="auth-link" type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="auth-status" data-testid="auth-status">
      <span className="auth-name">{status === "checking" ? "Checking auth" : "Remote mode"}</span>
      <button className="auth-link" type="button" onClick={openSignIn}>
        Sign in
      </button>
    </div>
  );
}
